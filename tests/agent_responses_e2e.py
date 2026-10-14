"""Durable assistant conversations + OpenClaw Responses continuation, against a scripted OpenResponses fixture (no gateway, no quota).

  KNIFE_DATA_DIR=$(mktemp -d) KNIFE_PORT=3236 npm run dev
  python3 tests/agent_responses_e2e.py http://127.0.0.1:3236

The suite starts (and stops) its own tests/mock_responses_provider.mjs, which mirrors the gateway contract (response
ids scoped to `user`, the "Cannot resolve previous_response_id" 400, SSE streaming) and flags any full-history request
sent into a session that already holds history. What it proves, from the fixture's request log and the live page:
  * the server refuses a Responses config the gateway cannot route (no /v1, not an openclaw/<agent> model);
  * one `user` scope per conversation, `previous_response_id` chained across rounds AND turns, delta-only input;
  * rounds are streamed: text shows in the widget while the round is still running;
  * the conversation + action journal live on the server (wiped browser storage + reload resumes; journal in instructions);
  * recovery never duplicates history: an expired id, a failed round and a Responses-off detour each reseed ONE fresh
    session with the full history; an unrelated 400 is shown, not replayed;
  * Stop during a tool keeps the chain: the next turn sends the cancelled result plus the new message;
  * the round-budget wrap-up is a chained delta (no tools), not a reseed;
  * Clear conversation rotates the scope; the transcript is per provider (model) and comes back when the provider does.
"""
import json
import os
import re
import signal
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tests.conversation_support import conversation, open_widget, send  # noqa: E402
from tests.scratch_server import free_port  # noqa: E402

BASE = sys.argv[1].rstrip("/")
ROOT = Path(__file__).resolve().parents[1]
failures: list[str] = []
errors: list[str] = []
expected_status: set[int] = set()  # deliberate failed requests the browser logs as "status of N"

MOCK_PORT = free_port()
MOCK = f"http://127.0.0.1:{MOCK_PORT}"
mock_proc = subprocess.Popen(["node", "tests/mock_responses_provider.mjs", str(MOCK_PORT)], cwd=ROOT, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True)


def check(name: str, ok: bool, detail: object = "") -> None:
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + ("" if ok else f"  -> {detail}"))
    if not ok:
        failures.append(name)


def mock_call(path: str, method: str = "GET") -> object:
    req = urllib.request.Request(MOCK + path, method=method, data=b"" if method != "GET" else None)
    return json.loads(urllib.request.urlopen(req, timeout=10).read() or b"null")


def put_provider(model: str, base_url: str | None = None, responses: bool = True) -> tuple[int, dict]:
    body = {"baseUrl": base_url or f"{MOCK}/v1", "model": model, "apiKey": "mock-key", "openClawResponses": responses}
    req = urllib.request.Request(BASE + "/api/account/provider", data=json.dumps(body).encode(), method="PUT",
                                 headers={"content-type": "application/json", "Origin": BASE})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, json.loads(res.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


def log() -> list[dict]:
    return mock_call("/__log")  # type: ignore[return-value]


def kinds(entry: dict) -> list[str]:
    return [item["type"] if item["type"] != "message" else f"message:{item['role']}" for item in entry["input"]]


def send_expect_error(page, text: str, needle: str) -> None:
    """Send and wait for a NEW error notice containing `needle` (an earlier turn's notice must not satisfy the wait)."""
    notices = page.get_by_text(needle)
    before = notices.count()
    box = page.locator("textarea[aria-label='Message the assistant']")
    box.fill(text)
    box.press("Enter")
    for _ in range(150):
        if notices.count() > before:
            break
        page.wait_for_timeout(100)
    else:
        raise RuntimeError(f"no new {needle!r} notice after {text!r}")
    for _ in range(100):
        if not page.evaluate("document.documentElement.hasAttribute('data-agent-active')"):
            break
        page.wait_for_timeout(100)


try:
    # -- the server, not only the form, validates the Responses config -----------------------------------------------
    status, body = put_provider("gpt-4o-mini")
    check("PUT refuses Responses mode for a non-OpenClaw model", status == 400 and "agent target" in body.get("error", ""), (status, body))
    status, body = put_provider("openclaw/mock", base_url=MOCK)
    check("PUT refuses Responses mode without a /v1 base URL", status == 400 and "/v1" in body.get("error", ""), (status, body))
    status, _ = put_provider("gpt-4o-mini", base_url=MOCK, responses=False)
    check("the same config is fine with Responses mode off", status == 200, status)
    status, _ = put_provider("openclaw/mock")
    check("a valid OpenClaw target is accepted", status == 200, status)

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_context(viewport={"width": 1440, "height": 900}).new_page()

        def on_console(m) -> None:
            if m.type != "error":
                return
            if any(f"status of {code}" in m.text for code in expected_status):
                return
            errors.append(m.text[:200])

        page.on("console", on_console)
        page.on("pageerror", lambda e: errors.append(str(e)[:200]))
        page.goto(BASE + "/tools/json", wait_until="networkidle")
        open_widget(page)

        # -- turn 1: plain text, seeds the session -----------------------------------------------------------------------
        first = conversation(page)
        check("a fresh provider scope starts with an empty durable conversation", first["messages"] == [] and first["actions"] == [] and first["responseId"] is None, first)
        send(page, "hello there")
        e1 = log()[0]
        check("turn 1: exactly one gateway request, streamed", len(log()) == 1 and e1["stream"] is True, log())
        check("turn 1: starts the chain (no previous_response_id) with one user message", e1["previous_response_id"] is None and kinds(e1) == ["message:user"], e1)
        check("turn 1: stable per-account/provider/session scope in `user`", bool(re.fullmatch(r"samurai-knife:[a-z0-9_-]+:[0-9a-f]{32}:[0-9a-f-]{36}", e1["user"] or "")), e1["user"])
        check("turn 1: system prompt travels as instructions and says no actions yet", "No prior tool actions recorded" in e1["instructions"], e1["instructions"][-300:])
        scope = e1["user"]

        # -- live text: the round streams --------------------------------------------------------------------------------
        box = page.locator("textarea[aria-label='Message the assistant']")
        box.fill("SLOW:alpha beta gamma delta epsilon zeta")
        box.press("Enter")
        partial = None
        for _ in range(60):
            draft = page.locator("[data-agent-draft]")
            if draft.count():
                text = draft.first.inner_text().strip()
                if text and text != "ECHO: alpha beta gamma delta epsilon zeta":
                    partial = text
                    break
            page.wait_for_timeout(50)
        check("Responses mode shows live text while the round runs", partial is not None and "ECHO: alpha beta gamma delta epsilon zeta".startswith(partial), partial)
        page.get_by_text("ECHO: alpha beta gamma delta epsilon zeta").first.wait_for(timeout=15_000)
        send(page, "settle")  # waits until the slow turn is fully finished and persisted

        # -- a tool round trip (call -> result) ---------------------------------------------------------------------------
        mock_call("/__log", "DELETE")
        conv2 = send(page, 'CALL:open_tool:{"slug":"qr"}')
        turn2 = log()
        check("tool turn: two gateway rounds (tool call, then its result)", len(turn2) == 2, [kinds(e) for e in turn2])
        check("tool turn: round 1 sends only the new user message", turn2[0]["previous_response_id"] is not None and kinds(turn2[0]) == ["message:user"], turn2[0])
        check("tool turn: round 2 chains from round 1 and sends ONLY the tool result", turn2[1]["previous_response_id"] == turn2[0]["id"] and kinds(turn2[1]) == ["function_call_output"], turn2[1])
        check("tool turn: same session scope throughout", {e["user"] for e in turn2} == {scope}, [e["user"] for e in turn2])
        check("tool turn: the tool really ran (page moved)", page.url.endswith("/tools/qr"), page.url)
        check("tool turn: the journal recorded the action without field values", len(conv2["actions"]) >= 1 and all(a.startswith("/tools/") for a in conv2["actions"]), conv2["actions"])
        check("tool turn: the server advanced the head to the last response", conv2["responseId"] == turn2[1]["id"] and conv2["pendingCallIds"] == [], conv2)

        # -- resume knowledge -----------------------------------------------------------------------------------------
        send(page, "where were we?")
        e3 = log()[-1]
        check("turn 3: delta-only again (one user message, chained)", kinds(e3) == ["message:user"] and e3["previous_response_id"] == turn2[1]["id"], e3)
        check("turn 3: the journal is in the instructions so the model can resume", re.search(r"^- /tools/\S+: ", e3["instructions"], re.M) is not None, e3["instructions"][-400:])

        # -- the server, not the browser, owns the conversation --------------------------------------------------------
        page.evaluate("localStorage.clear()")
        page.goto(BASE + "/tools/qr", wait_until="networkidle")
        open_widget(page)
        page.get_by_text("ECHO: where were we?").first.wait_for(timeout=15_000)
        check("wiped browser storage + reload: transcript restored from the server", page.get_by_text("ECHO: where were we?").count() >= 1)
        conv_after = conversation(page)
        check("... at the same chain position and in the same scope", conv_after["responseId"] == e3["id"] and conv_after["sessionId"] == conv2["sessionId"], conv_after)

        # -- expired response id: ONE reseed into a FRESH session, then the chain continues there --------------------------
        mock_call("/__log", "DELETE")
        mock_call("/__expire", "POST")
        expected_status.update({409})
        send(page, "after expiry")
        recovered = log()
        check("expired id: exactly one logged request (the 400 is not logged)", len(recovered) == 1, recovered)
        r0 = recovered[0]
        check("expired id: retried WITHOUT previous_response_id and with the full history", r0["previous_response_id"] is None and len(r0["input"]) > 3, kinds(r0))
        check("expired id: history resent includes the tool round trip", "function_call" in kinds(r0) and "function_call_output" in kinds(r0), kinds(r0))
        check("expired id: the reseed goes to a NEW session, never the one that already holds the history", r0["user"] != scope and not r0["seedIntoUsedSession"], r0["user"])
        send(page, "and again")
        e5 = log()[-1]
        check("after recovery the chain continues as delta in the new session", e5["previous_response_id"] == r0["id"] and kinds(e5) == ["message:user"] and e5["user"] == r0["user"], e5)
        scope = r0["user"]

        # -- an unrelated 400 is an error, not a replay; the failed round makes the next turn reseed ----------------------
        mock_call("/__log", "DELETE")
        mock_call("/__fail400", "POST")
        expected_status.update({502})
        send_expect_error(page, "this one fails", "Provider returned HTTP 400")
        check("unrelated 400: shown to the user and NOT replayed with the full history", log() == [], log())
        check("unrelated 400: the server dropped the head (the gateway state is unknown)", conversation(page)["responseId"] is None)
        send(page, "after the failure")
        f1 = log()[-1]
        check("next turn reseeds one fresh session with the full history", len(log()) == 1 and f1["previous_response_id"] is None and f1["user"] != scope and not f1["seedIntoUsedSession"] and len(f1["input"]) > 3, (len(log()), kinds(f1)))
        scope = f1["user"]

        # -- Stop during a tool keeps the chain: the cancelled result travels with the next message ----------------------
        mock_call("/__log", "DELETE")
        box.fill('CALL:wait_for_user:{"message":"Pick a file please."}')
        box.press("Enter")
        page.locator("[data-agent-wait]").wait_for(timeout=15_000)  # the parked tool's card, not the prompt bubble
        page.locator("[data-agent-wait]").get_by_role("button", name="Cancel run").click()  # the wait card's Stop
        page.get_by_text("Stopped.").last.wait_for(timeout=10_000)
        parked = conversation(page)
        check("Stop during a tool: the head still points at the round that asked for the tool", parked["responseId"] == log()[-1]["id"] and len(parked["pendingCallIds"]) == 1, parked["pendingCallIds"])
        send(page, "after stop")
        s2 = log()[-1]
        check("after Stop: one chained delta = the cancelled tool result + the new message, same session",
              s2["previous_response_id"] == parked["responseId"] and kinds(s2) == ["function_call_output", "message:user"] and s2["user"] == scope,
              (kinds(s2), s2["previous_response_id"]))
        check("... the result says it was cancelled", "Cancelled" in s2["input"][0]["output"], s2["input"][0]["output"][:120])

        # -- Responses off on the same provider breaks the chain; back on reseeds a fresh session ---------------------------
        status, _ = put_provider("openclaw/mock", responses=False)
        page.reload(wait_until="networkidle")
        open_widget(page)
        mock_call("/__log", "DELETE")
        send_expect_error(page, "chat completions detour", "Model request failed")  # the fixture serves no /chat/completions
        check("a round with Responses off drops the head", conversation(page)["responseId"] is None)
        put_provider("openclaw/mock")
        page.reload(wait_until="networkidle")
        open_widget(page)
        send(page, "back on responses")
        b1 = log()[-1]
        check("back on: one fresh session seeded with the full history (no stale delta into the old session)",
              len(log()) == 1 and b1["previous_response_id"] is None and b1["user"] != scope and not b1["seedIntoUsedSession"], (len(log()), b1["user"]))
        scope = b1["user"]

        # -- round budget: the wrap-up is a chained delta without tools ---------------------------------------------------
        mock_call("/__log", "DELETE")
        send(page, 'LOOP:wait:{"ms":1}', timeout_s=90)
        loop_log = log()
        wrap = loop_log[-1]
        check("budget turn: the model ran out of rounds", len(loop_log) >= 25 and page.get_by_text("Reached the per-turn limit").count() >= 1, len(loop_log))
        check("budget wrap-up: chained delta (pending result + toolbox note), no tools, same session",
              wrap["previous_response_id"] == loop_log[-2]["id"] and not wrap["hasTools"] and kinds(wrap) == ["function_call_output", "message:user"] and wrap["user"] == scope,
              (kinds(wrap), wrap["hasTools"], wrap["previous_response_id"]))
        check("no request in the whole run seeded a session that already held history", not any(e["seedIntoUsedSession"] for e in loop_log))

        # -- Clear conversation: new scope, nothing carried over ------------------------------------------------------
        old_session = conversation(page)["sessionId"]
        page.get_by_role("button", name="Clear conversation").click()
        for _ in range(100):
            cleared = conversation(page)
            if cleared["messages"] == []:
                break
            page.wait_for_timeout(100)
        check("Clear conversation empties transcript, journal and chain on the server", cleared["messages"] == [] and cleared["actions"] == [] and cleared["responseId"] is None, cleared)
        check("... and rotates the session scope", cleared["sessionId"] != old_session, cleared["sessionId"])
        mock_call("/__log", "DELETE")
        send(page, "fresh start")
        ef = log()[-1]
        check("after Clear: a brand-new chain in a different `user` scope", ef["previous_response_id"] is None and ef["user"] != scope and kinds(ef) == ["message:user"], ef)
        check("after Clear: no journal leaks into the instructions", "No prior tool actions recorded" in ef["instructions"])
        fresh_session = conversation(page)["sessionId"]

        # -- per provider ----------------------------------------------------------------------------------------
        put_provider("openclaw/other")
        page.goto(BASE + "/tools/json", wait_until="networkidle")
        open_widget(page)
        page.wait_for_timeout(500)
        other = conversation(page)
        check("another provider (model) has its own empty conversation", other["messages"] == [] and other["sessionId"] != fresh_session, other["messages"][:1])
        put_provider("openclaw/mock")
        page.goto(BASE + "/tools/json", wait_until="networkidle")
        open_widget(page)
        page.get_by_text("ECHO: fresh start").first.wait_for(timeout=15_000)
        check("switching back restores the first provider's conversation", conversation(page)["sessionId"] == fresh_session)
        browser.close()
finally:
    try:
        os.killpg(mock_proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass

check("zero console errors", not errors, errors[:3])
print("\nall checks passed" if not failures else f"\n{len(failures)} FAILED: {failures}")
sys.exit(1 if failures else 0)
