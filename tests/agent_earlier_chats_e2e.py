"""Chats saved before 0.13.0.22 (one server file per provider + model + chat) come back (real browser, mock provider).

  python3 tests/agent_earlier_chats_e2e.py <app-url> <mock-url> <app-data-dir>

The app's data dir is needed to plant provider-scoped transcripts the way the older release wrote them (sealed with the
instance's storage key, through the app's own conversation store). Scenarios: a chat whose file is missing adopts its
newest provider-scoped copy (another profile's model) and the model receives it; the rest appear in Settings > "Recover
earlier chats" (model, size, preview); "Open as a new chat" imports one, its untrusted mark follows, and it leaves the list.
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

BASE, MOCK, DATA = sys.argv[1].rstrip("/"), sys.argv[2].rstrip("/"), sys.argv[3]
ROOT = Path(__file__).resolve().parents[1]
COMPOSER = "textarea[aria-label='Message the assistant']"
failures: list[str] = []


def check(name: str, ok: bool, detail: object = "") -> None:
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + ("" if ok else f"  -> {str(detail)[:500]}"))
    if not ok:
        failures.append(name)


def call(path: str, method: str = "GET", body: object | None = None) -> object:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={"content-type": "application/json", "Origin": BASE})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or b"null")


def mock(path: str, method: str = "GET"):
    with urllib.request.urlopen(urllib.request.Request(MOCK + path, method=method), timeout=10) as r:
        return json.loads(r.read())


def plant(account: str, items: list[dict]) -> None:
    """Write provider-scoped files exactly as the store of an older release did (providerConversationId), aged."""
    script = """
import { utimesSync } from "node:fs";
import { join } from "node:path";
const { providerConversationId, writeConversation } = await import("./src/lib/agent-client/conversation-store.ts");
const [account, items] = JSON.parse(process.env.PLANT);
for (const item of items) {
  const id = providerConversationId(item.baseUrl, item.model, item.chat);
  writeConversation(account, id, { version: 1, messages: item.messages, actions: [], untrusted: item.untrusted === true });
  const at = new Date(Date.now() - item.age * 1000);
  utimesSync(join(process.env.KNIFE_DATA_DIR, "conversations", account, id + ".json"), at, at);
}
"""
    env = {**os.environ, "KNIFE_DATA_DIR": DATA, "PLANT": json.dumps([account, items])}
    subprocess.run(["node", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--disable-warning=ExperimentalWarning", "--import", "./tests/ts-resolve.mjs",
                    "--input-type=module", "-e", script], cwd=ROOT, env=env, check=True)


def pair(user: str, answer: str) -> list[dict]:
    return [{"role": "user", "content": user}, {"role": "assistant", "content": answer}]


def open_widget(ctx) -> Page:
    page = ctx.new_page()
    page.goto(BASE + "/tools/qr", wait_until="networkidle")
    page.keyboard.press("Control+j")
    page.wait_for_selector(COMPOSER)
    return page


call("/api/account/provider", "PUT", {"baseUrl": f"{MOCK}/v1", "model": "mock-model", "apiKey": "mock-key"})
account = call("/api/account")["id"]
profiles = call("/api/account/provider-profiles", "POST", {"action": "create", "name": "Second", "provider": {"baseUrl": f"{MOCK}/v1", "model": "mock-model-2", "apiKey": "mock-key"}, "activate": False})
check("a second profile (another model) is saved, not active", any(p.get("model") == "mock-model-2" for p in profiles["account"]["providerProfiles"]), profiles)

two = {"baseUrl": f"{MOCK}/v1", "model": "mock-model-2"}
plant(account, [
    {**two, "chat": "legacy_chat", "messages": pair("hello from model two", "ECHO: hello from model two"), "age": 900},
    {**two, "chat": "legacy_old", "messages": pair("an older idea", "ECHO: an older idea"), "age": 3600},
    {"baseUrl": f"{MOCK}/v1", "model": "mock-model", "chat": "gone_chat", "messages": pair("SECRET page summary", "ECHO: tainted"), "age": 120, "untrusted": True},
])

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    ctx.add_init_script("if (!localStorage.getItem('sk.agent.ui.v1')) localStorage.setItem('sk.agent.ui.v1', JSON.stringify({open:false,width:400,height:700,dock:false,chatIds:['default','legacy_chat','legacy_old']}))")
    page = open_widget(ctx)

    print("# a chat saved under another profile's model comes back by itself")
    page.select_option("select[aria-label='Assistant conversation']", "legacy_chat")
    page.wait_for_function("() => document.querySelector('[role=log]')?.innerText.includes('hello from model two')", timeout=15_000)
    check("the adopted transcript is shown", True)
    conv = page.evaluate("fetch('/api/agent/conversation?chat=legacy_chat').then(r => r.json())")
    check("the server stored it under the chat (adoptedFrom set)", bool(conv.get("adoptedFrom")) and conv["messages"][0]["content"] == "hello from model two", conv)
    mock("/__log", "DELETE")
    page.locator(COMPOSER).fill("and now?")
    page.locator(COMPOSER).press("Enter")
    page.wait_for_function("() => document.querySelector('[role=log]')?.innerText.includes('ECHO: and now?')", timeout=30_000)
    users = [m["text"] for m in mock("/__log")[-1]["messages"] if m["role"] == "user"]
    check("the model receives the recovered history", users[-2:] == ["hello from model two", "and now?"], users)

    print("# Settings > Recover earlier chats")
    page.locator("button[aria-label='Settings']").click()
    panel = page.locator("[data-earlier-chats]")
    panel.wait_for(timeout=15_000)
    panel.locator("summary").click()
    items = panel.locator("[data-earlier-chat]")
    texts = items.all_inner_texts()
    check("the two chats nobody took over are listed, newest first", len(texts) == 2 and "SECRET page summary" in texts[0] and "an older idea" in texts[1], texts)
    check("model and host when the chat id is known, message count, the outside-text mark", "mock-model-2 at 127.0.0.1" in texts[1] and "2 messages" in texts[0]
          and "outside sources" in texts[0] and "Unknown model" in texts[0], texts)
    check("the adopted chat is not listed again", not any("hello from model two" in t for t in texts), texts)
    items.first.get_by_role("button", name="Open as a new chat").click()
    page.wait_for_function("() => document.querySelector('[role=log]')?.innerText.includes('SECRET page summary')", timeout=15_000)
    check("the imported chat opens in the widget", True)
    prefs = json.loads(page.evaluate("localStorage.getItem('sk.agent.ui.v1')"))
    new_id = prefs["chatIds"][-1]
    check("it got a new chat id", new_id not in ("default", "legacy_chat", "gone_chat"), prefs["chatIds"])
    conv = page.evaluate(f"fetch('/api/agent/conversation?chat={new_id}').then(r => r.json())")
    check("its untrusted mark followed it", conv.get("untrusted") is True, conv)
    page.locator("button[aria-label='Settings']").click()
    page.locator("[data-earlier-chats]").wait_for(timeout=15_000)
    page.locator("[data-earlier-chats] summary").click()
    left = page.locator("[data-earlier-chat]").all_inner_texts()
    check("it left the list", len(left) == 1 and "an older idea" in left[0], left)

    print("# a guest and a foreign origin")
    guest = urllib.request.Request(BASE + "/api/agent/conversation/earlier", data=b'{"file":"' + b"0" * 32 + b'","chatId":"x"}', method="POST",
                                   headers={"content-type": "application/json", "Origin": "http://evil.example"})
    try:
        urllib.request.urlopen(guest, timeout=10)
        check("a foreign Origin cannot import", False)
    except urllib.error.HTTPError as error:
        check("a foreign Origin cannot import", error.code == 403, error.code)
    browser.close()

print(f"\n{'FAILED: ' + ', '.join(failures) if failures else 'all checks passed'}")
sys.exit(1 if failures else 0)
