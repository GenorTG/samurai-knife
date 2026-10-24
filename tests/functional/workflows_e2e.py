"""Workflows end to end (docs/WORKFLOWS.md) on a scratch server with its own KNIFE_DATA_DIR, driven like a person in
Firefox and Chromium:

- the list, a template, the canvas with its nodes;
- the Webhook node panel: test URL, Listen, a real HTTP call answered by Respond to Webhook (through the worker);
- live node status on the canvas, Save, Activate, the production URL, the run history;
- a Code-node template run: the output table, the code editor;
- the node picker (search + Enter adds a node and opens it);
- a credential: saved, listed, its secret never back in the page;
- webhook answers are sandboxed (CSP sandbox, no Set-Cookie) and never see the caller's cookies;
- no console errors or page errors.

Run: python3 tests/functional/workflows_e2e.py [--headed]
"""
from __future__ import annotations

import json
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


def check(name: str, ok: object, detail: object = "") -> bool:
    global PASSES
    if ok:
        PASSES += 1
        print(f"  ok   {name}", flush=True)
    else:
        FAILS.append(name)
        print(f"  FAIL {name}  {str(detail)[:400]}", flush=True)
    return bool(ok)


def post(url: str, body: object, headers: dict[str, str] | None = None) -> tuple[int, dict, object]:
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST", headers={"content-type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            text = resp.read().decode()
            return resp.status, dict(resp.headers), json.loads(text) if text else None
    except urllib.error.HTTPError as err:
        text = err.read().decode()
        try:
            parsed = json.loads(text)
        except ValueError:
            parsed = text
        return err.code, dict(err.headers), parsed


def hydrated(page: Page) -> None:
    page.wait_for_function("() => { const m = document.querySelector('main'); return !!m && Object.keys(m).some((k) => k.startsWith('__react')); }", timeout=60_000)


def open_template(page: Page, name: str) -> None:
    """Clicks a template until the editor shows (a dev server's Fast Refresh can swallow the first click)."""
    editor = page.locator("[data-workflow-editor]")
    for _ in range(6):
        page.get_by_role("list", name="Templates").get_by_role("button", name=name).click()
        try:
            # The first open compiles the editor chunk (React Flow, CodeMirror) on a dev server.
            editor.wait_for(timeout=30_000)
            return
        except Exception:  # noqa: BLE001
            if page.locator("[data-workflow-editor]").count():
                return
    editor.wait_for(timeout=60_000)


def run(page: Page, base: str, browser_name: str) -> None:
    tag = f"[{browser_name}]"
    page.goto(f"{base}/tools/workflows", wait_until="domcontentloaded")
    hydrated(page)
    open_template(page, "Webhook that answers")
    for name in ("Webhook", "Edit Fields", "Respond to Webhook"):
        expect(page.locator(f'[data-wf-node="{name}"]')).to_be_visible(timeout=20_000)
    check(f"{tag} template opens in the editor with its three nodes", True)

    # Webhook node: test URL + Listen + a real call answered through the worker.
    page.locator('[data-wf-node="Webhook"]').dblclick()
    panel = page.get_by_role("dialog", name="Node Webhook")
    panel.wait_for()
    test_code = panel.locator("code", has_text="/api/hooks-test/")
    url = test_code.inner_text().split(" ", 1)[1].strip()
    check(f"{tag} webhook panel shows the test URL", "/api/hooks-test/" in url and url.endswith("/hello"), url)
    panel.get_by_role("button", name="Listen for a test call").click()
    status, headers, answer = 0, {}, None
    for _ in range(40):
        status, headers, answer = post(url, {"name": "Ada"}, {"cookie": "sk_session=stolen-session-cookie"})
        if status != 404:
            break
        time.sleep(0.25)
    check(f"{tag} test call answered by Respond to Webhook", status == 200 and answer == {"greeting": "Hello Ada!"}, (status, answer))
    csp = headers.get("Content-Security-Policy") or headers.get("content-security-policy") or ""
    check(f"{tag} webhook answers are sandboxed, set no cookie", csp.startswith("sandbox") and not any(k.lower() == "set-cookie" for k in headers), headers)
    panel.get_by_role("button", name="Close node panel").click()
    expect(page.locator('[data-wf-node="Respond to Webhook"] [role=status]')).to_have_text("1 item", timeout=20_000)
    check(f"{tag} canvas shows per-node item counts after the run", True)
    page.locator('[data-wf-node="Webhook"]').dblclick()
    page.get_by_role("dialog", name="Node Webhook").locator("section[aria-label=Output]").get_by_role("radio", name="JSON").click()
    out_text = page.get_by_role("dialog", name="Node Webhook").locator("section[aria-label=Output] pre").inner_text()
    check(f"{tag} the caller's cookie never reaches the run", "stolen-session-cookie" not in out_text and "Ada" in out_text, out_text[:300])
    page.get_by_role("button", name="Close node panel").click()

    # Activate (nothing changed since the template was saved), production URL, history.
    check(f"{tag} Save is off while nothing changed", page.get_by_role("button", name="Save", exact=True).is_disabled())
    # The switch flips once the server confirmed the activation.
    page.get_by_role("switch", name="Active").click()
    expect(page.get_by_text("Saved and activated", exact=False)).to_be_visible(timeout=15_000)
    expect(page.get_by_role("switch", name="Active")).to_be_checked()
    prod = url.replace("/api/hooks-test/", "/api/hooks/")
    status, _, answer = post(prod, {"name": "Grace"})
    check(f"{tag} production URL answers once active", status == 200 and answer == {"greeting": "Hello Grace!"}, (status, answer))
    page.get_by_role("button", name="Runs").click()
    history = page.get_by_role("list", name="Run history")
    expect(history.locator("li")).to_have_count(2, timeout=15_000)
    check(f"{tag} run history lists the test and production runs", True)
    page.get_by_role("button", name="Close Runs").click()

    # Node picker: search + Enter adds and opens a node.
    page.get_by_role("button", name="Add a node").click()
    search = page.get_by_role("textbox", name="Search nodes")
    search.fill("http req")
    search.press("Enter")
    http_panel = page.get_by_role("dialog", name="Node HTTP Request")
    check(f"{tag} picker adds the searched node and opens it", http_panel.is_visible() or http_panel.wait_for(timeout=10_000) is None)
    http_panel.get_by_role("button", name="Close node panel").click()
    expect(page.get_by_text("Unsaved", exact=True)).to_be_visible()
    page.get_by_role("button", name="Save", exact=True).click()
    expect(page.get_by_text("Saved.", exact=True)).to_be_visible(timeout=15_000)

    # A code template, run from the editor.
    page.get_by_role("button", name="← Workflows").click()
    open_template(page, "Transform data with code")
    page.locator('[data-wf-node="Code"]').wait_for(timeout=60_000)
    page.get_by_role("button", name="Run workflow").click()
    expect(page.get_by_text("Last run: success")).to_be_visible(timeout=60_000)
    page.locator('[data-wf-node="Code"]').dblclick()
    code_panel = page.get_by_role("dialog", name="Node Code")
    code_panel.locator("[data-code-editor=javascript] .cm-content").wait_for(timeout=20_000)
    output = code_panel.locator("section[aria-label=Output]")
    check(f"{tag} Code node output shows its fields", "active" in output.inner_text() and "names" in output.inner_text(), output.inner_text()[:300])
    check(f"{tag} the code editor (CodeMirror) is there", code_panel.locator(".cm-gutters").count() > 0)
    code_panel.get_by_role("button", name="Close node panel").click()

    # A change saved elsewhere (the assistant, MCP, another tab) appears in the open editor by itself.
    wf_id = page.url.split("workflow=")[1].split("&")[0]
    with urllib.request.urlopen(f"{base}/api/workflows/{wf_id}", timeout=30) as resp:
        stored = json.loads(resp.read().decode())["workflow"]
    renamed = {"version": stored["version"], "name": f"Renamed by the assistant {browser_name}"}
    req = urllib.request.Request(f"{base}/api/workflows/{wf_id}", data=json.dumps(renamed).encode(), method="PUT", headers={"content-type": "application/json", "Origin": base})
    with urllib.request.urlopen(req, timeout=30) as resp:
        check(f"{tag} saved from outside", resp.status == 200)
    expect(page.get_by_label("Workflow name")).to_have_value(renamed["name"], timeout=15_000)
    check(f"{tag} the open editor picks up the outside change", True)

    # An AI node with the account's saved provider profile (the mock provider), run from the editor.
    page.get_by_role("button", name="← Workflows").click()
    open_template(page, "Ask AI about each item")
    page.locator('[data-wf-node="Ask AI"]').wait_for(timeout=60_000)
    page.locator('[data-wf-node="Ask AI"]').dblclick()
    ai_panel = page.get_by_role("dialog", name="Node Ask AI")
    expect(ai_panel.get_by_label("Provider profile")).to_contain_text("mock-model", timeout=15_000)
    ai_panel.get_by_role("button", name="Run up to here").click()
    expect(ai_panel.locator("section[aria-label=Output]")).to_contain_text("ECHO: Summarize in five words", timeout=60_000)
    check(f"{tag} AI node answers through the saved provider profile (profile picker lists it)", True)
    ai_panel.get_by_role("button", name="Close node panel").click()

    # Credentials: saved, listed, the secret never comes back.
    page.goto(f"{base}/tools/workflows?tab=credentials", wait_until="domcontentloaded")
    hydrated(page)
    page.get_by_role("button", name="New credential").first.click()
    form = page.get_by_role("form", name="New credential")
    form.get_by_label("Name", exact=True).fill(f"My API key {browser_name}")
    form.get_by_label("Header name *").fill("X-Api-Key")
    form.get_by_label("Value *").fill("secret-value-0123456789")
    form.get_by_role("button", name="Save credential").click()
    expect(page.get_by_role("list", name="Credentials").get_by_text(f"My API key {browser_name}")).to_be_visible(timeout=15_000)
    check(f"{tag} credential saved and listed", True)
    check(f"{tag} the secret never comes back to the page", "secret-value-0123456789" not in page.content())

    # One full-window page: no tool heading/tabs, sidebar hidden from the first paint, no page scroll; node list, canvas
    # tools and credentials inside the editor.
    page.goto(f"{base}/tools/workflows", wait_until="commit")
    page.wait_for_selector("aside[data-sidebar]", state="attached")
    first = page.evaluate("() => getComputedStyle(document.querySelector('aside[data-sidebar]')).display")
    hydrated(page)
    open_template(page, "Blank")
    page.wait_for_timeout(800)
    box = page.evaluate("""() => { const e = document.querySelector('[data-workflow-editor]').getBoundingClientRect(); const m = document.querySelector('main');
        return { first: null, sidebar: getComputedStyle(document.querySelector('aside[data-sidebar]')).display, header: getComputedStyle(m.querySelector(':scope > header')).display,
                 tabs: getComputedStyle(m.querySelector('.sk-tablist')).display, scroll: document.documentElement.scrollHeight - innerHeight, top: Math.round(e.top), bottom: Math.round(e.bottom), vh: innerHeight }; }""")
    check(f"{tag} workspace: sidebar hidden from the first paint, no heading/tabs, editor fills the window without page scroll",
          first == "none" and box["sidebar"] == "none" and box["header"] == "none" and box["tabs"] == "none" and box["scroll"] <= 0 and box["top"] <= 80 and box["vh"] - 16 <= box["bottom"] <= box["vh"], {**box, "first": first})
    page.keyboard.press("b")
    check(f"{tag} the sidebar toggle shows the sidebar for the visit", page.evaluate("() => getComputedStyle(document.querySelector('aside[data-sidebar]')).display") == "block")
    page.keyboard.press("b")
    nodes = page.locator(".react-flow__node")
    edges = page.locator(".react-flow__edge")
    start_nodes, start_edges = nodes.count(), edges.count()
    nodes.first.click()
    page.locator("[data-node-palette]").get_by_role("button", name="Code", exact=True).click()
    code_panel = page.get_by_role("dialog", name="Node Code")
    code_panel.wait_for()
    page.keyboard.press("Escape")
    expect(code_panel).to_be_hidden(timeout=5_000)
    check(f"{tag} node list adds the node after the selected one (connected) and Escape closes its panel", nodes.count() == start_nodes + 1 and edges.count() == start_edges + 1, (nodes.count(), edges.count()))
    tools = page.get_by_role("toolbar", name="Canvas tools")
    tools.get_by_role("button", name="Undo (Ctrl Z)").click()
    after_undo = nodes.count()
    page.keyboard.press("Control+Shift+Z")
    expect(nodes).to_have_count(start_nodes + 1, timeout=5_000)
    check(f"{tag} undo removes the added node, Ctrl Shift Z brings it back", after_undo == start_nodes, after_undo)
    page.locator('[data-wf-node="Code"]').click()
    tools.get_by_role("button", name="Duplicate the selected nodes (Ctrl D)").click()
    expect(nodes).to_have_count(start_nodes + 2, timeout=5_000)
    tools.get_by_role("button", name="Delete the selection (Delete)").click()
    expect(nodes).to_have_count(start_nodes + 1, timeout=5_000)
    tools.get_by_role("button", name="Tidy up (arrange the nodes)").click()
    check(f"{tag} duplicate, delete and tidy up work from the canvas toolbar", True)
    page.get_by_role("button", name="Credentials", exact=True).click()
    drawer = page.get_by_role("dialog", name="Credentials")
    expect(drawer.get_by_text(f"My API key {browser_name}")).to_be_visible(timeout=15_000)
    check(f"{tag} credentials open inside the editor (drawer lists the saved one)", True)
    drawer.get_by_role("button", name="Close Credentials").click()


def main() -> int:
    with ScratchServer() as server:
        server.start(env={"KNIFE_WF_SCHEDULER": "off"})
        print(f"scratch server {server.url} data {server.data_dir}", flush=True)
        import socket
        import subprocess
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            mock_port = sock.getsockname()[1]
        mock = subprocess.Popen(["node", str(ROOT / "tests" / "mock_provider.mjs"), str(mock_port)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(50):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{mock_port}/v1/models", timeout=2).read()
                break
            except OSError:
                time.sleep(0.1)
        req = urllib.request.Request(f"{server.url}/api/account/provider", data=json.dumps({"baseUrl": f"http://127.0.0.1:{mock_port}/v1", "model": "mock-model", "apiKey": "mock-key"}).encode(), method="PUT", headers={"content-type": "application/json", "Origin": server.url})
        urllib.request.urlopen(req, timeout=30).read()
        for path in ("/tools/workflows", "/api/workflows", "/tools/workflows?tab=credentials"):
            try:
                urllib.request.urlopen(server.url + path, timeout=180).read()
            except urllib.error.HTTPError:
                pass
        with sync_playwright() as pw:
            for name in ("firefox", "chromium"):
                browser = getattr(pw, name).launch(headless=not HEADED)
                context = browser.new_context(viewport={"width": 1440, "height": 900})
                page = context.new_page()
                errors: list[str] = []
                # A dev server recompiles a lazy chunk on its first use, so the page's preload of the old chunk name
                # 404s (Turbopack dev only; the production build is checked by prod_smoke). Every other 4xx/5xx counts.
                dev_chunk = lambda text: "/_next/static/chunks/" in text  # noqa: E731
                page.on("console", lambda msg: msg.type == "error" and not (msg.text.startswith("Failed to load resource") and dev_chunk(msg.location.get("url", ""))) and errors.append(msg.text))
                page.on("pageerror", lambda exc: errors.append(str(exc)))
                page.on("response", lambda resp: resp.status >= 400 and not (resp.status == 404 and dev_chunk(resp.url)) and errors.append(f"HTTP {resp.status} {resp.request.method} {resp.url}"))
                try:
                    run(page, server.url, name)
                    check(f"[{name}] no console or page errors", not errors, errors[:5])
                except Exception:  # noqa: BLE001
                    traceback.print_exc()
                    FAILS.append(f"[{name}] crashed: " + traceback.format_exc().strip().splitlines()[-1])
                    page.screenshot(path=f"/tmp/workflows-e2e-{name}.png", full_page=True)
                    print(server.log_tail(3000))
                finally:
                    context.close()
                    browser.close()
        mock.kill()
    print(f"\n{PASSES} passed, {len(FAILS)} failed")
    if FAILS:
        print(f"{len(FAILS)} FAILED: {FAILS}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
