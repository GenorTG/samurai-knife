"""The assistant never loses the conversation it is continuing (real browser, scripted mock provider).

  python3 tests/agent_context_e2e.py <app-url> <mock-url>

Regression (2026-10-29, Claude, Polish chat): after a 10-round turn with large tool outputs ended in a proposal ("Zrobić to
wszystko…?"), the follow-up "tak tak." reached the model ALONE: the context trim snapped forward to the next user message
and dropped the whole previous turn, its final answer included. Oracle: the mock provider's `/__log` (what the model was
actually sent). Also covered: a reload in between, a server copy left behind by a failed save (a restart mid-turn), a
second tab, and the "older messages shortened" notice.
"""
import json
import sys
import time
import urllib.request

from playwright.sync_api import Page, sync_playwright

BASE, MOCK = sys.argv[1].rstrip("/"), sys.argv[2].rstrip("/")
COMPOSER = "textarea[aria-label='Message the assistant']"
failures: list[str] = []
errors: list[str] = []

# One knife_format_json call per round; its result is clipped to 12,000 characters, so ten rounds are ~120k characters,
# the size of the model context the old trim allowed.
BIG = json.dumps({"text": json.dumps(["x" * 13_000])})
LOOP_PROMPT = f"Sprawdź stronę i zaproponuj zmiany LOOP:knife_format_json:{BIG}"


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


def open_panel(ctx) -> Page:
    page = ctx.new_page()
    page.on("console", lambda m: errors.append(m.text[:200]) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)[:200]))
    page.goto(BASE + "/tools/qr", wait_until="networkidle")
    page.keyboard.press("Control+j")
    page.wait_for_selector("[role=dialog][aria-label='Toolbox assistant']")
    page.wait_for_selector(COMPOSER)
    return page


def transcript(page: Page) -> list[dict]:
    return page.evaluate("fetch('/api/agent/conversation').then(r => r.json()).then(c => c.messages)")


def send_and_settle(page: Page, text: str, timeout: float = 120) -> None:
    before = len([m for m in transcript(page) if m["role"] == "user"])
    box = page.locator(COMPOSER)
    box.fill(text)
    box.press("Enter")
    deadline = time.time() + timeout
    stable = 0
    while time.time() < deadline:
        t = transcript(page)
        users = [m for m in t if m["role"] == "user"]
        done = len(users) > before and t[-1]["role"] == "notice" and t[-1].get("level") == "usage" \
            and page.locator("html[data-agent-active]").count() == 0
        stable = stable + 1 if done else 0
        if stable >= 3:
            return
        time.sleep(0.3)
    raise AssertionError(f"turn did not settle: {text[:40]!r} last={transcript(page)[-2:]}")


def last_request() -> dict:
    log = mock("/__log")
    return log[-1] if log else {"messages": []}


def assistant_texts(request: dict) -> list[str]:
    return [m["text"] for m in request["messages"] if m["role"] == "assistant" and m["text"]]


call("/api/account/provider", "PUT", {"baseUrl": f"{MOCK}/v1", "model": "mock-model", "apiKey": "mock-key"})
call("/api/account/assistant", "PUT", {"maxRounds": 10, "maxToolCalls": 40})
call("/api/agent/conversation", "DELETE")

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    ctx.add_init_script("localStorage.setItem('sk.agent.mode.v1', 'free')")
    page = open_panel(ctx)

    print("# a 10-round turn with large tool outputs, then a short yes")
    mock("/__log", "DELETE")
    send_and_settle(page, LOOP_PROMPT, 240)
    t = transcript(page)
    answer = next((m["content"] for m in reversed(t) if m["role"] == "assistant" and m.get("content") and not m.get("tool_calls")), "")
    check("the long turn ended with a written answer (the per-turn limit summary)", answer.startswith("ECHO: [Toolbox note"), answer[:120])
    rounds = len(mock("/__log"))
    check("the turn took the 10 model rounds + the summary", rounds == 11, rounds)

    mock("/__log", "DELETE")
    send_and_settle(page, "tak tak.")
    request = last_request()
    texts = assistant_texts(request)
    check("the follow-up reaches the model WITH the previous answer", answer in texts, texts[-3:])
    check("... and with the request it answered", any(m["role"] == "user" and m["text"].startswith("Sprawdź stronę") for m in request["messages"]),
          [m["role"] for m in request["messages"]])
    check("the request starts with a user message and ends with the new one", request["messages"][0]["role"] == "user" and request["messages"][-1]["text"] == "tak tak.",
          [(m["role"], m["text"][:20]) for m in request["messages"]][:3])
    shortened = [m for m in transcript(page) if m["role"] == "notice" and "shortened" in m["content"]]
    check("the user is told older messages were shortened", len(shortened) >= 1)
    check("the notice is visible in the widget", page.get_by_text("Older messages were shortened").count() >= 1)

    print("# after a reload (a deploy between turns)")
    page.reload(wait_until="networkidle")
    page.keyboard.press("Control+j")
    page.wait_for_selector(COMPOSER)
    page.wait_for_function("() => document.querySelector('[role=log]')?.innerText.includes('ECHO: tak tak.')", timeout=15_000)
    mock("/__log", "DELETE")
    send_and_settle(page, "i jeszcze raz")
    texts = assistant_texts(last_request())
    check("after a reload the model still gets both earlier answers", answer in texts and "ECHO: tak tak." in texts, texts[-3:])

    print("# the server copy fell behind (a save failed while the server restarted)")
    full = transcript(page)
    behind = full[:-3]  # drop the last user message, its answer and the usage footer
    call("/api/agent/conversation", "PUT", {"version": 1, "messages": behind, "actions": []})
    page.reload(wait_until="networkidle")
    page.keyboard.press("Control+j")
    page.wait_for_selector(COMPOSER)
    page.wait_for_function("() => document.querySelector('[role=log]')?.innerText.includes('ECHO: i jeszcze raz')", timeout=15_000)
    check("the widget keeps the newer browser copy", True)
    deadline = time.time() + 10
    while time.time() < deadline and not any(m.get("content") == "ECHO: i jeszcze raz" for m in transcript(page)):
        time.sleep(0.2)
    check("... and repairs the server copy with it", any(m.get("content") == "ECHO: i jeszcze raz" for m in transcript(page)))

    print("# a second tab continues the same conversation")
    other = browser.new_context(viewport={"width": 1440, "height": 900})
    other.add_init_script("localStorage.setItem('sk.agent.mode.v1', 'free')")
    b = open_panel(other)  # a fresh browser: nothing in its localStorage, only the server copy
    b.wait_for_function("() => document.querySelector('[role=log]')?.innerText.includes('ECHO: i jeszcze raz')", timeout=15_000)
    mock("/__log", "DELETE")
    send_and_settle(b, "z drugiej przeglądarki")
    texts = assistant_texts(last_request())
    check("another browser sends the whole recent conversation", answer in texts and "ECHO: i jeszcze raz" in texts, texts[-3:])
    page.reload(wait_until="networkidle")
    page.keyboard.press("Control+j")
    page.wait_for_selector(COMPOSER)
    page.wait_for_function("() => document.querySelector('[role=log]')?.innerText.includes('ECHO: z drugiej przeglądarki')", timeout=15_000)
    mock("/__log", "DELETE")
    send_and_settle(page, "wracam")
    users = [m["text"] for m in last_request()["messages"] if m["role"] == "user"]
    check("the first browser continues after the other one's turn (server copy ahead)", "z drugiej przeglądarki" in users, users[-3:])

    bad = [e for e in errors if "Hydration" in e or "hydrat" in e]
    check("no hydration errors in the console", not bad, bad)
    browser.close()

call("/api/account/assistant", "PUT", {"maxRounds": 24, "maxToolCalls": 40})
print(f"\n{'FAILED: ' + ', '.join(failures) if failures else 'all checks passed'}")
sys.exit(1 if failures else 0)
