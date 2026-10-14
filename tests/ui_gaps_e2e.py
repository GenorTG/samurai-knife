"""Widget UI gaps end-to-end: Stop button, password-account login/logout UI, settings view at 390px.

Start the mock:   node tests/mock_provider.mjs 3299
Start the server: KNIFE_DATA_DIR=$(mktemp -d) KNIFE_PORT=3233 npm run dev      (127.0.0.1 only)
Run:              KNIFE_DATA_DIR=<same dir> python3 tests/ui_gaps_e2e.py http://127.0.0.1:3233 http://127.0.0.1:3299

Uses the account CLI to seed accounts (alice becomes the default, so run on a throwaway data dir).
Never point this at a real model server.
"""
import os
import subprocess
import sys
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

if len(sys.argv) < 3 or not os.environ.get("KNIFE_DATA_DIR"):
    sys.exit("usage: KNIFE_DATA_DIR=<dir> python3 tests/ui_gaps_e2e.py <base_url> <mock_url>")
BASE = sys.argv[1].rstrip("/")
MOCK = sys.argv[2].rstrip("/")
MOCK_KEY = "mock-key"
PASSWORD = "correct horse battery"
ROOT = Path(__file__).resolve().parent.parent
SLOW = 60_000

failures: list[str] = []
console_errors: list[str] = []


def check(name: str, ok: bool, detail: object = "") -> None:
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + ("" if ok else f"  -> {detail}"))
    if not ok:
        failures.append(name)


def cli(*args: str, stdin: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(["node", str(ROOT / "scripts" / "accounts.mjs"), *args], input=stdin,
                          capture_output=True, text=True, cwd=ROOT, env=os.environ.copy())


def open_panel(page: Page):
    dialog = page.locator("[role=dialog][aria-label='Toolbox assistant']")
    if not dialog.is_visible():
        page.locator("button[aria-label='Open assistant']").click()
    dialog.wait_for()
    return dialog


r = cli("set-provider", "genor", "--base-url", f"{MOCK}/v1", "--model", "mock-model", "--key-stdin", stdin=f"{MOCK_KEY}\n")
check("seed genor provider", r.returncode == 0, r.stderr)

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1280, "height": 800})
    page = ctx.new_page()
    page.set_default_timeout(SLOW)
    page.on("console", lambda m: console_errors.append(f"{m.type}: {m.text}") if m.type == "error" and "401" not in m.text else None)
    page.on("pageerror", lambda e: console_errors.append(f"pageerror: {e}"))

    # 1. Stop button -------------------------------------------------------------------------
    page.goto(BASE + "/tools/qr", wait_until="networkidle")
    dialog = open_panel(page)
    composer = page.locator("textarea[aria-label='Message the assistant']")
    composer.wait_for()
    check("Stop hidden while idle", page.locator("button[aria-label='Stop']").count() == 0)
    composer.fill("SLOW:30000 take your time")
    composer.press("Enter")
    stop = page.locator("button[aria-label='Stop']")
    stop.wait_for()
    check("Stop appears while a run is in flight", True)
    check("Send is replaced by Stop", page.locator("button[aria-label='Send']").count() == 0)
    stop.click()
    page.locator("[role=log]").get_by_text("Stopped.").wait_for()
    check("Stop shows a 'Stopped.' notice", True)
    page.locator("button[aria-label='Send']").wait_for()
    check("Send returns after Stop", page.locator("button[aria-label='Stop']").count() == 0)
    msgs = page.evaluate("fetch('/api/agent/conversation').then(r => r.json()).then(c => c.messages)")
    check("no assistant reply was recorded for the aborted turn",
          not any(m["role"] == "assistant" for m in msgs) and msgs[-1]["role"] == "notice", msgs)
    page.wait_for_timeout(500)
    composer.fill("after stop")
    composer.press("Enter")
    page.locator("[role=log]").get_by_text("ECHO: after stop").wait_for()
    check("a new turn works after Stop", True)

    # Stop also at 390px
    page.set_viewport_size({"width": 390, "height": 844})
    composer.fill("SLOW:30000 again")
    composer.press("Enter")
    stop.wait_for()
    box = stop.bounding_box() or {"x": -1, "width": 0}
    check("390px: Stop button is inside the viewport", box["x"] >= 0 and box["x"] + box["width"] <= 390, box)
    stop.click()
    page.locator("button[aria-label='Send']").wait_for()
    check("390px: Stop aborts the run", True)

    # 2. Settings view at 390px -----------------------------------------------------------------
    page.locator("button[aria-label='Settings']").click()
    form = page.locator("form[aria-label='Provider settings']")
    form.wait_for()
    metrics = form.evaluate("f => ({sw: f.scrollWidth, cw: f.clientWidth})")
    check("390px settings: no horizontal overflow in the form", metrics["sw"] <= metrics["cw"], metrics)
    dbox = dialog.bounding_box() or {"x": -1, "width": 0}
    check("390px settings: panel fits viewport", dbox["x"] >= 0 and dbox["x"] + dbox["width"] <= 390, dbox)
    page.locator("summary", has_text="Extra headers").click()
    metrics = form.evaluate("f => ({sw: f.scrollWidth, cw: f.clientWidth})")
    check("390px settings: still no overflow with headers open", metrics["sw"] <= metrics["cw"], metrics)
    for name in ("Save", "Test connection"):
        btn = page.get_by_role("button", name=name, exact=True)
        btn.scroll_into_view_if_needed()
        b = btn.bounding_box() or {"x": -1, "width": 0}
        check(f"390px settings: '{name}' reachable", b["x"] >= 0 and b["x"] + b["width"] <= 390, b)
    page.get_by_role("button", name="Test connection").click()
    page.locator("[role=status]").filter(has_text="Connected").wait_for()
    check("390px settings: test connection works", True)
    page.set_viewport_size({"width": 1280, "height": 800})

    # 3. Password-account login UI ---------------------------------------------------------------
    r = cli("add", "alice", "--name", "Alice")
    check("seed alice", r.returncode == 0, r.stderr)
    r = cli("set-password", "alice", stdin=f"{PASSWORD}\n")
    check("alice password set", r.returncode == 0, r.stderr)
    r = cli("set-provider", "alice", "--base-url", f"{MOCK}/v1", "--model", "mock-model", "--key-stdin", stdin=f"{MOCK_KEY}\n")
    check("alice provider set", r.returncode == 0, r.stderr)
    r = cli("set-default", "alice")
    check("alice is default", r.returncode == 0, r.stderr)

    page.goto(BASE + "/", wait_until="networkidle")
    open_panel(page)
    login = page.locator("form[aria-label='Log in']")
    login.wait_for()
    check("password default account shows the login form", True)
    check("login form lists only alice", login.locator("select option").all_inner_texts() == ["Alice"],
          login.locator("select option").all_inner_texts())
    check("no composer before login", page.locator("textarea[aria-label='Message the assistant']").count() == 0)
    login.get_by_label("Password").fill("wrong password!")
    login.get_by_role("button", name="Log in").click()
    login.get_by_text("Wrong password.").wait_for()
    check("wrong password shows an error and stays on the form", login.is_visible())
    login.get_by_label("Password").fill(PASSWORD)
    login.get_by_role("button", name="Log in").click()
    composer = page.locator("textarea[aria-label='Message the assistant']")
    composer.wait_for()
    check("correct password reaches the chat", True)
    check("header shows the account name", "Alice" in dialog.locator("header").inner_text(), dialog.locator("header").inner_text())
    composer.fill("hi from alice")
    composer.press("Enter")
    page.locator("[role=log]").get_by_text("ECHO: hi from alice").wait_for()
    check("chat works as the logged-in account", True)
    cookies = {c["name"]: c for c in ctx.cookies()}
    sess = cookies.get("knife_session")
    check("session cookie is httpOnly", bool(sess) and sess["httpOnly"], sess)

    page.reload(wait_until="networkidle")
    open_panel(page)
    page.locator("textarea[aria-label='Message the assistant']").wait_for()
    check("session survives reload", "ECHO: hi from alice" in page.locator("[role=log]").inner_text())

    page.locator("button[aria-label='Settings']").click()
    page.get_by_role("button", name="Log out Alice").click()
    page.locator("form[aria-label='Log in']").wait_for()
    check("logout returns to the login form", True)
    check("logout hides the previous conversation", "hi from alice" not in page.locator("[role=dialog]").inner_text())
    status = page.evaluate("fetch('/api/account').then(r => r.status)")
    check("API is 401 after logout", status == 401, status)

    browser.close()

check("zero console errors", not console_errors, console_errors[:5])
print(f"\n{len(failures)} failure(s)" if failures else "\nall checks passed")
sys.exit(1 if failures else 0)
