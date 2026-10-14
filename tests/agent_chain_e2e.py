"""Tool-output chaining: a file one tool produces is handed to the next tool by id, never as bytes through the model.

QR (text -> Download PNG) -> File compressor (upload_file from_file -> Compress -> .gz). Independent oracles:
the PNG Playwright really downloaded, the bytes the compressor's file input holds, and the gunzipped result.
Default trust mode (Risky) stays on, so the chain must also run without any approval prompt.

  node tests/mock_provider.mjs 3299
  KNIFE_DATA_DIR=$(mktemp -d) KNIFE_PORT=3237 npm run dev
  python3 tests/agent_chain_e2e.py http://127.0.0.1:3237 http://127.0.0.1:3299
"""
import gzip
import json
import sys
import urllib.request
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

BASE, MOCK = sys.argv[1].rstrip("/"), sys.argv[2].rstrip("/")
failures: list[str] = []
errors: list[str] = []
n_user = 0


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


def tool_results(page: Page, k: str, name: str) -> list[dict]:
    ms = json.loads(page.evaluate("k => localStorage.getItem(k) || '[]'", k))
    ids = {c["id"] for m in ms if m["role"] == "assistant" for c in m.get("tool_calls", []) if c["function"]["name"] == name}
    out = []
    for m in ms:
        if m["role"] == "tool" and m["tool_call_id"] in ids:
            try:
                out.append(json.loads(m["content"]))
            except ValueError:
                pass
    return out


def run(page: Page, k: str, text: str) -> str:
    """Send a prompt, wait for the run to finish; 'asked:<title>' (and deny) if an approval card shows up, else 'ran'."""
    global n_user
    n_user += 1
    box = page.locator("textarea[aria-label='Message the assistant']")
    box.fill(text)
    box.press("Enter")
    done = """([k, n]) => { const m = JSON.parse(localStorage.getItem(k) || '[]');
        if (m.filter(x => x.role === 'user').length < n) return false;
        const l = m[m.length - 1]; return (l.role === 'assistant' && !l.tool_calls) || l.role === 'notice'; }"""
    for _ in range(300):
        card = page.locator("[data-agent-approval]")
        if card.count():
            title = page.locator("[data-agent-approval] p").first.inner_text()
            page.get_by_role("button", name="Deny").click()
            page.wait_for_function(done, arg=[k, n_user], timeout=30_000)
            return "asked:" + title
        if page.evaluate(done, [k, n_user]):
            return "ran"
        page.wait_for_timeout(100)
    return "timeout"


def agent_id(page: Page, js_selector: str) -> str | None:
    return page.evaluate("s => document.querySelector(s)?.getAttribute('data-agent-id') ?? null", js_selector)


def button_id(page: Page, text: str) -> str | None:
    return page.evaluate(
        "t => Array.from(document.querySelectorAll('main button')).find(b => b.textContent.trim().startsWith(t))?.getAttribute('data-agent-id') ?? null",
        text,
    )


put_provider()
with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True).new_page()
    page.on("console", lambda m: errors.append(m.text[:200]) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)[:200]))
    page.goto(BASE + "/tools/qr", wait_until="networkidle")
    page.keyboard.press("Control+j")
    page.wait_for_selector("[role=dialog][aria-label='Toolbox assistant']")
    k = key(page)
    check("default trust mode is Risky", page.locator("[aria-label='Ask before acting'] [role=radio][aria-checked=true]").inner_text() == "Risky")

    # 1) QR produces a PNG download.
    run(page, k, "CALL:page_snapshot:{}")
    text_id = agent_id(page, "main textarea, main input[type=text], main input:not([type])")
    check("snapshot tagged the QR text field", bool(text_id), text_id)
    check("fill QR text", run(page, k, 'CALL:fill_field:{"id":"%s","value":"chain-test-0001"}' % text_id) == "ran")
    page.wait_for_timeout(600)
    run(page, k, "CALL:page_snapshot:{}")
    dl_id = button_id(page, "Download PNG")
    check("Download PNG button found", bool(dl_id), dl_id)
    with page.expect_download(timeout=20_000) as dl:
        check("click Download PNG", run(page, k, 'CALL:click:{"id":"%s"}' % dl_id) == "ran")
    png = Path(dl.value.path()).read_bytes()
    check("a real PNG was downloaded", png[:8] == b"\x89PNG\r\n\x1a\n" and len(png) > 100, len(png))
    clicks = tool_results(page, k, "click")
    produced = (clicks[-1].get("new_files") or []) if clicks else []
    check("click result announces the produced file", len(produced) == 1 and produced[0]["id"] == "f1" and produced[0]["name"].endswith(".png") and produced[0]["bytes"] == len(png), produced)

    # 2) Binary files can be handed over, not read as text.
    run(page, k, 'CALL:read_text:{"id":"f1"}')
    r = tool_results(page, k, "read_text")[-1]
    check("read_text refuses a binary file and points at from_file", r.get("ok") is False and "from_file" in r.get("error", ""), r)

    # 3) Chain: open the compressor (no approval: only the assistant's own input is on the QR page) and attach f1.
    check("opening the next tool does not ask", run(page, k, 'CALL:open_tool:{"slug":"file-compressor"}') == "ran")
    run(page, k, "CALL:page_snapshot:{}")
    snap = tool_results(page, k, "page_snapshot")[-1]
    check("snapshot lists the produced file", [f["id"] for f in snap.get("files", [])] == ["f1"], snap.get("files"))
    file_id = agent_id(page, "main input[type=file]")
    check("compressor file input found", bool(file_id), file_id)
    r = run(page, k, 'CALL:upload_file:{"id":"%s","from_file":"f1"}' % file_id)
    check("upload from_file ran", r == "ran", r)
    up = tool_results(page, k, "upload_file")[-1]
    check("upload result reports the original name and size", up.get("ok") is True and up.get("name") == produced[0]["name"] and up.get("bytes") == len(png), up)
    check("the compressor shows the produced file as its input", produced[0]["name"] in page.locator("main").inner_text())

    # 4) Run the second tool; its output is chainable too.
    run(page, k, "CALL:page_snapshot:{}")
    go_id = button_id(page, "Compress file")
    check("click Compress file", run(page, k, 'CALL:click:{"id":"%s"}' % go_id) == "ran")
    page.wait_for_selector("main button:has-text('Download')")
    run(page, k, "CALL:page_snapshot:{}")
    save_id = button_id(page, "Download")
    with page.expect_download(timeout=20_000) as dl2:
        check("click Download of the compressed file", run(page, k, 'CALL:click:{"id":"%s"}' % save_id) == "ran")
    gz = Path(dl2.value.path()).read_bytes()
    check("gunzipped output equals the original PNG", gzip.decompress(gz) == png)
    clicks = tool_results(page, k, "click")
    produced2 = (clicks[-1].get("new_files") or []) if clicks else []
    check("second tool's output announced as f2", len(produced2) == 1 and produced2[0]["id"] == "f2" and produced2[0]["name"].endswith(".gz"), produced2)

    # 5) Downloads from a detached anchor (PdfTool's extracted.txt does this) are captured too, and text files can be read.
    page.evaluate("""() => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['hello detached'], { type: 'text/plain' })); a.download = 'extracted.txt'; a.click(); }""")
    run(page, k, "CALL:page_snapshot:{}")
    files = tool_results(page, k, "page_snapshot")[-1].get("files", [])
    check("detached-anchor download is captured", files and files[-1]["name"] == "extracted.txt", files)
    run(page, k, 'CALL:read_text:{"id":"%s"}' % files[-1]["id"])
    txt = tool_results(page, k, "read_text")[-1]
    check("read_text returns a produced text file", txt.get("text") == "hello detached", txt)

    # 6) Unknown ids fail cleanly.
    r = run(page, k, 'CALL:upload_file:{"id":"%s","from_file":"f99"}' % file_id)
    bad = tool_results(page, k, "upload_file")[-1]
    check("unknown from_file is a clear error", bad.get("ok") is False and "f99" in bad.get("error", ""), bad)
    browser.close()

check("zero console errors", not errors, errors[:3])
print("\nall checks passed" if not failures else f"\n{len(failures)} FAILED: {failures}")
sys.exit(1 if failures else 0)
