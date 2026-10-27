#!/usr/bin/env python3
"""CV projects and the Website tab end to end (docs/CV-STUDIO.md "Projects", docs/WEBSITE-STUDIO.md "Without a repository").

Private mode (one scratch server):
- an account's existing single CV is the first project as it is (the file stays cv/<account>.json, no index written);
- the project bar shows it; "Manage CV projects" creates a second one; the empty project shows "Start here" and
  "Build one from scratch" writes a first profile; the API with ?project= proves the two CVs are separate;
- switching in the bar (and from an agent over MCP, knife_cv_project_switch) changes what every tab shows;
- "How this works" opens on each tab; the retired /tools/site-studio lands on the Website tab;
- Website, "Just its address": a local fixture site, the check runs and compares with THIS project's CV; Verify finds
  the meta tag the fixture serves.
Public mode (restarted with a fresh data dir), a NON-admin user:
- creates a project, saves a website address, sees the ownership tag, an unverified check is refused with the reason,
  Verify of a loopback site is refused (public mode never reads private addresses for users); no admin-only option shows.
Screenshots (desktop + 390 px) in $CVP_SHOTS (default /tmp/cv-projects-shots).
Usage: python3 tests/functional/cv_projects_e2e.py [--headed]
"""
from __future__ import annotations

import http.server as httpserver
import json
import os
import subprocess
import sys
import threading
import traceback
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from playwright.sync_api import Page, expect, sync_playwright  # noqa: E402

from tests.scratch_server import ScratchServer  # noqa: E402

HEADED = "--headed" in sys.argv
SHOTS = Path(os.environ.get("CVP_SHOTS", "/tmp/cv-projects-shots"))
FAILS: list[str] = []
PASSES = 0
CONSOLE: list[str] = []
TOKEN_HOLDER: dict[str, str] = {"token": ""}


def check(name: str, ok: bool, detail: object = "") -> bool:
    global PASSES
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'' if ok else '  -> ' + str(detail)[:500]}", flush=True)
    if ok:
        PASSES += 1
    else:
        FAILS.append(name)
    return ok


def http(base: str, method: str, path: str, body: object | None = None, cookie: str | None = None, accept: str | None = None) -> tuple[int, object]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if method != "GET":
        req.add_header("Origin", base)
    if cookie:
        req.add_header("Cookie", cookie)
    if accept:
        req.add_header("Accept", accept)
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            raw = res.read().decode()
            status = res.status
    except urllib.error.HTTPError as err:
        raw, status = err.read().decode(), err.code
    try:
        return status, json.loads(raw) if raw else None
    except ValueError:
        return status, raw


def mcp(base: str, name: str, args: dict) -> tuple[bool, str]:
    status, body = http(base, "POST", "/api/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}}, accept="application/json, text/event-stream")
    if isinstance(body, str):  # Streamable HTTP answers as server-sent events: the JSON is on the data: line
        line = next((ln[5:].strip() for ln in body.splitlines() if ln.startswith("data:")), "")
        body = json.loads(line) if line else body
    if status != 200 or not isinstance(body, dict):
        return False, f"HTTP {status}: {body}"
    result = body.get("result", {})
    return not result.get("isError", False), "".join(p.get("text", "") for p in result.get("content", []))


def go(page: Page, path: str) -> None:
    page.goto(path, wait_until="domcontentloaded")
    page.wait_for_function("() => !/Loading tool/.test(document.querySelector('main')?.innerText ?? '')", timeout=60_000)
    page.wait_for_function("() => Array.from(document.querySelectorAll('main *')).slice(0, 400).some(el => Object.keys(el).some(k => k.startsWith('__reactProps$')))", timeout=60_000)
    page.wait_for_load_state("networkidle")


def shot(page: Page, name: str) -> None:
    SHOTS.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(SHOTS / f"{name}.png"), full_page=False)


class Site(httpserver.BaseHTTPRequestHandler):
    """A tiny personal site that names Ada's CV facts and one she no longer has (Fortran), with the verification tag."""

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/":
            body = (f'<!doctype html><html lang="en"><head><title>Ada Lovelace</title><meta name="description" content="Analyst">'
                    f'<meta name="smart-knife-verification" content="{TOKEN_HOLDER["token"]}"></head><body><main><h1>Ada Lovelace</h1>'
                    "<p>Analytical engine programmer. Projects: Note G. Skills: Fortran.</p>"
                    '<a href="mailto:ada@example.org">Write to me</a></main></body></html>').encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()


def watch(page: Page) -> None:
    page.on("console", lambda m: CONSOLE.append(f"{page.url}: {m.text[:200]}") if m.type == "error" and "Failed to load resource" not in m.text else None)


def private_mode(server: ScratchServer, site_url: str) -> None:
    base = server.url
    data = Path(server.data_dir)
    ok, text = mcp(base, "knife_cv_import", {"profile": {
        "contact": {"name": "Ada Lovelace", "headline": {"pl": "", "en": "Analyst"}, "email": "ada@example.org", "links": []},
        "projects": [{"id": "g", "name": "Note G"}],
        "skills": [{"id": "s", "name": {"pl": "", "en": "Skills"}, "items": ["Mathematics"]}],
    }})
    check("seed: one CV, as an account had before projects", ok, text[:200])
    cv_files = sorted(p.name for p in (data / "cv").iterdir())
    check("the existing CV stays cv/<account>.json, no project index written", any(n.endswith(".json") and ".p-" not in n and "projects" not in n for n in cv_files) and not any("projects.json" in n for n in cv_files), cv_files)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=not HEADED)
        page = browser.new_context(base_url=base, viewport={"width": 1366, "height": 900}).new_page()
        watch(page)
        go(page, "/tools/cv-studio?tab=profile")
        bar = page.locator("[data-cv-project-bar]")
        expect(bar.get_by_label("CV project")).to_have_value("main", timeout=20_000)
        check("the project bar names the first project after the CV", "Ada Lovelace" in (bar.get_by_label("CV project").inner_text()))
        shot(page, "profile-desktop")

        # Create a second project in the drawer: it becomes active and empty -> Start here.
        page.get_by_role("button", name="Manage CV projects").click()
        drawer = page.get_by_role("dialog", name="CV projects")
        drawer.get_by_label("New CV project").fill("Charles Babbage")
        drawer.get_by_role("button", name="Create empty").click()
        expect(drawer.locator("[data-cv-project]")).to_have_count(2, timeout=20_000)
        shot(page, "projects-drawer")
        drawer.get_by_role("button", name="Close CV projects").click()
        expect(page.locator("[data-cv-start-here]")).to_be_visible(timeout=20_000)
        check("a new project starts empty with Start here", True)
        shot(page, "start-here-desktop")
        page.locator("[data-cv-start=scratch]").click()
        page.get_by_role("button", name="English", exact=True).click()
        page.get_by_label("Full name").fill("Charles Babbage")
        page.get_by_label("Job title you want to be seen as").fill("Engineer")
        page.get_by_label("Company").fill("Difference Engine Ltd")
        page.get_by_label("Your role").fill("Designer")
        page.get_by_label("From (YYYY-MM)").fill("1822-06")
        page.get_by_label("What you did there, one point per line").fill("Designed the Difference Engine\nRaised government funding")
        page.get_by_label("4. Skills, separated by commas (optional)").fill("Mechanics, Mathematics")
        page.get_by_role("button", name="Create my CV").click()
        expect(page.locator("[data-cv-start-here]")).to_have_count(0, timeout=20_000)
        expect(page.locator("main")).to_contain_text("Difference Engine Ltd", timeout=20_000)
        check("Build from scratch writes a first profile", True)

        status, projects = http(base, "GET", "/api/cv/projects")
        second = next((p["id"] for p in projects["projects"] if p["name"] == "Charles Babbage"), "") if isinstance(projects, dict) else ""
        check("the API lists both projects, the new one active", status == 200 and projects["active"] == second and len(projects["projects"]) == 2, projects)
        _, main_cv = http(base, "GET", "/api/cv?project=main")
        _, second_cv = http(base, "GET", f"/api/cv?project={second}")
        check("isolation: each project has its own CV", main_cv["profile"]["contact"]["name"] == "Ada Lovelace" and second_cv["profile"]["contact"]["name"] == "Charles Babbage"
              and second_cv["profile"]["experience"][0]["bullets"][1]["text"]["en"] == "Raised government funding" and not second_cv["profile"]["experience"][0]["bullets"][1]["text"]["pl"], second_cv["profile"]["contact"])
        ok, text = mcp(base, "knife_cv_get", {"path": "/contact/name", "projectId": "main"})
        check("knife_cv_get with projectId reads the other project without switching", ok and "Ada Lovelace" in text, text)

        # Switch in the bar: the open tab shows the other CV.
        page.locator("[data-cv-project-bar]").get_by_label("CV project").select_option("main")
        expect(page.locator("main")).to_contain_text("Note G", timeout=20_000)
        check("switching in the bar shows the other CV", "Difference Engine Ltd" not in page.locator("main").inner_text())
        # An agent switches: the open page follows by itself.
        ok, text = mcp(base, "knife_cv_project_switch", {"id": second})
        expect(page.locator("main")).to_contain_text("Difference Engine Ltd", timeout=20_000)
        check("a switch by an agent over MCP is followed by the open page", ok, text)

        for tab in ("profile", "jobs", "variants", "applications", "showcase", "website"):
            go(page, f"/tools/cv-studio?tab={tab}")
            how = page.locator(f"[data-cv-how={tab}]")
            how.locator("summary").click()
            check(f"'How this works' on {tab}", how.locator("li").count() >= 1)

        page.goto(base + "/tools/site-studio?tab=score", wait_until="networkidle")
        check("the retired website studio lands on the Website tab's step", "/tools/cv-studio?tab=website&step=score" in page.url, page.url)

        # Website, address only, for Ada's project.
        http(base, "POST", "/api/cv/projects", {"action": "switch", "id": "main"})
        go(page, "/tools/cv-studio?tab=website&step=connect")
        page.get_by_role("button", name="Just its address").click()
        page.get_by_label("Address").fill(site_url)
        page.get_by_role("button", name="Save address").click()
        expect(page.get_by_text("Saved. Next: check the site.")).to_be_visible(timeout=20_000)
        _, view = http(base, "GET", "/api/site?project=main")
        TOKEN_HOLDER["token"] = view["siteUrl"]["token"]
        check("private mode: no proof needed, the token exists for later", view["proofNeeded"] is False and view["siteUrl"]["token"].startswith("sk-"), view.get("siteUrl"))
        status, verified = http(base, "POST", "/api/site?project=main", {"action": "verify-url"})
        check("Verify reads the fixture's meta tag", status == 200 and verified["siteUrl"]["verified"] is True, verified)
        shot(page, "website-address")
        go(page, "/tools/cv-studio?tab=website&step=score")
        page.get_by_label("Lighthouse (PageSpeed, ~30-60 s)").uncheck()
        page.get_by_role("button", name="Run audit").click()
        expect(page.get_by_role("group", name="Scores")).to_be_visible(timeout=90_000)
        go(page, "/tools/cv-studio?tab=website&step=copy")
        expect(page.get_by_text("CV fit ·")).to_be_visible(timeout=20_000)
        text = page.locator("main").text_content() or ""
        check("URL-only check compared with THIS project's CV (Note G found, name found)", "✓ Note G" in text and "Ada Lovelace" in text, text[:400])
        _, other_site = http(base, "GET", f"/api/site?project={second}")
        check("the other project has no website and no audit", other_site["siteUrl"] is None and other_site["latest"] is None, other_site)
        shot(page, "website-compare")

        mobile = browser.new_context(base_url=base, viewport={"width": 390, "height": 844}).new_page()
        watch(mobile)
        for tab, name in (("profile", "profile-390"), ("website", "website-390")):
            go(mobile, f"/tools/cv-studio?tab={tab}")
            shot(mobile, name)
        overflow = mobile.evaluate("document.documentElement.scrollWidth - window.innerWidth")
        check("390 px: no horizontal overflow", overflow <= 1, overflow)
        browser.close()


def public_mode(server: ScratchServer, site_url: str) -> None:
    base = server.url
    data = Path(server.data_dir)
    env = {**os.environ, "KNIFE_DATA_DIR": str(data), "KNIFE_AUTH_MODE": "public"}
    r = subprocess.run(["node", str(ROOT / "scripts/accounts.mjs"), "add", "carol", "--name", "Carol", "--password-prompt", "--email", "carol@example.org", "--role", "user"],
                       input="carol password 12\n", capture_output=True, text=True, env=env, cwd=ROOT)
    check("public mode: a non-admin user carol", r.returncode == 0, r.stderr)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=not HEADED)
        page = browser.new_context(base_url=base, viewport={"width": 1366, "height": 900}).new_page()
        watch(page)
        page.goto("/login", wait_until="networkidle")
        page.locator("input[autocomplete=username]").fill("carol")
        page.locator("input[autocomplete=current-password]").fill("carol password 12")
        page.get_by_role("button", name="Log in").click()
        page.wait_for_url(lambda u: "/login" not in u, timeout=30_000)
        cookie = "; ".join(f"{c['name']}={c['value']}" for c in page.context.cookies())
        status, created = http(base, "POST", "/api/cv/projects", {"action": "create", "name": "Carol main"}, cookie)
        check("a user creates CV projects", status == 201, created)
        go(page, "/tools/cv-studio?tab=website&step=connect")
        page.get_by_role("button", name="Just its address").click()
        page.get_by_label("Address").fill(site_url)
        page.get_by_role("button", name="Save address").click()
        expect(page.locator("[data-site-proof]")).to_contain_text("not verified yet", timeout=20_000)
        check("a user sees the ownership tag to add", "smart-knife-verification" in page.locator("[data-site-proof]").inner_text())
        shot(page, "public-proof")
        status, refused = http(base, "POST", "/api/site/audit", {"lighthouse": False}, cookie)
        check("an unverified check is refused with the reason", status == 403 and "not verified" in json.dumps(refused), (status, refused))
        page.get_by_role("button", name="Verify").click()
        expect(page.locator("[data-site-proof]").get_by_role("paragraph").last).to_be_visible()
        status, verify = http(base, "POST", "/api/site", {"action": "verify-url"}, cookie)
        check("public mode never reads a loopback site for a user (verify refused, readable)", status in (403, 422) and isinstance(verify, dict) and verify.get("error"), (status, verify))
        page.get_by_role("button", name="Its GitHub repository").click()
        page.wait_for_load_state("networkidle")
        check("no admin-only GitHub option (the server's own gh login) for a user", page.get_by_text("Server gh login").count() == 0 and page.get_by_text("server's gh").count() == 0)
        browser.close()


def main() -> int:
    site = httpserver.ThreadingHTTPServer(("127.0.0.1", 0), Site)
    threading.Thread(target=site.serve_forever, daemon=True).start()
    site_url = f"http://127.0.0.1:{site.server_address[1]}"
    untracked = subprocess.run(["git", "ls-files", "--others", "--exclude-standard"], cwd=ROOT, capture_output=True, text=True).stdout.split()
    overlay = [u for u in untracked if u.startswith(("src/", "tests/"))]
    try:
        with ScratchServer() as server:
            server.start(overlay=overlay)
            try:
                private_mode(server, site_url)
            except Exception:  # noqa: BLE001
                traceback.print_exc()
                FAILS.append("private mode crashed: " + traceback.format_exc().strip().splitlines()[-1])
                print(server.log_tail(3000))
            server.restart({"KNIFE_AUTH_MODE": "public", "KNIFE_MAIL_TRANSPORT": "outbox", "KNIFE_TRUSTED_PROXIES": "127.0.0.1,::1"})
            try:
                public_mode(server, site_url)
            except Exception:  # noqa: BLE001
                traceback.print_exc()
                FAILS.append("public mode crashed: " + traceback.format_exc().strip().splitlines()[-1])
                print(server.log_tail(3000))
    finally:
        site.shutdown()
    check("no console errors", not CONSOLE, CONSOLE[:4])
    print(f"\n{PASSES} passed, {len(FAILS)} failed")
    if FAILS:
        print(f"FAILED: {FAILS}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
