"""Tasks (durable assistant goals) in the widget, real browser + the mock provider.

  python3 tests/agent_goals_e2e.py <app-url> <mock-url>

Create a task with steps in the Tasks panel (status, "0 of 3 steps done", the next step), pause/resume, the assistant
checkpoints it through knife_goal_checkpoint (loaded with load_tools {group:"goals"}), the panel shows the progress,
the next action and the note; "Continue with assistant" sends the goal's id to the model; complete, then delete it.
"""
import json
import sys
import urllib.request

from playwright.sync_api import Page, sync_playwright

BASE, MOCK = sys.argv[1].rstrip("/"), sys.argv[2].rstrip("/")
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


def panel_text(page: Page) -> str:
    return page.locator("section[aria-label='Tasks']").inner_text()


call("/api/account/provider", "PUT", {"baseUrl": f"{MOCK}/v1", "model": "mock-model", "apiKey": "mock-key"})

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page()
    page.on("dialog", lambda d: d.accept())
    page.goto(BASE + "/tools/qr", wait_until="networkidle")
    page.keyboard.press("Control+j")
    page.wait_for_selector(COMPOSER)

    print("# create a task in the Tasks panel")
    page.get_by_role("button", name="Tasks", exact=True).click()
    tasks = page.locator("section[aria-label='Tasks']")
    tasks.wait_for(timeout=10_000)
    tasks.get_by_label("Task title").first.fill("Website SEO to 100")
    tasks.get_by_label("Objective").last.fill("All HTML pages score 100 on technical SEO")
    tasks.get_by_label("Steps (one per line)").last.fill("Audit the HTML pages\nFix titles\nRe-audit")
    tasks.get_by_role("button", name="Save task").click()
    page.wait_for_function("() => document.querySelector(\"section[aria-label='Tasks'] [data-goal-progress]\")?.innerText.includes('0 of 3')", timeout=10_000)
    text = panel_text(page)
    check("status, progress and the next step are shown", "Active" in text.title() or "ACTIVE" in text, text[:300])
    check("the next step is the first open step", "Next: Audit the HTML pages" in text.replace("\n", " "), text[:400])
    goal = call("/api/agent/goals")["goals"][0]
    check("the task is stored for the account", goal["title"] == "Website SEO to 100" and len(goal["steps"]) == 3, goal)

    print("# pause / resume")
    tasks.get_by_role("button", name="Pause").click()
    page.wait_for_function("() => document.querySelector(\"section[aria-label='Tasks']\")?.innerText.toLowerCase().includes('paused')", timeout=10_000)
    check("paused", call("/api/agent/goals")["goals"][0]["status"] == "paused")
    tasks.get_by_role("button", name="Resume").click()
    page.wait_for_function("() => !document.querySelector(\"section[aria-label='Tasks']\")?.innerText.toLowerCase().includes('paused')", timeout=10_000)
    check("resumed", call("/api/agent/goals")["goals"][0]["status"] == "active")

    print("# the assistant checkpoints it (mock provider)")
    page.get_by_role("button", name="Back to chat").click()
    page.wait_for_selector(COMPOSER)
    step = goal["steps"][0]["id"]
    args = json.dumps({"id": goal["id"], "note": "Audit audit_e2e1 done: SEO 92", "stepId": step, "stepStatus": "completed", "nextAction": "Fix the two long titles"})
    page.locator(COMPOSER).fill(f'run goals\nCALL:load_tools:{{"group":"goals"}}\nCALL:knife_goal_checkpoint:{args}')
    page.locator(COMPOSER).press("Enter")
    page.wait_for_function("() => (document.querySelector('[role=log]')?.innerText ?? '').includes('DONE:')", timeout=30_000)
    stored = call("/api/agent/goals")["goals"][0]
    check("the checkpoint is stored (step done, next action, note)", stored["steps"][0]["status"] == "completed" and stored["nextAction"] == "Fix the two long titles" and any("audit_e2e1" in e["text"] for e in stored["events"]), stored)
    page.get_by_role("button", name="Tasks", exact=True).click()
    page.wait_for_function("() => document.querySelector(\"section[aria-label='Tasks'] [data-goal-progress]\")?.innerText.includes('1 of 3')", timeout=10_000)
    text = panel_text(page).replace("\n", " ")
    check("the panel shows the progress and the saved next action", "Next: Fix the two long titles" in text, text[:400])
    tasks.locator("summary").first.click()
    check("the history shows the assistant's note", "audit_e2e1" in panel_text(page))

    print("# Continue with assistant")
    mock("/__log", "DELETE")
    tasks.get_by_role("button", name="Continue with assistant").click()
    page.wait_for_selector(COMPOSER)
    page.wait_for_function("() => (document.querySelector('[role=log]')?.innerText ?? '').includes('ECHO: Resume saved goal')", timeout=30_000)
    users = [m["text"] for m in mock("/__log")[-1]["messages"] if m["role"] == "user"]
    check("the model receives the goal's id to resume", goal["id"] in users[-1] and "Website SEO to 100" in users[-1], users[-1:])

    print("# complete, delete")
    page.get_by_role("button", name="Tasks", exact=True).click()
    tasks.get_by_role("button", name="Complete").click()
    tasks.get_by_role("button", name="Delete").wait_for(timeout=10_000)
    check("no Continue on a finished task", tasks.get_by_role("button", name="Continue with assistant").count() == 0)
    tasks.get_by_role("button", name="Delete").click()
    page.wait_for_function("() => document.querySelector(\"section[aria-label='Tasks']\")?.innerText.includes('No saved tasks yet')", timeout=10_000)
    check("deleted from the account", call("/api/agent/goals")["goals"] == [])
    browser.close()

print(f"\n{'FAILED: ' + ', '.join(failures) if failures else 'all checks passed'}")
sys.exit(1 if failures else 0)
