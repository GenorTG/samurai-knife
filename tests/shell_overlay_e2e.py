#!/usr/bin/env python3
"""App-shell overlays: the Ctrl+K palette and the `?` shortcuts help are modal and live on one page.

Regression for 2026-10-10 (found by hand in the browser, confirmed in code): the shell is never remounted, so both
overlays used plain `open` state and survived client navigation (Back/Forward, `]`, assistant open_tool), and while the
palette was open the global single-key shortcuts (`b`, `]`, ...) still acted on the page behind the scrim.

Usage (scratch server, any data dir):  python3 tests/shell_overlay_e2e.py http://127.0.0.1:3252
"""
import sys

from playwright.sync_api import expect, sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3210").rstrip("/")
FAILED: list[str] = []
CONSOLE: list[str] = []


def check(name, fn):
    try:
        fn()
        print(f"ok   {name}")
    except Exception as exc:  # noqa: BLE001 - report every failing check, not just the first
        FAILED.append(name)
        print(f"FAIL {name}: {type(exc).__name__}: {str(exc)[:200]}")


def main() -> int:
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1280, "height": 900})
        page = ctx.new_page()
        page.on("console", lambda m: CONSOLE.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: CONSOLE.append(str(e)))

        def goto(path):
            page.goto(BASE + path, wait_until="domcontentloaded")
            page.wait_for_function("() => !document.body.innerText.includes('Loading tool')")
            page.wait_for_timeout(500)

        palette = page.get_by_role("dialog", name="Jump to a tool")
        help_dialog = page.get_by_role("dialog", name="Keyboard shortcuts")

        def wait_path(path):
            page.wait_for_function("(p) => location.pathname === p", arg=path, timeout=15000)

        def navigate_in_app(slug):
            # a client-side navigation like the assistant's open_tool, with an overlay in the way (no reload, no pointer click)
            page.evaluate("(p) => window.next.router.push(p)", f"/tools/{slug}")
            wait_path(f"/tools/{slug}")

        goto("/tools/json")

        def palette_opens_with_focus():
            page.keyboard.press("Control+k")
            expect(palette).to_be_visible()
            expect(page.get_by_role("combobox", name="Search tools")).to_be_focused()

        check("Ctrl+K opens the palette with the input focused", palette_opens_with_focus)

        def palette_survives_nothing():
            navigate_in_app("regex")
            expect(palette).to_have_count(0)

        check("a client-side navigation closes the open palette", palette_survives_nothing)

        def back_closes_palette():
            page.go_back()
            wait_path("/tools/json")
            page.keyboard.press("Control+k")
            expect(palette).to_be_visible()
            page.go_forward()
            wait_path("/tools/regex")
            expect(palette).to_have_count(0)

        check("Back/Forward with the palette open leaves no palette over the new page", back_closes_palette)

        def single_keys_blocked():
            sidebar = lambda: page.evaluate("() => JSON.stringify(Object.entries(localStorage).filter(([k]) => /sidebar/i.test(k)))")  # noqa: E731
            was_collapsed = sidebar()
            page.keyboard.press("Control+k")
            expect(palette).to_be_visible()
            # focus leaves the input (click on the dialog's own padding), then single keys must not reach the page behind
            page.locator("[role=dialog] ul").first.click(position={"x": 2, "y": 2}) if page.locator("[role=dialog] ul").count() else None
            url = page.url
            page.keyboard.press("]")
            page.keyboard.press("b")
            page.wait_for_timeout(400)
            assert page.url == url, f"`]` navigated behind the palette: {page.url}"
            assert sidebar() == was_collapsed, "`b` toggled the sidebar behind the palette"
            page.keyboard.press("Escape")
            expect(palette).to_have_count(0)

        check("single-key shortcuts do not act behind the palette; Esc closes it even after focus left the input", single_keys_blocked)

        def help_toggle_and_navigation():
            page.locator("main h1").first.click()
            page.keyboard.press("?")
            expect(help_dialog).to_be_visible()
            page.keyboard.press("?")
            expect(help_dialog).to_have_count(0)
            page.keyboard.press("?")
            expect(help_dialog).to_be_visible()
            navigate_in_app("json")
            expect(help_dialog).to_have_count(0)

        check("`?` toggles the shortcuts help and a navigation closes it", help_toggle_and_navigation)

        def palette_still_navigates():
            page.keyboard.press("Control+k")
            expect(page.get_by_role("combobox", name="Search tools")).to_be_focused()
            page.keyboard.type("jwt")
            page.keyboard.press("Enter")
            wait_path("/tools/ids")  # JWT is a tab of "IDs, tokens and passwords" since 0.6
            expect(palette).to_have_count(0)

        check("typing in the palette and Enter still opens the tool and closes the palette", palette_still_navigates)

        check("no console errors", lambda: (_ for _ in ()).throw(AssertionError(CONSOLE[:3])) if [c for c in CONSOLE if "hmr" not in c.lower() and "favicon" not in c.lower()] else None)
        browser.close()

    print(f"\n{'all checks passed' if not FAILED else str(len(FAILED)) + ' FAILED: ' + str(FAILED)}")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
