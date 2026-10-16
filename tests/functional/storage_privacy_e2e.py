#!/usr/bin/env python3
"""Per-account storage privacy end to end (KNIFE_AUTH_MODE=public), two users and an admin on one scratch server:

- tool drafts follow the account, not the browser: alice types into a tool, the draft is saved to her account, restored
  after a reload and in a fresh browser context (another machine) in Chromium and Firefox; bob opening the same tool sees
  none of it, and GET /api/workspace never answers another account's drafts;
- server-backed tools are not wrapped (no draft line on the CV studio), signed-out pages work without drafts;
- at rest: after real flows (CV offer + photo, office document, course progress, drafts) every per-account file under the
  data dir is sealed (src/lib/storage/sealed.ts magic header) and no file anywhere in the data dir carries the plaintext;
  the storage key lives in KNIFE_STORAGE_KEY_FILE outside the data dir.

Self-contained: own scratch server (tests/scratch_server.py: worktree of the current tree, fresh KNIFE_DATA_DIR, free
loopback port), outbox mail, own KNIFE_SIDECAR_PREFIX, key file in a temp dir removed on exit. Never the live server.

Usage: python3 tests/functional/storage_privacy_e2e.py [--headed]
"""
from __future__ import annotations

import base64
import secrets
import shutil
import sys
import tempfile
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from playwright.sync_api import Browser, Page, expect, sync_playwright  # noqa: E402

from tests.functional.accounts_public_e2e import Api, Outbox, cli, go, new_context, ui_login  # noqa: E402
from tests.functional.roles_mcp_e2e import register_user  # noqa: E402
import tests.functional.roles_mcp_e2e as roles  # noqa: E402
from tests.scratch_server import ScratchServer  # noqa: E402

HEADED = "--headed" in sys.argv
FAILS: list[str] = []
PASSES = 0
ADMIN_PW = "admin password 12"
MAGIC = b"\0SKENC01"
MARKER = "privacy-marker-" + secrets.token_hex(4)
TOOL = "/tools/reading-grade?tab=words"
# A tiny valid JPEG (SOI, APP0 marker with the plaintext marker as payload, EOI): the photo store checks the magic bytes.
JPEG = b"\xff\xd8\xff\xe0" + MARKER.encode() + b"\xff\xd9"
ACCOUNT_DIRS = ("cv", "docs", "conversations", "learn", "usage", "workspace")


def check(name: str, ok: bool, detail: object = "") -> bool:
    global PASSES
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'' if ok else '  -> ' + str(detail)[:600]}", flush=True)
    if ok:
        PASSES += 1
    else:
        FAILS.append(name)
    return ok


def textarea(page: Page):  # noqa: ANN201
    return page.locator("main textarea").first


def open_tool(page: Page) -> None:
    go(page, TOOL)
    page.wait_for_function("!/Loading tool/.test(document.querySelector('main')?.innerText ?? '')", timeout=30_000)
    textarea(page).wait_for(timeout=15_000)


def drafts(browser: Browser, engine: str, base: str, data: Path) -> None:
    ip_a, ip_b = ("203.0.113.31", "203.0.113.32") if engine == "chromium" else ("203.0.113.41", "203.0.113.42")
    text = f"{MARKER} {engine} draft words words"
    ctx_a, page_a = new_context(browser, base, ip_a)
    ui_login(page_a, "alice", "alice password 1")
    page_a.wait_for_url(base + "/", timeout=15_000)
    open_tool(page_a)
    textarea(page_a).fill(text)
    expect(page_a.get_by_text("Draft saved to your account")).to_be_visible(timeout=10_000)
    page_a.wait_for_timeout(1_500)  # the 700 ms debounce + the PATCH
    expect(page_a.get_by_text("Draft saved to your account")).to_be_visible(timeout=10_000)
    page_a.reload(wait_until="networkidle")
    textarea(page_a).wait_for(timeout=15_000)
    check(f"[{engine}] alice's draft is restored after a reload", textarea(page_a).input_value() == text, textarea(page_a).input_value()[:120])
    words = page_a.locator("main table tbody tr").filter(has_text="words")
    check(f"[{engine}] the restored draft drives the tool (its word table counts it)",
          words.count() == 1 and words.first.locator("td").nth(1).inner_text().strip() == "2", page_a.locator("main table").inner_text()[:200])
    ctx_a.close()

    ctx_a2, page_a2 = new_context(browser, base, ip_a)
    ui_login(page_a2, "alice", "alice password 1")
    page_a2.wait_for_url(base + "/", timeout=15_000)
    open_tool(page_a2)
    expect(textarea(page_a2)).to_have_value(text, timeout=10_000)
    check(f"[{engine}] alice's draft follows her to a fresh browser (another machine)", textarea(page_a2).input_value() == text)
    ctx_a2.close()

    ctx_b, page_b = new_context(browser, base, ip_b)
    ui_login(page_b, "bob", "bob password 1")
    page_b.wait_for_url(base + "/", timeout=15_000)
    open_tool(page_b)
    page_b.wait_for_timeout(800)
    check(f"[{engine}] bob opening the same tool sees none of alice's draft", MARKER not in textarea(page_b).input_value(), textarea(page_b).input_value()[:120])
    go(page_b, "/tools/cv-studio")
    page_b.wait_for_function("!/Loading/.test(document.querySelector('main [role=status]')?.textContent ?? '')", timeout=30_000)
    check(f"[{engine}] CV studio is not wrapped by drafts (server data wins)", page_b.locator("[data-workspace-tool]").count() == 0)
    ctx_b.close()


def run(server: ScratchServer, key_file: Path) -> None:
    base = server.url
    data = server.data_dir
    assert data is not None
    api = Api(base)
    box = Outbox(data)
    roles.check = check  # register_user reports through this suite's counters

    check("CLI set-password + set-email for the admin",
          cli(data, "set-password", "genor", stdin=ADMIN_PW + "\n").returncode == 0 and cli(data, "set-email", "genor", "admin@knife.example.com").returncode == 0)
    alice = register_user(api, box, "alice", "203.0.113.3")
    bob = register_user(api, box, "bob", "203.0.113.4")

    # ------------------------------------------------------------------------------------ 1. real per-account writes
    status, body, _ = api.call("POST", "/api/agent/tool", {"name": "knife_cv_job_save", "args": {"title": MARKER, "company": f"{MARKER} Corp", "text": f"{MARKER} offer"}}, cookie=alice)
    check("alice saves a CV job offer", status == 200, (status, body))
    status, body, _ = api.call("POST", "/api/cv/photo", {"dataUrl": "data:image/jpeg;base64," + base64.b64encode(JPEG).decode()}, cookie=alice)
    check("alice uploads a CV photo", status == 200, (status, body))
    status, body, _ = api.call("POST", "/api/office/docs", {"action": "create", "format": "docx", "name": MARKER}, cookie=alice)
    check("alice creates an office document", status == 201, (status, body))
    status, body, _ = api.call("POST", "/api/learn/progress", {"action": "save", "course": "sql", "lessonId": "select-all", "sql": f"SELECT '{MARKER}'"}, cookie=alice)
    check("alice saves a course query", status == 200, (status, body))
    status, body, _ = api.call("PATCH", "/api/workspace", {"tool": "json", "fields": {"textarea::input:0": f"{MARKER} api draft"}}, cookie=alice)
    check("alice saves a draft over the API", status == 200, (status, body))

    # ------------------------------------------------------------------------------------ 2. isolation over HTTP
    status, body, _ = api.call("GET", "/api/workspace", cookie=bob)
    check("bob's drafts carry nothing of alice's", status == 200 and MARKER not in str(body), (status, str(body)[:200]))
    status, body, _ = api.call("GET", "/api/workspace", cookie=alice)
    check("alice reads her own draft back", status == 200 and f"{MARKER} api draft" in str(body), (status, str(body)[:200]))
    status, body, _ = api.call("GET", "/api/cv/photo", cookie=bob)
    check("bob has no photo", status in (404, 200) and MARKER.encode() not in (body.encode() if isinstance(body, str) else str(body).encode()), status)
    status, body, _ = api.call("GET", "/api/office/docs", cookie=bob)
    check("bob's library does not list alice's document", status == 200 and MARKER not in str(body), status)
    status, body, _ = api.call("GET", "/api/workspace?tool=json", cookie=alice)
    check("GET ?tool= answers only that tool's draft", status == 200 and list(body) == ["json"], (status, body))
    status, body, _ = api.call("GET", "/api/workspace?tool=reading-grade", cookie=alice)
    check("GET ?tool= for a tool without a draft -> {}", status == 200 and body == {}, (status, body))
    status, body, _ = api.call("GET", "/api/workspace?tool=..%2Fx", cookie=alice)
    check("GET ?tool= with a malformed id -> 400", status == 400, status)
    status, body, _ = api.call("GET", "/api/workspace", ip="203.0.113.77")
    check("drafts without a session -> 401", status == 401, status)
    status, body, _ = api.call("PATCH", "/api/workspace", {"tool": "../x", "fields": {}}, cookie=alice)
    check("a draft for a malformed tool id -> 400", status == 400, status)

    # ------------------------------------------------------------------------------------ 3. drafts in two browsers
    with sync_playwright() as pw:
        for engine in ("chromium", "firefox"):
            browser = getattr(pw, engine).launch(headless=not HEADED)
            try:
                drafts(browser, engine, base, data)
            finally:
                browser.close()

    # ------------------------------------------------------------------------------------ 4. at rest
    per_account = [p for d in ACCOUNT_DIRS if (data / d).exists() for p in (data / d).rglob("*") if p.is_file()]
    owners = {p.relative_to(data).parts[0] for p in per_account}
    check("every kind of per-account store wrote files", {"cv", "docs", "learn", "workspace"} <= owners, sorted(owners))
    unsealed = [str(p.relative_to(data)) for p in per_account if p.read_bytes()[: len(MAGIC)] != MAGIC]
    check(f"all {len(per_account)} per-account files are sealed", not unsealed, unsealed[:10])
    leaking = [str(p.relative_to(data)) for p in data.rglob("*") if p.is_file() and MARKER.encode() in p.read_bytes()]
    check("no file in the data dir carries the plaintext marker", not leaking, leaking[:10])
    check("the storage key is outside the data dir (KNIFE_STORAGE_KEY_FILE), 0600",
          key_file.exists() and (key_file.stat().st_mode & 0o777) == 0o600 and not (data / "storage.key").exists())
    modes = {oct(p.stat().st_mode & 0o777) for p in per_account}
    check("per-account files are 0600", modes == {"0o600"}, modes)


def main() -> int:
    key_dir = Path(tempfile.mkdtemp(prefix="knife-storage-key-"))
    key_file = key_dir / "storage.key"
    env = {
        "KNIFE_AUTH_MODE": "public",
        "KNIFE_MAIL_TRANSPORT": "outbox",
        "KNIFE_TRUSTED_PROXIES": "127.0.0.1,::1",
        "KNIFE_SIDECAR_PREFIX": f"sk-storage-e2e-{secrets.token_hex(3)}",
        "KNIFE_STORAGE_KEY_FILE": str(key_file),
    }
    try:
        with ScratchServer() as server:
            server.start(env=env)
            print(f"scratch server {server.url} data {server.data_dir}", flush=True)
            try:
                run(server, key_file)
            except Exception:  # noqa: BLE001
                traceback.print_exc()
                FAILS.append("crashed: " + traceback.format_exc().strip().splitlines()[-1])
                print(server.log_tail(3000))
    finally:
        shutil.rmtree(key_dir, ignore_errors=True)
    print(f"\n{PASSES} passed, {len(FAILS)} failed")
    if FAILS:
        print(f"{len(FAILS)} FAILED: {FAILS}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
