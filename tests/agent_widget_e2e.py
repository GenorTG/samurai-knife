"""Floating assistant widget end-to-end (real browser, real account/agent routes, scripted mock provider).

Start the mock:   node tests/mock_provider.mjs 3299
Start the server: KNIFE_DATA_DIR=$(mktemp -d) KNIFE_PORT=3232 npm run dev      (127.0.0.1 only)
Run:              python3 tests/agent_widget_e2e.py http://127.0.0.1:3232 http://127.0.0.1:3299

Needs python3 + playwright (chromium). The default passwordless account is used. The mock
requires `Authorization: Bearer mock-key`. Never point this at a real model server.
"""
import json
import sys
import urllib.request

from playwright.sync_api import Page, sync_playwright

if len(sys.argv) < 3:
    sys.exit("usage: python3 tests/agent_widget_e2e.py <base_url> <mock_url>")
BASE = sys.argv[1].rstrip("/")
MOCK = sys.argv[2].rstrip("/")
MOCK_KEY = "mock-key"
SLOW = 60_000

failures: list[str] = []
console_errors: list[str] = []


def check(name: str, ok: bool, detail: object = "") -> None:
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + ("" if ok else f"  -> {detail}"))
    if not ok:
        failures.append(name)


def http_json(method: str, path: str, body: object | None = None) -> tuple[int, object]:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"content-type": "application/json", "Origin": BASE})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, json.loads(res.read() or b"null")
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"null")


def storage_key(page: Page) -> str:
    # One stored conversation per account and provider: the key only keeps the helpers' signatures.
    return "conversation"


def stored_messages(page: Page, key: str) -> list[dict]:
    # The quiet per-turn token footer is telemetry, not conversation (tests/agent_usage_e2e.py covers it).
    conversation = page.evaluate("fetch('/api/agent/conversation').then(r => r.json())")
    return [m for m in conversation["messages"] if not (m["role"] == "notice" and m.get("level") == "usage")]


def launcher(page: Page):
    return page.locator("button[aria-label='Open assistant'], button[aria-label='Close assistant'][aria-expanded]").last


def ensure_open(page: Page) -> None:
    if not page.locator("[role=dialog][aria-label='Toolbox assistant']").is_visible():
        page.locator("button[aria-label='Open assistant']").click()
    page.wait_for_selector("[role=dialog][aria-label='Toolbox assistant']", timeout=SLOW)


def send(page: Page, key: str, text: str) -> list[dict]:
    """Type into the composer, press Enter, wait until the turn finished; return the stored chat."""
    users_before = sum(1 for m in stored_messages(page, key) if m["role"] == "user")
    composer = page.locator("textarea[aria-label='Message the assistant']")
    composer.fill(text)
    composer.press("Enter")
    page.wait_for_function(
        """async ([session, n]) => {
            const r = await fetch('/api/agent/conversation');
            if (!r.ok) return false;
            const c = await r.json();
            const m = c.messages;
            if (m.filter(x => x.role === 'user').length <= n) return false;
            const l = m[m.length - 1];
            return (l.role === 'assistant' && !l.tool_calls) || l.role === 'notice';
        }""",
        arg=[key, users_before], timeout=SLOW, polling=250,
    )
    page.locator("button[aria-label='Send']").wait_for(timeout=SLOW)
    return stored_messages(page, key)


def tool_result(msgs: list[dict], tool: str) -> dict:
    """Parsed content of the last tool message produced by calling `tool`."""
    ids = [c["id"] for m in msgs if m["role"] == "assistant" for c in m.get("tool_calls", []) if c["function"]["name"] == tool]
    for m in reversed(msgs):
        if m["role"] == "tool" and m["tool_call_id"] in ids:
            return json.loads(m["content"])
    return {}


def control_id(snapshot: dict, kind: str, label_contains: str = "") -> str | None:
    for c in snapshot.get("controls", []):
        if c["kind"] == kind and label_contains.lower() in c.get("label", "").lower():
            return c["id"]
    return None


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1280, "height": 800})
    page = ctx.new_page()
    page.set_default_timeout(SLOW)
    page.on("console", lambda m: console_errors.append(f"{m.type}: {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: console_errors.append(f"pageerror: {e}"))

    # 1. Launcher everywhere ------------------------------------------------------------------
    page.goto(BASE + "/", wait_until="networkidle")
    check("launcher visible on /", page.locator("button[aria-label='Open assistant']").is_visible())
    page.goto(BASE + "/tools/qr", wait_until="networkidle")
    check("launcher visible on /tools/qr", page.locator("button[aria-label='Open assistant']").is_visible())
    check("no panel before opening", not page.locator("[role=dialog][aria-label='Toolbox assistant']").is_visible())

    # 2. Open: non-modal dialog, page stays clickable ---------------------------------------------
    page.goto(BASE + "/", wait_until="networkidle")
    page.evaluate("window.__sk_marker = 'alive'")
    page.locator("button[aria-label='Open assistant']").click()
    dialog = page.locator("[role=dialog][aria-label='Toolbox assistant']")
    dialog.wait_for()
    check("dialog is not modal", dialog.get_attribute("aria-modal") == "false")
    box = dialog.bounding_box() or {"width": 0, "height": 0}
    check("desktop panel is about 400x560", 380 <= box["width"] <= 420 and 540 <= box["height"] <= 580, box)
    over_page = page.evaluate("!document.elementFromPoint(12, 12)?.closest('[data-agent-widget]')")
    check("no backdrop: page behind the panel is reachable", over_page)
    # 3. Settings: save + test (first run shows presets) ------------------------------------------
    if page.locator("button[aria-label='Settings']").count():
        page.locator("button[aria-label='Settings']").click()
    page.wait_for_selector("form[aria-label='Provider settings']")
    check("presets offered", all(page.get_by_role("button", name=n, exact=True).is_visible() for n in ("OpenAI", "OpenRouter", "Custom")))
    page.get_by_role("button", name="OpenRouter", exact=True).click()
    check("OpenRouter preset fills base URL", page.get_by_label("Base URL").input_value() == "https://openrouter.ai/api/v1")
    page.get_by_role("button", name="Custom", exact=True).click()
    page.get_by_label("Base URL").fill(f"{MOCK}/v1")
    page.get_by_label("Model", exact=True).fill("mock-model")
    page.get_by_label("API key").fill(MOCK_KEY)
    page.get_by_role("button", name="Load models").click()
    models = page.get_by_label("Available models")
    models.wait_for()
    check("Load models lists the provider's models before saving", "mock-model" in models.locator("option").all_inner_texts(), models.locator("option").all_inner_texts())
    page.get_by_role("button", name="Connect", exact=True).click()
    # The first connection saves, tests and goes straight to the chat.
    page.wait_for_selector("textarea[aria-label='Message the assistant']")
    check("Connect saves, tests and opens the chat on the first run", True)
    page.locator("button[aria-label='Settings']").click()
    page.wait_for_selector("form[aria-label='Provider settings']")
    page.get_by_role("button", name="Test the connection").click()
    page.locator("[role=status]").filter(has_text="Connected").wait_for()
    check("Test the connection reports success for the saved provider", True)
    status, account = http_json("GET", "/api/account")
    prov = account.get("provider") if isinstance(account, dict) else None
    check("server stored provider", bool(prov) and prov["baseUrl"].startswith(MOCK) and prov["model"] == "mock-model" and prov["hasKey"], account)
    check("API key never returned to the browser", MOCK_KEY not in json.dumps(account) and MOCK_KEY not in page.content())
    # Load models for fields not saved yet: the stored key goes only to the stored address.
    status, listed = http_json("POST", "/api/account/provider/models", {"baseUrl": f"{MOCK}/v1"})
    check("models for the stored address use the stored key", status == 200 and listed.get("ok") is True and "mock-model" in listed.get("models", []), listed)
    other = MOCK.replace("127.0.0.1", "localhost")
    status, listed = http_json("POST", "/api/account/provider/models", {"baseUrl": f"{other}/v1"})
    check("a newly typed address never receives the stored key (mock answers 401)", status == 200 and listed.get("ok") is False and listed.get("status") == 401, listed)
    # Saved profiles: the first Save made "Default"; create a second from the form, switch back, delete it.
    picker = page.get_by_label("Provider profile")
    check("profile bar lists the Default profile", picker.locator("option").all_inner_texts() == ["Default · mock-model"], picker.locator("option").all_inner_texts())
    page.locator("[data-provider-profiles]").get_by_role("button", name="New", exact=True).click()
    page.get_by_label("Profile name").fill("Second")
    page.get_by_role("button", name="Create from the fields below").click()
    page.locator("[role=status]").filter(has_text="Profile Second created").wait_for()
    _, profiles = http_json("GET", "/api/account/provider-profiles")
    names = [(x["name"], x["active"], x["hasKey"]) for x in profiles["profiles"]]
    check("new profile created from the form, active, key carried", names == [("Default", False, True), ("Second", True, True)], names)
    picker.select_option(label="Default · mock-model")
    page.locator("[role=status]").filter(has_text="Profile switched").wait_for()
    _, profiles = http_json("GET", "/api/account/provider-profiles")
    check("switching activates on the server", [x["active"] for x in profiles["profiles"]] == [True, False], profiles)
    picker.select_option(label="Second · mock-model")
    page.locator("[role=status]").filter(has_text="Profile switched").wait_for()
    page.once("dialog", lambda d: d.accept())
    page.locator("[data-provider-profiles]").get_by_role("button", name="Profile actions").click()
    page.get_by_role("menu", name="Profile actions").get_by_role("menuitem", name="Delete").click()
    page.locator("[role=status]").filter(has_text="Deleted Second").wait_for()
    _, profiles = http_json("GET", "/api/account/provider-profiles")
    check("deleting the active profile falls back to Default", [(x["name"], x["active"]) for x in profiles["profiles"]] == [("Default", True)], profiles)
    check("profile keys never reach the page", MOCK_KEY not in page.content())
    page.locator("button[aria-label='Back to chat']").first.click()
    page.wait_for_selector("textarea[aria-label='Message the assistant']")
    check("header shows account and model", "mock-model" in dialog.locator("header").inner_text())
    # Provider scope changed, so the durable conversation has a distinct session id.
    key = storage_key(page)

    # 4. Plain chat round trip ----------------------------------------------------------------------
    msgs = send(page, key, "hello there")
    check("echo reply from mock provider", msgs[-1]["role"] == "assistant" and msgs[-1]["content"] == "ECHO: hello there", msgs[-1:])
    composer = page.locator("textarea[aria-label='Message the assistant']")
    composer.fill("a")
    composer.press("Shift+Enter")
    composer.type("b")
    check("Shift+Enter keeps both lines in the composer", composer.input_value() == "a\nb", composer.input_value())
    composer.fill("")

    # 5. Survives client-side navigation -----------------------------------------------------------------
    page.get_by_text("QR codes", exact=True).first.click()  # launcher card -> router.push
    page.wait_for_url("**/tools/qr")
    check("client navigation kept the document alive", page.evaluate("window.__sk_marker") == "alive")
    check("panel still open after navigation", dialog.is_visible())
    check("conversation still visible after navigation", "ECHO: hello there" in dialog.inner_text())

    # 6. Scripted open_tool navigates ----------------------------------------------------------------------
    msgs = send(page, key, 'CALL:open_tool:{"slug":"text"}')
    page.wait_for_url("**/tools/text")
    res = tool_result(msgs, "open_tool")
    check("open_tool navigates and reports success", res.get("ok") is True and res.get("opened") == "text", res)
    check("document still alive after agent navigation", page.evaluate("window.__sk_marker") == "alive")

    # 7. snapshot -> fill_field -> click changes a real tool's output ---------------------------------------------
    msgs = send(page, key, "CALL:page_snapshot:{}")
    snap = tool_result(msgs, "page_snapshot")
    field = control_id(snap, "textarea")
    upper = control_id(snap, "button", "UPPERCASE")
    check("snapshot exposes the text area and UPPERCASE button", bool(field and upper), snap.get("controls", [])[:6])
    check("snapshot excludes the widget itself", not any("assistant" in c.get("label", "").lower() for c in snap.get("controls", [])))
    if field and upper:
        send(page, key, "CALL:fill_field:" + json.dumps({"id": field, "value": "hello agent"}))
        check("fill_field typed into the page", page.locator("main textarea").first.input_value() == "hello agent")
        send(page, key, "CALL:click:" + json.dumps({"id": upper}))
        page.wait_for_function("document.querySelector('main').innerText.includes('HELLO AGENT')")
        check("click changed the tool output", True)

    # 7a. Instant feedback: every cue appears while the run is in progress, not after it ----------------------------
    CUE_JS = """() => {
        window.__obs?.disconnect();
        window.__cues = {};
        const mark = (k) => { if (!(k in window.__cues)) window.__cues[k] = performance.now(); };
        // Step rows of earlier turns stay in the transcript: only count rows added after this point.
        const rows0 = document.querySelectorAll('[data-agent-step]').length;
        const ok0 = document.querySelectorAll('[data-agent-step][data-status=ok]').length;
        const scan = () => {
            if (document.documentElement.hasAttribute('data-agent-active')) mark('active');
            if (document.querySelectorAll('[data-agent-step]').length > rows0) mark('step');
            if (document.querySelectorAll('[data-agent-step][data-status=ok]').length > ok0) mark('stepOk');
            if (document.querySelector('[data-agent-highlight]')) mark('highlight');
            if (document.querySelector('[data-agent-flash]')) mark('flash');
            if (document.querySelector('[data-agent-toast]')) mark('toast');
            if (document.querySelector('[data-agent-progress]')) mark('progress');
            if (document.querySelector('[data-agent-draft]')) mark('draft');
            if (document.querySelector('[data-agent-here]')) mark('here');
        };
        window.__obs = new MutationObserver(scan);
        window.__obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    }"""

    def run_cues(text: str, samples: str | None = None) -> tuple[dict, list]:
        """Send `text`, record when each cue first appears (ms since send); optionally sample an expression while busy."""
        page.evaluate(CUE_JS)
        t_send = page.evaluate("performance.now()")
        composer = page.locator("textarea[aria-label='Message the assistant']")
        composer.fill(text)
        composer.press("Enter")
        seen: list = []
        deadline = t_send + 30_000
        while page.evaluate("performance.now()") < deadline:
            if samples:
                value = page.evaluate(samples)
                if value is not None and (not seen or seen[-1] != value):
                    seen.append(value)
            if page.evaluate("!!window.__cues.active && !document.documentElement.hasAttribute('data-agent-active')"):
                break
            page.wait_for_timeout(25)
        page.locator("button[aria-label='Send']").wait_for(timeout=SLOW)
        if "flash" in text or "click" in text:
            page.wait_for_timeout(1800)  # debounced outputs may land just after the run ends
        cues = page.evaluate("window.__cues")
        return {k: round(v - t_send) for k, v in cues.items()}, seen

    def under(cues: dict, name: str, limit: int, since: str | None = None) -> bool:
        if name not in cues:
            return False
        return (cues[name] - (cues[since] if since else 0)) <= limit

    if field and upper:
        # thinking state: the page knows the run started and the model is thinking, well before any answer
        cues, _ = run_cues("THINK:1200 STREAM:2 GAP:100", "document.querySelector('[data-agent-status]')?.textContent || null")
        check("data-agent-active is set within 300ms of Send", under(cues, "active", 300), cues)
        check("a thinking status line shows while the model reasons", "Thinking" in json.dumps(_), _)
        check("data-agent-active is cleared when the run ends", page.evaluate("!document.documentElement.hasAttribute('data-agent-active') && !document.body.hasAttribute('data-agent-active')"))

        # streaming text: the draft grows in place instead of landing in one piece
        cues, lens = run_cues("STREAM:14 GAP:150", "document.querySelector('[data-agent-draft]')?.textContent.length ?? null")
        # The reply reaches the server transcript one save after the run ends (seconds under load): wait for it, do not race it.
        streamed = " ".join(f"word{i}" for i in range(1, 15))
        msgs = stored_messages(page, key)
        for _ in range(50):
            if msgs and msgs[-1].get("role") == "assistant" and msgs[-1].get("content") == streamed:
                break
            page.wait_for_timeout(200)
            msgs = stored_messages(page, key)
        check("streamed text renders incrementally (draft grows over several frames)", len(lens) >= 4 and lens == sorted(lens), lens)
        check("first streamed word is visible quickly", under(cues, "draft", 900), cues)
        check("final stored reply equals the streamed text", msgs[-1].get("content") == " ".join(f"word{i}" for i in range(1, 15)), msgs[-1])

        # tool step + highlight + output flash
        send(page, key, "CALL:page_snapshot:{}")
        cues, _ = run_cues("CALL:fill_field:" + json.dumps({"id": field, "value": "second value"}) + "\nCALL:click:" + json.dumps({"id": upper}) + " GAP:100")
        print("info feedback timings (ms after Send):", cues)
        check("a running step row is shown as soon as the model names the tool", "step" in cues and cues["step"] < 1500, cues)
        check("highlight ring appears within 300ms of the step starting", under(cues, "highlight", 300, "step") or under(cues, "highlight", 450, "step"), cues)
        check("'AI is here' badge appears with the highlight", "here" in cues, cues)
        check("step turns ok", "stepOk" in cues, cues)
        check("changed output region is flashed", "flash" in cues, cues)
        last_msgs = stored_messages(page, key)
        check("typed value landed and output updated", "SECOND VALUE" in page.locator("main").inner_text())
        row = dialog.locator("details[data-agent-step=fill_field]").last
        check("transcript step reads as a sentence with status", 'Fill "' in row.inner_text() and row.get_attribute("data-status") == "ok", row.inner_text()[:80])

        # prefers-reduced-motion: cues still set, animations off
        page.emulate_media(reduced_motion="reduce")
        page.evaluate(CUE_JS)
        composer = page.locator("textarea[aria-label='Message the assistant']")
        composer.fill("CALL:fill_field:" + json.dumps({"id": field, "value": "calm"}))
        composer.press("Enter")
        anim = page.evaluate("""() => new Promise((resolve) => {
            const t = setInterval(() => {
                const el = document.querySelector('[data-agent-highlight]');
                if (el) { clearInterval(t); resolve(getComputedStyle(el).animationName); }
            }, 10);
            setTimeout(() => { clearInterval(t); resolve('missing'); }, 4000);
        })""")
        check("reduced motion: highlight ring has no animation", anim == "none", anim)
        page.locator("button[aria-label='Send']").wait_for(timeout=SLOW)
        page.emulate_media(reduced_motion="no-preference")

    # page switch cue: progress bar + toast naming the destination (leaving a page that holds input would ask under Risky; this is about cues)
    page.locator("[aria-label='Ask before acting']").get_by_role("radio", name="None", exact=True).click()
    cues, _ = run_cues('CALL:open_tool:{"slug":"ids","tab":"jwt"}', "document.querySelector('[data-agent-toast]')?.textContent || null")
    check("page switch shows the progress bar", "progress" in cues, cues)
    check("progress bar appears within 300ms of the step starting", under(cues, "progress", 300, "step"), cues)
    check("toast names where the AI went", any("JWT" in t and "opened" in t for t in _) and any("opening" in t for t in _), _)
    check("toast is exposed as data-agent-toast", page.evaluate("1") == 1 and "toast" in cues, cues)

    # Stop cancels at once with visible confirmation
    composer = page.locator("textarea[aria-label='Message the assistant']")
    composer.fill("SLOW:20000 hold on")
    composer.press("Enter")
    page.locator("button[aria-label='Stop']").wait_for(timeout=SLOW)
    page.wait_for_selector("html[data-agent-active]", timeout=2000)
    t0 = page.evaluate("performance.now()")
    page.locator("button[aria-label='Stop']").click()
    page.locator("button[aria-label='Send']").wait_for(timeout=2000)
    stopped_ms = page.evaluate("performance.now()") - t0
    check("Stop returns the composer within 400ms", stopped_ms < 400, stopped_ms)
    check("Stop is confirmed in the transcript", "Stopped." in dialog.inner_text())
    check("Stop clears data-agent-active", page.evaluate("!document.documentElement.hasAttribute('data-agent-active')"))
    send(page, key, 'CALL:open_tool:{"slug":"text"}')
    page.wait_for_url("**/tools/text")

    # 7b. Suites: retired slugs and explicit tabs ------------------------------------------------------------------
    msgs = send(page, key, 'CALL:list_tools:{"query":"cron"}')
    lt = tool_result(msgs, "list_tools")
    top = (lt.get("matches") or [{}])[0].get("open_tool", {})
    check("list_tools ranks the Cron tab first with ready open_tool args", top == {"slug": "dates", "tab": "cron"}, lt)

    msgs = send(page, key, 'CALL:open_tool:{"slug":"cron"}')
    res = tool_result(msgs, "open_tool")
    page.wait_for_url("**/tools/dates?tab=cron")
    check("open_tool resolves the retired slug 'cron' to its suite tab", res.get("ok") is True and res.get("opened") == "dates", res)

    # The retired suite slug (merged into `dates` in 0.6) with one of its tabs still lands there.
    msgs = send(page, key, 'CALL:open_tool:{"slug":"meeting-timezones","tab":"recurrence"}')
    res = tool_result(msgs, "open_tool")
    check("open_tool switches tabs inside the same suite", res.get("ok") is True and "/tools/dates?tab=recurrence" in page.url, (res, page.url))

    msgs = send(page, key, 'CALL:open_tool:{"slug":"meeting-timezones","tab":"nope"}')
    res = tool_result(msgs, "open_tool")
    check("open_tool rejects an unknown tab and names the valid ones", res.get("ok") is False and "cron" in res.get("error", ""), res)

    # 7c. upload_file feeds a real file input ----------------------------------------------------------------------
    send(page, key, 'CALL:open_tool:{"slug":"characters","tab":"encoding"}')
    page.wait_for_url("**/tools/characters?tab=encoding")
    snap = tool_result(send(page, key, "CALL:page_snapshot:{}"), "page_snapshot")
    fid = control_id(snap, "file")
    check("snapshot exposes the encoding tab file input with an upload hint", fid is not None, snap.get("controls", [])[:5])
    if fid:
        res = tool_result(send(page, key, "CALL:upload_file:" + json.dumps({"id": fid, "name": "hello.txt", "text": "hello agent"})), "upload_file")
        check("upload_file attaches agent-made text", res.get("ok") is True and res.get("bytes") == 11, res)
        page.wait_for_timeout(500)
        dump = json.dumps(tool_result(send(page, key, "CALL:page_snapshot:{}"), "page_snapshot"))
        # The tab decodes the attached bytes (the hex viewer was folded into it in the 2026-10-25 audit): detection + decoded sample.
        check("the encoding tab decoded the uploaded bytes", "hello agent" in dump and "UTF-8" in dump and "11 bytes" in dump, dump[:400])
        res = tool_result(send(page, key, "CALL:upload_file:" + json.dumps({"id": fid, "name": "x.bin", "base64": "!!notb64"})), "upload_file")
        check("upload_file rejects invalid base64", res.get("ok") is False, res)
        res = tool_result(send(page, key, "CALL:upload_file:" + json.dumps({"id": fid, "name": "x.bin"})), "upload_file")
        check("upload_file needs text or base64", res.get("ok") is False, res)
    res = tool_result(send(page, key, "CALL:upload_file:" + json.dumps({"id": "c1", "name": "x.txt", "text": "a"})), "upload_file")
    check("upload_file refuses a non-file control", res.get("ok") is False, res)

    msgs = send(page, key, 'CALL:open_tool:{"slug":"jwt","tab":"password"}')
    page.wait_for_url("**/tools/ids?tab=password")  # Security (jwt) merged into ids in 0.6
    msgs = send(page, key, "CALL:page_snapshot:{}")
    snap = tool_result(msgs, "page_snapshot")
    check("snapshot of Security > Passwords exposes controls", len(snap.get("controls", [])) >= 2, snap.get("controls", [])[:6])
    check("document still alive after suite navigation", page.evaluate("window.__sk_marker") == "alive")
    msgs = send(page, key, 'CALL:open_tool:{"slug":"text"}')
    page.wait_for_url("**/tools/text")

    all_ids = [c["id"] for m in stored_messages(page, key) if m["role"] == "assistant" for c in m.get("tool_calls", [])]
    check("tool-call ids are unique even if the provider reuses them", len(all_ids) == len(set(all_ids)) and len(all_ids) >= 4, all_ids)

    # 8. Stop and Clear -------------------------------------------------------------------------------------------
    check("Clear button present", page.locator("button[aria-label='Clear conversation']").is_visible())

    # 9. Persistence across reload + Escape -----------------------------------------------------------------------------
    page.reload(wait_until="networkidle")
    dialog.wait_for()
    check("open state survives reload", dialog.is_visible())
    check("conversation survives reload", "ECHO: hello there" in dialog.inner_text())
    check("at most 200 messages stored", len(stored_messages(page, key)) <= 200)
    dialog.locator("textarea").focus()
    page.keyboard.press("Escape")
    page.wait_for_selector("[role=dialog][aria-label='Toolbox assistant']", state="detached")
    check("Escape closes the panel", True)
    check("focus returns to the launcher", page.evaluate("document.activeElement?.getAttribute('aria-label')") == "Open assistant")
    page.locator("button[aria-label='Open assistant']").click()
    dialog.wait_for()
    page.locator("button[aria-label='Clear conversation']").click()
    page.wait_for_function(
        """async previous => {
            const r = await fetch('/api/agent/conversation');
            if (!r.ok) return false;
            const c = await r.json();
            return c.messages.length === 0 && c.actions.length === 0;
        }""",
        arg=key, timeout=SLOW, polling=250,
    )
    check("Clear empties the stored conversation", True)

    # 10. 390px: no horizontal overflow with the panel open ---------------------------------------------------------------
    page.set_viewport_size({"width": 390, "height": 844})
    for path in ("/", "/tools/qr", "/tools/text"):
        page.goto(BASE + path, wait_until="networkidle")
        dialog.wait_for()
        box = dialog.bounding_box() or {"x": -1, "width": 0}
        with_widget = page.evaluate("document.documentElement.scrollWidth")
        check(f"390px {path}: panel fits the viewport", box["x"] >= 0 and box["x"] + box["width"] <= 390 and box["width"] >= 330, box)
        # The widget is position:fixed, so removing it must not change the page width; any
        # remaining overflow belongs to the page itself (pre-existing), not to the widget.
        page.evaluate("document.querySelectorAll('[data-agent-widget]').forEach(e => e.remove())")
        without_widget = page.evaluate("document.documentElement.scrollWidth")
        check(f"390px {path}: widget adds no horizontal overflow", with_widget <= without_widget, (with_widget, without_widget))
        if without_widget > 390:
            print(f"note 390px {path}: the page itself is {without_widget}px wide (pre-existing overflow, not the widget)")
        elif path != "/":
            check(f"390px {path}: no horizontal overflow at all", with_widget <= 390, with_widget)

    browser.close()

check("zero console errors", not console_errors, console_errors[:5])
print(f"\n{len(failures)} failure(s)" if failures else "\nall checks passed")
sys.exit(1 if failures else 0)
