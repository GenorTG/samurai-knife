"""CV studio driven by the floating assistant's UI tools (real browser, real routes, scripted mock provider).

Shows the widget can operate every control it needs through `page_snapshot` / `fill_field` / `click` alone: fill the job form
and click Save, edit a profile field in place, add an application in the drawer and move it along the pipeline. Each step is
verified against the CV API, not against the screen.

Start the mock:   node tests/mock_provider.mjs 3299
Start the server: KNIFE_DATA_DIR=$(mktemp -d) KNIFE_PORT=3326 npm run dev      (127.0.0.1 only, FRESH data dir)
Run:              python3 tests/cv_ui_agent_e2e.py http://127.0.0.1:3326 http://127.0.0.1:3299

Needs python3 + playwright (chromium). Never point this at a real model server.
"""
import json
import sys
import urllib.error
import urllib.request

from playwright.sync_api import Page, sync_playwright

if len(sys.argv) < 3:
    sys.exit("usage: python3 tests/cv_ui_agent_e2e.py <base_url> <mock_url>")
BASE = sys.argv[1].rstrip("/")
MOCK = sys.argv[2].rstrip("/")
MOCK_KEY = "mock-key"
SLOW = 60_000

failures: list[str] = []
console_errors: list[str] = []

PROFILE = {
    "contact": {"name": "Jan Testowy", "headline": {"pl": "Inżynier oprogramowania", "en": "Software engineer"}},
    "summary": {"pl": "Opis.", "en": "Summary."},
    "experience": [{"id": "acme", "org": "Acme", "role": {"pl": "Programista", "en": "Developer"}, "start": "2021-03", "end": None,
                    "bullets": [{"id": "acme-1", "text": {"pl": "Zbudowałem API.", "en": "Built an API."}}]}],
}


def check(name: str, ok: bool, detail: object = "") -> None:
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + ("" if ok else f"  -> {str(detail)[:300]}"))
    if not ok:
        failures.append(name)


def http_json(method: str, path: str, body: object | None = None) -> tuple[int, object]:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={"content-type": "application/json", "Origin": BASE})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, json.loads(res.read() or b"null")
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"null")


def cv() -> dict:
    return http_json("GET", "/api/cv")[1]  # type: ignore[return-value]


def storage_key(page: Page) -> str:
    return page.evaluate("fetch('/api/account').then(r => r.json()).then(a => `sk.agent.chat.v1.${a.id}:${encodeURIComponent(a.provider?.baseUrl ?? '')}:${encodeURIComponent(a.provider?.model ?? '')}`)")


def stored_messages(page: Page, key: str) -> list[dict]:
    return [m for m in json.loads(page.evaluate("k => localStorage.getItem(k) || '[]'", key)) if not (m["role"] == "notice" and m.get("level") == "usage")]


def send(page: Page, key: str, text: str) -> list[dict]:
    """Type into the composer, press Enter, wait until the turn finished; return the stored chat."""
    users_before = sum(1 for m in stored_messages(page, key) if m["role"] == "user")
    composer = page.locator("textarea[aria-label='Message the assistant']")
    composer.fill(text)
    composer.press("Enter")
    page.wait_for_function(
        """([k, n]) => {
            const m = JSON.parse(localStorage.getItem(k) || '[]');
            if (m.filter(x => x.role === 'user').length <= n) return false;
            const l = m[m.length - 1];
            return (l.role === 'assistant' && !l.tool_calls) || l.role === 'notice';
        }""",
        arg=[key, users_before], timeout=SLOW,
    )
    page.locator("button[aria-label='Send']").wait_for(timeout=SLOW)
    return stored_messages(page, key)


def tool_result(msgs: list[dict], tool: str) -> dict:
    ids = [c["id"] for m in msgs if m["role"] == "assistant" for c in m.get("tool_calls", []) if c["function"]["name"] == tool]
    for m in reversed(msgs):
        if m["role"] == "tool" and m["tool_call_id"] in ids:
            return json.loads(m["content"])
    return {}


def snapshot(page: Page, key: str) -> dict:
    return tool_result(send(page, key, "CALL:page_snapshot:{}"), "page_snapshot")


def cid(snap: dict, label: str, kind: str | None = None) -> str:
    """Id of the control with exactly this label (kind optional)."""
    for c in snap.get("controls", []):
        if c.get("label") == label and (kind is None or c["kind"] == kind):
            return c["id"]
    labels = [f'{c["kind"]}:{c.get("label")}' for c in snap.get("controls", [])][:40]
    raise AssertionError(f"no control {label!r} ({kind}) in snapshot; have {labels}")


def fill(page: Page, key: str, control: str, value: str) -> dict:
    return tool_result(send(page, key, "CALL:fill_field:" + json.dumps({"id": control, "value": value})), "fill_field")


def click(page: Page, key: str, control: str) -> dict:
    return tool_result(send(page, key, "CALL:click:" + json.dumps({"id": control})), "click")


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    page = ctx.new_page()
    page.set_default_timeout(SLOW)
    page.on("console", lambda m: console_errors.append(f"{m.type}: {m.text}") if m.type == "error" and "Failed to load resource" not in m.text else None)
    page.on("pageerror", lambda e: console_errors.append(f"pageerror: {e}"))

    assert not cv()["profile"]["experience"], "needs a FRESH KNIFE_DATA_DIR"
    status, _ = http_json("POST", "/api/cv/import", {"profile": PROFILE})
    check("seed profile imported through the API", status == 200, status)

    # Provider settings (same flow as tests/agent_widget_e2e.py) ---------------------------------------------------------------
    page.goto(BASE + "/tools/cv-studio?tab=jobs", wait_until="domcontentloaded")
    page.wait_for_function("!document.querySelector('main [role=status]')?.textContent?.match(/Loading/)")
    page.locator("button[aria-label='Open assistant']").click()
    page.wait_for_selector("[role=dialog][aria-label='Toolbox assistant']")
    if page.locator("button[aria-label='Settings']").count():
        page.locator("button[aria-label='Settings']").click()
    page.wait_for_selector("form[aria-label='Provider settings']")
    page.get_by_role("button", name="Custom", exact=True).click()
    page.get_by_label("Base URL").fill(f"{MOCK}/v1")
    page.get_by_label("Model", exact=True).fill("mock-model")
    page.get_by_label("API key").fill(MOCK_KEY)
    page.get_by_role("button", name="Connect", exact=True).click()
    # The first connection saves, tests and opens the chat by itself.
    page.wait_for_selector("textarea[aria-label='Message the assistant']")
    page.locator("[aria-label='Ask before acting']").get_by_role("radio", name="None", exact=True).click()
    key = storage_key(page)

    # 1. The assistant opens the suite on the Jobs tab -------------------------------------------------------------------------
    page.goto(BASE + "/", wait_until="networkidle")
    res = tool_result(send(page, key, 'CALL:open_tool:{"slug":"cv-studio","tab":"jobs"}'), "open_tool")
    page.wait_for_url("**/tools/cv-studio?tab=jobs")
    check("open_tool opens the CV studio Jobs tab", res.get("ok") is True, res)
    page.wait_for_function("!document.querySelector('main [role=status]')?.textContent?.match(/Loading/)")

    # 2. Fill the job form and click Save through UI tools only -----------------------------------------------------------------
    snap = snapshot(page, key)
    posting = "Platform Engineer at Zeta Cloud. Requirements: Python, SQL, Docker. Nice to have: Kubernetes."
    ids = {name: cid(snap, name) for name in ("Job link or posting text", "Company", "Job title", "Save offer")}
    check("snapshot exposes the job form controls with clear names", len(set(ids.values())) == 4, ids)
    r1 = fill(page, key, ids["Job link or posting text"], posting)
    r2 = fill(page, key, ids["Company"], "Zeta Cloud")
    r3 = fill(page, key, ids["Job title"], "Platform Engineer")
    check("fill_field typed into the form", all(r.get("ok") for r in (r1, r2, r3)), (r1, r2, r3))
    check("the Save offer button is enabled after filling", page.get_by_role("button", name="Save offer", exact=True).is_enabled())
    res = click(page, key, ids["Save offer"])
    check("click Save offer succeeded", res.get("ok") is True, res)
    page.wait_for_function("async () => (await (await fetch('/api/cv')).json()).jobs.some(j => j.company === 'Zeta Cloud')", timeout=20000)
    job = next(j for j in cv()["jobs"] if j["company"] == "Zeta Cloud")
    check("the offer was stored with the filled text, company and title", job["title"] == "Platform Engineer" and "Docker" in job["text"], job)
    check("the saved offer appears in the list", page.get_by_role("button", name="Open offer Zeta Cloud Platform Engineer", exact=True).is_visible())

    # 3. Edit requirements and track the application ---------------------------------------------------------------------------
    snap = snapshot(page, key)
    fill(page, key, cid(snap, "Requirements (one per line)", "textarea"), "Python\nSQL\nDocker")
    res = click(page, key, cid(snap, "Save requirements"))
    check("click Save requirements succeeded", res.get("ok") is True, res)
    page.wait_for_function("async () => (await (await fetch('/api/cv')).json()).jobs.some(j => j.requirements.length === 3)", timeout=15000)
    check("requirements saved one per line", next(j for j in cv()["jobs"] if j["company"] == "Zeta Cloud")["requirements"] == ["Python", "SQL", "Docker"])
    snap = snapshot(page, key)
    res = click(page, key, cid(snap, "Track application"))
    page.wait_for_function("async () => (await (await fetch('/api/cv')).json()).applications.length === 1", timeout=15000)
    app = cv()["applications"][0]
    check("Track application created a linked application", app["company"] == "Zeta Cloud" and app["jobId"] == job["id"] and app["status"] == "wishlist", app)

    # 4. Applications tab: drawer form + quick status buttons --------------------------------------------------------------------
    res = tool_result(send(page, key, 'CALL:open_tool:{"slug":"cv-studio","tab":"applications"}'), "open_tool")
    check("open_tool switches to the Applications tab", res.get("ok") is True and "tab=applications" in page.url, (res, page.url))
    page.wait_for_function("document.body.innerText.includes('Zeta Cloud')")
    snap = snapshot(page, key)
    click(page, key, cid(snap, "Add application"))
    page.get_by_role("dialog", name="Add application").wait_for()
    snap = snapshot(page, key)
    fill(page, key, cid(snap, "Company", "input"), "Omega Labs")
    fill(page, key, cid(snap, "Role", "input"), "Data Engineer")
    fill(page, key, cid(snap, "Status", "select"), "Applied")
    fill(page, key, cid(snap, "Saved link", "input"), "https://example.com/careers/omega-1")
    fill(page, key, cid(snap, "Next action", "input"), "Follow up after a week")
    res = click(page, key, cid(snap, "Save application"))
    check("click Save application succeeded", res.get("ok") is True, res)
    page.wait_for_function("async () => (await (await fetch('/api/cv')).json()).applications.some(a => a.company === 'Omega Labs')", timeout=15000)
    omega = next(a for a in cv()["applications"] if a["company"] == "Omega Labs")
    check("the drawer form stored status, saved link and next action", omega["status"] == "applied" and omega["url"].endswith("omega-1") and omega["nextAction"] == "Follow up after a week", omega)
    snap = snapshot(page, key)
    res = click(page, key, cid(snap, "Move Omega Labs Data Engineer to Screening"))
    page.wait_for_function("async () => (await (await fetch('/api/cv')).json()).applications.some(a => a.company === 'Omega Labs' && a.status === 'screening')", timeout=15000)
    omega = next(a for a in cv()["applications"] if a["company"] == "Omega Labs")
    check("a quick status button moved the application and logged history", [h["status"] for h in omega["history"]] == ["applied", "screening"], omega["history"])

    # 5. Profile: open the inline editor, fill it, press Save -----------------------------------------------------------------------
    send(page, key, 'CALL:open_tool:{"slug":"cv-studio","tab":"profile"}')
    page.wait_for_function("document.body.innerText.includes('Jan Testowy')")
    page.get_by_role("radio", name="English", exact=True).click()
    snap = snapshot(page, key)
    res = click(page, key, cid(snap, "Edit Headline (EN)"))
    snap = snapshot(page, key)

    fill(page, key, cid(snap, "Headline (EN)", "textarea"), "Staff software engineer")
    res = click(page, key, cid(snap, "Save Headline (EN)"))
    check("click Save on the inline editor succeeded", res.get("ok") is True, res)
    page.wait_for_function("async () => (await (await fetch('/api/cv')).json()).profile.contact.headline.en === 'Staff software engineer'", timeout=15000)
    check("the inline edit made by the assistant is stored", cv()["profile"]["contact"]["headline"]["en"] == "Staff software engineer")
    check("the change toast with Undo is on screen", page.locator("[data-cv-toast]").filter(has_text="Undo").count() >= 1)

    # 6. The widget never shows up in the CV page snapshot --------------------------------------------------------------------------
    snap = snapshot(page, key)
    check("snapshot excludes the widget itself", not any("assistant" in c.get("label", "").lower() for c in snap.get("controls", [])))
    check("no console errors during the whole run", not console_errors, console_errors[:3])

    browser.close()

if failures:
    print(f"\n{len(failures)} failed: {failures}")
    sys.exit(1)
print("\nall CV studio agent checks passed")
