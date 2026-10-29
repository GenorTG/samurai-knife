#!/usr/bin/env python3
"""Roles and per-account MCP end to end (KNIFE_AUTH_MODE=public), two users and an admin on one scratch server:

- a user never sees or calls admin tools (GitHub with the host's `gh` login, git repos on the host's disk): not in
  GET /api/agent/tools, 403 from POST /api/agent/tool, absent from MCP tools/list and an error from tools/call; the
  matching /api/cv/showcase/* routes are 403; the admin gets all of them;
- a user cannot control sidecars (every lifecycle action, the lazy start of a stopped one), read op logs, rebuild the
  course data or read the server queue; the 401 body names no account;
- MCP keys: create/list/revoke on /account (the UI shows the key once, with the personal URL and ready-made client
  settings; a read-only key from the page lists no write tool), Basic and Bearer + X-Knife-User, a wrong username, a
  malformed header, a revoked key, no key at all, another account's key on a personal URL;
- cross-account isolation over MCP: alice's CV offers and documents are invisible to bob, and knife_ui_state /
  knife_ui_show reach only the caller's own open tabs;
- the CV studio tells a user that an administrator has to run the GitHub showcase; logging out clears the account's
  browser storage.

Self-contained: own scratch server (tests/scratch_server.py: worktree of the current tree, fresh KNIFE_DATA_DIR, free
loopback port; KNIFE_SCRATCH_PORTS / KNIFE_SCRATCH_TMP_PREFIX narrow both), outbox mail, own KNIFE_SIDECAR_PREFIX. No
container is ever started (the "installed but stopped" sidecar is a state file only). Never the live server or its data.

Usage: python3 tests/functional/roles_mcp_e2e.py [--headed]
"""
from __future__ import annotations

import base64
import json
import re
import secrets
import sys
import time
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from playwright.sync_api import Browser, expect, sync_playwright  # noqa: E402

from tests.functional.accounts_public_e2e import Api, Outbox, cli, go, new_context, ui_login  # noqa: E402
from tests.scratch_server import ScratchServer, free_port  # noqa: E402

HEADED = "--headed" in sys.argv
FAILS: list[str] = []
PASSES = 0
ADMIN_PW = "admin password 12"
ADMIN_TOOLS = {"knife_cv_github_repos", "knife_cv_github_repo_facts", "knife_cv_local_repo_facts", "knife_cv_showcase_rank", "knife_cv_project_from_github"}


def check(name: str, ok: bool, detail: object = "") -> bool:
    global PASSES
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'' if ok else '  -> ' + str(detail)[:600]}", flush=True)
    if ok:
        PASSES += 1
    else:
        FAILS.append(name)
    return ok


def basic(user: str, key: str) -> dict[str, str]:
    return {"Authorization": "Basic " + base64.b64encode(f"{user}:{key}".encode()).decode()}


class Mcp:
    def __init__(self, api: Api) -> None:
        self.api = api
        self.rpc = 0

    def call(self, method: str, params: dict | None, headers: dict[str, str] | None, ip: str = "203.0.113.50", path: str = "/api/mcp") -> tuple[int, object]:
        self.rpc += 1
        status, body, _ = self.api.call("POST", path, {"jsonrpc": "2.0", "id": self.rpc, "method": method, "params": params or {}}, ip=ip,
                                        headers={"Accept": "application/json, text/event-stream", **(headers or {})})
        if isinstance(body, str):  # SSE framing
            data = [line[6:] for line in body.split("\n") if line.startswith("data: ")]
            body = json.loads(data[0]) if data else body
        return status, body

    def tools(self, headers: dict[str, str], path: str = "/api/mcp") -> set[str]:
        status, body = self.call("tools/list", {}, headers, path=path)
        if status != 200 or not isinstance(body, dict):
            return set()
        return {tool["name"] for tool in body.get("result", {}).get("tools", [])}

    def tool(self, name: str, args: dict, headers: dict[str, str]) -> tuple[bool, str]:
        """(ok, text) of tools/call; ok False for a JSON-RPC error or an isError result."""
        status, body = self.call("tools/call", {"name": name, "arguments": args}, headers)
        if status != 200 or not isinstance(body, dict):
            return False, f"HTTP {status}: {body}"
        if "error" in body:
            return False, json.dumps(body["error"])
        result = body.get("result", {})
        text = "".join(part.get("text", "") for part in result.get("content", []))
        return not result.get("isError", False), text


def register_user(api: Api, box: Outbox, name: str, ip: str) -> str:
    """Registers and verifies `name` through the API (password '<name> password 1'); returns a session cookie."""
    api.call("POST", "/api/account/register", {"username": name, "email": f"{name}@example.com", "password": f"{name} password 1"}, ip=ip)
    mails = box.wait(f"{name}@example.com", 1)
    token = Outbox.token(Outbox.link(mails[0][2], "/verify")) if mails else ""
    api.call("POST", "/api/account/verify", {"token": token}, ip=ip)
    status, _, cookie = api.login(name, f"{name} password 1", ip)
    check(f"{name} registered, verified and logged in", status == 200 and bool(cookie), status)
    return cookie or ""


def run(server: ScratchServer, browser: Browser) -> None:
    base = server.url
    data = server.data_dir
    assert data is not None
    api = Api(base)
    box = Outbox(data)
    mcp = Mcp(api)

    # ---------------------------------------------------------------------------------------------- setup
    status, body, _ = api.call("GET", "/api/account", ip="203.0.113.1")
    check("public 401 names no account", status == 401 and isinstance(body, dict) and "accounts" not in body and body.get("mode") == "public", body)
    check("CLI set-password + set-email for the admin",
          cli(data, "set-password", "genor", stdin=ADMIN_PW + "\n").returncode == 0 and cli(data, "set-email", "genor", "admin@knife.example.com").returncode == 0)
    status, _, admin = api.login("genor", ADMIN_PW, "203.0.113.2")
    check("admin logs in", status == 200 and bool(admin), status)
    alice = register_user(api, box, "alice", "203.0.113.3")
    bob = register_user(api, box, "bob", "203.0.113.4")

    # ------------------------------------------------------------------------------- 1. widget tool route by role
    _, body, _ = api.call("GET", "/api/agent/tools", cookie=alice)
    user_tools = {t["function"]["name"] for t in body.get("tools", [])} if isinstance(body, dict) else set()
    _, body, _ = api.call("GET", "/api/agent/tools", cookie=admin)
    admin_tools = {t["function"]["name"] for t in body.get("tools", [])} if isinstance(body, dict) else set()
    check("widget tool list: a user gets no admin tool", user_tools and not (user_tools & ADMIN_TOOLS), user_tools & ADMIN_TOOLS)
    check("widget tool list: the admin gets every admin tool", ADMIN_TOOLS <= admin_tools, ADMIN_TOOLS - admin_tools)
    check("widget tool list: account tools for both", "knife_cv_get" in user_tools and "knife_cv_get" in admin_tools)
    for name, args in (("knife_cv_local_repo_facts", {"path": str(ROOT)}), ("knife_cv_github_repos", {}), ("knife_cv_github_repo_facts", {"repo": "x"}),
                       ("knife_cv_showcase_rank", {}), ("knife_cv_project_from_github", {"repo": "x/y"})):
        status, body, _ = api.call("POST", "/api/agent/tool", {"name": name, "args": args}, cookie=alice)
        check(f"widget route: user calling {name} -> 403 admin_required", status == 403 and isinstance(body, dict) and body.get("code") == "admin_required"
              and body.get("ok") is False and "administrator" in body.get("error", ""), (status, body))
    status, body, _ = api.call("POST", "/api/agent/tool", {"name": "knife_cv_local_repo_facts", "args": {"path": "/definitely/not/allowed"}}, cookie=admin)
    check("widget route: the admin may call knife_cv_local_repo_facts (refused by the path fence, not by role)",
          status == 200 and isinstance(body, dict) and body.get("ok") is False and "administrator" not in body.get("error", ""), (status, body))

    # ---------------------------------------------------------------------------------- 2. showcase routes by role
    for method, path, payload in (("GET", "/api/cv/showcase/repo?repo=x/y", None), ("GET", "/api/cv/showcase/rank", None),
                                  ("GET", f"/api/cv/showcase/local?path={ROOT}", None), ("POST", "/api/cv/showcase/project", {"repo": "x/y"})):
        status, body, _ = api.call(method, path, payload, cookie=alice)
        check(f"user {method} {path.split('?')[0]} -> 403", status == 403 and isinstance(body, dict) and body.get("code") == "admin_required", (status, body))
    status, body, _ = api.call("GET", "/api/cv/showcase/local?path=/definitely/not/allowed", cookie=admin)
    check("admin GET /api/cv/showcase/local passes the role check", status != 403 or (isinstance(body, dict) and body.get("code") != "admin_required"), (status, body))

    # ------------------------------------------------------------------- 3. sidecar control, course rebuild, queue
    svc_dir = data / "services" / "office"
    svc_dir.mkdir(parents=True, exist_ok=True)
    now_iso = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    (svc_dir / "state.json").write_text(json.dumps({
        "id": "office", "image": "ghcr.io/example/office:1", "bindHost": "127.0.0.1", "hostPort": free_port(),
        "idleStopMinutes": 0, "installedAt": now_iso, "updatedAt": now_iso,
    }))
    for action in ({"action": "install"}, {"action": "start"}, {"action": "stop"}, {"action": "update"}, {"action": "remove", "purge": True},
                   {"action": "configure", "publicUrl": "http://evil.example"}, {"action": "ensure"}):
        status, body, _ = api.call("POST", "/api/services/office", action, cookie=bob)
        check(f"user sidecar {action['action']} -> 403 (no container started)", status == 403 and isinstance(body, dict) and body.get("code") == "admin_required", (status, body))
    status, body, _ = api.call("GET", "/api/services", cookie=bob)
    office = next((s for s in body.get("services", []) if s.get("id") == "office"), {}) if isinstance(body, dict) else {}
    check("user sidecar list: no configuration, canManage false", status == 200 and office.get("canManage") is False and office.get("state") is None, office)
    status, body, _ = api.call("GET", "/api/services/ops/op_doesnotexist", cookie=bob)
    check("user op lookup of a missing op -> 404", status == 404, (status, body))
    check("user course rebuild -> 403", api.call("POST", "/api/learn/sql/setup", {"force": True}, cookie=bob)[0] == 403)
    check("user server queue stats -> 403", api.call("GET", "/api/system/queue", cookie=bob)[0] == 403)
    check("admin server queue stats -> 200", api.call("GET", "/api/system/queue", cookie=admin)[0] == 200)

    # ----------------------------------------------------------------------------------------- 4. MCP keys API
    status, body = mcp.call("tools/list", {}, None)
    check("MCP without credentials -> 401 mcp_key_required", status == 401 and isinstance(body, dict) and body.get("error") == "mcp_key_required", (status, body))
    status, body, hdrs = api.call("POST", "/api/account/mcp-keys", {"action": "create", "name": "alice laptop"}, cookie=alice)
    alice_key = body.get("key", "") if isinstance(body, dict) else ""
    check("alice creates an MCP key (201, shown once)", status == 201 and alice_key.startswith("skm_") and body.get("username") == "alice", (status, body))
    status, body, _ = api.call("POST", "/api/account/mcp-keys", {"action": "create", "name": "bob ci"}, cookie=bob)
    bob_key = body.get("key", "") if isinstance(body, dict) else ""
    status, body, _ = api.call("POST", "/api/account/mcp-keys", {"action": "create", "name": "admin agent"}, cookie=admin)
    admin_key = body.get("key", "") if isinstance(body, dict) else ""
    status, body, _ = api.call("GET", "/api/account/mcp-keys", cookie=alice)
    rows = body.get("keys", []) if isinstance(body, dict) else []
    check("alice's key list: one key, no secret or hash", len(rows) == 1 and rows[0]["name"] == "alice laptop" and alice_key not in json.dumps(body)
          and "hash" not in rows[0], body)
    alice_key_id = rows[0]["id"] if rows else ""
    store_text = (data / "mcp-keys.json").read_text()
    check("mcp-keys.json holds hashes only", alice_key not in store_text and bob_key not in store_text, "raw key on disk")
    _, body, _ = api.call("GET", "/api/account/mcp-keys", cookie=bob)
    check("bob's list does not show alice's key", all(r["id"] != alice_key_id for r in body.get("keys", [])), body)

    # ----------------------------------------------------------------------------------------- 5. MCP auth forms
    check("MCP Basic alice:key -> tools listed", "knife_cv_get" in mcp.tools(basic("alice", alice_key)))
    check("MCP Bearer + X-Knife-User -> tools listed", "knife_cv_get" in mcp.tools({"Authorization": f"Bearer {alice_key}", "X-Knife-User": "alice"}))
    status, body = mcp.call("tools/list", {}, basic("bob", alice_key))
    check("MCP alice's key with username bob -> 401", status == 401 and body.get("error") == "invalid_mcp_key", (status, body))
    status, _ = mcp.call("tools/list", {}, {"Authorization": f"Bearer {alice_key}"})
    check("MCP Bearer without X-Knife-User -> 401", status == 401, status)
    status, _ = mcp.call("tools/list", {}, basic("alice", "skm_" + "A" * 43))
    check("MCP made-up key -> 401", status == 401, status)

    # ------------------------------------------------------------------------------------- 6. MCP tools by role
    user_mcp = mcp.tools(basic("alice", alice_key))
    admin_mcp = mcp.tools(basic("genor", admin_key))
    check("MCP tools/list: a user gets no admin tool, but the UI tools", user_mcp and not (user_mcp & ADMIN_TOOLS) and "knife_ui_show" in user_mcp, user_mcp & ADMIN_TOOLS)
    check("MCP tools/list: the admin gets the admin tools", ADMIN_TOOLS <= admin_mcp, ADMIN_TOOLS - admin_mcp)
    for name in sorted(ADMIN_TOOLS):
        ok, text = mcp.tool(name, {"path": str(ROOT)} if name == "knife_cv_local_repo_facts" else {}, basic("alice", alice_key))
        check(f"MCP user calling {name} fails without running it", not ok, text[:200])

    # ------------------------------------------------------------------------------ 7. cross-account data over MCP
    ok, text = mcp.tool("knife_cv_job_save", {"title": "Alice Secret Role", "company": "AliceCorp", "text": "alice only"}, basic("alice", alice_key))
    check("alice saves a job offer over MCP", ok, text[:300])
    ok, text = mcp.tool("knife_doc_create", {"format": "docx", "name": "alice-private-notes", "paragraphs": ["alice only"]}, basic("alice", alice_key))
    check("alice creates a document over MCP", ok, text[:300])
    ok, alice_jobs = mcp.tool("knife_cv_job_list", {}, basic("alice", alice_key))
    check("alice sees her offer", ok and "AliceCorp" in alice_jobs, alice_jobs[:300])
    ok, bob_jobs = mcp.tool("knife_cv_job_list", {}, basic("bob", bob_key))
    check("bob's MCP job list does not contain alice's offer", ok and "AliceCorp" not in bob_jobs, bob_jobs[:300])
    ok, bob_docs = mcp.tool("knife_doc_list", {}, basic("bob", bob_key))
    check("bob's MCP document list does not contain alice's document", ok and "alice-private-notes" not in bob_docs, bob_docs[:300])
    status, body, _ = api.call("GET", "/api/cv", cookie=bob)
    check("bob's CV over HTTP does not contain alice's offer", status == 200 and "AliceCorp" not in json.dumps(body), status)
    status, body, _ = api.call("GET", "/api/office/docs", cookie=bob)
    check("bob's document library over HTTP is empty of alice's", status == 200 and "alice-private-notes" not in json.dumps(body), status)

    # ------------------------------------------------------------------------- 8. UI bridge: only your own tabs
    ctx_a, page_a = new_context(browser, base, "203.0.113.60")
    ui_login(page_a, "alice", "alice password 1")
    page_a.wait_for_url(base + "/", timeout=30_000)
    go(page_a, "/tools/cv-studio?tab=showcase")
    expect(page_a.get_by_text(re.compile(r"An administrator has to run the project showcase"))).to_be_visible(timeout=60_000)
    check("CV studio showcase tab tells a user an administrator has to run it", page_a.get_by_role("button", name="Rank my repositories").count() == 0)
    deadline = time.monotonic() + 20
    alice_state = ""
    while time.monotonic() < deadline:
        ok, alice_state = mcp.tool("knife_ui_state", {}, basic("alice", alice_key))
        if "cv-studio" in alice_state:
            break
        time.sleep(0.5)
    check("knife_ui_state as alice lists her open tab", "cv-studio" in alice_state, alice_state[:300])
    ok, bob_state = mcp.tool("knife_ui_state", {}, basic("bob", bob_key))
    check("knife_ui_state as bob does not see alice's tab", ok and "cv-studio" not in bob_state, bob_state[:300])
    ok, shown = mcp.tool("knife_ui_show", {"slug": "qr", "note": "bob was here"}, basic("bob", bob_key))
    time.sleep(3)
    check("knife_ui_show as bob reaches no tab of alice's", ok and '"shown": false' in shown and "/tools/cv-studio" in page_a.url, (shown[:200], page_a.url))

    # ------------------------------------------------------------------------------ 9. MCP keys UI and revocation
    go(page_a, "/account")
    form = page_a.get_by_role("form", name="New MCP key")
    form.get_by_label("Key name").fill("from the page")
    form.get_by_role("button", name="Create key").click()
    shown_key = page_a.get_by_test_id("mcp-key-value")
    expect(shown_key).to_be_visible(timeout=15_000)
    ui_key = shown_key.inner_text().strip()
    check("account page creates a key and shows it once", ui_key.startswith("skm_") and "knife_cv_get" in mcp.tools(basic("alice", ui_key)), ui_key[:8])
    personal = page_a.get_by_test_id("mcp-personal-url").inner_text().strip()
    check("account page shows the personal MCP URL", personal.startswith("http") and personal.endswith("/api/mcp/u/alice"), personal)
    openclaw = page_a.locator("[data-mcp-config=openclaw] pre").inner_text()
    claude = page_a.locator("[data-mcp-config=claude] pre").inner_text()
    cursor = json.loads(page_a.locator("[data-mcp-config=cursor] pre").inner_text())
    check("ready-made OpenClaw / Claude Code / Cursor settings carry the personal URL and the new key",
          f"--url {personal} --transport streamable-http --header \"Authorization=Bearer {ui_key}\"" in openclaw
          and f"claude mcp add --transport http samurai-knife {personal} --header \"Authorization: Bearer {ui_key}\"" in claude
          and cursor["mcpServers"]["samurai-knife"] == {"url": personal, "headers": {"Authorization": f"Bearer {ui_key}"}}, (openclaw, claude))
    check("the personal URL takes the key alone", "knife_cv_patch" in mcp.tools({"Authorization": f"Bearer {ui_key}"}, path="/api/mcp/u/alice"))
    status, _ = mcp.call("tools/list", {}, {"Authorization": f"Bearer {ui_key}"}, path="/api/mcp/u/bob")
    check("alice's key on bob's personal URL -> 401", status == 401, status)
    form.get_by_label("Key name").fill("reader")
    form.get_by_role("combobox", name="What the key may do").select_option("read-only")
    form.get_by_role("button", name="Create key").click()
    expect(page_a.get_by_text('Key "reader" created')).to_be_visible(timeout=15_000)
    reader_key = page_a.get_by_test_id("mcp-key-value").inner_text().strip()
    expect(page_a.locator("[data-mcp-scope=read-only]")).to_have_count(1, timeout=15_000)
    reader_tools = mcp.tools({"Authorization": f"Bearer {reader_key}"}, path="/api/mcp/u/alice")
    check("a read-only key from the page lists read tools only", "knife_cv_get" in reader_tools and "knife_cv_patch" not in reader_tools and "knife_cv_job_save" not in reader_tools, sorted(reader_tools)[:10])
    ok, text = mcp.tool("knife_cv_job_save", {"title": "x", "company": "y", "text": "z"}, basic("alice", reader_key))
    check("a read-only key cannot call a write tool", not ok, text[:200])
    page_a.reload(wait_until="networkidle")
    check("the key is not shown again after a reload", page_a.get_by_test_id("mcp-key-value").count() == 0 and ui_key not in page_a.content())
    page_a.get_by_role("button", name="Revoke from the page").click()
    expect(page_a.get_by_text('Revoked "from the page"')).to_be_visible(timeout=15_000)
    status, _ = mcp.call("tools/list", {}, basic("alice", ui_key))
    check("a key revoked in the UI stops working", status == 401, status)
    status, _, _ = api.call("POST", "/api/account/mcp-keys", {"action": "revoke", "id": alice_key_id}, cookie=bob)
    check("bob cannot revoke alice's key (404)", status == 404, status)
    check("alice's key still works after bob's attempt", "knife_cv_get" in mcp.tools(basic("alice", alice_key)))
    status, _, _ = api.call("POST", "/api/account/mcp-keys", {"action": "revoke", "id": alice_key_id}, cookie=alice)
    status2, _ = mcp.call("tools/list", {}, basic("alice", alice_key))
    check("alice revokes her key over the API; it stops working", status == 200 and status2 == 401, (status, status2))

    # --------------------------------------------------------------------------------- 10. logout clears storage
    page_a.evaluate("""() => {
        localStorage.setItem('sk.agent.chat.v1.alice:http%3A%2F%2Fx:m', '[]');
        localStorage.setItem('sk.agent.queue.v1.alice', '{"items":[]}');
        localStorage.setItem('sk.sql.schema.v1.alice', '{"schema":{"tables":[]},"source":"t"}');
        localStorage.setItem('sk.agent.mode.v1', 'all');
        localStorage.setItem('sk.agent.chat.v1.bob', 'other');
    }""")
    page_a.get_by_role("button", name="Log out", exact=True).click()
    page_a.wait_for_url(re.compile(r"/login"), timeout=15_000)
    # sk.agent.ui.v1 is the widget's size/position, not account data.
    left = page_a.evaluate("() => Object.keys(localStorage).filter(k => (k.startsWith('sk.agent.') || k.startsWith('sk.sql.')) && k !== 'sk.agent.ui.v1')")
    check("logout removes alice's transcript, queue, SQL schema and the trust mode (another account's key untouched)",
          sorted(left) == ["sk.agent.chat.v1.bob"], left)
    ctx_a.close()

    # --------------------------------------------------------------------------- 11. failed MCP auth rate limit
    codes = [mcp.call("tools/list", {}, basic("alice", "skm_" + "B" * 43), ip="203.0.113.99")[0] for _ in range(31)]
    check("30 failed MCP authentications per address, then 429", codes[:30] == [401] * 30 and codes[30] == 429, codes[-3:])


def main() -> int:
    prefix = f"sk-roles-e2e-{secrets.token_hex(3)}"
    env = {
        "KNIFE_AUTH_MODE": "public",
        "KNIFE_MAIL_TRANSPORT": "outbox",
        "KNIFE_TRUSTED_PROXIES": "127.0.0.1,::1",
        "KNIFE_SIDECAR_PREFIX": prefix,
    }
    with ScratchServer() as server:
        server.start(env=env)
        print(f"scratch server {server.url} data {server.data_dir}", flush=True)
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=not HEADED)
            try:
                run(server, browser)
            except Exception:  # noqa: BLE001
                traceback.print_exc()
                FAILS.append("crashed: " + traceback.format_exc().strip().splitlines()[-1])
                print(server.log_tail(3000))
            finally:
                browser.close()
    print(f"\n{PASSES} passed, {len(FAILS)} failed")
    if FAILS:
        print(f"{len(FAILS)} FAILED: {FAILS}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
