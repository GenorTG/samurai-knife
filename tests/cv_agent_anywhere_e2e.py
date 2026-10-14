"""The assistant can use the CV studio from ANY page (real browser, scripted mock provider, real routes):
the `cv` tool group is not sent on unrelated pages, the system prompt teaches it, `load_tools {group:"cv"}` brings it in
anywhere, and applications saved through it (with the day they were applied to) show up in the CV studio and can be
asked for as "still open". Oracles are the CV API and the request the mock provider really received (GET /__last).

  node tests/mock_provider.mjs 3299
  KNIFE_DATA_DIR=$(mktemp -d) KNIFE_PORT=3239 npm run dev      (FRESH data dir)
  python3 tests/cv_agent_anywhere_e2e.py http://127.0.0.1:3239 http://127.0.0.1:3299
"""
import datetime
import json
import sys
import urllib.request

from playwright.sync_api import Page, sync_playwright

BASE, MOCK = sys.argv[1].rstrip("/"), sys.argv[2].rstrip("/")
failures: list[str] = []
errors: list[str] = []


def check(name: str, ok: bool, detail: object = "") -> None:
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + ("" if ok else f"  -> {detail}"))
    if not ok:
        failures.append(name)


def put_provider() -> None:
    body = {"baseUrl": f"{MOCK}/v1", "model": "mock-model", "apiKey": "mock-key"}
    req = urllib.request.Request(BASE + "/api/account/provider", data=json.dumps(body).encode(), method="PUT",
                                 headers={"content-type": "application/json", "Origin": BASE})
    urllib.request.urlopen(req, timeout=30).read()


def last_tools() -> list[str]:
    body = json.loads(urllib.request.urlopen(MOCK + "/__last", timeout=10).read())
    request = body.get("body", body)
    return [t["function"]["name"] for t in request.get("tools", [])]


def history(page: Page, k: str) -> list[dict]:
    return json.loads(page.evaluate("k => localStorage.getItem(k) || '[]'", k))


def run(page: Page, k: str, text: str) -> dict:
    """Send a prompt, wait for the footer of that turn, return it."""
    n = sum(1 for m in history(page, k) if m["role"] == "user") + 1
    box = page.locator("textarea[aria-label='Message the assistant']")
    box.fill(text)
    box.press("Enter")
    page.wait_for_function(
        """([k, n]) => { const m = JSON.parse(localStorage.getItem(k) || '[]');
           if (m.filter(x => x.role === 'user').length < n) return false;
           const l = m[m.length - 1]; return l.role === 'notice' && l.level === 'usage'; }""",
        arg=[k, n], timeout=30_000)
    return history(page, k)[-1]


def tool_results(page: Page, k: str, name: str) -> list[dict]:
    ms = history(page, k)
    ids = {c["id"] for m in ms if m["role"] == "assistant" for c in m.get("tool_calls", []) if c["function"]["name"] == name}
    out = []
    for m in ms:
        if m["role"] == "tool" and m["tool_call_id"] in ids:
            try:
                out.append(json.loads(m["content"]))
            except ValueError:
                pass
    return out


def open_panel(page: Page, url: str) -> str:
    page.goto(BASE + url, wait_until="networkidle")
    page.keyboard.press("Control+j")
    page.wait_for_selector("[role=dialog][aria-label='Toolbox assistant']")
    return page.evaluate("fetch('/api/account').then(r => r.json()).then(a => `sk.agent.chat.v1.${a.id}:${encodeURIComponent(a.provider?.baseUrl ?? '')}:${encodeURIComponent(a.provider?.model ?? '')}`)")



TODAY = datetime.date.today().isoformat()


def api(path: str, body: object | None = None) -> dict:
    req = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(),
                                 method="GET" if body is None else "POST",
                                 headers={"content-type": "application/json", "Origin": BASE})
    return json.loads(urllib.request.urlopen(req, timeout=30).read())


def system_prompt() -> str:
    body = json.loads(urllib.request.urlopen(MOCK + "/__last", timeout=10).read())
    request = body.get("body", body)
    return "\n".join(m["content"] for m in request["messages"] if m["role"] == "system" and isinstance(m["content"], str))


def raw_results(page: Page, k: str, name: str) -> list[str]:
    ms = history(page, k)
    ids = {c["id"] for m in ms if m["role"] == "assistant" for c in m.get("tool_calls", []) if c["function"]["name"] == name}
    return [m["content"] for m in ms if m["role"] == "tool" and m["tool_call_id"] in ids]


def call(page: Page, k: str, tool: str, args: dict):
    """Run one scripted tool call; return its parsed JSON result (or the raw text when it is not JSON)."""
    run(page, k, f"CALL:{tool}:{json.dumps(args, ensure_ascii=False)}")
    res = raw_results(page, k, tool)
    if not res:
        return {}
    try:
        return json.loads(res[-1])
    except ValueError:
        return res[-1]


put_provider()
profile = {"contact": {"name": "Jan Test"}, "summary": {"pl": "Programista", "en": "Developer"},
           "experience": [{"id": "acme", "org": "Acme", "bullets": [{"id": "b1", "text": {"pl": "Zbudowałem API", "en": "Built an API"}}]}]}
check("fresh data dir: import a synthetic profile", "revision" in api("/api/cv/import", {"profile": profile}))

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_context(viewport={"width": 1440, "height": 900}).new_page()
    page.on("console", lambda m: errors.append(m.text[:200]) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)[:200]))

    # 1) an unrelated page: no cv tools in the request, but the prompt teaches the group and load_tools offers it
    k = open_panel(page, "/tools/json")
    run(page, k, "hello")
    tools = last_tools()
    check("json page: no knife_cv_ tools sent (prefix diet)", not any(t.startswith("knife_cv_") for t in tools), [t for t in tools if t.startswith("knife_cv")])
    prompt = system_prompt()
    check("system prompt teaches the cv group and the truthfulness rule", 'load_tools {group:"cv"}' in prompt and "never invent employers" in prompt, prompt[-400:])
    check("system prompt covers applied-on tracking and open applications", "appliedOn" in prompt and "open:true" in prompt, "")

    # 2) load the group from here and work with the real data
    loaded = call(page, k, "load_tools", {"group": "cv"})
    check("load_tools {cv} succeeds and lists the cv tools", loaded.get("ok") is True and "knife_cv_patch" in loaded.get("tools", []) and "knife_cv_app_list" in loaded.get("tools", []), loaded)
    check("next round sends the cv tools", "knife_cv_get" in last_tools() and "knife_cv_app_save" in last_tools(), last_tools())
    got = call(page, k, "knife_cv_get", {"path": "/experience/id=acme/org"})
    check("knife_cv_get reads the real profile from a non-CV page", got == "Acme", got)

    saved = call(page, k, "knife_cv_job_save", {"company": "Globex", "title": "Backend Dev", "url": "https://example.com/jobs/1", "requirements": ["Python"]})
    job_id = saved.get("id", "") if isinstance(saved, dict) else ""
    check("a job offer link is saved with its id", job_id == "globex-backend-dev", saved)
    a1 = call(page, k, "knife_cv_app_save", {"company": "Globex", "role": "Backend Dev", "status": "applied", "jobId": job_id, "url": "https://example.com/jobs/1", "nextAction": "Follow up", "nextActionDue": TODAY})
    a2 = call(page, k, "knife_cv_app_save", {"company": "Initech", "role": "SRE", "status": "wishlist"})
    a3 = call(page, k, "knife_cv_app_save", {"company": "Hooli", "role": "Dev", "status": "applied", "appliedOn": "2026-09-01"})
    call(page, k, "knife_cv_app_save", {"id": "hooli-dev", "status": "rejected", "note": "no thanks"})
    cv = api("/api/cv")
    apps = {a["id"]: a for a in cv["applications"]}
    check("applied status stamps today's date automatically (API oracle)", apps["globex-backend-dev"]["appliedOn"] == TODAY, apps.get("globex-backend-dev"))
    check("wishlist has no applied date; explicit backfill is kept", apps["initech-sre"]["appliedOn"] is None and apps["hooli-dev"]["appliedOn"] == "2026-09-01", apps)

    listed = call(page, k, "knife_cv_app_list", {"open": True})
    body = listed
    open_ids = [a["id"] for a in body["applications"]]
    check("open=true lists only unfinished applications (rejected one excluded)", sorted(open_ids) == ["globex-backend-dev", "initech-sre"], open_ids)
    check("counts and days-since-applied are reported", body["counts"]["open"] == 2 and body["counts"]["inProgress"] == 1 and body["today"] == TODAY and body["applications"][0]["daysSinceApplied"] in (0, None), body["counts"])
    closed = call(page, k, "knife_cv_app_list", {"open": False})
    check("open=false shows the closed one with the day it closed", [a["id"] for a in closed["applications"]] == ["hooli-dev"] and closed["applications"][0]["closedOn"] == TODAY, closed)
    due = call(page, k, "knife_cv_app_due", {})
    check("follow-up due today is reported with its applied date", [a["id"] for a in due["due"]] == ["globex-backend-dev"] and due["due"][0]["appliedOn"] == TODAY, due)
    jl = call(page, k, "knife_cv_job_list", {})
    check("the offer list says which offers were applied to and when", jl[0]["application"] == {"id": "globex-backend-dev", "status": "applied", "appliedOn": TODAY}, jl)

    # 3) the user sees it in the CV studio: applied date on the card, offer badge with the date
    page.goto(BASE + "/tools/cv-studio?tab=applications", wait_until="networkidle")
    card = page.locator("[data-cv-path='/applications/id=globex-backend-dev']")
    card.wait_for(timeout=15_000)
    check("application card shows the applied date", card.locator(f"[data-applied-on='{TODAY}']").count() == 1, card.inner_text()[:200])
    page.goto(BASE + "/tools/cv-studio?tab=jobs", wait_until="networkidle")
    page.get_by_text(f"applied · {TODAY}").first.wait_for(timeout=15_000)
    check("the offer list badge shows status and applied date", True)
    page.goto(BASE + "/tools/cv-studio?tab=applications", wait_until="networkidle")
    page.get_by_role("button", name="Edit Globex Backend Dev").click()
    check("edit drawer has an 'Applied on' date field with the stored value", page.get_by_label("Applied on").input_value() == TODAY, "")

    # 4) cv tools preloaded on the studio page itself
    k2 = open_panel(page, "/tools/cv-studio?tab=profile")
    page.locator("button[aria-label='Clear conversation']").click()
    run(page, k2, "hello")
    check("cv-studio page: cv tools preloaded without load_tools", "knife_cv_get" in last_tools() and "knife_cv_app_list" in last_tools(), [t for t in last_tools() if t.startswith("knife_cv")][:4])
    browser.close()

check("zero console errors", not errors, errors[:3])
print("\nall checks passed" if not failures else f"\n{len(failures)} FAILED: {failures}")
sys.exit(1 if failures else 0)
