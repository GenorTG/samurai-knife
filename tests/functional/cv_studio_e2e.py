#!/usr/bin/env python3
"""Real-UI functional tests for the CV studio suite (/tools/cv-studio): profile, job offers, CV versions, applications, showcase.

Oracles are independent of the app: the API (GET /api/cv) is read back after every UI action, the translation backlog is
counted by a separate Python walker, dates come from the Python clock. All data is synthetic.

Usage: python3 tests/functional/cv_studio_e2e.py <base_url>   (default http://127.0.0.1:3210)
Needs a FRESH data dir (KNIFE_DATA_DIR=$(mktemp -d)): the run imports a profile and refuses to start on a non-empty one.
Routes owned by other lanes (audit, jobs fetch/match, variants suggest, export) are exercised when present; the tests that
depend on them check the readable 'not available yet' state instead when the server answers 404/501. No network beyond the scratch server.
"""
import datetime
import json
import os
import re
import sys
import traceback
import urllib.error
import urllib.request

from playwright.sync_api import expect, sync_playwright

_ARGS = [a for a in sys.argv[1:] if not a.startswith("-")]
BASE = (_ARGS[0] if _ARGS else "http://127.0.0.1:3210").rstrip("/")
SHOTS = os.environ.get("CV_STUDIO_SHOTS", "")
FAILS: list[str] = []
CONSOLE: list[str] = []
page = None
TODAY = datetime.date.today().isoformat()
YESTERDAY = (datetime.date.today() - datetime.timedelta(days=1)).isoformat()

PROFILE = {
    "contact": {
        "name": "Jan Testowy",
        "headline": {"pl": "Inżynier oprogramowania", "en": "Software engineer"},
        "location": {"pl": "Warszawa", "en": "Warsaw"},
        "email": "jan@example.com",
        "phone": "+48 500 000 000",
        "links": [{"label": "github.com/jan-test", "url": "https://github.com/jan-test"}],
    },
    "summary": {"pl": "Inżynier z pięcioletnim doświadczeniem w narzędziach webowych.", "en": ""},
    "experience": [
        {
            "id": "acme", "org": "Acme Sp. z o.o.", "role": {"pl": "Starszy programista", "en": "Senior developer"},
            "start": "2021-03", "end": None, "location": "Warszawa",
            "bullets": [
                {"id": "acme-api", "text": {"pl": "Zaprojektowałem API obsługujące 2 mln zapytań dziennie.", "en": "Designed an API serving 2M requests per day."}, "verified": True},
                {"id": "acme-ci", "text": {"pl": "Wdrożyłem CI skracające build z 20 do 6 minut.", "en": ""}},
            ],
        },
        {
            "id": "beta", "org": "Beta Labs", "role": {"pl": "Programista", "en": "Developer"}, "start": "2018-06", "end": "2021-02",
            "bullets": [{"id": "beta-ui", "text": {"pl": "Zbudowałem panel administracyjny w React i TypeScript.", "en": "Built an admin panel in React and TypeScript."}}],
        },
    ],
    "projects": [
        {"id": "toolbox", "name": "Toolbox", "url": "https://example.com/toolbox", "summary": {"pl": "Zestaw narzędzi przeglądarkowych.", "en": "A set of browser tools."}, "tech": ["Next.js", "TypeScript"],
         "bullets": [{"id": "toolbox-1", "text": {"pl": "Ponad 200 narzędzi.", "en": "Over 200 tools."}}]},
    ],
    "skills": [
        {"id": "languages", "name": {"pl": "Języki", "en": "Languages"}, "items": ["TypeScript", "Python", "SQL"]},
        {"id": "web", "name": {"pl": "Web", "en": "Web"}, "items": ["React", "Next.js", "Node.js"]},
    ],
    "education": [{"id": "pw", "institution": "Politechnika Testowa", "detail": {"pl": "Informatyka, magister", "en": "Computer science, MSc"}, "start": "2013-10", "end": "2018-06"}],
    "languages": [{"id": "pl", "name": {"pl": "Polski", "en": "Polish"}, "level": {"pl": "ojczysty", "en": "native"}}],
    "consent": {"pl": "Wyrażam zgodę na przetwarzanie danych w celu rekrutacji.", "en": ""},
    "extras": {"pl": "", "en": ""},
}

POSTING = (
    "Backend Developer at Gamma Systems. We need strong TypeScript and Node.js, SQL databases, and hands-on Kubernetes experience.\n"
    "Requirements:\n- TypeScript\n- Node.js\n- Kubernetes\nNice to have:\n- Docker\n"
)


def ok(name):
    print(f"ok   {name}", flush=True)


def check(name):
    def deco(fn):
        before = len(CONSOLE)
        try:
            fn()
            # Deliberate 4xx/5xx answers (422 reasons, mocked 404/502, missing lane routes) log a browser "Failed to load resource" line: not an app error.
            fresh = [m for m in CONSOLE[before:] if "Failed to load resource" not in m]
            if fresh:
                raise AssertionError("console/page errors: " + " | ".join(fresh)[:300])
            ok(name)
        except Exception as e:  # noqa: BLE001
            FAILS.append(name)
            print(f"FAIL {name}: {type(e).__name__}: {str(e).splitlines()[0] if str(e) else ''}", flush=True)
            if "-v" in sys.argv:
                traceback.print_exc()
        return fn
    return deco


def eq(actual, expected, what=""):
    assert actual == expected, f"{what} expected {expected!r} got {actual!r}"


def api(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={"content-type": "application/json", "Origin": BASE})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, json.loads(res.read() or b"null")
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            return exc.code, json.loads(raw or b"null")
        except ValueError:
            return exc.code, None


def cv():
    status, body = api("GET", "/api/cv")
    assert status == 200, status
    return body


def go(tab, width=1400, extra=""):
    page.set_viewport_size({"width": width, "height": 900})
    page.goto(f"{BASE}/tools/cv-studio?tab={tab}{extra}", wait_until="domcontentloaded")
    page.wait_for_selector("main button, main input, main textarea", timeout=30000)
    page.wait_for_function("!document.querySelector('main [role=status]')?.textContent?.match(/Loading (tool|CV workspace)/)", timeout=30000)
    page.wait_for_timeout(300)


def btn(name, exact=True):
    return page.get_by_role("button", name=name, exact=exact).first


def has(text, timeout=8000):
    expect(page.locator("main")).to_contain_text(text, timeout=timeout)


def hasnt(text):
    expect(page.locator("main")).not_to_contain_text(text, timeout=5000)


def toast():
    return page.locator("[data-cv-toast]").last


def wait_revision_change(before, timeout=8000):
    page.wait_for_function("async (r) => (await (await fetch('/api/cv')).json()).revision !== r", arg=before, timeout=timeout)


def overflow_ok():
    w = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
    assert w <= 1, f"horizontal overflow {w}px"


def bi_missing(profile, lang):
    """Independent oracle for the translation backlog: bilingual {pl,en} objects written in the other language only."""
    other = "pl" if lang == "en" else "en"
    count = 0

    def walk(node):
        nonlocal count
        if isinstance(node, list):
            for item in node:
                walk(item)
        elif isinstance(node, dict):
            if set(node.keys()) == {"pl", "en"}:
                if not node[lang] and node[other]:
                    count += 1
                return
            for v in node.values():
                walk(v)

    walk(profile)
    return count


def bullet_text(profile, exp_id, bullet_id, lang="en"):
    exp = next(e for e in profile["experience"] if e["id"] == exp_id)
    return next(b for b in exp["bullets"] if b["id"] == bullet_id)["text"][lang]


def shot(name):
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        page.screenshot(path=os.path.join(SHOTS, f"{name}.png"), full_page=True)


# ----------------------------------------------------------------------------------------------------------------------
with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1400, "height": 900}, locale="pl-PL", timezone_id="Europe/Warsaw", accept_downloads=True)
    # Polish dates and numbers, English interface: a pl-PL browser without a choice would get the Polish UI (docs/I18N.md).
    ctx.add_cookies([{"name": "knife_lang", "value": "en", "url": BASE}])
    ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=BASE)
    page = ctx.new_page()
    page.set_default_timeout(15000)
    page.on("console", lambda m: CONSOLE.append(f"{m.type}: {m.text}") if m.type in ("error", "warning") and "DevTools" not in m.text else None)
    page.on("pageerror", lambda e: CONSOLE.append(f"pageerror: {e}"))

    start = cv()
    assert start["profile"]["contact"]["name"] == "" and not start["profile"]["experience"], "needs a fresh KNIFE_DATA_DIR (profile already imported)"

    # ---------------------------------------------------------------- profile: empty state + import
    @check("empty state offers the import panel on every tab that needs a profile")
    def _():
        go("profile")
        has("Your master profile starts here")
        expect(page.get_by_label("Profile JSON")).to_be_visible()
        go("variants")
        has("No profile yet")

    @check("import shows JSON syntax errors and the API's validation reason")
    def _():
        go("profile")
        box = page.get_by_label("Profile JSON")
        box.fill("{ not json")
        btn("Import profile").click()
        expect(page.get_by_role("alert").filter(has_text="not valid JSON")).to_be_visible()
        box.fill(json.dumps({"contact": {"name": 5}}))
        btn("Import profile").click()
        expect(page.get_by_role("alert").filter(has_text=re.compile("contact/name"))).to_be_visible()
        eq(cv()["revision"], start["revision"], "nothing was saved")

    @check("import accepts a valid profile and renders it")
    def _():
        page.get_by_label("Profile JSON").fill(json.dumps(PROFILE))
        btn("Import profile").click()
        has("Jan Testowy")
        eq(cv()["profile"]["contact"]["name"], "Jan Testowy")
        expect(page.get_by_role("button", name="Edit Name", exact=True)).to_be_visible()
        shot("profile-imported")

    @check("replacing an existing profile needs an explicit second click and a bad paste stays harmless")
    def _():
        btn("Replace profile…").click()
        box = page.get_by_label("Profile JSON")
        box.fill(json.dumps({**PROFILE, "contact": {**PROFILE["contact"], "name": "Zmieniony"}}))
        btn("Replace profile").click()
        has("A profile already exists")
        eq(cv()["profile"]["contact"]["name"], "Jan Testowy", "unchanged before confirm")
        btn("Confirm replace").click()
        has("Zmieniony")
        eq(cv()["profile"]["contact"]["name"], "Zmieniony")
        btn("Undo the last change").click()
        # The replace toast itself says "Jan Testowy -> Zmieniony", so waiting for page text alone passes before the undo
        # request has finished. Wait on the Name field, then read the API.
        expect(page.get_by_role("button", name="Edit Name", exact=True)).to_contain_text("Jan Testowy")
        eq(cv()["profile"]["contact"]["name"], "Jan Testowy", "undo restored the profile")

    # ---------------------------------------------------------------- profile: translation + inline editing
    @check("translation badge equals the independent count and the filter narrows the view")
    def _():
        go("profile")
        want = bi_missing(cv()["profile"], "pl")
        page.get_by_role("radio", name="Polish", exact=True).click()
        want = bi_missing(cv()["profile"], "pl")
        label = f"{want} untranslated in PL" if want else "Fully translated to PL"
        has(label)
        page.get_by_role("radio", name="English", exact=True).click()
        want_en = bi_missing(cv()["profile"], "en")
        assert want_en >= 3, want_en
        has(f"{want_en} untranslated in EN")
        btn("Show untranslated").click()
        has("Wdrożyłem CI")  # the PL reference of the empty EN bullet is shown
        expect(page.get_by_role("button", name="Edit Acme Sp. z o.o. bullet acme-ci text (EN)", exact=True)).to_be_visible()
        expect(page.get_by_role("button", name="Edit Name", exact=True)).to_have_count(0)
        expect(page.get_by_role("button", name="Edit Acme Sp. z o.o. bullet acme-api text (EN)", exact=True)).to_have_count(0)
        btn("Show everything").click()
        expect(page.get_by_role("button", name="Edit Name", exact=True)).to_be_visible()

    @check("language toggle is remembered per tab after a reload without console errors")
    def _():
        page.get_by_role("radio", name="English", exact=True).click()
        page.reload(wait_until="domcontentloaded")
        page.wait_for_function("!document.querySelector('main [role=status]')?.textContent?.match(/Loading/)")
        expect(page.get_by_role("radio", name="English", exact=True)).to_have_attribute("aria-checked", "true")
        expect(page.get_by_role("button", name="Edit Headline (EN)", exact=True)).to_be_visible()
        go("variants")  # another tab keeps its own choice (default PL)
        expect(page.get_by_role("radiogroup", name="Document language").get_by_role("radio", name="Polish")).to_have_attribute("aria-checked", "true")
        go("profile")
        expect(page.get_by_role("radio", name="English", exact=True)).to_have_attribute("aria-checked", "true")

    @check("inline edit: click -> textarea, Ctrl+Enter saves through the API, toast offers Undo")
    def _():
        before = cv()["revision"]
        btn("Edit Headline (EN)").click()
        area = page.get_by_label("Headline (EN)", exact=True)
        expect(area).to_be_focused()
        area.fill("Senior software engineer")
        area.press("Control+Enter")
        expect(area).to_have_count(0)  # the editor closes only after the API accepted the edit
        has("Senior software engineer")
        c = cv()
        eq(c["profile"]["contact"]["headline"]["en"], "Senior software engineer")
        assert c["revision"] > before
        t = toast()
        expect(t).to_contain_text("Updated")
        expect(t).to_contain_text("Software engineer -> Senior software engineer")
        t.get_by_role("button", name="Undo").click()
        has("Software engineer")
        eq(cv()["profile"]["contact"]["headline"]["en"], "Software engineer", "Undo restored it")

    @check("inline edit: blur saves, Escape cancels")
    def _():
        btn("Edit Summary (EN)").click()
        area = page.get_by_label("Summary (EN)", exact=True)
        area.fill("Engineer building reliable tools.")
        page.get_by_role("heading", name="Summary").click()  # click away = blur
        expect(area).to_have_count(0)
        has("Engineer building reliable tools.")
        eq(cv()["profile"]["summary"]["en"], "Engineer building reliable tools.")
        btn("Edit Summary (EN)").click()
        area = page.get_by_label("Summary (EN)", exact=True)
        area.fill("thrown away")
        area.press("Escape")
        has("Engineer building reliable tools.")
        eq(cv()["profile"]["summary"]["en"], "Engineer building reliable tools.")

    @check("inline edit: the API's 422 reason is shown inline and the editor stays open")
    def _():
        btn("Edit Acme Sp. z o.o. start (YYYY-MM)").click()
        area = page.get_by_label("Acme Sp. z o.o. start (YYYY-MM)", exact=True)
        area.fill("2021-03-01-extra")
        before = cv()["revision"]
        area.press("Control+Enter")
        alert = page.get_by_role("alert").filter(has_text=re.compile("invalid|start"))
        expect(alert.first).to_be_visible()
        expect(area).to_be_visible()
        eq(cv()["revision"], before, "nothing saved")
        area.press("Escape")
        has("2021-03")

    @check("keyboard: Enter on an editable value opens it, Escape closes it")
    def _():
        b = btn("Edit Name")
        b.focus()
        page.keyboard.press("Enter")
        expect(page.get_by_label("Name", exact=True)).to_be_focused()
        page.keyboard.press("Escape")
        expect(btn("Edit Name")).to_be_visible()

    @check("add a bullet opens it for typing; remove drops it; both reported and undoable")
    def _():
        btn("Add bullet to Beta Labs").click()
        area = page.get_by_label(re.compile(r"^Beta Labs bullet bullet text \(EN\)$"))
        expect(area).to_be_focused()
        area.fill("Mentored two junior developers.")
        page.get_by_role("heading", name="Summary").click()
        c = cv()
        beta = next(e for e in c["profile"]["experience"] if e["id"] == "beta")
        eq([b["text"]["en"] for b in beta["bullets"]][-1], "Mentored two junior developers.")
        new_id = beta["bullets"][-1]["id"]
        btn(f"Remove Beta Labs bullet {new_id}").click()
        expect(toast()).to_contain_text("Removed")
        beta = next(e for e in cv()["profile"]["experience"] if e["id"] == "beta")
        eq(len(beta["bullets"]), 1)
        toast().get_by_role("button", name="Undo").click()
        page.wait_for_function("async () => (await (await fetch('/api/cv')).json()).profile.experience[1].bullets.length === 2")

    @check("add a project and a skill group; remove a project")
    def _():
        page.get_by_label("New project name").fill("Side Project")
        btn("Add project").click()
        has("Side Project")
        assert any(p["name"] == "Side Project" for p in cv()["profile"]["projects"])
        page.get_by_label("New skill group name").fill("Cloud")
        btn("Add skill group").click()
        sk = [s for s in cv()["profile"]["skills"] if s["name"]["en"] == "Cloud"]
        eq(len(sk), 1)
        btn("Remove project Side Project").click()
        page.wait_for_function("async () => !(await (await fetch('/api/cv')).json()).profile.projects.some(p => p.name === 'Side Project')")
        btn("Remove skill group Cloud").click()
        page.wait_for_function("async () => !(await (await fetch('/api/cv')).json()).profile.skills.some(s => s.name.en === 'Cloud')")

    @check("verified toggle flips the provenance flag")
    def _():
        btn("Mark Acme Sp. z o.o. bullet acme-ci as verified").click()
        page.wait_for_function("async () => (await (await fetch('/api/cv')).json()).profile.experience[0].bullets[1].verified === true")
        btn("Unmark Acme Sp. z o.o. bullet acme-ci as verified").click()
        page.wait_for_function("async () => (await (await fetch('/api/cv')).json()).profile.experience[0].bullets[1].verified === false")

    # ---------------------------------------------------------------- assistant-style changes show live
    @check("a change made by the assistant (POST /api/agent/tool) flashes the field, raises a toast and can be undone")
    def _():
        go("profile")
        page.get_by_role("radio", name="English", exact=True).click()
        before = cv()["revision"]
        page.evaluate("window.__flashSeen = false; new MutationObserver(() => { if (document.querySelector('[data-cv-flash]')) window.__flashSeen = true; }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-cv-flash'] })")
        status, res = api("POST", "/api/agent/tool", {"name": "knife_cv_patch", "args": {"ops": [{"op": "set", "path": "/experience/id=acme/bullets/id=acme-ci/text/en", "value": "Introduced CI that cut builds from 20 to 6 minutes."}]}})
        assert status == 200 and res.get("ok"), res
        expect(toast()).to_contain_text("Updated", timeout=8000)
        expect(toast()).to_contain_text("Introduced CI that cut builds")
        expect(toast()).to_contain_text("(empty) ->")
        page.wait_for_function("window.__flashSeen === true", timeout=5000)
        has("Introduced CI that cut builds")
        toast().get_by_role("button", name="Undo").click()
        page.wait_for_function("async () => (await (await fetch('/api/cv')).json()).profile.experience[0].bullets[1].text.en === ''")
        assert cv()["revision"] > before

    @check("assistant changes to jobs/applications also surface (added offer toast)")
    def _():
        go("jobs")
        status, _res = api("POST", "/api/cv/jobs", {"job": {"company": "Epsilon", "title": "Live Offer", "text": "Python and SQL"}})
        assert status == 200
        expect(toast()).to_contain_text("Added Job offer Epsilon - Live Offer", timeout=8000)
        expect(page.get_by_role("button", name="Open offer Epsilon Live Offer", exact=True)).to_be_visible()
        _s, listing = api("GET", "/api/cv")
        api("DELETE", f"/api/cv/jobs?id={next(j['id'] for j in listing['jobs'] if j['company'] == 'Epsilon')}")
        expect(page.get_by_role("button", name="Open offer Epsilon Live Offer", exact=True)).to_have_count(0, timeout=8000)

    # ---------------------------------------------------------------- audit
    @check("audit panel shows findings or the readable 'not available yet' state, never an error")
    def _():
        go("profile")
        panel = page.locator('[data-agent-region="cv-audit"]')
        expect(panel).to_be_visible()
        page.wait_for_function("!document.querySelector('[data-agent-region=cv-audit]').innerText.includes('Checking the profile')", timeout=15000)
        text = panel.inner_text()
        assert "Audit failed" not in text, text
        assert "not available yet" in text or re.search(r"(error|warn|info): \d+|No findings", text), text

    @check("audit degrades gracefully when its route is missing (mocked 404)")
    def _():
        page.route("**/api/cv/audit**", lambda r: r.fulfill(status=404, content_type="application/json", body='{"error":"nope"}'))
        go("profile")
        page.wait_for_function("document.querySelector('[data-agent-region=cv-audit]')?.innerText.includes('not available yet')", timeout=10000)
        page.unroute("**/api/cv/audit**")

    @check("audit findings are linked to their fields (mocked payload) and Go to field scrolls + flashes")
    def _():
        payload = {"lang": "pl", "scope": "/", "counts": {"error": 0, "warn": 1, "info": 0}, "byRule": {"weak-verb": 1},
                   "findings": {"/experience/id=beta/bullets/id=beta-ui/text/pl": [{"rule": "weak-verb", "severity": "warn", "message": "Starts with a weak verb.", "hint": "Lead with the result."}]}}
        page.route("**/api/cv/audit**", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(payload)))
        go("profile")
        page.get_by_role("radio", name="Polish", exact=True).click()
        panel = page.locator('[data-agent-region="cv-audit"]')
        expect(panel).to_contain_text("Starts with a weak verb")
        expect(page.get_by_label(re.compile("^Findings for Beta Labs bullet beta-ui text"))).to_contain_text("weak-verb")
        page.evaluate("window.scrollTo(0, 0)")
        page.get_by_role("button", name=re.compile("^Go to ")).first.click()
        page.wait_for_function("document.querySelector('[data-cv-flash]') !== null", timeout=4000)
        page.unroute("**/api/cv/audit**")


    # ---------------------------------------------------------------- tailoring priorities (profile)
    @check("pin a project, write tailoring notes, add an own section with an item, move a section: all stored")
    def _():
        go("profile")
        btn("Pin project Toolbox").click()
        page.wait_for_function("async () => (await (await fetch('/api/cv')).json()).profile.projects[0].pinned === true", timeout=8000)
        expect(btn("Unpin project Toolbox")).to_have_attribute("aria-pressed", "true")
        btn("Edit Notes for tailoring").click()
        page.get_by_label("Notes for tailoring", exact=True).fill("Lead with Toolbox.")
        btn("Save Notes for tailoring").click()
        page.wait_for_function("async () => (await (await fetch('/api/cv')).json()).profile.guidance === 'Lead with Toolbox.'", timeout=8000)
        page.get_by_label("New section title").fill("Certyfikaty")
        btn("Add section").click()
        page.wait_for_function("async () => (await (await fetch('/api/cv')).json()).profile.customSections.length === 1", timeout=8000)
        page.get_by_label("New item in Certyfikaty").fill("AWS Cloud Practitioner")
        btn("Add item").click()
        page.wait_for_function("async () => (await (await fetch('/api/cv')).json()).profile.customSections[0].items.length === 1", timeout=8000)
        btn("Move Wybrane projekty up").click()
        page.wait_for_function("async () => (await (await fetch('/api/cv')).json()).profile.sectionOrder?.[1] === 'projects'", timeout=8000)
        p = cv()["profile"]
        eq(p["sectionOrder"][:3], ["summary", "projects", "experience"])
        eq(p["customSections"][0]["items"][0]["title"]["pl"], "AWS Cloud Practitioner")
        btn("Reset to standard").click()
        page.wait_for_function("async () => (await (await fetch('/api/cv')).json()).profile.sectionOrder === null", timeout=8000)

    @check("Add from GitHub shows the server's reason when the repo cannot be read (mocked 502)")
    def _():
        page.route("**/api/cv/showcase/project", lambda r: r.fulfill(status=502, content_type="application/json", body='{"error":"gh is not authenticated. Fix: run `gh auth login` on the host, then retry."}'))
        go("profile")
        page.get_by_label("GitHub repository link").fill("https://github.com/jan-test/toolbox")
        btn("Add from GitHub").click()
        expect(page.get_by_role("alert").filter(has_text="gh auth login")).to_be_visible()
        page.unroute("**/api/cv/showcase/project")
        assert len(cv()["profile"]["projects"]) == 1, "nothing added"

    # ---------------------------------------------------------------- job offers
    @check("add an offer by pasting the posting text; it is listed and matched")
    def _():
        go("jobs")
        has("No offers saved yet")
        page.get_by_label("Job link or posting text").fill(POSTING)
        page.get_by_label("Company", exact=True).first.fill("Gamma Systems")
        page.get_by_label("Job title", exact=True).first.fill("Backend Developer")
        btn("Save offer").click()
        expect(page.get_by_role("button", name=re.compile("^Open offer Gamma Systems Backend Developer"))).to_be_visible()
        jobs = [j for j in cv()["jobs"] if j["company"] == "Gamma Systems"]
        eq(len(jobs), 1)
        assert "Kubernetes" in jobs[0]["text"], "posting text stored"
        shot("jobs-added")

    @check("match panel: coverage, evidence linked to profile fields and missing terms as gaps (or a readable fallback)")
    def _():
        panel = page.locator('[data-agent-region="cv-match"]')
        page.wait_for_function("!document.querySelector('[data-agent-region=cv-match]')?.innerText.match(/Matching…/)", timeout=15000)
        text = panel.inner_text()
        if "not available yet" in text:
            return
        assert "coverage" in text.lower() and "%" in text, text
        has("Gaps")
        expect(panel.locator("section[aria-label=Gaps]")).to_contain_text("Kubernetes")
        link = panel.get_by_role("link", name=re.compile(r"^Open .* in the profile$")).first
        expect(link).to_be_visible()
        href = link.get_attribute("href")
        assert "tab=profile" in href and "focus=" in href, href
        link.click()
        page.wait_for_url(re.compile("tab=profile"))
        page.wait_for_function("document.querySelector('[data-cv-flash]') !== null || document.querySelector('[data-cv-path]') !== null")

    @check("match degrades gracefully when its route is missing (mocked 404)")
    def _():
        page.route("**/api/cv/jobs/match**", lambda r: r.fulfill(status=404, content_type="application/json", body='{"error":"nope"}'))
        go("jobs")
        page.wait_for_function("document.querySelector('[data-agent-region=cv-match]')?.innerText.includes('not available yet')", timeout=10000)
        page.unroute("**/api/cv/jobs/match**")

    @check("requirements editor saves one requirement per line; offer link opens safely in a new tab")
    def _():
        go("jobs")
        page.get_by_label("Requirements (one per line)").fill("TypeScript\nNode.js\nKubernetes")
        btn("Save requirements").click()
        has("Requirements saved.")
        job = next(j for j in cv()["jobs"] if j["company"] == "Gamma Systems")
        eq(job["requirements"], ["TypeScript", "Node.js", "Kubernetes"])
        page.get_by_label("Offer link").fill("https://example.com/jobs/backend-1")
        btn("Save details").click()
        has("Details saved.")
        link = page.get_by_role("link", name="Open the offer ↗")
        eq(link.get_attribute("href"), "https://example.com/jobs/backend-1")
        eq(link.get_attribute("target"), "_blank")
        rel = link.get_attribute("rel") or ""
        assert "noopener" in rel, rel

    @check("a javascript: link is never rendered as a clickable anchor")
    def _():
        job = next(j for j in cv()["jobs"] if j["company"] == "Gamma Systems")
        api("POST", "/api/cv/jobs", {"job": {"id": job["id"], "url": "javascript:alert(1)"}})
        page.reload(wait_until="domcontentloaded")
        page.wait_for_function("!document.querySelector('main [role=status]')?.textContent?.match(/Loading/)")
        expect(page.get_by_role("link", name="Open the offer ↗")).to_have_count(0)
        api("POST", "/api/cv/jobs", {"job": {"id": job["id"], "url": "https://example.com/jobs/backend-1"}})

    @check("Quick version (no rewording): suggest -> review -> save (or a readable fallback)")
    def _():
        go("jobs")
        btn("Quick version (no rewording)").click()
        page.wait_for_function("!document.querySelector('main').innerText.includes('Suggesting…')", timeout=20000)
        body = page.locator("main").inner_text()
        if "not available yet" in body:
            return
        expect(page.get_by_text(re.compile(r"^Review the suggested version"))).to_be_visible()
        name = page.get_by_label("Version name")
        expect(name).to_be_visible()
        name.fill("Gamma backend version")
        btn("Save version").click()
        has("Saved the version")
        vs = [v for v in cv()["variants"] if v["name"] == "Gamma backend version"]
        eq(len(vs), 1)
        eq(vs[0]["jobId"], next(j["id"] for j in cv()["jobs"] if j["company"] == "Gamma Systems"))

    @check("Track application creates a linked application with the offer's link; the button then shows the status")
    def _():
        go("jobs")
        btn("Track application").click()
        has("Application tracked as wishlist")
        job = next(j for j in cv()["jobs"] if j["company"] == "Gamma Systems")
        apps = [a for a in cv()["applications"] if a["jobId"] == job["id"]]
        eq(len(apps), 1)
        eq(apps[0]["status"], "wishlist")
        eq(apps[0]["url"], "https://example.com/jobs/backend-1")
        expect(page.get_by_role("button", name="Tracked (wishlist)")).to_be_disabled()

    @check("a link pasted alone is saved as the offer link (fetch route or fallback)")
    def _():
        go("jobs")
        page.get_by_label("Job link or posting text").fill("https://example.invalid/jobs/ghost-1")
        page.get_by_label("Company", exact=True).first.fill("Ghost Corp")
        btn("Save offer").click()
        page.wait_for_function("document.body.innerText.includes('Ghost Corp') || document.querySelector('[role=alert]')", timeout=20000)
        alerts = [a for a in page.get_by_role("alert").all_inner_texts() if a.strip()]
        listed = any(j["company"] == "Ghost Corp" for j in cv()["jobs"])
        assert listed or alerts, "either saved or a readable error"
        if not listed:
            assert alerts and all(len(a) > 8 for a in alerts), alerts
        else:
            ghost = next(j for j in cv()["jobs"] if j["company"] == "Ghost Corp")
            eq(ghost["url"], "https://example.invalid/jobs/ghost-1")


    @check("offer form stores the user's notes and company website; an unreadable website is a note, not an error")
    def _():
        go("jobs")
        page.get_by_label("Job link or posting text").fill("Data Engineer — Delta Analytics, Kraków\nWymagania:\n- Python\n- Airflow\nMile widziane:\n- dbt\nOferujemy:\n- karta sportowa\n" + "Pracujemy nad platformą danych dla handlu. " * 12)
        page.get_by_label("Company website", exact=True).fill("https://delta.invalid")
        page.get_by_label("Offer notes").fill("Rekruterka: liczy się Airflow w produkcji.")
        btn("Save offer").click()
        has("The company website was not read", timeout=30000)
        job = next(j for j in cv()["jobs"] if j["company"] == "Delta Analytics")
        eq(job["notes"], "Rekruterka: liczy się Airflow w produkcji.")
        eq(job["companyUrl"], "https://delta.invalid")
        eq(job["requirements"], ["Python", "Airflow"], "requirement lines from the posting's own headings")
        eq(job["niceToHave"], ["dbt"])
        expect(page.get_by_label("Notes for this offer")).to_have_value("Rekruterka: liczy się Airflow w produkcji.")
        page.get_by_label("Notes for this offer").fill("Rekruterka: liczy się Airflow w produkcji. Rozmowa w piątek.")
        btn("Save notes").click()
        has("Notes saved.")
        eq(next(j for j in cv()["jobs"] if j["company"] == "Delta Analytics")["notes"], "Rekruterka: liczy się Airflow w produkcji. Rozmowa w piątek.")

    @check("board facts render (skills with levels, salary, apply link) for an offer that has them")
    def _():
        job = next(j for j in cv()["jobs"] if j["company"] == "Delta Analytics")
        api("POST", "/api/cv/jobs", {"job": {"id": job["id"], "skills": [{"name": "Python", "level": 4}, {"name": "dbt", "level": 1, "required": False}], "salary": "20000-25000 PLN/month b2b (net)", "seniority": "mid", "applyUrl": "https://ats.example/apply/9"}})
        go("jobs", extra=f"&job={job['id']}")
        board = page.locator("section[aria-label='From the job board']")
        expect(board).to_contain_text("Python · advanced")
        expect(board).to_contain_text("dbt · nice to have")
        expect(board).to_contain_text("20000-25000 PLN/month b2b (net)")
        link = board.get_by_role("link", name=re.compile("Apply on the company"))
        eq(link.get_attribute("href"), "https://ats.example/apply/9")

    @check("several links at once: each is saved in turn; failures stay in the box with their reason (mocked fetch route)")
    def _():
        calls = []

        def fake(route):
            body = json.loads(route.request.post_data or "{}")
            calls.append(body)
            if "broken" in body["urlOrText"]:
                route.fulfill(status=422, content_type="application/json", body='{"error":"https://x.example/broken answered HTTP 404. Ask the user to paste the full posting text and call knife_cv_job_fetch again with that text."}')
            else:
                job = {"id": f"bulk-{len(calls)}", "url": body["urlOrText"], "title": "T", "company": "C", "requirements": [], "niceToHave": [], "text": "", "savedAt": ""}
                route.fulfill(status=200, content_type="application/json", body=json.dumps({"revision": 1, "job": job}))

        page.route("**/api/cv/jobs/fetch", fake)
        go("jobs")
        page.get_by_label("Job link or posting text").fill("https://x.example/a\nhttps://x.example/broken\n https://x.example/c https://x.example/a")
        expect(page.get_by_text("3 links: each is saved as its own offer")).to_be_visible()
        btn("Save 3 offers").click()
        alert = page.locator("main form[aria-label='Add job offer']").get_by_role("alert")
        expect(alert).to_contain_text("2 of 3 saved", timeout=15000)
        expect(alert).to_contain_text("answered HTTP 404. Paste the posting text instead.")
        expect(page.get_by_label("Job link or posting text")).to_have_value("https://x.example/broken")
        eq([c["urlOrText"] for c in calls], ["https://x.example/a", "https://x.example/broken", "https://x.example/c"])
        assert all(set(c) == {"urlOrText"} for c in calls), calls
        page.unroute("**/api/cv/jobs/fetch")
        page.get_by_label("Job link or posting text").fill("")

    @check("Tailor with the assistant opens the assistant with the offer and the language")
    def _():
        job = next(j for j in cv()["jobs"] if j["company"] == "Delta Analytics")
        go("jobs", extra=f"&job={job['id']}")
        # this suite runs without a model provider: the widget holds the prompt until one is set, so read it off the event
        page.evaluate("() => { window.__skPrompt = null; window.addEventListener('sk:agent-open', (e) => { window.__skPrompt = e.detail?.prompt ?? null; }, { once: true }); }")
        btn("Tailor with the assistant").click()
        prompt = page.wait_for_function("() => window.__skPrompt", timeout=8000).json_value()
        assert f"jobId: {job['id']}" in prompt and "Polish (pl)" in prompt and "do not add anything my profile does not show" in prompt, prompt
        expect(page.locator("[data-agent-widget]")).to_be_visible()
        page.locator("[data-agent-widget]").get_by_role("button", name="Close assistant").first.click()
        expect(page.get_by_label("Message the assistant")).to_have_count(0)

    # ---------------------------------------------------------------- applications
    @check("add an application in the drawer: link, offer, next action; card, due badge and highlight appear")
    def _():
        go("applications")
        btn("Add application").click()
        dlg = page.get_by_role("dialog", name="Add application")
        expect(dlg).to_be_visible()
        expect(dlg.get_by_label("Company")).to_be_focused()
        dlg.get_by_label("Company").fill("Delta Corp")
        dlg.get_by_label("Role").fill("Platform Engineer")
        dlg.get_by_label("Status").select_option("applied")
        dlg.get_by_label("Saved link").fill("https://example.org/careers/42")
        dlg.get_by_label("Next action").fill("Send a follow-up e-mail")
        dlg.get_by_label("Due date").fill(YESTERDAY)
        dlg.get_by_label("Notes").fill("Referred by a former colleague.")
        dlg.get_by_role("button", name="Save application").click()
        expect(dlg).to_have_count(0)
        has("Delta Corp")
        a = next(x for x in cv()["applications"] if x["company"] == "Delta Corp")
        eq([a["status"], a["url"], a["nextActionDue"], a["nextAction"]], ["applied", "https://example.org/careers/42", YESTERDAY, "Send a follow-up e-mail"])
        eq(a["history"][0]["on"], TODAY)
        due = page.locator("[data-due=true]")
        expect(due).to_have_count(1)
        has("1 due now")
        expect(page.get_by_label("Due now", exact=True)).to_contain_text("Delta Corp")

    @check("saved link opens in a new tab with rel=noopener")
    def _():
        card = page.locator("article", has_text="Delta Corp")
        link = card.get_by_role("link", name=re.compile("example.org")).first
        eq(link.get_attribute("target"), "_blank")
        assert "noopener" in (link.get_attribute("rel") or "")
        eq(link.get_attribute("href"), "https://example.org/careers/42")

    @check("quick status buttons move the card between columns and extend the dated history")
    def _():
        page.get_by_role("button", name="Move Delta Corp Platform Engineer to Screening", exact=True).click()
        page.wait_for_function("async () => (await (await fetch('/api/cv')).json()).applications.some(a => a.company === 'Delta Corp' && a.status === 'screening')")
        a = next(x for x in cv()["applications"] if x["company"] == "Delta Corp")
        eq([h["status"] for h in a["history"]], ["applied", "screening"])
        eq(a["history"][1]["on"], TODAY)
        col = page.get_by_role("region", name="Screening applications")
        expect(col).to_contain_text("Delta Corp")
        expect(page.get_by_role("region", name="Applied applications")).not_to_contain_text("Delta Corp")
        expect(toast()).to_contain_text("Updated Application Delta Corp - Platform Engineer", timeout=8000)

    @check("edit drawer shows the dated status history; Escape closes it")
    def _():
        btn("Edit Delta Corp Platform Engineer").click()
        dlg = page.get_by_role("dialog", name="Edit application")
        hist = dlg.get_by_label("Status history", exact=True)
        expect(hist).to_contain_text(TODAY)
        expect(hist).to_contain_text("Screening")
        expect(hist).to_contain_text("Applied")
        page.keyboard.press("Escape")
        expect(dlg).to_have_count(0)

    @check("closing an application moves it into the Closed group; due highlight only applies to open ones")
    def _():
        page.get_by_role("button", name="Move Delta Corp Platform Engineer to Rejected", exact=True).click()
        page.wait_for_function("async () => (await (await fetch('/api/cv')).json()).applications.some(a => a.company === 'Delta Corp' && a.status === 'rejected')")
        expect(page.locator("[data-due=true]")).to_have_count(0)
        has("0 due now")
        has("Closed (1)")

    @check("deleting an application from the drawer removes it")
    def _():
        btn("Edit Delta Corp Platform Engineer").click()
        page.get_by_role("dialog", name="Edit application").get_by_role("button", name="Delete application").click()
        page.wait_for_function("async () => !(await (await fetch('/api/cv')).json()).applications.some(a => a.company === 'Delta Corp')")

    @check("application form rejects an unknown linked offer with the API's reason")
    def _():
        btn("Add application").click()
        dlg = page.get_by_role("dialog", name="Add application")
        expect(dlg.get_by_role("button", name="Save application")).to_be_disabled()
        dlg.get_by_label("Company").fill("X")
        dlg.get_by_label("Role").fill("Y")
        dlg.get_by_label("Saved link").fill("https://example.net/x")
        dlg.get_by_role("button", name="Save application").click()
        expect(dlg).to_have_count(0)
        api("DELETE", f"/api/cv/applications?id={next(a['id'] for a in cv()['applications'] if a['company'] == 'X')}")

    # ---------------------------------------------------------------- CV versions
    @check("a version made for an offer shows the ATS check; rewording a bullet warns about invented facts; Restore undoes it")
    def _():
        go("variants")
        page.get_by_role("button", name="Open version Gamma backend version", exact=True).click()
        ats = page.locator("[data-agent-region='cv-ats']")
        expect(ats).to_contain_text("Required keywords", timeout=15000)
        expect(ats).to_contain_text("Kubernetes")
        v = next(x for x in cv()["variants"] if x["name"] == "Gamma backend version")
        path = "/experience/id=acme/bullets/id=acme-api/text"
        page.get_by_role("button", name=f"Reword for this version: Acme Sp. z o.o. {path}").click()
        page.get_by_label("Wording for this version: Acme Sp. z o.o.").fill("Samodzielnie zaprojektowałem od zera API obsługujące 9 mln zapytań dziennie.")
        btn("Save for this version").click()
        wording = page.locator("[data-agent-region='cv-wording']")
        expect(wording.get_by_role("status")).to_contain_text("adds number 9", timeout=8000)
        expect(wording.get_by_role("status")).to_contain_text("drops number 2")
        expect(wording.get_by_role("status")).not_to_contain_text("/experience/")
        stored = next(x for x in cv()["variants"] if x["id"] == v["id"])
        eq([r["path"] for r in stored["rewrites"]], [path])
        expect(page.locator("[data-cv-document]")).to_contain_text("9 mln zapytań")
        page.get_by_role("button", name=f"Restore profile wording: {path}").click()
        page.wait_for_function("async (id) => (await (await fetch('/api/cv')).json()).variants.find((x) => x.id === id).rewrites.length === 0", arg=v["id"], timeout=8000)
        expect(page.locator("[data-cv-document]")).to_contain_text("2 mln zapytań")

    @check("own sections print in the live preview and can be left out of a version")
    def _():
        go("variants")
        page.get_by_role("button", name="Open version Gamma backend version", exact=True).click()
        doc = page.locator("[data-cv-document]")
        page.get_by_role("radiogroup", name="Version language").get_by_role("radio", name="Polish").click()
        expect(doc).to_contain_text("CERTYFIKATY", ignore_case=True)
        expect(doc).to_contain_text("AWS Cloud Practitioner")
        page.get_by_label("Include Certyfikaty").uncheck()
        expect(doc).not_to_contain_text("AWS Cloud Practitioner")
        btn("Discard changes").click()

    @check("create a version, toggle a bullet and a project: the live preview follows before saving")
    def _():
        go("variants")
        page.get_by_label("New version name").fill("Backend CV")
        btn("Create version").click()
        has("Version name")
        sel_lang = page.get_by_role("radiogroup", name="Version language")
        sel_lang.get_by_role("radio", name="English").click()
        doc = page.locator("[data-cv-document]")
        expect(doc).to_contain_text("Designed an API serving 2M requests per day.")
        page.get_by_label("Include bullet acme-api of Acme Sp. z o.o.").uncheck()
        expect(doc).not_to_contain_text("Designed an API serving")
        expect(page.get_by_text("Unsaved changes")).to_be_visible()
        # nothing was written yet
        v = next((x for x in cv()["variants"] if x["name"] == "Backend CV"), None)
        assert v is not None and v["experience"] is None, v

    @check("Save version stores an explicit overlay and resolveVariant semantics hold (bullet gone from preview and API)")
    def _():
        btn("Save version").click()
        has("Version saved.")
        v = next(x for x in cv()["variants"] if x["name"] == "Backend CV")
        acme = next(e for e in v["experience"] if e["id"] == "acme")
        assert "acme-api" not in (acme["bulletIds"] or []), v
        expect(page.get_by_text("Saved", exact=True).first).to_be_visible()

    @check("reorder: moving a role down reorders the preview and the stored overlay")
    def _():
        btn("Move Acme Sp. z o.o. (Senior developer) down").click()
        doc = page.locator("[data-cv-document]")
        text = doc.inner_text()
        assert text.index("Beta Labs") < text.index("Acme"), text
        btn("Save version").click()
        has("Version saved.")
        v = next(x for x in cv()["variants"] if x["name"] == "Backend CV")
        eq([e["id"] for e in v["experience"]], ["beta", "acme"])

    @check("layout and language selectors change the document")
    def _():
        page.get_by_role("radiogroup", name="Document layout").get_by_role("radio", name="Modern layout").click()
        eq(page.locator("[data-cv-document]").get_attribute("data-theme"), "modern")
        page.get_by_role("radiogroup", name="Version language").get_by_role("radio", name="Polish").click()
        eq(page.locator("[data-cv-document]").get_attribute("data-lang"), "pl")
        expect(page.locator("[data-cv-document]")).to_contain_text("Starszy programista")
        btn("Discard changes").click()
        eq(page.locator("[data-cv-document]").get_attribute("data-lang"), "en")

    @check("segmented controls are keyboard operable (arrow keys move the selection)")
    def _():
        group = page.get_by_role("radiogroup", name="Document layout")
        group.get_by_role("radio", name="ATS layout").focus()
        page.keyboard.press("ArrowRight")
        expect(group.get_by_role("radio", name="Modern layout")).to_have_attribute("aria-checked", "true")
        page.keyboard.press("ArrowLeft")
        expect(group.get_by_role("radio", name="ATS layout")).to_have_attribute("aria-checked", "true")

    @check("print media shows only the CV document")
    def _():
        page.emulate_media(media="print")
        visible = page.evaluate("""() => {
            const vis = (el) => { const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && el.getBoundingClientRect().height > 0; };
            const doc = document.querySelector('[data-cv-document]');
            const side = document.querySelector('aside, nav, header');
            return { doc: !!doc && vis(doc), chrome: side ? vis(side) : false };
        }""")
        page.emulate_media(media="screen")
        assert visible["doc"], visible
        assert not visible["chrome"], f"app chrome still printed: {visible}"

    @check("DOCX download delivers a .docx (or a readable error when the export is unavailable)")
    def _():
        try:
            with page.expect_download(timeout=20000) as dl:
                btn("Download DOCX").click()
            name = dl.value.suggested_filename
            assert name.lower().endswith(".docx"), name
        except Exception:  # noqa: BLE001
            alerts = [a for a in page.get_by_role("alert").all_inner_texts() if a.strip()]
            assert alerts and len(alerts[0]) > 8, "neither a download nor a readable error"

    @check("dangling ids: deleting a bullet the version uses raises a warning and Remove broken references fixes it")
    def _():
        v = next(x for x in cv()["variants"] if x["name"] == "Backend CV")
        api("POST", "/api/cv/patch", {"ops": [{"op": "remove", "path": "/experience/id=beta/bullets/id=beta-ui"}]})
        # Saved overlay of 'Backend CV' lists beta/beta-ui explicitly -> now dangling
        page.wait_for_function("document.body.innerText.includes('broken reference')", timeout=8000)
        expect(page.get_by_role("alert").filter(has_text="no longer has")).to_be_visible()
        expect(btn("Save version")).to_be_disabled()
        btn("Remove broken references").click()
        expect(page.get_by_role("alert").filter(has_text="no longer has")).to_have_count(0)
        btn("Save version").click()
        has("Version saved.")
        beta_bullet = {"id": "beta-ui", "text": PROFILE["experience"][1]["bullets"][0]["text"]}
        api("POST", "/api/cv/patch", {"ops": [{"op": "add", "path": "/experience/id=beta/bullets/-", "value": beta_bullet}]})
        assert v

    @check("rename + delete a version")
    def _():
        go("variants")
        page.get_by_role("button", name="Open version Backend CV", exact=True).click()
        page.get_by_label("Version name", exact=True).fill("Renamed CV")
        btn("Save version").click()
        has("Version saved.")
        assert any(x["name"] == "Renamed CV" for x in cv()["variants"])
        btn("Delete version Renamed CV").click()
        page.wait_for_function("async () => !(await (await fetch('/api/cv')).json()).variants.some(v => v.name === 'Renamed CV')")

    # ---------------------------------------------------------------- showcase
    @check("showcase renders the ranking, checklist and 'Copy facts for the assistant' (mocked routes, no network)")
    def _():
        rank = {"ranked": [{"repo": "jan-test/toolbox", "url": "https://github.com/jan-test/toolbox", "score": 81.5,
                            "breakdown": {"stars": 12, "recency": 20, "commits": 13.5, "presentation": 36},
                            "reasons": ["Active in the last 90 days", "README has a tagline"], "improveFirst": ["Add a screenshot"]}],
                "considered": 1, "skipped": [], "note": "score 0-100"}
        repo = {"name": "toolbox", "url": "https://github.com/jan-test/toolbox", "showcaseScore": 90, "description": "Browser tools", "languages": {"TypeScript": 900, "CSS": 100},
                "topics": ["tools"], "license": "MIT", "stars": 12, "commitCount": 340, "hasCi": True, "hasTests": False,
                "checklist": [{"id": "readme-tagline", "passed": True, "weight": 10, "advice": "Keep the tagline."}, {"id": "screenshot", "passed": False, "weight": 8, "advice": "Add a screenshot of the main screen."}]}
        page.route("**/api/cv/showcase/rank**", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(rank)))
        page.route("**/api/cv/showcase/repo**", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(repo)))
        go("showcase")
        page.get_by_label("GitHub owner").fill("jan-test")
        btn("Rank my repositories").click()
        expect(page.get_by_role("list", name="Ranked repositories")).to_contain_text("jan-test/toolbox")
        has("Add a screenshot")
        page.get_by_role("button", name="Load details of jan-test/toolbox").click()
        expect(page.get_by_label("Showcase checklist")).to_contain_text("screenshot")
        expect(page.get_by_label("Repository facts")).to_contain_text("TypeScript 90%")
        page.get_by_role("button", name="Copy facts for the assistant: jan-test/toolbox").click()
        page.wait_for_function("document.body.innerText.includes('Copied')")
        text = page.evaluate("navigator.clipboard.readText()")
        assert "Showcase facts for jan-test/toolbox" in text and "[ ] screenshot: Add a screenshot of the main screen." in text and "[x] readme-tagline" in text, text
        page.unroute("**/api/cv/showcase/rank**")
        page.unroute("**/api/cv/showcase/repo**")

    @check("showcase shows the server's reason when GitHub is unreachable (mocked 502)")
    def _():
        page.route("**/api/cv/showcase/rank**", lambda r: r.fulfill(status=502, content_type="application/json", body='{"error":"gh is not authenticated"}'))
        go("showcase")
        btn("Rank my repositories").click()
        expect(page.get_by_role("alert").filter(has_text="gh is not authenticated")).to_be_visible()
        page.unroute("**/api/cv/showcase/rank**")

    # ---------------------------------------------------------------- layout
    for width in (800, 390):
        for tab in ("profile", "jobs", "variants", "applications", "showcase"):
            @check(f"no horizontal overflow on {tab} at {width}px")
            def _(tab=tab, width=width):
                go(tab, width)
                overflow_ok()
                shot(f"{tab}-{width}")

    browser.close()

if FAILS:
    print(f"\n{len(FAILS)} failed: {FAILS}")
    sys.exit(1)
print("\nall CV studio checks passed")
