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
import re
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
    # A service node: the picker finds it, its operation picks the fields, and a run without a credential says so.
    page.get_by_role("button", name="Add a node").click()
    search = page.get_by_role("textbox", name="Search nodes")
    search.fill("github")
    search.press("Enter")
    gh_panel = page.get_by_role("dialog", name="Node GitHub")
    gh_panel.wait_for(timeout=10_000)
    operation = gh_panel.get_by_label("Operation", exact=True)
    labels = operation.evaluate("(el) => [...el.options].map((o) => o.textContent)")
    check(f"{tag} GitHub node lists its operations", "Create an issue" in labels and "List repository issues" in labels, labels)
    operation.select_option("createIssue")
    gh_panel.get_by_label("Repository owner", exact=True).fill("octo")
    gh_panel.get_by_label("Repository", exact=True).fill("demo")
    check(f"{tag} createIssue shows its own fields", gh_panel.get_by_label("Title", exact=True).count() == 1)
    check(f"{tag} the service node asks for its connection (credential slot)", gh_panel.get_by_text(re.compile(r"GitHub connection", re.I)).count() > 0)
    gh_panel.get_by_role("button", name="Close node panel").click()
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
    # The tab's own buttons hydrate after <main>: click only once React owns the button.
    page.wait_for_function("() => [...document.querySelectorAll('main button')].some((b) => b.textContent.trim() === 'New credential' && Object.keys(b).some((k) => k.startsWith('__reactProps')))", timeout=60_000)
    page.get_by_role("button", name="New credential").first.click()
    form = page.get_by_role("form", name="New credential")
    form.get_by_label("Name", exact=True).fill(f"My API key {browser_name}")
    form.get_by_label("Header name *").fill("X-Api-Key")
    form.get_by_label("Value *").fill("secret-value-0123456789")
    form.get_by_role("button", name="Save credential").click()
    expect(page.get_by_role("list", name="Credentials").get_by_text(f"My API key {browser_name}")).to_be_visible(timeout=15_000)
    check(f"{tag} credential saved and listed", True)
    check(f"{tag} the secret never comes back to the page", "secret-value-0123456789" not in page.content())

    # Service recipes must populate the actual saved values, not just their visual placeholders.
    page.get_by_role("button", name="New credential").first.click()
    form = page.get_by_role("form", name="New credential")
    form.get_by_label("Service setup").select_option("slack")
    expect(form.get_by_label(re.compile(r"^Type"))).to_have_value("oAuth2Api")
    expect(form.get_by_label(re.compile(r"^Scopes"))).to_have_value("chat:write,channels:read")
    expect(form.get_by_label("Send client credentials")).to_have_value("header")
    check(f"{tag} service recipe shows provider setup and callback", "Register an app" in form.inner_text() and "/api/workflows/oauth/callback" in form.inner_text())
    form.get_by_label("Name", exact=True).fill(f"Slack setup {browser_name}")
    form.get_by_label("Client ID *").fill("scratch-client-id")
    form.get_by_label("Client secret *").fill("scratch-client-secret")
    form.get_by_role("button", name="Save credential").click()
    entry = page.get_by_role("list", name="Credentials").locator("li").filter(has_text=f"Slack setup {browser_name}")
    expect(entry).to_contain_text("Not connected", timeout=15_000)
    entry.get_by_role("button", name="Edit", exact=True).click()
    edit_form = page.get_by_role("form", name=f"Edit credential Slack setup {browser_name}")
    expect(edit_form.get_by_label(re.compile(r"^Token URL"))).to_have_value("https://slack.com/api/oauth.v2.access")
    expect(edit_form.get_by_label("Send client credentials")).to_have_value("header")
    check(f"{tag} service recipe persisted defaults and keeps client secret hidden", "scratch-client-secret" not in page.content())
    edit_form.get_by_role("button", name="Cancel", exact=True).click()

    page.get_by_role("button", name="New credential").first.click()
    form = page.get_by_role("form", name="New credential")
    form.get_by_label("Service setup").select_option("notion")
    expect(form.get_by_label("Send client credentials")).to_have_value("header")
    expect(form.get_by_label(re.compile(r"^Token URL"))).to_have_value("https://api.notion.com/v1/oauth/token")
    check(f"{tag} Notion recipe provides page-sharing guidance", "select/share pages" in form.inner_text())
    form.get_by_label(re.compile(r"^Type")).select_option("httpHeaderAuth")
    expect(form.get_by_label("Header name *")).to_have_value("")
    expect(form.get_by_label("Value *")).to_have_value("")
    check(f"{tag} changing credential type clears service fields", form.get_by_label("Service setup").input_value() == "")
    form.get_by_role("button", name="Cancel", exact=True).click()

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

    # Mouse and keys: right-click menus (canvas, node, connection), double-click and Tab open the picker, middle-drag
    # pans, D deactivates, copy/paste through the clipboard events.
    pane = page.locator(".react-flow__pane")
    pane.click(button="right", position={"x": 500, "y": 600})
    canvas_menu = page.get_by_role("menu", name="Canvas")
    canvas_menu.get_by_role("menuitem", name="Add a node here…").click()
    picker = page.get_by_role("dialog", name="Add a node")
    picker.get_by_label("Search nodes").fill("sort")
    picker.get_by_label("Search nodes").press("Enter")
    page.get_by_role("dialog", name="Node Sort").wait_for()
    page.keyboard.press("Escape")
    check(f"{tag} right-click on the canvas: Add a node here opens the picker and adds the node", page.locator('[data-wf-node="Sort"]').count() == 1)
    page.locator('[data-wf-node="Sort"]').click(button="right")
    node_menu = page.get_by_role("menu", name="Node Sort")
    check(f"{tag} right-click on a node shows its menu (open, run, add after, duplicate, copy, deactivate, delete)",
          all(node_menu.get_by_role("menuitem", name=n).count() for n in ("Open", "Run up to this node", "Add a node after…", "Duplicate", "Copy", "Deactivate", "Delete")))
    node_menu.get_by_role("menuitem", name="Deactivate").click()
    off = page.locator('[data-wf-node="Sort"] .line-through').count() == 1
    page.locator('[data-wf-node="Sort"]').click()
    page.keyboard.press("d")
    check(f"{tag} Deactivate from the menu, D activates again", off and page.locator('[data-wf-node="Sort"] .line-through').count() == 0)
    page.keyboard.press("Escape")
    edge = page.locator(".react-flow__edge").first
    edge_box = edge.locator("path").first.bounding_box()
    before_nodes = page.locator(".react-flow__node").count()
    page.mouse.click(edge_box["x"] + edge_box["width"] / 2, edge_box["y"] + edge_box["height"] / 2, button="right")
    conn_menu = page.get_by_role("menu", name="Connection")
    conn_menu.get_by_role("menuitem", name="Add a node in between…").click()
    picker.get_by_label("Search nodes").fill("limit")
    picker.get_by_label("Search nodes").press("Enter")
    page.get_by_role("dialog", name="Node Limit").wait_for()
    page.keyboard.press("Escape")
    check(f"{tag} right-click on a connection: Add a node in between splits it", page.locator(".react-flow__node").count() == before_nodes + 1 and page.locator('[data-wf-node="Limit"]').count() == 1)
    pane_box = pane.bounding_box()
    page.mouse.dblclick(pane_box["x"] + pane_box["width"] - 140, pane_box["y"] + 80)  # top right: clear of nodes, toolbar and minimap
    picker.wait_for()
    check(f"{tag} double-click on the canvas opens the picker", True)
    page.keyboard.press("Escape")
    page.locator('[data-wf-node="Limit"]').click()
    page.keyboard.press("Tab")
    picker.wait_for()
    check(f"{tag} Tab opens the picker after the selected node", True)
    page.keyboard.press("Escape")
    vp = lambda: page.locator(".react-flow__viewport").evaluate("e => e.style.transform")
    t0 = vp()
    page.mouse.move(1200, 500)
    page.mouse.down(button="middle")
    page.mouse.move(1100, 420, steps=6)
    page.mouse.up(button="middle")
    check(f"{tag} middle-button drag pans the canvas", vp() != t0, (t0, vp()))
    count = page.locator(".react-flow__node").count()
    page.locator('[data-wf-node="Limit"]').click()
    page.keyboard.press("Control+c")
    page.keyboard.press("Control+v")
    expect(page.locator(".react-flow__node")).to_have_count(count + 1, timeout=5_000)
    check(f"{tag} Ctrl C / Ctrl V copies and pastes the node", page.locator('[data-wf-node="Limit1"]').count() == 1, page.locator(".react-flow__node").all_inner_texts()[:8])
    pane_box = pane.bounding_box()
    page.mouse.click(pane_box["x"] + pane_box["width"] - 140, pane_box["y"] + 80, button="right")
    page.get_by_role("menu", name="Canvas").get_by_role("menuitem", name="Keyboard and mouse…").click()
    expect(page.get_by_role("dialog", name="Keyboard and mouse").get_by_text("Right-click")).to_be_visible()
    page.get_by_role("dialog", name="Keyboard and mouse").get_by_role("button", name="Close Keyboard and mouse").click()
    check(f"{tag} the keyboard and mouse list opens from the canvas menu", True)


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
