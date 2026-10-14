"""Durable conversation + OpenClaw Responses continuation against the REAL gateway test agent (`knife-test`). Spends a little quota.

  KNIFE_REAL_ACCOUNT=openclaw python3 tests/agent_responses_real_e2e.py http://127.0.0.1:3236   (scratch server, fresh data dir)

The point of the feature, proven with a real model:
  * Knife sends only the NEW input per request, so a fact told in turn 1 can only be known in turn 3 through the gateway's own session;
  * the whole conversation (many turns, tool rounds, a reload with wiped browser storage) leaves exactly ONE gateway session,
    not one per request;
  * Clear conversation starts a new gateway session and the old fact is gone;
  * rounds stream (text visible mid-round), and the gateway's unknown-id 400 matches what Knife's replay classifier expects.
The gateway sessions this suite created are deleted at the end (and only those: sessions that existed before the run are left alone).
"""
import json
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import tests.real_provider as rp  # noqa: E402
from tests.conversation_support import conversation, open_widget, send  # noqa: E402

BASE = sys.argv[1].rstrip("/")
failures: list[str] = []
errors: list[str] = []
SECRET = "PERSIMMON-4417"


def check(name: str, ok: bool, detail: object = "") -> None:
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + ("" if ok else f"  -> {str(detail)[:400]}"))
    if not ok:
        failures.append(name)


def gateway_sessions(agent: str) -> set[str]:
    out = subprocess.run(["openclaw", "sessions", "--agent", agent, "--limit", "all", "--json"], capture_output=True, text=True, timeout=120)
    data = json.loads(out.stdout or "{}")
    rows = data.get("sessions", data) if isinstance(data, dict) else data
    return {row["key"] for row in rows if isinstance(row, dict) and "key" in row}


def final_text(conv: dict) -> str:
    talk = [m for m in conv["messages"] if m["role"] == "assistant" and not m.get("tool_calls")]
    return str(talk[-1]["content"]) if talk else ""


provider = rp._provider_body("")
agent = provider["model"].split("/", 1)[1] if "/" in provider["model"] else provider["model"]
if provider["model"] in rp._DEFAULT_AGENT_TARGETS:
    sys.exit(f"{provider['model']} is the main agent: this suite needs the restricted test agent (e.g. openclaw/knife-test)")
before = gateway_sessions(agent)

# The classifier's contract, checked against the real gateway: an unresolvable previous_response_id is a 400 whose message
# names the field (Knife replays the history only for that; any other 400 is shown). Rejected before any run: no session.
probe = urllib.request.Request(
    provider["baseUrl"].rstrip("/") + "/responses", method="POST",
    data=json.dumps({"model": provider["model"], "input": "ping", "previous_response_id": "resp_does_not_exist", "user": "samurai-knife:probe"}).encode(),
    headers={"content-type": "application/json", "authorization": f"Bearer {provider['apiKey']}", **provider["extraHeaders"]},
)
try:
    urllib.request.urlopen(probe, timeout=30)
    check("gateway rejects an unknown previous_response_id with a 400 naming the field", False, "request succeeded")
except urllib.error.HTTPError as exc:
    detail = json.loads(exc.read() or b"{}").get("error", {})
    check("gateway rejects an unknown previous_response_id with a 400 naming the field",
          exc.code == 400 and "previous_response_id" in str(detail.get("message", "")), (exc.code, detail))

body = {**provider, "openClawResponses": True}
req = urllib.request.Request(BASE + "/api/account/provider", data=json.dumps(body).encode(), method="PUT",
                             headers={"content-type": "application/json", "Origin": BASE})
urllib.request.urlopen(req, timeout=30).read()

try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_context(viewport={"width": 1440, "height": 900}).new_page()
        page.on("console", lambda m: errors.append(m.text[:200]) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)[:200]))
        page.goto(BASE + "/tools/json", wait_until="networkidle")
        open_widget(page)

        # Live text: the round streams, so the draft shows part of the reply before the round ends.
        box = page.locator("textarea[aria-label='Message the assistant']")
        box.fill(f"Remember this codeword for later: {SECRET}. Then write the numbers one to thirty as English words, one per line.")
        box.press("Enter")
        partial: str | None = None
        for _ in range(1200):
            draft = page.locator("[data-agent-draft]")
            if draft.count() and draft.first.inner_text().strip():
                partial = draft.first.inner_text().strip()
                break
            if not page.evaluate("document.documentElement.hasAttribute('data-agent-active')") and conversation(page)["messages"]:
                break
            page.wait_for_timeout(50)
        check("Responses mode streams: reply text is visible while the round is still running", bool(partial), partial)
        send(page, "Reply with just the word OK.", 120)
        conv = send(page, "Open the QR code generator tool for me (use open_tool with slug qr), then confirm in one short sentence.", 180)
        check("a real tool round trip ran through the continuation path", page.url.endswith("/tools/qr"), page.url)
        check("the action journal recorded it", any(a.startswith("/tools/") for a in conv["actions"]), conv["actions"])
        conv = send(page, "What was the codeword I told you at the start? Answer with just the codeword.", 120)
        check("turn 3 recalls turn 1 (Knife sent only the new message: the gateway session remembered)", SECRET in final_text(conv), final_text(conv))

        page.evaluate("localStorage.clear()")
        page.goto(BASE + "/tools/text", wait_until="networkidle")
        open_widget(page)
        page.get_by_text("What was the codeword").first.wait_for(timeout=15_000)
        conv = send(page, "Which tool did you open for me earlier? Answer with just the tool name.", 120)
        check("after wiping browser storage + reload, the conversation resumes and still knows the tool", "qr" in final_text(conv).lower(), final_text(conv))

        # Stop while a tool call is parked on an approval: the gateway session now ends in a function_call nobody answered.
        page.goto(BASE + "/tools/json", wait_until="networkidle")
        open_widget(page)
        field = page.locator("main textarea").first
        field.click()
        field.press("Control+A")
        field.type("my own words")
        box = page.locator("textarea[aria-label='Message the assistant']")
        box.fill("Open the QR code generator tool for me (open_tool with slug qr).")
        box.press("Enter")
        page.wait_for_selector("[data-agent-approval]", timeout=120_000)
        page.get_by_role("button", name="Stop", exact=True).click()
        page.wait_for_function("!document.documentElement.hasAttribute('data-agent-active')", timeout=30_000)
        check("Stop left the run parked on nothing and kept my page", page.url.endswith("/tools/json") and field.input_value() == "my own words", page.url)
        conv = send(page, "Reply with just the word PONG.", 180)
        check("the next turn works after a Stop that left an unanswered tool call in the gateway session", "PONG" in final_text(conv), final_text(conv))

        created = gateway_sessions(agent) - before
        check("the whole conversation left exactly ONE gateway session", len(created) == 1, sorted(created))

        page.get_by_role("button", name="Clear conversation").click()
        for _ in range(100):
            if conversation(page)["messages"] == []:
                break
            page.wait_for_timeout(100)
        conv = send(page, "What was the codeword I gave you? If you do not know any codeword, answer exactly: NONE.", 120)
        check("after Clear the earlier fact is gone (a new gateway session)", SECRET not in final_text(conv), final_text(conv))
        created = gateway_sessions(agent) - before
        check("Clear started a second gateway session, not one per request", len(created) == 2, sorted(created))
        browser.close()
finally:
    leftovers = sorted(gateway_sessions(agent) - before)
    if leftovers:
        subprocess.run(["openclaw", "sessions", "delete", "--agent", agent, "--yes", *leftovers], capture_output=True, text=True, timeout=120)
    check("cleanup: no gateway sessions left from this run", not (gateway_sessions(agent) - before))

check("zero console errors", not errors, errors[:3])
print("\nall checks passed" if not failures else f"\n{len(failures)} FAILED: {failures}")
sys.exit(1 if failures else 0)
