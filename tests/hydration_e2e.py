#!/usr/bin/env python3
"""Hydration guard: every tool/tab must hydrate cleanly under non-server locales and timezones.

A bare `toLocaleString()` or `Intl.*(undefined, …)` in render output differs between the server
(en-US/UTC) and a Polish/German/Japanese browser, and React reports a hydration mismatch. Read-only
(GET only), so it is safe against any instance. A second pass loads and RELOADS every page in Firefox, which restores a
<button>'s dynamic `disabled` state across reloads before React hydrates (every button carries autocomplete="off"):
  python3 tests/hydration_e2e.py http://127.0.0.1:3210 [--quick]
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from playwright.sync_api import sync_playwright  # noqa: E402

from tests.coverage.core import all_targets  # noqa: E402

PROFILES = [
    {"timezone_id": "Europe/Warsaw", "locale": "pl-PL"},
    {"timezone_id": "America/Los_Angeles", "locale": "de-DE"},
    {"timezone_id": "Asia/Tokyo", "locale": "ja-JP"},
]


def first_mismatch(logs: list[str]) -> str | None:
    hits = [l for l in logs if any(k in l.lower() for k in ("didn't match", "hydration failed", "error while hydrating"))]
    if not hits:
        return None
    return "\n".join(x for x in hits[0].splitlines() if x.lstrip().startswith(("+", "-")))[:240] or hits[0][:160]


def wait_tool(page) -> None:
    page.wait_for_function("document.querySelector('[role=status]') === null || !/Loading tool/.test(document.body.innerText)", timeout=20_000)
    page.wait_for_timeout(500)


def firefox_reload_pass(pw, base: str, paths: list[str], bad: list[str]) -> None:
    try:
        browser = pw.firefox.launch()
    except Exception as error:  # noqa: BLE001 - browser not installed: say so instead of passing silently
        bad.append(f"firefox: cannot launch ({str(error).splitlines()[0][:120]}); run `python3 -m playwright install firefox`")
        return
    page = browser.new_context(viewport={"width": 1440, "height": 900}, locale="pl-PL", timezone_id="Europe/Warsaw").new_page()
    logs: list[str] = []
    page.on("console", lambda m: logs.append(m.text))
    for path in paths:
        logs.clear()
        page.goto(base + path, wait_until="domcontentloaded")
        wait_tool(page)
        page.reload(wait_until="domcontentloaded")
        wait_tool(page)
        detail = first_mismatch(logs)
        if detail:
            bad.append(f"firefox reload {path}: {detail}")
    browser.close()


def main() -> int:
    base = sys.argv[1].rstrip("/")
    quick = "--quick" in sys.argv
    paths = ["/"] + [f"/tools/{s}" + (f"?tab={t}" if t else "") for s, t in all_targets()]
    profiles = PROFILES[:1] if quick else PROFILES
    bad: list[str] = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        for prof in profiles:
            ctx = browser.new_context(viewport={"width": 1440, "height": 900}, **prof)
            page = ctx.new_page()
            logs: list[str] = []
            page.on("console", lambda m: logs.append(m.text) if m.type == "error" else None)
            page.on("pageerror", lambda e: logs.append(str(e)))
            for path in paths:
                logs.clear()
                page.goto(base + path, wait_until="domcontentloaded")
                wait_tool(page)
                detail = first_mismatch(logs)
                if detail:
                    bad.append(f"{prof['locale']} {path}: {detail}")
            ctx.close()
        browser.close()
        firefox_reload_pass(pw, base, paths, bad)
    for line in bad:
        print("FAIL", line)
    print(f"{len(paths)} pages x {len(profiles)} locale/timezone profiles + a Firefox reload pass: {'ALL PASS' if not bad else str(len(bad)) + ' mismatches'}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
