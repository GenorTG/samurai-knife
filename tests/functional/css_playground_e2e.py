#!/usr/bin/env python3
"""CSS playground (CSS studio's first tab) in Firefox and Chromium, self-contained (scratch server + mock provider).

Presets fill the three files and the preview; console output and errors come back from the sandboxed preview; TypeScript
is transpiled; the preview cannot reach the page (opaque origin); Export HTML is one self-contained file; files survive
a reload; and the assistant writes CSS into the editor through page_snapshot + fill_field (code fields are fillable).
  python3 tests/functional/css_playground_e2e.py [--headed]
"""
from __future__ import annotations

import json
import socket
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from playwright.sync_api import Page, expect, sync_playwright  # noqa: E402

from tests.scratch_server import ScratchServer  # noqa: E402

HEADED = "--headed" in sys.argv
PASSES = 0
FAILS: list[str] = []
PANEL = "[role=dialog][aria-label='Toolbox assistant']"


def check(name: str, ok: object, detail: object = "") -> bool:
    global PASSES
    if ok:
        PASSES += 1
        print(f"  ok   {name}", flush=True)
    else:
        FAILS.append(name)
        print(f"  FAIL {name}  {str(detail)[:400]}", flush=True)
    return bool(ok)


def ask(page: Page, text: str) -> None:
    """Send one message to the assistant and wait for the turn to end (its last stored message is a plain reply)."""
    # Idle first: a message typed while a run is still finishing is queued, not sent.
    page.locator(f"{PANEL} button[aria-label='Send']").wait_for(timeout=180_000)
    before = page.evaluate("fetch('/api/agent/conversation').then(r => r.json()).then(c => c.messages.filter(m => m.role === 'user').length)")
    composer = page.locator("textarea[aria-label='Message the assistant']")
    composer.fill(text)
    composer.press("Enter")
    page.wait_for_function(
        """async (n) => { const c = await (await fetch('/api/agent/conversation')).json(); const m = c.messages.filter(x => !(x.role === 'notice' && x.level === 'usage'));
           if (m.filter(x => x.role === 'user').length <= n) return false; const l = m[m.length - 1]; return (l.role === 'assistant' && !l.tool_calls) || l.role === 'notice'; }""",
        arg=before, timeout=180_000, polling=250,
    )
    page.locator(f"{PANEL} button[aria-label='Send']").wait_for(timeout=180_000)


def run(page: Page, base: str, tag: str) -> None:
    page.goto(f"{base}/tools/css", wait_until="domcontentloaded")
    css = page.locator("[data-css-playground] [data-agent-code=css]")
    css.wait_for(timeout=120_000)
    # A dev server compiles the assistant's chunks on first open and reloads the page once (Turbopack dev only), which
    # would cut a run short: open it once now and let that settle before anything else.
    # The first message also loads the run code lazily (another compile): send one throwaway message, once more if cut.
    for _ in range(2):
        try:
            if not page.locator(PANEL).count():
                page.locator("button[aria-label='Open assistant']").click()
            page.wait_for_selector(PANEL)
            ask(page, "warm up")
            break
        except Exception:  # noqa: BLE001
            page.wait_for_load_state("networkidle")
    page.locator("button[aria-label='Close assistant']").first.click()
    css.wait_for(timeout=120_000)
    frame = page.frame_locator("iframe[title=Preview]")
    expect(frame.locator("h1")).to_have_text("Glass card", timeout=15_000)
    check(f"{tag} the playground opens on a preset with a live preview", True)

    page.once("dialog", lambda d: d.accept())
    page.get_by_label("Start from a preset").select_option("tilt")
    page.locator("summary", has_text="Console").click()
    expect(page.get_by_label("Console output")).to_contain_text("Tilt ready", timeout=15_000)
    check(f"{tag} console.log from the preview shows in the console", True)

    page.once("dialog", lambda d: d.accept())
    page.get_by_label("Start from a preset").select_option("typewriter")
    expect(frame.locator("#out")).not_to_have_text("", timeout=15_000)
    check(f"{tag} TypeScript is transpiled and runs", page.get_by_role("tab", name="script.ts").count() == 1)

    isolated = frame.locator("body").evaluate("() => { try { return parent.document ? 'reached' : 'blocked'; } catch (e) { return 'blocked'; } }")
    check(f"{tag} the preview cannot reach the page (sandboxed, opaque origin)", isolated == "blocked", isolated)

    page.get_by_role("tab", name="script.ts").click()
    page.locator("[data-agent-code=typescript]").evaluate("el => el.dispatchEvent(new CustomEvent('knife:code-fill', { detail: { value: 'throw new Error(\"boom\");' } }))")
    expect(page.get_by_label("Console output")).to_contain_text("boom", timeout=15_000)
    check(f"{tag} errors from the preview show in the console", True)

    with page.expect_download() as download:
        page.get_by_role("button", name="Export HTML").click()
    exported = Path(download.value.path()).read_text()
    check(f"{tag} Export HTML is one self-contained file (CSS inline, compiled script, no console bridge)",
          "@keyframes blink" in exported and '<script type="module">' in exported and "knifePlayground" not in exported, exported[:200])

    # The assistant writes CSS: page_snapshot lists the code field like a textarea, fill_field replaces its text.
    page.get_by_role("tab", name="style.css").click()
    page.locator("button[aria-label='Open assistant']").click()
    page.wait_for_selector(PANEL)
    page.locator("[aria-label='Ask before acting']").get_by_role("radio", name="None", exact=True).click()
    last_tool = """fetch('/api/agent/conversation').then(r => r.json()).then(c => { const m = c.messages; const i = m.map(x => x.role).lastIndexOf('user'); return m.slice(i).filter(x => x.role === 'tool').map(x => x.content).pop() ?? null; })"""
    snapshot = None
    # The first tool call loads the page tools lazily; on a dev server that compile reloads the page and cuts the run.
    for _ in range(3):
        try:
            css.wait_for(timeout=60_000)
            if not page.locator(PANEL).count():
                page.locator("button[aria-label='Open assistant']").click()
                page.wait_for_selector(PANEL)
            ask(page, "CALL:page_snapshot:{}")
            snapshot = page.evaluate(last_tool)
        except Exception as error:  # noqa: BLE001
            print(f"  (retrying the snapshot: {str(error).splitlines()[0][:200]})", flush=True)
            snapshot = None
        if snapshot is not None and "code:css" in snapshot:
            break
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(2000)
        css.wait_for(timeout=60_000)
    if snapshot is None:
        print("conversation:", json.dumps(page.evaluate("fetch('/api/agent/conversation').then(r => r.json())"))[:2000])
        print("panel:", page.locator(PANEL).inner_text()[-1500:])
    data = json.loads(snapshot or "{}")
    if not (data.get("snapshot") or data).get("controls"):
        print("tool result:", (snapshot or "")[:600])
    controls = (data.get("snapshot") or data).get("controls", [])
    field = next((c for c in controls if c.get("type") == "code:css"), None)
    check(f"{tag} page_snapshot lists the CSS editor as a fillable code field", field is not None and field.get("kind") == "textarea", [(c.get("kind"), c.get("label"), c.get("type")) for c in controls][:40])
    if field:
        css_text = "body { background: rgb(9, 8, 7); }"
        ask(page, "CALL:fill_field:" + json.dumps({"id": field["id"], "value": css_text}))
        expect(frame.locator("body")).to_have_css("background-color", "rgb(9, 8, 7)", timeout=15_000)
        check(f"{tag} the assistant's fill_field writes the CSS and the preview updates", "rgb(9, 8, 7)" in css.inner_text())
    page.locator("button[aria-label='Close assistant']").first.click()

    page.reload(wait_until="domcontentloaded")
    css.wait_for(timeout=60_000)
    expect(css).to_contain_text("rgb(9, 8, 7)", timeout=15_000)
    check(f"{tag} the files survive a reload", True)


def main() -> int:
    with ScratchServer() as server:
        server.start()
        print(f"scratch server {server.url} data {server.data_dir}", flush=True)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            mock_port = sock.getsockname()[1]
        mock = subprocess.Popen(["node", str(ROOT / "tests" / "mock_provider.mjs"), str(mock_port)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for _ in range(50):
                try:
                    urllib.request.urlopen(f"http://127.0.0.1:{mock_port}/v1/models", timeout=2).read()
                    break
                except OSError:
                    time.sleep(0.1)
            req = urllib.request.Request(f"{server.url}/api/account/provider", data=json.dumps({"baseUrl": f"http://127.0.0.1:{mock_port}/v1", "model": "mock-model", "apiKey": "mock-key"}).encode(), method="PUT", headers={"content-type": "application/json", "Origin": server.url})
            urllib.request.urlopen(req, timeout=60).read()
            # A dev scratch server compiles each route on first use: warm the page and the assistant's routes.
            for path in ("/tools/css", "/api/agent/tools", "/api/agent/conversation", "/api/account"):
                try:
                    urllib.request.urlopen(server.url + path, timeout=240).read()
                except urllib.error.HTTPError:
                    pass
            warm = urllib.request.Request(server.url + "/api/agent/chat", data=json.dumps({"messages": [{"role": "user", "content": "warm up"}]}).encode(), method="POST", headers={"content-type": "application/json", "Origin": server.url})
            try:
                urllib.request.urlopen(warm, timeout=240).read()
            except urllib.error.HTTPError:
                pass
            with sync_playwright() as pw:
                for name in ("firefox", "chromium"):
                    browser = getattr(pw, name).launch(headless=not HEADED)
                    page = browser.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True).new_page()
                    try:
                        run(page, server.url, f"[{name}]")
                    except Exception:  # noqa: BLE001
                        traceback.print_exc()
                        print("server log tail:\n" + server.log_tail(4000))
                        FAILS.append(f"[{name}] crashed: " + traceback.format_exc().strip().splitlines()[-1])
                    browser.close()
        finally:
            mock.terminate()
    print(f"\n{PASSES} passed, {len(FAILS)} failed")
    if FAILS:
        print(f"{len(FAILS)} FAILED: {FAILS}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
