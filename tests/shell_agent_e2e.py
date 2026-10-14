"""App shell <-> assistant integration (real browser, scripted mock provider).

  node tests/mock_provider.mjs 3299
  KNIFE_DATA_DIR=$(mktemp -d) KNIFE_PORT=3234 npm run dev
  python3 tests/shell_agent_e2e.py http://127.0.0.1:3234 http://127.0.0.1:3299
"""
import json
import sys
import urllib.request

from playwright.sync_api import sync_playwright

BASE, MOCK = sys.argv[1].rstrip("/"), sys.argv[2].rstrip("/")
failures: list[str] = []
errors: list[str] = []


def check(name: str, ok: bool, detail: object = "") -> None:
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + ("" if ok else f"  -> {detail}"))
    if not ok:
        failures.append(name)


def put_provider() -> None:
    body = {"baseUrl": f"{MOCK}/v1", "model": "mock-model", "apiKey": "mock-key"}
    req = urllib.request.Request(BASE + "/api/account/provider", data=json.dumps(body).encode(), method="PUT",
                                 headers={"content-type": "application/json", "Origin": BASE})
    urllib.request.urlopen(req, timeout=30).read()


def geom(page, sel: str) -> dict:
    return page.evaluate("s => { const r = document.querySelector(s).getBoundingClientRect(); return {l: r.left, r: r.right, t: r.top, w: r.width}; }", sel)


put_provider()
with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.on("console", lambda m: errors.append(m.text[:200]) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)[:200]))
    page.goto(BASE + "/", wait_until="networkidle")

    # Ctrl+J opens the assistant from anywhere; empty state offers starter prompts.
    page.keyboard.press("Control+j")
    page.wait_for_selector("[role=dialog][aria-label='Toolbox assistant']")
    check("Ctrl+J opens the assistant", True)
    page.locator("ul[aria-label='Suggested prompts'] button").first.wait_for()  # rendered once /api/account resolves
    check("starter prompts shown", page.locator("ul[aria-label='Suggested prompts'] button").count() == 3)

    # Dock: the page reflows beside the panel instead of being covered.
    before = geom(page, "main")
    page.locator("button[aria-label='Dock assistant beside the page']").click()
    page.wait_for_selector("[data-agent-docked]")
    page.wait_for_timeout(400)
    panel, after = geom(page, "[data-agent-docked]"), geom(page, "main")
    check("docked panel sits under the top bar", abs(panel["t"] - 56) < 2, panel)
    check("page content shrinks to make room", after["w"] < before["w"] - 300, (before, after))
    check("content does not run under the panel", after["r"] <= panel["l"] + 1, (after, panel))
    check("launcher button hidden while docked", not page.locator("button[aria-label='Close assistant'][aria-expanded]").is_visible())

    # Palette -> "Ask the assistant" sends the query; the agent navigates while we watch.
    page.locator("main").click(position={"x": 5, "y": 5})
    page.keyboard.press("Control+k")
    page.wait_for_selector("[role=combobox]")
    page.keyboard.type('GAP:1200 CALL:open_tool:{"slug":"qr"}')
    page.wait_for_selector("#sk-pal-ask")
    page.keyboard.press("Control+Enter")
    page.wait_for_selector("[data-agent-pill]", timeout=10_000)
    check("top-bar pill shows while the agent works", True)
    page.wait_for_url("**/tools/qr", timeout=30_000)
    check("agent moved the page to /tools/qr", True)
    page.wait_for_selector("[data-agent-pill]", state="detached", timeout=30_000)
    check("pill clears when the run ends", True)
    check("sidebar highlights the page the agent opened", page.locator("nav[aria-label='Tools'] a[aria-current='page']").inner_text().strip().startswith("QR"))
    check("panel stays docked across the agent's page switch", page.locator("[data-agent-docked]").count() == 1)

    # Stop from the pill.
    page.keyboard.press("Control+k")
    page.wait_for_selector("[role=combobox]")
    page.keyboard.type("SLOW:20000 wait")
    page.wait_for_selector("#sk-pal-ask")
    page.keyboard.press("Control+Enter")
    page.wait_for_selector("[data-agent-pill]")
    page.locator("[data-agent-pill] button[aria-label='Stop the assistant']").click()
    page.wait_for_selector("[data-agent-pill]", state="detached", timeout=10_000)
    check("Stop in the top bar ends the run", True)

    # Narrow screens never dock.
    page.set_viewport_size({"width": 800, "height": 900})
    page.wait_for_timeout(300)
    check("no docking below lg", page.locator("[data-agent-docked]").count() == 0)
    check("no horizontal overflow at 800px", not page.evaluate("document.documentElement.scrollWidth > innerWidth"))

    # Phones (390px): the top bar keeps a compact chip (step count + Stop), the step line sits in a strip below it.
    phone = browser.new_context(viewport={"width": 390, "height": 800})
    phone.add_init_script("localStorage.setItem('sk.agent.mode.v1', 'standard')")
    mobile = phone.new_page()
    mobile.on("console", lambda m: errors.append(m.text[:200]) if m.type == "error" else None)
    mobile.goto(BASE + "/tools/json", wait_until="networkidle")
    mobile.keyboard.press("Control+j")
    mobile.wait_for_selector("[role=dialog][aria-label='Toolbox assistant']")

    def inside(sel: str) -> bool:
        return mobile.evaluate(
            "s => { const r = document.querySelector(s).getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.width > 20 && r.height > 20; }", sel)

    box = mobile.locator("textarea[aria-label='Message the assistant']")
    box.fill('GAP:300 CALL:page_snapshot:{}\nCALL:wait:{"ms":2500}\nCALL:page_snapshot:{}')
    box.press("Enter")
    mobile.wait_for_selector("[data-agent-chip]")
    mobile.get_by_role("button", name="Close assistant").first.click()
    mobile.wait_for_selector("[data-agent-strip]")
    check("390px: compact chip, not the text pill", mobile.locator("[data-agent-pill]").is_hidden() and inside("[data-agent-chip]"))
    check("390px: Stop and theme toggle both fit in the bar", inside("[data-agent-chip] button[aria-label='Stop the assistant']") and inside("header button[aria-label*='heme']"))
    check("390px: step line shown in the strip", len(mobile.locator("[data-agent-strip]").inner_text().strip()) > 3, mobile.locator("[data-agent-strip]").inner_text())
    check("390px: no horizontal overflow while running", not mobile.evaluate("document.documentElement.scrollWidth > innerWidth"))
    mobile.locator("[data-agent-chip] button[aria-label='Stop the assistant']").click()
    mobile.wait_for_selector("[data-agent-chip]", state="detached", timeout=10_000)
    check("390px: Stop on the chip ends the run (chip and strip clear)", mobile.locator("[data-agent-strip]").count() == 0)

    mobile.keyboard.press("Control+j")
    box.fill('CALL:open_tool:{"slug":"qr"}')
    box.press("Enter")
    mobile.wait_for_selector("[data-agent-approval]")
    mobile.get_by_role("button", name="Close assistant").first.click()
    mobile.wait_for_selector("[data-agent-strip='approval']")
    check("390px: approval state shows in the strip", "OK" in mobile.locator("[data-agent-strip='approval']").inner_text())
    mobile.locator("[data-agent-strip]").click()
    mobile.wait_for_selector("[data-agent-approval]")
    check("390px: tapping the strip reopens the panel on the approval card", mobile.locator("[data-agent-approval]").is_visible())
    mobile.get_by_role("button", name="Deny").click()
    browser.close()

check("zero console errors", not errors, errors[:3])
print("\nall checks passed" if not failures else f"\n{len(failures)} FAILED: {failures}")
sys.exit(1 if failures else 0)
