#!/usr/bin/env python3
"""Website (the CV studio's Website tab) end to end (docs/WEBSITE-STUDIO.md) against the fake world of tests/mock_site_world.mjs (in-memory
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
- Vercel (tests/mock_vercel.mjs): Connect Vercel in the UI picks the project, the token never comes back; an agent
  follows the work branch's preview (knife_site_previews), starts a preview build (knife_site_deploy), is refused on a
  protected preview without a bypass secret, the UI creates one, then knife_site_audit target=preview and
  knife_site_page read it with the header (every request that reached it carried it), knife_site_deploy_logs; the
  Changes tab shows the Vercel previews panel. knife_whats_new names the new tools.
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
VTOKEN = "vercelMockToken0123456789abcdef"
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


def run(server: ScratchServer, gh_url: str, site_url: str, preview_url: str) -> None:
    base = server.url
    mcp = Mcp(base)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=not HEADED)
        ctx = browser.new_context(base_url=base, viewport={"width": 1366, "height": 900})
        page = ctx.new_page()
        page.on("console", lambda m: CONSOLE.append(f"{page.url}: {m.text[:200]}") if m.type == "error" and "Failed to load resource" not in m.text else None)

        # ---------------------------------------------------------------- 1. connect
        go(page, "/tools/cv-studio?tab=website&step=connect")
        # The website now lives in the CV studio: the repository path is the second way in (the address alone is the first).
        page.get_by_role("button", name="Its GitHub repository").click()
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
        go(page, "/tools/cv-studio?tab=website&step=score")
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
        go(page, "/tools/cv-studio?tab=website&step=copy")
        expect(page.get_by_text("CV fit ·")).to_be_visible(timeout=20_000)
        badges = page.locator("main").text_content() or ""
        check("Copy & CV: ✓ Samurai Knife, ✗ Toberenamed RTS, ✗ Kubernetes", "✓ Samurai Knife" in badges and "✗ Toberenamed RTS" in badges and "✗ Kubernetes" in badges, badges[:500])
        check("Copy & CV: per-page copy metrics (FOG-PL)", "FOG-PL" in badges and "Calls to action" in badges)
        page.goto(base + "/tools/site-studio?tab=copy", wait_until="networkidle")
        check("the retired site-studio URL lands on the same step of the CV studio's Website tab", "/tools/cv-studio?tab=website&step=copy" in page.url, page.url)
        expect(page.get_by_text("CV fit ·")).to_be_visible(timeout=20_000)

        # ---------------------------------------------------------------- 4. agent edits, the Changes tab follows
        go(page, "/tools/cv-studio?tab=website&step=changes")
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

        # ---------------------------------------------------------------- 4b. Vercel (optional): connect, preview build, protected preview
        ok, text = mcp.tool("knife_whats_new", {"count": 1})
        check("knife_whats_new names the new Vercel tools and the server's version", ok and "knife_site_previews" in text and '"version": "0.13.0.' in text, text[:300])
        ok, text = mcp.tool("knife_site_previews", {})
        check("without Vercel, knife_site_previews says how to connect", not ok and "Vercel is not connected" in text, text[:200])
        go(page, "/tools/cv-studio?tab=website&step=connect")
        page.get_by_label("Vercel token").fill(VTOKEN)
        page.get_by_role("button", name="Connect Vercel").click()
        expect(page.get_by_text("no bypass secret: protected previews cannot be read")).to_be_visible(timeout=20_000)
        check("Connect Vercel picks the project that deploys genor/website", page.get_by_label("Vercel project").input_value() == "prj_site")
        _, vview = http("GET", f"{base}/api/site/vercel?projects=1")
        check("the Vercel token never comes back from /api/site/vercel", VTOKEN not in json.dumps(vview) and isinstance(vview, dict) and vview.get("vercel", {}).get("hasBypass") is False, vview)
        ok, text = mcp.tool("knife_site_previews", {})
        check("knife_site_previews: no deployment of the work branch head yet", ok and '"headDeployment": null' in text and "knife_site_deploy" in text, text[:400])
        ok, text = mcp.tool("knife_site_deploy", {})
        check("knife_site_deploy starts a preview build of the work branch", ok and '"created": true' in text and '"branch": "knife/' in text, text[:300])
        go(page, "/tools/cv-studio?tab=website&step=changes")
        expect(page.get_by_text("Vercel previews")).to_be_visible(timeout=20_000)
        ready = False
        for _ in range(10):
            ok, text = mcp.tool("knife_site_previews", {})
            if ok and '"state": "READY"' in text:
                ready = True
                break
            time.sleep(1)
        check("the head preview reaches READY (knife_site_previews)", ready, text[:400])
        ok, text = mcp.tool("knife_site_audit", {"target": "preview", "lighthouse": False})
        check("a protected preview without a bypass secret is refused with the fix", not ok and "no bypass secret" in text, text[:300])
        go(page, "/tools/cv-studio?tab=website&step=connect")
        page.get_by_role("button", name="Create bypass secret").click()
        expect(page.get_by_text("bypass secret stored")).to_be_visible(timeout=20_000)
        ok, text = mcp.tool("knife_site_audit", {"target": "preview", "lighthouse": False})
        check("knife_site_audit target=preview reads the protected preview with the bypass", ok and "Protected Vercel preview read with the bypass secret" in text and preview_url in text, text[:400])
        _, seen = http("GET", f"{preview_url}/__seen")
        check("every request that reached the protected preview carried the bypass header", isinstance(seen, list) and len(seen) > 0 and all(x["bypass"] for x in seen), seen)
        ok, text = mcp.tool("knife_site_page", {"url": preview_url + "/"})
        check("knife_site_page reads the protected preview (not Vercel's login page)", ok and "Vercel Authentication" not in text and "Samurai Knife" in text, text[:300])
        ok, text = mcp.tool("knife_site_deploy_logs", {"id": "dpl_new1"})
        check("knife_site_deploy_logs returns the build output", ok and "boom in app/page.tsx" in text, text[:300])
        go(page, "/tools/cv-studio?tab=website&step=changes")
        expect(page.get_by_text("Vercel previews")).to_be_visible(timeout=20_000)
        expect(page.locator("main").get_by_text("READY").first).to_be_visible(timeout=20_000)

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
        for step in ("connect", "score", "copy", "changes"):
            go(fpage, f"/tools/cv-studio?tab=website&step={step}")
        check("Firefox: all tabs hydrate without console errors", not errors, errors[:3])
        ff.close()
    check("Chromium: no console errors", not CONSOLE, CONSOLE[:3])


def main() -> int:
    gh_port, site_port, psi_port, vercel_port, preview_port = free_ports(5)
    site_url = f"http://127.0.0.1:{site_port}"
    preview_url = f"http://127.0.0.1:{preview_port}"
    world = subprocess.Popen(["node", str(ROOT / "tests/mock_site_world.mjs"), str(gh_port), str(site_port), str(psi_port)], stdout=subprocess.PIPE, text=True, env={**__import__("os").environ, "MOCK_PREVIEW_URL": site_url, "MOCK_REPO_HOMEPAGE": site_url})
    vercel = subprocess.Popen(["node", str(ROOT / "tests/mock_vercel.mjs"), str(vercel_port), str(preview_port)], stdout=subprocess.PIPE, text=True)
    try:
        assert world.stdout is not None and world.stdout.readline().strip() == "READY", "mock world did not start"
        assert vercel.stdout is not None and vercel.stdout.readline().strip() == "READY", "mock Vercel did not start"
        env = {"KNIFE_GITHUB_API_URL": f"http://127.0.0.1:{gh_port}", "KNIFE_PSI_API_URL": f"http://127.0.0.1:{psi_port}/run", "KNIFE_VERCEL_API_URL": f"http://127.0.0.1:{vercel_port}"}
        with ScratchServer() as server:
            server.start(env=env)
            print(f"scratch server {server.url} data {server.data_dir}", flush=True)
            try:
                run(server, f"http://127.0.0.1:{gh_port}", site_url, preview_url)
            except Exception:  # noqa: BLE001
                traceback.print_exc()
                FAILS.append("crashed: " + traceback.format_exc().strip().splitlines()[-1])
                print(server.log_tail(3000))
    finally:
        for proc in (world, vercel):
            proc.terminate()
            proc.wait(timeout=10)
    print(f"\n{PASSES} passed, {len(FAILS)} failed")
    if FAILS:
        print(f"{len(FAILS)} FAILED: {FAILS}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
