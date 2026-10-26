#!/usr/bin/env python3
"""Website studio end to end (docs/WEBSITE-STUDIO.md) against the fake world of tests/mock_site_world.mjs (in-memory
GitHub API, a small Polish website, a PageSpeed endpoint), driven like a person in Chromium plus an agent over MCP:

- Connect in the UI (repo, token, production URL, extra page) -> the repository panel shows write access and the repo's
  AGENTS.md; the token never comes back from /api/site.
- Score: Run audit -> live role=status progress -> score tiles (Lighthouse 72 from the fake PageSpeed), issues with a
  fix each (missing alt, stale copyright...), Lighthouse panel, site checks.
- Copy & CV with a CV seeded over MCP (knife_cv_import): CV fit badges, per-page copy metrics; the same view as the
  CV studio's Website tab.
- An agent over MCP: knife_site_status (instructions), knife_site_replace + knife_site_pr -> the open Changes tab shows
  the work branch, the commit, the diff and the preview by itself; "Score the preview" audits it; Publish (two steps)
  merges exactly the reviewed head into main on the fake GitHub; the work branch is gone.
- Firefox: every tab hydrates without console errors.

Self-contained: own scratch server (tests/scratch_server.py), own mock world on free loopback ports, never the live app.
Usage: python3 tests/functional/site_studio_e2e.py [--headed]
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
import traceback
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from playwright.sync_api import Page, expect, sync_playwright  # noqa: E402

from tests.scratch_server import ScratchServer, free_ports  # noqa: E402

HEADED = "--headed" in sys.argv
FAILS: list[str] = []
PASSES = 0
TOKEN = "ghp_mockTokenForSiteStudioTests000000"
CONSOLE: list[str] = []


def check(name: str, ok: bool, detail: object = "") -> bool:
    global PASSES
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'' if ok else '  -> ' + str(detail)[:600]}", flush=True)
    if ok:
        PASSES += 1
    else:
        FAILS.append(name)
    return ok


def http(method: str, url: str, body: object | None = None, headers: dict[str, str] | None = None) -> tuple[int, object]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            raw = res.read().decode()
            status = res.status
    except urllib.error.HTTPError as err:  # type: ignore[attr-defined]
        raw = err.read().decode()
        status = err.code
    if raw.startswith("event:") or "\ndata: " in raw or raw.startswith("data: "):
        raw = next((line[6:] for line in raw.split("\n") if line.startswith("data: ")), raw)
    try:
        return status, json.loads(raw) if raw else None
    except json.JSONDecodeError:
        return status, raw


class Mcp:
    def __init__(self, base: str) -> None:
        self.base = base
        self.rpc = 0

    def tool(self, name: str, args: dict) -> tuple[bool, str]:
        self.rpc += 1
        status, body = http("POST", f"{self.base}/api/mcp", {"jsonrpc": "2.0", "id": self.rpc, "method": "tools/call", "params": {"name": name, "arguments": args}},
                            {"Accept": "application/json, text/event-stream", "Origin": self.base})
        if status != 200 or not isinstance(body, dict):
            return False, f"HTTP {status}: {body}"
        if "error" in body:
            return False, json.dumps(body["error"])
        result = body.get("result", {})
        return not result.get("isError", False), "".join(p.get("text", "") for p in result.get("content", []))


def go(page: Page, path: str) -> None:
    page.goto(path, wait_until="domcontentloaded")
    page.wait_for_function("() => !/Loading tool/.test(document.querySelector('main')?.innerText ?? '')", timeout=60_000)
    page.wait_for_function("() => Array.from(document.querySelectorAll('main *')).slice(0, 400).some(el => Object.keys(el).some(k => k.startsWith('__reactProps$')))", timeout=60_000)


def run(server: ScratchServer, gh_url: str, site_url: str) -> None:
    base = server.url
    mcp = Mcp(base)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=not HEADED)
        ctx = browser.new_context(base_url=base, viewport={"width": 1366, "height": 900})
        page = ctx.new_page()
        page.on("console", lambda m: CONSOLE.append(f"{page.url}: {m.text[:200]}") if m.type == "error" and "Failed to load resource" not in m.text else None)

        # ---------------------------------------------------------------- 1. connect
        go(page, "/tools/site-studio?tab=connect")
        # The tab re-renders its form once the GitHub/connection status arrives: type only after that, or the input is reset.
        page.wait_for_load_state("networkidle")
        # The scratch server can have a GitHub App configured; choose the PAT path this test exercises first (switching
        # the access type resets the repository field).
        access = page.get_by_role("radiogroup", name="GitHub access")
        if access.count():
            access.get_by_text("Personal token", exact=True).click()
        page.get_by_label("GitHub repository").fill("genor/website")
        page.get_by_label("Production URL").fill(site_url)
        page.get_by_label("GitHub token").fill(TOKEN)
        page.get_by_text("More settings").click()
        page.get_by_label("More pages to audit").fill("/projekty")
        page.get_by_role("button", name="Connect", exact=True).click()
        expect(page.get_by_text("Connected. Next: run an audit")).to_be_visible(timeout=20_000)
        expect(page.get_by_text("read and write")).to_be_visible(timeout=20_000)
        check("connect in the UI: write access and the repo's AGENTS.md are shown", page.get_by_text("AGENTS.md").first.is_visible())
        status, view = http("GET", f"{base}/api/site")
        check("GET /api/site carries no token", status == 200 and TOKEN not in json.dumps(view) and view["connection"]["token"]["login"] == "genor", view)

        # ---------------------------------------------------------------- 2. score
        go(page, "/tools/site-studio?tab=score")
        page.get_by_role("button", name="Run audit").click()
        expect(page.get_by_role("status").filter(has_text="Auditing")).to_be_visible(timeout=10_000)
        check("audit progress is shown as role=status", True)
        expect(page.get_by_role("group", name="Scores")).to_be_visible(timeout=90_000)
        scores = page.get_by_role("group", name="Scores").text_content() or ""  # labels are CSS-uppercased in innerText
        check("score tiles: overall, SEO, copywriting, performance 72 from PageSpeed", all(s in scores for s in ("Overall", "Technical SEO", "Copywriting", "Performance")) and "72" in scores, scores)
        issues = page.locator("main").inner_text()
        check("issues with fixes: missing alt text and the stale copyright", "have no alt text" in issues and "Footer says © 2023" in issues and "Fix:" in issues, issues[:400])
        check("Lighthouse and site checks panels", page.get_by_text("Lighthouse (PageSpeed Insights)").is_visible() and page.get_by_text("Site checks").is_visible())

        # ---------------------------------------------------------------- 3. copy & CV (CV seeded by an agent)
        ok, text = mcp.tool("knife_cv_import", {"profile": {
            "contact": {"name": "Jan Kowalski", "headline": {"pl": "Inżynier systemów AI", "en": "AI systems engineer"}, "links": [{"label": "GitHub", "url": "https://github.com/janko"}]},
            "projects": [{"id": "p1", "name": "Samurai Knife"}, {"id": "p2", "name": "Toberenamed RTS"}],
            "skills": [{"id": "s1", "name": {"pl": "Narzędzia", "en": "Tools"}, "items": ["Docker", "Kubernetes"]}],
        }, "overwrite": True})
        check("an agent seeds the CV over MCP (knife_cv_import)", ok, text[:300])
        ok, text = mcp.tool("knife_site_audit", {"lighthouse": False})
        check("knife_site_audit over MCP returns scores and CV gaps", ok and '"alignment"' in text and "Toberenamed RTS" in text, text[:400])
        go(page, "/tools/site-studio?tab=copy")
        expect(page.get_by_text("CV fit ·")).to_be_visible(timeout=20_000)
        badges = page.locator("main").text_content() or ""
        check("Copy & CV: ✓ Samurai Knife, ✗ Toberenamed RTS, ✗ Kubernetes", "✓ Samurai Knife" in badges and "✗ Toberenamed RTS" in badges and "✗ Kubernetes" in badges, badges[:500])
        check("Copy & CV: per-page copy metrics (FOG-PL)", "FOG-PL" in badges and "Calls to action" in badges)
        go(page, "/tools/cv-studio?tab=website")
        expect(page.get_by_text("CV fit ·")).to_be_visible(timeout=20_000)
        check("the same view is the CV studio's Website tab, linking to the website studio", page.get_by_role("link", name="website studio").count() >= 1)

        # ---------------------------------------------------------------- 4. agent edits, the Changes tab follows
        go(page, "/tools/site-studio?tab=changes")
        expect(page.get_by_text("No changes prepared")).to_be_visible(timeout=20_000)
        ok, text = mcp.tool("knife_site_status", {})
        check("knife_site_status gives the agent the repo's AGENTS.md", ok and "Copy lives in lib/site-data.ts" in text, text[:300])
        ok, text = mcp.tool("knife_site_replace", {"path": "lib/site-data.ts", "find": '["Samurai Knife"]', "replace": '["Samurai Knife", "Toberenamed RTS"]', "message": "Show Toberenamed RTS on the site"})
        check("knife_site_replace commits to a knife/ work branch", ok and '"branch": "knife/' in text, text[:300])
        ok, text = mcp.tool("knife_site_pr", {"title": "Add Toberenamed RTS", "body": "From the CV studio."})
        check("knife_site_pr opens the pull request", ok and '"number": 1' in text, text[:300])
        expect(page.get_by_role("link", name="#1 Add Toberenamed RTS")).to_be_visible(timeout=30_000)
        main = page.locator("main").inner_text()
        check("the open Changes tab shows the branch, commit, diff and preview by itself", "Work branch knife/" in main and "Show Toberenamed RTS on the site" in main and "lib/site-data.ts" in main and "Preview:" in main, main[:600])
        page.get_by_role("button", name="Score the preview").click()
        expect(page.get_by_text("Preview audit started")).to_be_visible(timeout=10_000)
        deadline = time.time() + 60
        while time.time() < deadline:
            _, progress = http("GET", f"{base}/api/site/audit")
            if isinstance(progress, dict) and not progress.get("running"):
                break
            time.sleep(1)
        _, latest = http("GET", f"{base}/api/site/audit?run=latest")
        check("the preview audit is stored with target preview", isinstance(latest, dict) and latest.get("target") == "preview", latest if not isinstance(latest, dict) else latest.get("target"))
        ok, text = mcp.tool("knife_site_changes", {})
        check("knife_site_changes reports the preview URL", ok and site_url.replace("http://", "") in text, text[:300])

        # ---------------------------------------------------------------- 5. publish (two steps, UI only)
        page.get_by_role("button", name="Publish to production…").click()
        publish = page.get_by_role("button", name="Publish to production", exact=True)
        check("publishing needs the review checkbox first", publish.is_disabled())
        page.get_by_label("I reviewed the files above (and the preview)").check()
        publish.click()
        expect(page.get_by_text("Published to main.")).to_be_visible(timeout=30_000)
        status, main_file = http("GET", f"{gh_url}/repos/genor/website/contents/lib/site-data.ts?ref=main", headers={"Authorization": f"Bearer {TOKEN}"})
        import base64
        content = base64.b64decode(main_file["content"]).decode() if isinstance(main_file, dict) and "content" in main_file else ""
        check("the fake GitHub's main has the change after Publish", "Toberenamed RTS" in content, content)
        expect(page.get_by_text("No changes prepared")).to_be_visible(timeout=20_000)
        check("the work branch is gone; Last: published", "published" in page.locator("main").inner_text())
        ok, text = mcp.tool("knife_site_pr", {"title": "x"})
        check("with no work branch a new PR is refused (nothing prepared)", not ok and "no changes yet" in text, text[:200])
        check("no tool can publish or discard", all(n not in json.dumps(http("POST", f"{base}/api/mcp", {"jsonrpc": "2.0", "id": 99, "method": "tools/list", "params": {}}, {"Accept": "application/json, text/event-stream"})[1]) for n in ("knife_site_publish", "knife_site_merge", "knife_site_discard")))
        browser.close()

        # ---------------------------------------------------------------- 6. Firefox renders every tab
        ff = pw.firefox.launch(headless=not HEADED)
        fpage = ff.new_page(base_url=base)
        errors: list[str] = []
        fpage.on("console", lambda m: errors.append(m.text[:200]) if m.type == "error" and "Failed to load resource" not in m.text else None)
        for tab in ("connect", "score", "copy", "changes"):
            go(fpage, f"/tools/site-studio?tab={tab}")
        go(fpage, "/tools/cv-studio?tab=website")
        check("Firefox: all tabs hydrate without console errors", not errors, errors[:3])
        ff.close()
    check("Chromium: no console errors", not CONSOLE, CONSOLE[:3])


def main() -> int:
    gh_port, site_port, psi_port = free_ports(3)
    site_url = f"http://127.0.0.1:{site_port}"
    world = subprocess.Popen(["node", str(ROOT / "tests/mock_site_world.mjs"), str(gh_port), str(site_port), str(psi_port)], stdout=subprocess.PIPE, text=True, env={**__import__("os").environ, "MOCK_PREVIEW_URL": site_url, "MOCK_REPO_HOMEPAGE": site_url})
    try:
        assert world.stdout is not None and world.stdout.readline().strip() == "READY", "mock world did not start"
        env = {"KNIFE_GITHUB_API_URL": f"http://127.0.0.1:{gh_port}", "KNIFE_PSI_API_URL": f"http://127.0.0.1:{psi_port}/run"}
        with ScratchServer() as server:
            server.start(env=env)
            print(f"scratch server {server.url} data {server.data_dir}", flush=True)
            try:
                run(server, f"http://127.0.0.1:{gh_port}", site_url)
            except Exception:  # noqa: BLE001
                traceback.print_exc()
                FAILS.append("crashed: " + traceback.format_exc().strip().splitlines()[-1])
                print(server.log_tail(3000))
    finally:
        world.terminate()
        world.wait(timeout=10)
    print(f"\n{PASSES} passed, {len(FAILS)} failed")
    if FAILS:
        print(f"{len(FAILS)} FAILED: {FAILS}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
