"""Assistant run state, message queue and multi-tab safety (real browser, scripted mock provider).

  node tests/mock_provider.mjs 3299
  KNIFE_DATA_DIR=$(mktemp -d) KNIFE_PORT=3236 npm run dev
  python3 tests/agent_runtime_e2e.py http://127.0.0.1:3236 http://127.0.0.1:3299

Oracles are independent of the app: the mock provider's request log (`/__log`: what the model was actually
sent, in which order; `/__stats`: peak concurrent requests) and the stored transcript/queue in localStorage.
Every scenario runs in a fresh browser context; the durable server transcript is shared per account/provider. `locks=False` hides `navigator.locks` to
exercise the localStorage-lease fallback that production (plain HTTP, not a secure context) really uses.
"""
import json
import sys
import time
import urllib.request

from playwright.sync_api import Page, sync_playwright

BASE, MOCK = sys.argv[1].rstrip("/"), sys.argv[2].rstrip("/")
failures: list[str] = []
errors: list[str] = []
LONG = "STREAM:40 GAP:100"  # ~4 s of streaming: long enough to type, queue, click and stop during the run
STREAMED40 = " ".join(f"word{i}" for i in range(1, 41))
STREAMED20 = " ".join(f"word{i}" for i in range(1, 21))
COMPOSER = "textarea[aria-label='Message the assistant']"


def check(name: str, ok: bool, detail: object = "") -> None:
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + ("" if ok else f"  -> {str(detail)[:400]}"))
    if not ok:
        failures.append(name)


def put_provider() -> None:
    body = {"baseUrl": f"{MOCK}/v1", "model": "mock-model", "apiKey": "mock-key"}
    req = urllib.request.Request(BASE + "/api/account/provider", data=json.dumps(body).encode(), method="PUT",
                                 headers={"content-type": "application/json", "Origin": BASE})
    urllib.request.urlopen(req, timeout=30).read()


def mock(path: str, method: str = "GET"):
    with urllib.request.urlopen(urllib.request.Request(MOCK + path, method=method), timeout=10) as r:
        return json.loads(r.read())


def provider_log() -> list[dict]:
    return mock("/__log")


def wait_for_provider_requests(count: int, timeout: float = 10) -> list[dict]:
    deadline = time.time() + timeout
    while time.time() < deadline:
        requests = provider_log()
        if len(requests) >= count:
            return requests
        time.sleep(0.05)
    return provider_log()


def user_texts(request: dict) -> list[str]:
    return [m["text"] for m in request["messages"] if m["role"] == "user"]


def account_id(page: Page) -> str:
    return page.evaluate("fetch('/api/account').then(r => r.json()).then(a => a.id)")


def transcript(page: Page) -> list[dict]:
    messages = page.evaluate("fetch('/api/agent/conversation').then(r => r.json()).then(c => c.messages)")
    return [m for m in messages if not (m["role"] == "notice" and m.get("level") == "usage")]


def stored_queue(page: Page) -> dict:
    raw = page.evaluate("id => localStorage.getItem('sk.agent.queue.v1.' + id)", account_id(page))
    return json.loads(raw) if raw else {"items": [], "paused": None}


def user_msgs(page: Page) -> list[str]:
    return [m["content"] for m in transcript(page) if m["role"] == "user"]


def assistant_msgs(page: Page) -> list[str]:
    return [m["content"] for m in transcript(page) if m["role"] == "assistant" and m.get("content")]


def new_ctx(browser, locks: bool = True, mode: str | None = None):
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    scripts = ["window.__phases = []; new MutationObserver(() => { const v = document.documentElement.getAttribute('data-agent-active'); "
               "if (v && window.__phases[window.__phases.length - 1] !== v) window.__phases.push(v); })"
               ".observe(document, { subtree: true, attributes: true, attributeFilter: ['data-agent-active'] });"]
    if mode:
        scripts.append(f"localStorage.setItem('sk.agent.mode.v1', '{mode}')")
    if not locks:
        scripts.append("Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true })")
    for s in scripts:
        ctx.add_init_script(s)
    return ctx


def open_panel(ctx, path: str = "/tools/qr") -> Page:
    page = ctx.new_page()
    page.on("console", lambda m: errors.append(m.text[:200]) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)[:200]))
    page.goto(BASE + path, wait_until="networkidle")
    page.keyboard.press("Control+j")
    page.wait_for_selector("[role=dialog][aria-label='Toolbox assistant']")
    page.wait_for_selector(COMPOSER)
    return page


def send(page: Page, text: str) -> None:
    box = page.locator(COMPOSER)
    box.fill(text)
    box.press("Enter")


def running(page: Page) -> bool:
    return page.locator("button[aria-label=Stop]").count() == 1


def wait_running(page: Page) -> None:
    page.wait_for_selector("button[aria-label=Stop]", timeout=10_000)


def wait_user_stored(page: Page, text: str, timeout: float = 10) -> bool:
    """True once `text` is a user message in the server-side transcript."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if text in user_msgs(page):
            return True
        time.sleep(0.05)
    return False


def chips(page: Page) -> list[str]:
    return page.locator("[data-agent-queued] span.truncate").all_inner_texts()


def settle(page: Page, n_user: int, timeout: float = 40) -> None:
    """All n_user messages delivered, last one answered, no run in flight, queue empty (stable twice)."""
    deadline = time.time() + timeout
    stable = 0
    while time.time() < deadline:
        t = transcript(page)
        done = (len([m for m in t if m["role"] == "user"]) >= n_user and t and
                ((t[-1]["role"] == "assistant" and not t[-1].get("tool_calls")) or t[-1]["role"] == "notice")
                and page.locator("html[data-agent-active]").count() == 0 and not stored_queue(page)["items"])
        stable = stable + 1 if done else 0
        if stable >= 3:
            return
        time.sleep(0.25)
    raise AssertionError(f"not settled: users={len(user_msgs(page))} queue={stored_queue(page)} last={transcript(page)[-1:]}")


def same_conversation(a: Page, b: Page, timeout: float = 8) -> bool:
    """Both tabs render the same log; the idle tab learns of the last append through a storage event, so poll briefly."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if a.locator("[role=log]").inner_text() == b.locator("[role=log]").inner_text():
            return True
        time.sleep(0.2)
    return False


def no_illegal_transitions(label: str) -> None:
    bad = [e for e in errors if "illegal transition" in e or "[agent-runtime]" in e]
    check(f"{label}: no illegal state transition was reported", not bad, bad)


put_provider()
with sync_playwright() as pw:
    browser = pw.chromium.launch()

    # ------------------------------------------------------------------ 1. queue during a run, drained in order
    print("# queue: typed during a run is never dropped, delivered after it, once, in order")
    ctx = new_ctx(browser)
    page = open_panel(ctx)
    mock("/__log", "DELETE")
    send(page, f"{LONG} first")
    wait_running(page)
    send(page, "second one")
    send(page, "third one")
    page.wait_for_selector("[data-agent-queued='2']")
    check("two chips above the composer, in typing order", chips(page) == ["second one", "third one"], chips(page))
    check("composer is cleared after queueing", page.locator(COMPOSER).input_value() == "")
    # The Stop button shows the instant the turn starts; the user message reaches the SERVER transcript one GET + PUT later
    # (async persist queue, awaited before the model call). Wait for it, then assert the queued texts are not there.
    stored_first = wait_user_stored(page, f"{LONG} first")
    check("queued texts are not in the transcript yet", stored_first and user_msgs(page)[-1:] == [f"{LONG} first"], user_msgs(page)[-3:])
    check("queue persisted in localStorage in order", [i["text"] for i in stored_queue(page)["items"]] == ["second one", "third one"])
    requests = wait_for_provider_requests(1)
    check("the model has received exactly one request so far", len(requests) == 1, len(requests))
    settle(page, 3)
    check("transcript order: first, second, third (stored)", user_msgs(page)[-3:] == [f"{LONG} first", "second one", "third one"], user_msgs(page)[-3:])
    check("replies in order", assistant_msgs(page)[-2:] == ["ECHO: second one", "ECHO: third one"], assistant_msgs(page))
    log = provider_log()
    check("provider got exactly 3 requests (nothing dropped, nothing duplicated)", len(log) == 3, len(log))
    check("the third request carries first/second/third once each, in order", user_texts(log[2])[-3:] == [f"{LONG} first", "second one", "third one"], user_texts(log[2])[-3:])
    check("queue storage is empty afterwards", stored_queue(page)["items"] == [] and chips(page) == [])
    check("run phases seen: thinking... and back to idle", page.evaluate("window.__phases").count("thinking") >= 1 and page.locator("html[data-agent-active]").count() == 0, page.evaluate("window.__phases"))
    ctx.close()

    # ------------------------------------------------------------------ 2. cancel + edit chips
    print("# queue: cancel and edit")
    ctx = new_ctx(browser)
    page = open_panel(ctx)
    mock("/__log", "DELETE")
    send(page, f"{LONG} base")
    wait_running(page)
    for t in ("alpha", "beta", "gamma"):
        send(page, t)
    page.wait_for_selector("[data-agent-queued='3']")
    page.locator("[data-agent-queued='2'] button[aria-label='Cancel queued message']").click()
    check("cancel removes exactly that chip", chips(page) == ["alpha", "gamma"], chips(page))
    page.locator("[data-agent-queued='2'] button", has_text="Edit").click()
    box = page.locator("input[aria-label='Edit queued message']")
    box.fill("gamma EDITED")
    box.press("Enter")
    check("edit changes the text in place, order kept", chips(page) == ["alpha", "gamma EDITED"], chips(page))
    check("storage matches the chips", [i["text"] for i in stored_queue(page)["items"]] == ["alpha", "gamma EDITED"], stored_queue(page))
    settle(page, 3)
    log = provider_log()
    sent = [t for r in log for t in user_texts(r)]
    check("provider never saw the cancelled message nor the old text", "beta" not in sent and "gamma" not in sent, sent)
    check("delivered: base, alpha, gamma EDITED in order", user_msgs(page)[-3:] == [f"{LONG} base", "alpha", "gamma EDITED"], user_msgs(page)[-3:])
    check("exactly 3 provider requests", len(log) == 3, len(log))
    ctx.close()

    # ------------------------------------------------------------------ 3. Send now steers the running turn
    print("# queue: Send now delivers into the running turn at the next round boundary")
    ctx = new_ctx(browser)
    page = open_panel(ctx)
    mock("/__log", "DELETE")
    send(page, 'CALL:wait:{"ms":3000}')
    page.wait_for_selector("[data-agent-step='wait']")
    send(page, "steer me")
    page.wait_for_selector("[data-agent-queued='1']")
    page.locator("[data-agent-queued='1'] button", has_text="Send now").click()
    page.wait_for_selector("[data-agent-steering]")
    check("the chip left the queue and shows as joining the run", chips(page) == [] and page.locator("[data-agent-steering]").count() == 1)
    settle(page, 2)
    t = transcript(page)
    roles = [m["role"] for m in t if m["role"] != "notice"]
    check("stored order: user, assistant(tool call), tool, user(steer), assistant", roles[-5:] == ["user", "assistant", "tool", "user", "assistant"], roles[-5:])
    check("steer text is the second user message and is answered", user_msgs(page)[-1] == "steer me" and assistant_msgs(page)[-1] == "ECHO: steer me", (user_msgs(page)[-3:], assistant_msgs(page)[-2:]))
    log = provider_log()
    check("only two model rounds: the steer did not start a second turn", len(log) == 2, len(log))
    tail = [m["role"] for m in log[1]["messages"]]
    check("provider's 2nd round ends [..., tool result, user steer]", tail[-3:] == ["assistant", "tool", "user"] and log[1]["messages"][-1]["text"] == "steer me", tail)
    check("steering chip gone, queue empty", page.locator("[data-agent-steering]").count() == 0 and stored_queue(page)["items"] == [])
    ctx.close()

    # ------------------------------------------------------------------ 4. Stop pauses; Send now / Resume / Clear
    print("# queue: Stop pauses the queue; resume continues; clear discards")
    ctx = new_ctx(browser)
    page = open_panel(ctx)
    mock("/__log", "DELETE")
    send(page, "STREAM:80 GAP:100 long")
    wait_running(page)
    send(page, "after-1")
    send(page, "after-2")
    page.wait_for_selector("[data-agent-queued='2']")
    page.locator("button[aria-label=Stop]").click()
    page.wait_for_selector("[data-agent-queue-paused]")
    check("banner offers Resume and Clear", page.locator("[data-agent-queue-paused] button", has_text="Resume").count() == 1 and page.locator("[data-agent-queue-paused] button", has_text="Clear").count() == 1)
    check("run phase went through stopping", "stopping" in page.evaluate("window.__phases"), page.evaluate("window.__phases"))
    time.sleep(2.5)
    check("nothing was sent after Stop (paused)", len(provider_log()) == 1 and chips(page) == ["after-1", "after-2"], (len(provider_log()), chips(page)))
    check("pause is persisted", stored_queue(page)["paused"] == "stopped", stored_queue(page))
    check("transcript says Stopped.", any(m["role"] == "notice" and m["content"] == "Stopped." for m in transcript(page)))
    page.locator("[data-agent-queued='1'] button", has_text="Send now").click()
    page.wait_for_function("() => document.querySelectorAll('[data-agent-queued]').length === 1", timeout=10_000)
    for _ in range(80):
        if "ECHO: after-1" in assistant_msgs(page):
            break
        time.sleep(0.25)
    check("Send now on a paused chip runs it immediately", "ECHO: after-1" in assistant_msgs(page), assistant_msgs(page))
    time.sleep(1.0)
    check("the rest stays paused after that turn", chips(page) == ["after-2"] and page.locator("[data-agent-queue-paused]").count() == 1 and len(provider_log()) == 2, (chips(page), len(provider_log())))
    page.locator("[data-agent-queue-paused] button", has_text="Resume").click()
    settle(page, 3)
    check("Resume delivers the remaining message once", "ECHO: after-2" in assistant_msgs(page) and len(provider_log()) == 3, (assistant_msgs(page), len(provider_log())))
    check("banner gone after resume", page.locator("[data-agent-queue-paused]").count() == 0)
    # Clear path
    mock("/__log", "DELETE")
    send(page, "STREAM:80 GAP:100 long2")
    wait_running(page)
    send(page, "doomed")
    page.wait_for_selector("[data-agent-queued='1']")
    page.locator("button[aria-label=Stop]").click()
    page.wait_for_selector("[data-agent-queue-paused]")
    page.locator("[data-agent-queue-paused] button", has_text="Clear").click()
    time.sleep(1.5)
    check("Clear drops the queue and sends nothing", chips(page) == [] and stored_queue(page)["items"] == [] and len(provider_log()) == 1, (chips(page), len(provider_log())))
    ctx.close()

    # ------------------------------------------------------------------ 5. reload keeps the queue (paused: the run died with the page)
    print("# queue: survives a reload")
    ctx = new_ctx(browser)
    page = open_panel(ctx)
    mock("/__log", "DELETE")
    send(page, "STREAM:80 GAP:100 interrupted")
    wait_running(page)
    send(page, "survivor-1")
    send(page, "survivor-2")
    page.wait_for_selector("[data-agent-queued='2']")
    page.reload(wait_until="networkidle")
    page.keyboard.press("Control+j")
    page.wait_for_selector("[data-agent-queued='2']", timeout=15_000)
    check("both chips are back after reload, in order", chips(page) == ["survivor-1", "survivor-2"], chips(page))
    check("a run killed by the reload does not fire the queue by itself", page.locator("[data-agent-queue-paused]").count() == 1)
    time.sleep(1.5)
    check("still only the interrupted request reached the model", len(provider_log()) == 1, len(provider_log()))
    page.locator("[data-agent-queue-paused] button", has_text="Resume").click()
    settle(page, 3)
    check("after Resume both are delivered in order exactly once", user_msgs(page)[-2:] == ["survivor-1", "survivor-2"] and len(provider_log()) == 3, (user_msgs(page), len(provider_log())))
    # client-side navigation keeps chips and the drain going
    send(page, "STREAM:30 GAP:100 nav")
    wait_running(page)
    send(page, "queued-before-nav")
    page.wait_for_selector("[data-agent-queued='1']")
    link = page.locator("a[href='/tools/regex']")
    check("a sidebar/launcher link to navigate with exists", link.count() > 0)
    if link.count():
        link.first.click()
        page.wait_for_url("**/tools/regex")
    settle(page, 5)
    check("queue survived in-app navigation and drained", user_msgs(page)[-1] == "queued-before-nav", user_msgs(page)[-2:])
    ctx.close()

    # ------------------------------------------------------------------ 6. waits and approvals in the state machine
    print("# state machine: wait_for_user answers, approval queues")
    ctx = new_ctx(browser, mode="standard")
    page = open_panel(ctx, "/tools/ids")  # open_tool to the page already open needs no approval
    mock("/__log", "DELETE")
    send(page, 'CALL:wait_for_user:{"message":"Pick a file"}')
    page.wait_for_selector("[data-agent-wait]")
    send(page, "my answer")
    page.wait_for_function("() => !document.querySelector('[data-agent-wait]')", timeout=10_000)
    settle(page, 1)
    check("typing while awaiting_user answers the wait: no chip, nothing queued", chips(page) == [] and stored_queue(page)["items"] == [])
    res = [json.loads(m["content"]) for m in transcript(page) if m["role"] == "tool"]
    check("the wait was resumed by the message", any(r.get("resumedBy") == "message" or "my answer" in json.dumps(r) for r in res), res)
    check("the typed answer was not delivered as a separate user turn", user_msgs(page)[-1:] == ['CALL:wait_for_user:{"message":"Pick a file"}'], user_msgs(page)[-3:])

    send(page, 'CALL:open_tool:{"slug":"qr"}')
    page.wait_for_selector("[data-agent-approval]")
    check("pill shows the approval state", page.locator("[data-agent-pill='approval']").count() == 1)
    send(page, "queued during approval")
    page.wait_for_selector("[data-agent-queued='1']")
    check("typing during awaiting_approval queues", chips(page) == ["queued during approval"], chips(page))
    page.get_by_role("button", name="Allow", exact=True).click()
    settle(page, 3)
    check("after the approved run the queued message is delivered", user_msgs(page)[-1] == "queued during approval" and assistant_msgs(page)[-1] == "ECHO: queued during approval", (user_msgs(page)[-2:], assistant_msgs(page)[-1:]))
    phases = page.evaluate("window.__phases")
    check("phases observed include thinking and tool", "thinking" in phases and "tool" in phases, phases)
    ctx.close()

    # ------------------------------------------------------------------ 7. two tabs of one account
    for locks in (True, False):
        backend = "Web Locks" if locks else "localStorage lease (no navigator.locks, like plain-HTTP production)"
        print(f"# two tabs, {backend}")
        ctx = new_ctx(browser, locks=locks)
        a = open_panel(ctx)
        b = open_panel(ctx)
        check("backend under test is active", a.evaluate("!!navigator.locks") == locks)
        mock("/__log", "DELETE")
        mock("/__stats", "DELETE")
        send(a, f"{LONG} tabA-run")
        wait_running(a)
        b.wait_for_selector("[data-agent-lock]", timeout=10_000)
        check("tab B shows 'Another tab is running this conversation'", "Another tab is running this conversation" in b.locator("[data-agent-lock]").inner_text())
        check("tab B has no Stop button (it is not the runner)", not running(b))
        b.wait_for_function("t => document.querySelector('[role=log]').innerText.includes(t)", arg="tabA-run", timeout=10_000)
        check("tab B shows A's user message live", True)
        send(b, "from-B")
        b.wait_for_selector("[data-agent-queued='1']")
        a.wait_for_selector("[data-agent-queued='1']", timeout=10_000)
        check("B's message is queued, and the queue is shared (A shows the chip too)", chips(a) == ["from-B"] and chips(b) == ["from-B"], (chips(a), chips(b)))
        settle(a, 2)
        settle(b, 2)
        a.wait_for_selector("[data-agent-lock]", state="detached", timeout=10_000)
        b.wait_for_selector("[data-agent-lock]", state="detached", timeout=10_000)
        check("exactly the two messages, in order, once", user_msgs(a)[-2:] == [f"{LONG} tabA-run", "from-B"], user_msgs(a)[-2:])
        check("replies are in order and complete", assistant_msgs(a)[-2:] == [STREAMED40, "ECHO: from-B"], assistant_msgs(a)[-2:])
        check("both tabs show an identical conversation", same_conversation(a, b), (a.locator("[role=log]").inner_text()[-120:], b.locator("[role=log]").inner_text()[-120:]))
        log = provider_log()
        check("provider saw 2 requests; the model never ran twice at once", len(log) == 2 and mock("/__stats")["maxConcurrent"] == 1, (len(log), mock("/__stats")))
        check("the second request contains the first exchange then B's message", user_texts(log[1])[-2:] == [f"{LONG} tabA-run", "from-B"], user_texts(log[1])[-4:])

        # true race: both tabs fire at the same instant
        mock("/__log", "DELETE")
        mock("/__stats", "DELETE")
        a.locator(COMPOSER).fill("STREAM:20 GAP:100 race-A")
        b.locator(COMPOSER).fill("STREAM:20 GAP:100 race-B")
        t0 = int(time.time() * 1000) + 700
        for p in (a, b):
            p.evaluate("t0 => setTimeout(() => document.querySelector('button[aria-label=Send]').click(), t0 - Date.now())", t0)
        time.sleep(1.0)
        settle(a, 4, 60)
        settle(b, 4, 60)
        got = user_msgs(a)[-2:]
        check("simultaneous send: both delivered exactly once", sorted(got) == ["STREAM:20 GAP:100 race-A", "STREAM:20 GAP:100 race-B"] and len(got) == 2, got)
        check("simultaneous send: the model never ran twice at once", mock("/__stats")["maxConcurrent"] == 1, mock("/__stats"))
        expected_tail = [STREAMED40, "ECHO: from-B"]
        racing_replies = assistant_msgs(a)[-2:]
        check("simultaneous send: transcripts identical, nothing lost", same_conversation(a, b) and user_msgs(a) == user_msgs(b) and racing_replies == [STREAMED20, STREAMED20] and assistant_msgs(a)[-4:-2] == expected_tail, (user_msgs(a)[-4:], assistant_msgs(a)[-4:]))

        # closing the running tab frees the conversation
        send(a, f"{LONG} tabA-again")
        wait_running(a)
        b.wait_for_selector("[data-agent-lock]", timeout=10_000)
        a.close()
        b.wait_for_selector("[data-agent-lock]", state="detached", timeout=30_000 if not locks else 10_000)
        check("closing the runner releases the lock: banner gone in the other tab", True)
        send(b, "after A closed")
        settle(b, 6, 60)
        check("the surviving tab can run again", user_msgs(b)[-1] == "after A closed", user_msgs(b)[-2:])
        ctx.close()

    no_illegal_transitions("all scenarios")
    bad = [e for e in errors if "Hydration" in e or "hydrat" in e]
    check("no hydration errors in the console", not bad, bad)
    browser.close()

print(f"\n{'FAILED: ' + ', '.join(failures) if failures else 'all checks passed'}")
sys.exit(1 if failures else 0)
