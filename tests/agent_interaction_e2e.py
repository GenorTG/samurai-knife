"""Trust modes, wait-for-user and no-reload navigation (real browser, scripted mock provider).

  node tests/mock_provider.mjs 3299
  KNIFE_DATA_DIR=$(mktemp -d) KNIFE_PORT=3235 npm run dev
  python3 tests/agent_interaction_e2e.py http://127.0.0.1:3235 http://127.0.0.1:3299
"""
import json
import sys
import tempfile
import urllib.request
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

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


def key(page: Page) -> str:
    return page.evaluate("fetch('/api/account').then(r => r.json()).then(a => `sk.agent.chat.v1.${a.id}:${encodeURIComponent(a.provider?.baseUrl ?? '')}:${encodeURIComponent(a.provider?.model ?? '')}`)")


def msgs(page: Page, k: str) -> list[dict]:
    return json.loads(page.evaluate("k => localStorage.getItem(k) || '[]'", k))


def tool_results(page: Page, k: str, name: str) -> list[dict]:
    ms = msgs(page, k)
    ids = {c["id"] for m in ms if m["role"] == "assistant" for c in m.get("tool_calls", []) if c["function"]["name"] == name}
    out = []
    for m in ms:
        if m["role"] == "tool" and m["tool_call_id"] in ids:
            try:
                out.append(json.loads(m["content"]))
            except ValueError:
                pass
    return out


def send(page: Page, text: str) -> None:
    box = page.locator("textarea[aria-label='Message the assistant']")
    box.fill(text)
    box.press("Enter")


def idle(page: Page, k: str, n_user: int) -> None:
    page.wait_for_function(
        """([k, n]) => { const m = JSON.parse(localStorage.getItem(k) || '[]');
           if (m.filter(x => x.role === 'user').length < n) return false;
           const l = m[m.length - 1]; return (l.role === 'assistant' && !l.tool_calls) || l.role === 'notice'; }""",
        arg=[k, n_user], timeout=30_000)


put_provider()
with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    ctx.add_init_script("localStorage.setItem('sk.agent.mode.v1', 'standard')")
    page = ctx.new_page()
    page.on("console", lambda m: errors.append(m.text[:200]) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)[:200]))
    page.goto(BASE + "/tools/ids", wait_until="networkidle")
    page.keyboard.press("Control+j")
    page.wait_for_selector("[role=dialog][aria-label='Toolbox assistant']")
    k = key(page)
    check("mode switch shows Most selected", page.locator("[aria-label='Ask before acting'] [role=radio][aria-checked=true]").inner_text() == "Most")

    # --- Ask mode: deny, then allow -------------------------------------------------------------
    send(page, 'CALL:open_tool:{"slug":"qr"}')
    page.wait_for_selector("[data-agent-approval]")
    check("approval names the destination", "Open QR" in page.locator("[data-agent-approval]").inner_text(), page.locator("[data-agent-approval]").inner_text())
    check("pill flags that the assistant needs an OK", page.locator("[data-agent-pill='approval']").count() == 1)
    check("page unchanged while waiting for approval", page.url.endswith("/tools/ids"), page.url)
    page.get_by_role("button", name="Deny").click()
    idle(page, k, 1)
    res = tool_results(page, k, "open_tool")
    check("denied call returns a 'declined' result", len(res) == 1 and res[0].get("ok") is False and "declined" in res[0].get("error", ""), res)
    check("page still unchanged after deny", page.url.endswith("/tools/ids"), page.url)

    send(page, 'CALL:open_tool:{"slug":"qr"}')
    page.wait_for_selector("[data-agent-approval]")
    page.evaluate("window.__noReloadProbe = 42")
    page.get_by_role("button", name="Allow", exact=True).click()
    page.wait_for_url("**/tools/qr", timeout=20_000)
    idle(page, k, 2)
    check("allowed navigation happened", True)
    check("agent navigation did not reload the page", page.evaluate("window.__noReloadProbe") == 42)
    check("assistant panel + chat survived the page switch", page.locator("[role=dialog][aria-label='Toolbox assistant']").is_visible() and len(msgs(page, k)) >= 4)

    # Approving a navigation covers operating that page: no second prompt for page_snapshot/click on it.
    send(page, 'CALL:page_snapshot:{}')
    idle(page, k, 3)
    check("read-only tools never prompt in Ask mode", page.locator("[data-agent-approval]").count() == 0)

    # --- Wait for user -----------------------------------------------------------------------------
    page.goto(BASE + "/tools/ids", wait_until="networkidle")
    page.wait_for_selector("[role=dialog][aria-label='Toolbox assistant']")
    send(page, 'CALL:page_snapshot:{}')
    idle(page, k, 4)
    file_id = page.evaluate("document.querySelector('main input[type=file]').getAttribute('data-agent-id')")
    check("snapshot tagged the file input", bool(file_id), file_id)

    send(page, 'CALL:wait_for_user:{"message":"Choose the file to hash","id":"%s"}' % file_id)
    page.wait_for_selector("[data-agent-wait]")
    check("wait card shows the request", "Choose the file to hash" in page.locator("[data-agent-wait]").inner_text())
    check("target control pulses on the page", page.locator("main input[type=file][data-agent-await]").count() == 1)
    check("pill says it is waiting for the user", page.locator("[data-agent-pill='wait']").count() == 1)
    tmp = Path(tempfile.mkdtemp()) / "mine.txt"
    tmp.write_text("my real data " * 20)
    page.set_input_files("main input[type=file]", str(tmp))
    idle(page, k, 5)
    res = tool_results(page, k, "wait_for_user")
    check("run resumed by itself after the upload", res and res[-1].get("resumed_by") == "upload", res)
    check("pulse removed after resume", page.locator("[data-agent-await]").count() == 0)

    send(page, 'CALL:wait_for_user:{"message":"Which format do you want?"}')
    page.wait_for_selector("[data-agent-wait]")
    send(page, "gzip please")
    idle(page, k, 6)
    res = tool_results(page, k, "wait_for_user")
    check("a chat reply resumes the wait and is passed along", res[-1].get("resumed_by") == "message" and res[-1].get("user_said") == "gzip please", res[-1])

    send(page, 'CALL:wait_for_user:{"message":"Tell me when you are ready"}')
    page.wait_for_selector("[data-agent-wait]")
    page.get_by_role("button", name="Continue", exact=True).click()
    idle(page, k, 7)
    check("Continue resumes the wait", tool_results(page, k, "wait_for_user")[-1].get("resumed_by") == "continue")

    send(page, 'CALL:wait_for_user:{"message":"never mind"}')
    page.wait_for_selector("[data-agent-wait]")
    page.get_by_role("button", name="Cancel run").click()
    page.wait_for_selector("[data-agent-wait]", state="detached", timeout=10_000)
    check("Cancel run ends a wait", True)

    # --- "Allow rest of this run" skips later non-destructive prompts, mode unchanged -----------
    page.goto(BASE + "/tools/text", wait_until="networkidle")  # a clean page: nothing of mine to lose
    page.wait_for_selector("[role=dialog][aria-label='Toolbox assistant']")
    send(page, 'CALL:open_tool:{"slug":"json"}\nCALL:open_tool:{"slug":"qr"}')  # mock: one CALL per line
    page.wait_for_selector("[data-agent-approval]")
    page.get_by_role("button", name="Allow rest of this run").click()
    page.wait_for_url("**/tools/qr", timeout=20_000)
    idle(page, k, 9)
    check("allow-rest-of-run covered the second navigation", page.locator("[data-agent-approval]").count() == 0)
    check("mode is still Most afterwards", page.locator("[aria-label='Ask before acting'] [role=radio][aria-checked=true]").inner_text() == "Most")
    browser.close()

check("zero console errors", not errors, errors[:3])
print("\nall checks passed" if not failures else f"\n{len(failures)} FAILED: {failures}")
sys.exit(1 if failures else 0)
