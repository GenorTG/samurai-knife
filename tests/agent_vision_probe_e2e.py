"""Vision detection + turn limit, end to end (real browser, real account/agent routes, scripted mock provider).

The mock's `/vision/v1` base lists mock-vision (names the probe picture's colours), mock-text (HTTP 400 to images) and
mock-blind (answers NO_IMAGE) next to mock-model / mock-model-2 (which answer without naming colours: unknown).

Start the mock:   node tests/mock_provider.mjs 3299
Start the server: KNIFE_DATA_DIR=$(mktemp -d) KNIFE_PORT=3232 npm run dev      (127.0.0.1 only, FRESH data dir)
Run:              python3 tests/agent_vision_probe_e2e.py http://127.0.0.1:3232 http://127.0.0.1:3299

Covers: the vision control is visible next to the model (not inside a closed panel); Detect on one model; "Check all
models"; learned answers shown in the list after a reload (server cache); picking a detected vision model sets "Sees
images", saved and kept after reload; the saved setting really sends a picture (knife_vision_describe -> mock); a
text-only setting sends none; probe errors are not remembered; route bounds; the per-turn limit saved, shown and
honoured by the loop (rounds and tool calls).
"""
import base64
import json
import os
import sys
import time
import urllib.request

from playwright.sync_api import Page, sync_playwright

if len(sys.argv) < 3:
    sys.exit("usage: python3 tests/agent_vision_probe_e2e.py <base_url> <mock_url>")
BASE = sys.argv[1].rstrip("/")
MOCK = sys.argv[2].rstrip("/")
VISION_BASE = f"{MOCK}/vision/v1"
SLOW = 60_000

failures: list[str] = []
console_errors: list[str] = []


def check(name: str, ok: bool, detail: object = "") -> None:
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + ("" if ok else f"  -> {detail}"))
    if not ok:
        failures.append(name)


def http_json(method: str, path: str, body: object | None = None, base: str = BASE) -> tuple[int, object]:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, method=method, headers={"content-type": "application/json", "Origin": BASE})
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return res.status, json.loads(res.read() or b"null")
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"null")


def wait_until(probe, what: str, timeout: float = SLOW / 1000) -> None:
    """Poll a Python predicate (page.wait_for_function does not await an async predicate's promise)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if probe():
            return
        time.sleep(0.25)
    raise TimeoutError(f"timed out waiting for {what}")


def page_account(page: Page) -> dict:
    return page.evaluate("fetch('/api/account').then(r => r.json())")


def form(page: Page):
    return page.locator("form[aria-label='Provider settings']")


def form_status(page: Page) -> str:
    status = form(page).locator(":scope > [role=status]")
    return status.inner_text() if status.count() else ""


def wait_status(page: Page, needle: str) -> str:
    page.wait_for_function(
        "needle => { const s = document.querySelector(\"form[aria-label='Provider settings'] > [role=status]\"); return !!s && s.textContent.includes(needle); }",
        arg=needle, timeout=SLOW,
    )
    return form_status(page)


def open_settings(page: Page) -> None:
    if page.locator("button[aria-label='Open assistant']").is_visible():
        page.locator("button[aria-label='Open assistant']").click()
    page.wait_for_selector("[role=dialog][aria-label='Toolbox assistant']", timeout=SLOW)
    if not form(page).is_visible():
        page.locator("button[aria-label='Settings']").click()
    form(page).wait_for(timeout=SLOW)


def back_to_chat(page: Page) -> None:
    if form(page).is_visible():
        page.locator("button[aria-label='Back to chat']").click()
    page.locator("textarea[aria-label='Message the assistant']").wait_for(timeout=SLOW)


def option_label(page: Page, model: str) -> str:
    return form(page).locator(f"select[aria-label='Available models'] option[value='{model}']").inner_text()


def conversation(page: Page) -> list[dict]:
    data = page.evaluate("fetch('/api/agent/conversation').then(r => r.json())")
    return [m for m in data["messages"] if not (m["role"] == "notice" and m.get("level") == "usage")]


def send(page: Page, text: str) -> list[dict]:
    users_before = sum(1 for m in conversation(page) if m["role"] == "user")
    composer = page.locator("textarea[aria-label='Message the assistant']")
    composer.fill(text)
    composer.press("Enter")
    def finished() -> bool:
        messages = conversation(page)
        if sum(1 for m in messages if m["role"] == "user") <= users_before:
            return False
        return messages[-1]["role"] == "assistant" and not messages[-1].get("tool_calls")
    wait_until(finished, "the turn to end", timeout=SLOW * 2 / 1000)
    page.locator("button[aria-label='Send']").wait_for(timeout=SLOW)
    return conversation(page)


def this_turn(messages: list[dict], marker: str) -> list[dict]:
    start = max(i for i, m in enumerate(messages) if m["role"] == "user" and marker in m["content"])
    return messages[start:]


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    page.set_default_timeout(SLOW)
    page.on("pageerror", lambda e: console_errors.append(f"pageerror: {e}"))

    # 1. First run: the vision control is visible beside the model --------------------------------------------------
    page.goto(BASE + "/", wait_until="networkidle")
    open_settings(page)
    f = form(page)
    vision_select = f.locator("select[aria-label='Does this model see images?']")
    check("vision control visible without opening a panel", vision_select.is_visible())
    check("vision control starts at Text only", vision_select.input_value() == "none", vision_select.input_value())
    check("the unknown-vision note explains Detect", "Detect asks it" in f.locator("[data-provider-vision-note]").inner_text())
    f.locator("button", has_text="Custom").click()
    f.locator("input[type=url]").fill(VISION_BASE)
    f.locator("#sk-provider-key").fill("mock-key")
    f.locator("#sk-provider-model").fill("mock-text")

    # 2. Model list: nothing advertised --------------------------------------------------------------------------------
    f.locator("button", has_text="Load models").click()
    f.locator("select[aria-label='Available models']").wait_for()
    labels = f.locator("select[aria-label='Available models'] option").all_inner_texts()
    check("model list: 5 models, all vision unknown", len(labels) == 6 and all("vision unknown" in label for label in labels[1:]), labels)

    # 3. Detect the typed model --------------------------------------------------------------------------------------
    f.locator("[data-provider-detect]").click()
    text = wait_status(page, "refused the test picture")
    check("Detect: mock-text is text only (provider refused the picture)", "text only" in text and "HTTP 400" in text, text)
    check("Detect: still Text only", vision_select.input_value() == "none")
    check("Detect: the note says detected", "Detected on" in f.locator("[data-provider-vision-note]").inner_text())
    check("Detect: button offers Check again", f.locator("[data-provider-detect]").inner_text() == "Check again")
    last = http_json("GET", "/__last", base=MOCK)[1]
    parts = last["body"]["messages"][0]["content"]
    check("probe request: one tiny PNG as image_url to the probed model", last["body"]["model"] == "mock-text" and any(p.get("type") == "image_url" and p["image_url"]["url"].startswith("data:image/png;base64,") for p in parts), last["body"]["model"])
    check("probe request: small token budget, no tools", last["body"].get("max_tokens") == 400 and "tools" not in last["body"], last["body"].keys())

    # 4. Check all models ----------------------------------------------------------------------------------------------
    f.locator("[data-provider-check-all]").click()
    text = wait_status(page, "Vision check done")
    check("Check all: 4 unknown models probed (1 sees, 1 text only, 2 unclear)", "(4 models)" in text and "Sees images: 1" in text and "Text only: 1" in text and "Unknown: 2" in text, text)
    check("list: mock-vision vision (detected)", "vision (detected)" in option_label(page, "mock-vision"), option_label(page, "mock-vision"))
    check("list: mock-blind text only (detected)", "text only (detected)" in option_label(page, "mock-blind"), option_label(page, "mock-blind"))
    check("list: mock-model still unknown (unclear answers are not remembered)", "vision unknown" in option_label(page, "mock-model"), option_label(page, "mock-model"))

    # 5. Picking a detected model sets the vision choice; save, reload --------------------------------------------------
    f.locator("select[aria-label='Available models']").select_option("mock-blind")
    check("picking mock-blind: Text only", vision_select.input_value() == "none")
    f.locator("select[aria-label='Available models']").select_option("mock-vision")
    check("picking mock-vision: Sees images set automatically", vision_select.input_value() == "native", vision_select.input_value())
    f.locator("button[type=submit]").click()
    wait_until(lambda: (page_account(page).get("provider") or {}).get("model") == "mock-vision", "the provider to be saved")
    page.wait_for_selector("textarea[aria-label='Message the assistant']")
    account = page_account(page)
    check("saved: mock-vision sees images", (account.get("provider") or {}).get("vision") == "native" and account["providerProfiles"][0]["vision"] == "native", account)
    page.reload(wait_until="networkidle")
    open_settings(page)
    check("after reload: Sees images", form(page).locator("select[aria-label='Does this model see images?']").input_value() == "native")
    form(page).locator("button", has_text="Load models").click()
    form(page).locator("select[aria-label='Available models']").wait_for()
    check("after reload: learned answers in the list", "vision (detected)" in option_label(page, "mock-vision") and "text only (detected)" in option_label(page, "mock-text"), option_label(page, "mock-vision"))
    check("after reload: the note for the current model says detected", "Detected on" in form(page).locator("[data-provider-vision-note]").inner_text())
    status, listed = http_json("POST", "/api/account/provider/models", {"baseUrl": VISION_BASE})
    sources = {d["id"]: (d["vision"], d["visionSource"]) for d in listed.get("modelDetails", [])}
    check("models route merges learned answers", sources.get("mock-vision") == (True, "detected") and sources.get("mock-blind") == (False, "detected") and sources.get("mock-model") == (None, None), sources)
    status, probed = http_json("POST", "/api/account/provider/vision-probe", {"baseUrl": VISION_BASE, "models": ["mock-vision"]})
    check("a remembered answer is served from the cache", status == 200 and probed["results"][0]["reason"] == "cached" and probed["results"][0]["vision"] is True, probed)

    # 6. The saved setting really sends pictures --------------------------------------------------------------------
    png = base64.b64encode(bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a1f1e1a40000000049454e44ae426082")).decode()
    status, saved = http_json("POST", "/api/craft/files", {"action": "save", "app": "vectorcraft", "name": "vision-e2e.png", "mime": "image/png", "data": png})
    file_id = saved.get("file", {}).get("id") if isinstance(saved, dict) else None
    check("craft file saved for the describe check", status in (200, 201) and file_id, (status, saved))
    status, described = http_json("POST", "/api/agent/tool", {"name": "knife_vision_describe", "args": {"image": file_id}})
    last = http_json("GET", "/__last", base=MOCK)[1]
    images = [p for m in last["body"]["messages"] if isinstance(m.get("content"), list) for p in m["content"] if p.get("type") == "image_url"]
    check("Sees images: the picture goes to mock-vision", described.get("ok") is True and last["body"]["model"] == "mock-vision" and len(images) == 1, (described, last["body"]["model"]))
    http_json("PUT", "/api/account/provider", {"baseUrl": VISION_BASE, "model": "mock-vision", "vision": "none"})
    before = http_json("GET", "/__stats", base=MOCK)[1]["requests"]
    status, described = http_json("POST", "/api/agent/tool", {"name": "knife_vision_describe", "args": {"image": file_id}})
    after = http_json("GET", "/__stats", base=MOCK)[1]["requests"]
    check("Text only: no picture is sent", described.get("ok") is False and after == before, (described, before, after))
    http_json("PUT", "/api/account/provider", {"baseUrl": VISION_BASE, "model": "mock-vision", "vision": "native"})

    # 7. Probe route rules -------------------------------------------------------------------------------------------
    status, _ = http_json("POST", "/api/account/provider/vision-probe", {"baseUrl": VISION_BASE, "models": []})
    check("probe: no models -> 400", status == 400, status)
    status, _ = http_json("POST", "/api/account/provider/vision-probe", {"baseUrl": VISION_BASE, "models": [f"m{i}" for i in range(7)]})
    check("probe: more than 6 models -> 400", status == 400, status)
    # Another address never gets the stored key: the mock answers 401, nothing is learned.
    status, probed = http_json("POST", "/api/account/provider/vision-probe", {"baseUrl": f"{MOCK}/v1", "models": ["mock-vision"]})
    result = probed["results"][0] if status == 200 else {}
    check("probe: a failed request is unknown (HTTP 401)", result.get("vision") is None and result.get("reason") == "error" and result.get("status") == 401, probed)
    status, listed = http_json("POST", "/api/account/provider/models", {"baseUrl": f"{MOCK}/v1", "apiKey": "mock-key"})
    learned = {d["id"]: d["visionSource"] for d in listed.get("modelDetails", [])}
    check("probe: the failure was not remembered", learned.get("mock-model") is None, learned)

    # 8. Turn limit ----------------------------------------------------------------------------------------------------
    page.reload(wait_until="networkidle")
    open_settings(page)
    panel = form(page).locator("[data-turn-limit]")
    check("turn limit summary shows the defaults", "24 model rounds, 40 tool calls" in panel.locator("summary").inner_text(), panel.locator("summary").inner_text())
    panel.locator("summary").click()
    panel.locator("input[aria-label='Model rounds per message']").fill("3")
    check("turn limit: 3 rounds is refused in the form", panel.locator("button", has_text="Save turn limit").is_disabled())
    panel.locator("input[aria-label='Model rounds per message']").fill("4")
    panel.locator("button", has_text="Save turn limit").click()
    page.wait_for_function("() => document.querySelector('[data-turn-limit] [role=status]')?.textContent.includes('Turn limit saved')", timeout=SLOW)
    account = http_json("GET", "/api/account")[1]
    check("turn limit saved on the account", account["assistant"] == {"maxRounds": 4, "maxToolCalls": 40, "custom": True}, account.get("assistant"))
    page.reload(wait_until="networkidle")
    open_settings(page)
    check("turn limit kept after reload", "4 model rounds, 40 tool calls" in form(page).locator("[data-turn-limit] summary").inner_text())
    for bad in ({"maxRounds": 3, "maxToolCalls": 40}, {"maxRounds": 101, "maxToolCalls": 40}, {"maxRounds": 24, "maxToolCalls": 201}, {"maxRounds": 24}):
        status, _ = http_json("PUT", "/api/account/assistant", bad)
        check(f"turn limit route refuses {bad}", status == 400, status)

    # The loop honours it: a scripted model that calls a tool after every result stops after 4 rounds + the summary.
    http_json("PUT", "/api/account/provider", {"baseUrl": f"{MOCK}/v1", "model": "mock-model", "apiKey": "mock-key", "vision": "none"})
    page.reload(wait_until="networkidle")
    open_settings(page)
    back_to_chat(page)
    urllib.request.urlopen(urllib.request.Request(MOCK + "/__log", method="DELETE")).close()
    turn = this_turn(send(page, "rounds LOOP:list_tools:{}"), "rounds LOOP")
    notices = [m["content"] for m in turn if m["role"] == "notice"]
    log = http_json("GET", "/__log", base=MOCK)[1]
    check("rounds limit: the notice names the configured numbers", any("Reached the per-turn limit (4 model rounds / 40 tool calls" in n for n in notices), notices)
    check("rounds limit: 4 tool rounds + 1 summary sent to the model", len(log) == 5, len(log))
    check("rounds limit: 4 tool results", sum(1 for m in turn if m["role"] == "tool") == 4)

    status, _ = http_json("PUT", "/api/account/assistant", {"maxRounds": 10, "maxToolCalls": 4})
    page.reload(wait_until="networkidle")
    back_to_chat(page)
    urllib.request.urlopen(urllib.request.Request(MOCK + "/__log", method="DELETE")).close()
    turn = this_turn(send(page, "calls LOOP:list_tools:{}"), "calls LOOP")
    notices = [m["content"] for m in turn if m["role"] == "notice"]
    results = [m for m in turn if m["role"] == "tool"]
    check("tool-call limit: the notice names 10 rounds / 4 tool calls", any("(10 model rounds / 4 tool calls" in n for n in notices), notices)
    check("tool-call limit: 4 run, the 5th skipped", len(results) == 5 and "budget for this turn is used up" in results[-1]["content"], [r["content"][:60] for r in results])

    status, account = http_json("PUT", "/api/account/assistant", {"reset": True})
    check("turn limit reset to the defaults", status == 200 and account["assistant"] == {"maxRounds": 24, "maxToolCalls": 40, "custom": False}, account.get("assistant"))

    data_dir = os.environ.get("KNIFE_DATA_DIR", "")
    if data_dir:
        with open(os.path.join(data_dir, "model-capabilities.json")) as fh:
            raw = fh.read()
        entries = json.loads(raw)["entries"]
        check("shared capability file: endpoint+model keys only, no key or account", "mock-key" not in raw and "genor" not in raw and all(k.startswith("127.0.0.1:") for k in entries), list(entries)[:5])

    check("no page errors", not console_errors, console_errors[:5])
    browser.close()

print(f"\n{len(failures)} failure(s)" if failures else "\nALL PASS")
sys.exit(1 if failures else 0)
