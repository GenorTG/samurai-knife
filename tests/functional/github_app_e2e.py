#!/usr/bin/env python3
"""GitHub App end to end (docs/GITHUB.md), public mode, against tests/mock_github_app.mjs (fake GitHub API + github.com
+ website + PageSpeed), driven in Chromium like people would:

- the admin creates the GitHub App from the Users page (manifest form POSTed to "github.com", confirmed, back with
  "GitHub App created"); the credentials file is 0600 and outside the data dir;
- "Continue with GitHub" on /login sends a new GitHub user to /register for the Terms; after accepting, "Sign up with GitHub"
  registers alice (GitHub's verified email, no password, user role) and signs her in;
  her account page shows the GitHub link, the password-less note, and refuses to unlink;
- the website studio Connect tab offers "GitHub App (no token)", lists the repository of the installation alice can
  reach, connects it; an agent with alice's MCP key edits and opens a pull request through a one-hour token minted for
  that one repository;
- mallory signs up with GitHub and opens the setup URL with alice's installation id: nothing is linked, connecting is
  refused (403);
- bob has a password account with the same email his GitHub user verifies: "Continue with GitHub" does not take it over;
- a forged callback state is refused; alice deletes her GitHub-only account by typing her username.

Self-contained: own scratch server, own mock world on free loopback ports. Never the live app or real GitHub.
Usage: python3 tests/functional/github_app_e2e.py [--headed]
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import traceback
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from playwright.sync_api import Page, expect, sync_playwright  # noqa: E402

from tests.functional.accounts_public_e2e import Api, cli, new_context, ui_login  # noqa: E402
from tests.scratch_server import ScratchServer, free_ports  # noqa: E402

HEADED = "--headed" in sys.argv
FAILS: list[str] = []
PASSES = 0
ADMIN_PW = "admin password 12"


def check(name: str, ok: bool, detail: object = "") -> bool:
    global PASSES
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'' if ok else '  -> ' + str(detail)[:600]}", flush=True)
    if ok:
        PASSES += 1
    else:
        FAILS.append(name)
    return ok


def web_user(web: str, login: str) -> None:
    urllib.request.urlopen(urllib.request.Request(f"{web}/__mock/user", data=json.dumps({"login": login}).encode(), method="POST"), timeout=10).read()


def hydrated(page: Page) -> None:
    page.wait_for_function("() => Array.from(document.querySelectorAll('main *')).slice(0, 400).some(el => Object.keys(el).some(k => k.startsWith('__reactProps$')))", timeout=60_000)


def mcp_tool(api: Api, key_user: str, key: str, name: str, args: dict) -> tuple[bool, str]:
    import base64
    status, body, _ = api.call("POST", "/api/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}},
                               headers={"Accept": "application/json, text/event-stream", "Authorization": "Basic " + base64.b64encode(f"{key_user}:{key}".encode()).decode()})
    if isinstance(body, str):
        data = [line[6:] for line in body.split("\n") if line.startswith("data: ")]
        body = json.loads(data[0]) if data else body
    if status != 200 or not isinstance(body, dict):
        return False, f"HTTP {status}: {body}"
    result = body.get("result", {})
    return not result.get("isError", False), "".join(p.get("text", "") for p in result.get("content", []))


def run(server: ScratchServer, web: str, app_file: Path) -> None:
    base = server.url
    data = server.data_dir
    assert data is not None
    api = Api(base)
    check("CLI: admin password + email", cli(data, "set-password", "genor", stdin=ADMIN_PW + "\n").returncode == 0 and cli(data, "set-email", "genor", "admin@knife.example.com").returncode == 0)
    r = cli(data, "add", "bob", "--name", "Bob", "--password-prompt", "--email", "bob@example.org", "--role", "user", stdin="bob password 12\n")
    check("CLI: bob has a password account with bob@example.org", r.returncode == 0, r.stderr)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=not HEADED)

        # ------------------------------------------------------------------------- 1. the admin creates the app
        ctx, page = new_context(browser, base, "203.0.113.10")
        ui_login(page, "genor", ADMIN_PW)
        page.wait_for_url(base + "/", timeout=15_000)
        page.goto("/account/admin", wait_until="networkidle")
        expect(page.get_by_role("button", name="Create the GitHub App on GitHub")).to_be_visible(timeout=20_000)
        page.get_by_label("App name (unique on GitHub)").fill("Knife E2E")
        page.get_by_role("button", name="Create the GitHub App on GitHub").click()
        page.wait_for_url("**/account/admin?github=created**", timeout=30_000)
        expect(page.get_by_text("GitHub App created.")).to_be_visible(timeout=20_000)
        expect(page.get_by_text("Knife E2E (knife-e2e)")).to_be_visible(timeout=20_000)
        check("admin creates the GitHub App through the manifest flow", True)
        check("the app credentials file is 0600 and outside the data dir", app_file.exists() and (app_file.stat().st_mode & 0o777) == 0o600 and str(data) not in str(app_file))
        ctx.close()

        # ------------------------------------------------------------------------- 2. alice registers with GitHub
        web_user(web, "alice")
        ctx_a, page_a = new_context(browser, base, "203.0.113.11")
        page_a.goto("/login", wait_until="networkidle")
        page_a.get_by_role("link", name="Continue with GitHub").click()
        # A new GitHub user has no account yet: the sign-up page asks for the Terms first (no account was created).
        page_a.wait_for_url("**/register?github_error=terms_required**", timeout=30_000)
        hydrated(page_a)
        ids = [a["id"] for a in json.loads((data / "accounts.json").read_text())["accounts"]]
        check("Continue with GitHub for a new user asks for the Terms on the sign-up page, creating no account", "alice" not in ids, ids)
        page_a.get_by_role("checkbox").check()
        page_a.get_by_role("link", name="Sign up with GitHub").click()
        page_a.wait_for_url("**/account?github=welcome**", timeout=30_000)
        hydrated(page_a)
        expect(page_a.get_by_text("Linked to GitHub user")).to_be_visible(timeout=20_000)
        status, me, _ = api.call("GET", "/api/account", cookie="knife_session=" + {c["name"]: c for c in ctx_a.cookies()}["knife_session"]["value"])
        acc = me.get("account", me) if isinstance(me, dict) else {}
        check("Continue with GitHub registers alice: verified email, user role, no password", status == 200 and acc.get("id") == "alice" and acc.get("email") == "alice@example.org" and acc.get("role") == "user" and acc.get("requiresPassword") is False and acc.get("github") == "alice", acc)
        check("the account page says she signs in with GitHub", page_a.get_by_text("You sign in with GitHub.").is_visible())
        page_a.get_by_role("button", name="Unlink GitHub").click()
        expect(page_a.get_by_text("Set a password first")).to_be_visible(timeout=10_000)
        check("a GitHub-only account cannot unlink (would lock itself out)", True)
        alice_cookie = "knife_session=" + {c["name"]: c for c in ctx_a.cookies()}["knife_session"]["value"]

        # ------------------------------------------------------------------------- 3. Connect with the app
        page_a.goto("/tools/cv-studio?tab=website&step=connect", wait_until="networkidle")
        page_a.get_by_role("button", name="Its GitHub repository").click()
        hydrated(page_a)
        expect(page_a.get_by_text("Signed in as @alice")).to_be_visible(timeout=20_000)
        check("Connect offers the GitHub App (no token) by default", page_a.get_by_role("radio", name="GitHub App (no token)").get_attribute("aria-checked") == "true" or page_a.get_by_role("button", name="GitHub App (no token)").count() > 0)
        page_a.get_by_label("GitHub repository").select_option("genor/website")
        page_a.get_by_role("button", name="Connect", exact=True).click()
        expect(page_a.get_by_text("Connected. Next: run an audit")).to_be_visible(timeout=20_000)
        expect(page_a.get_by_text("read and write")).to_be_visible(timeout=20_000)
        check("alice connects genor/website through the installation (read and write)", True)
        status, view, _ = api.call("GET", "/api/site", cookie=alice_cookie)
        conn = (view or {}).get("connection") or {} if isinstance(view, dict) else {}
        check("the stored connection is an installation, no token", status == 200 and conn.get("token", {}).get("source") == "app" and conn.get("token", {}).get("installationId") == 7, view)

        status, body, _ = api.call("POST", "/api/account/mcp-keys", {"action": "create", "name": "alice agent"}, cookie=alice_cookie)
        key = body.get("key", "") if isinstance(body, dict) else ""
        ok, text = mcp_tool(api, "alice", key, "knife_site_replace", {"path": "lib/site-data.ts", "find": '["Samurai Knife"]', "replace": '["Samurai Knife", "Alice project"]', "message": "Show Alice project"})
        check("an agent with alice's MCP key edits through the installation token", ok and '"branch": "knife/' in text, text[:300])
        ok, text = mcp_tool(api, "alice", key, "knife_site_pr", {"title": "Alice project", "body": "via the GitHub App"})
        check("and opens the pull request", ok and '"number": 1' in text, text[:300])
        ctx_a.close()

        # ------------------------------------------------------------------------- 4. mallory claims alice's installation
        web_user(web, "mallory")
        ctx_m, page_m = new_context(browser, base, "203.0.113.12")
        page_m.goto("/register", wait_until="networkidle")
        hydrated(page_m)
        page_m.get_by_role("checkbox").check()
        page_m.get_by_role("link", name="Sign up with GitHub").click()
        page_m.wait_for_url("**/account?github=welcome**", timeout=30_000)
        page_m.goto("/api/github/setup?installation_id=7&setup_action=install")
        page_m.wait_for_url("**/tools/cv-studio?tab=website&step=connect**", timeout=30_000)
        hydrated(page_m)
        expect(page_m.get_by_text("Signed in as @mallory")).to_be_visible(timeout=20_000)
        check("mallory's setup URL with installation 7 links nothing", page_m.get_by_text("not installed on any repository you can write to yet").is_visible())
        mal_cookie = "knife_session=" + {c["name"]: c for c in ctx_m.cookies()}["knife_session"]["value"]
        status, body, _ = api.call("PUT", "/api/site", {"repo": "genor/website", "tokenSource": "app", "installationId": 7}, cookie=mal_cookie)
        check("connecting to alice's installation is refused (403)", status == 403, (status, body))
        ctx_m.close()

        # ------------------------------------------------------------------------- 5. bob is not taken over
        web_user(web, "bob")
        ctx_b, page_b = new_context(browser, base, "203.0.113.13")
        page_b.goto("/register", wait_until="networkidle")
        hydrated(page_b)
        page_b.get_by_role("checkbox").check()
        page_b.get_by_role("link", name="Sign up with GitHub").click()
        page_b.wait_for_url("**/login?github_error=email_in_use**", timeout=30_000)
        expect(page_b.get_by_text("An account with bob@example.org already exists")).to_be_visible(timeout=10_000)
        check("GitHub sign-in with bob's email does not take over his password account", "knife_session" not in {c["name"] for c in ctx_b.cookies()})
        page_b.goto("/api/github/callback?code=x&state=forged")
        page_b.wait_for_url("**/login?github_error=expired**", timeout=10_000)
        check("a forged callback state is refused", True)
        ctx_b.close()

        # ------------------------------------------------------------------------- 6. alice deletes her account
        web_user(web, "alice")
        ctx_a2, page_a2 = new_context(browser, base, "203.0.113.14")
        page_a2.goto("/login", wait_until="networkidle")
        page_a2.get_by_role("link", name="Continue with GitHub").click()
        page_a2.wait_for_url(base + "/", timeout=30_000)
        page_a2.goto("/account", wait_until="networkidle")
        hydrated(page_a2)
        page_a2.get_by_role("button", name="Delete my account…").click()
        page_a2.get_by_label("Your username").fill("alice")
        page_a2.get_by_role("button", name="Delete account and data").click()
        page_a2.wait_for_url("**/?account-deleted=1", timeout=20_000)
        accounts = {a["id"] for a in json.loads((data / "accounts.json").read_text())["accounts"]}
        check("returning alice signs in with GitHub and deletes her GitHub-only account by typing her username", "alice" not in accounts, accounts)
        ctx_a2.close()

        # ------------------------------------------------------------------------- 7. Firefox renders the login page
        ff = pw.firefox.launch(headless=not HEADED)
        fpage = ff.new_page(base_url=base)
        errors: list[str] = []
        fpage.on("console", lambda m: errors.append(m.text[:200]) if m.type == "error" and "Failed to load resource" not in m.text else None)
        fpage.goto("/login", wait_until="networkidle")
        check("Firefox: the login page shows Continue with GitHub without console errors", fpage.get_by_role("link", name="Continue with GitHub").is_visible() and not errors, errors[:3])
        ff.close()
        browser.close()


def main() -> int:
    api_port, web_port, site_port, psi_port, app_port = free_ports(5)
    web = f"http://127.0.0.1:{web_port}"
    tmp = Path(tempfile.mkdtemp(prefix="knife-ghapp-e2e-"))
    app_file = tmp / "ops" / "github-app.json"
    world = subprocess.Popen(["node", str(ROOT / "tests/mock_github_app.mjs"), str(api_port), str(web_port), str(site_port), str(psi_port)], stdout=subprocess.PIPE, text=True)
    try:
        assert world.stdout is not None and world.stdout.readline().strip() == "READY", "mock world did not start"
        env = {
            "KNIFE_AUTH_MODE": "public",
            "KNIFE_MAIL_TRANSPORT": "outbox",
            "KNIFE_TRUSTED_PROXIES": "127.0.0.1,::1",
            "KNIFE_GITHUB_API_URL": f"http://127.0.0.1:{api_port}",
            "KNIFE_GITHUB_WEB_URL": web,
            "KNIFE_PSI_API_URL": f"http://127.0.0.1:{psi_port}/run",
            "KNIFE_GITHUB_APP_FILE": str(app_file),
            # GitHub only ever talks to the public URL (docs/GITHUB.md): here the scratch server's own address.
            "KNIFE_PORT": str(app_port),
            "KNIFE_PUBLIC_URL": f"http://127.0.0.1:{app_port}",
        }
        with ScratchServer() as server:
            server.start(env=env, overlay=["src/lib/agent-client/server-tool-policy.ts", "src/lib/net/budgets.ts", "src/lib/security/"])
            print(f"scratch server {server.url} data {server.data_dir}", flush=True)
            try:
                run(server, web, app_file)
            except Exception:  # noqa: BLE001
                traceback.print_exc()
                FAILS.append("crashed: " + traceback.format_exc().strip().splitlines()[-1])
                print(server.log_tail(3000))
    finally:
        world.terminate()
        world.wait(timeout=10)
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{PASSES} passed, {len(FAILS)} failed")
    if FAILS:
        print(f"{len(FAILS)} FAILED: {FAILS}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
