#!/usr/bin/env python3
"""Public-mode accounts end to end (KNIFE_AUTH_MODE=public): register, verify, login, sessions, reset, resend, generic
answers, rate limits, roles on sidecar ops, admin disable, account deletion. docs/ACCOUNTS.md is the contract.

Self-contained: starts its own scratch server (tests/scratch_server.py: worktree of the current tree, fresh KNIFE_DATA_DIR,
free loopback port) with KNIFE_AUTH_MODE=public, KNIFE_MAIL_TRANSPORT=outbox (links are read from the .eml files in
$KNIFE_DATA_DIR/mail-outbox/) and KNIFE_TRUSTED_PROXIES=loopback, so every scenario gets its own client address through
X-Forwarded-For and the rate-limit buckets of one scenario never leak into the next. It never touches the live :3210 server,
its data or any container: the "installed but stopped" sidecar is a state file under the scratch data dir with its own
KNIFE_SIDECAR_PREFIX, and no step can start it (only an administrator could, and the admin here never asks).

Usage: python3 tests/functional/accounts_public_e2e.py [--shots DIR] [--headed]
Oracles: the .eml files, accounts.json / sessions.json on disk, the files of every data location, HTTP status codes.
"""
from __future__ import annotations

import calendar
import email
import email.policy
import hashlib
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright  # noqa: E402

from tests.scratch_server import ScratchServer  # noqa: E402

SHOTS = ""
if "--shots" in sys.argv:
    SHOTS = sys.argv[sys.argv.index("--shots") + 1]
HEADED = "--headed" in sys.argv
FAILS: list[str] = []
PASSES = 0
CONSOLE: list[str] = []

GENERIC_REGISTER = "If the details can be used, a message is on its way to that address. Open the link in it to finish."
GENERIC_RESEND = "If that address has an account waiting for confirmation, a new link is on its way."
GENERIC_FORGOT = "If that address belongs to an account, a link to set a new password is on its way."
EMAIL_POLICY = "We can't send mail to that address."
MAILBOX_PER_HOUR = 6
ADMIN_PW = "admin password 12"


def check(name: str, ok: bool, detail: object = "") -> bool:
    global PASSES
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'' if ok else '  -> ' + str(detail)[:600]}", flush=True)
    if ok:
        PASSES += 1
    else:
        FAILS.append(name)
    return ok


class Api:
    def __init__(self, base: str) -> None:
        self.base = base

    def call(self, method: str, path: str, body: object | None = None, cookie: str | None = None, ip: str | None = None,
             headers: dict[str, str] | None = None, _pow_attempt: bool = False) -> tuple[int, object, dict[str, str]]:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        if method != "GET":
            req.add_header("Origin", self.base)
        if cookie:
            req.add_header("Cookie", cookie)
        if ip:
            req.add_header("X-Forwarded-For", ip)
        for key, value in (headers or {}).items():
            req.add_header(key, value)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                status, text, hdrs = resp.status, resp.read().decode(), dict(resp.headers)
                cookies = resp.headers.get_all("Set-Cookie") or []
        except urllib.error.HTTPError as err:
            status, text, hdrs = err.code, err.read().decode(), dict(err.headers)
            cookies = err.headers.get_all("Set-Cookie") or []
        hdrs = {key.lower(): value for key, value in hdrs.items()}
        hdrs["__cookies"] = "\n".join(cookies)
        try:
            parsed: object = json.loads(text)
        except ValueError:
            parsed = text
        # Direct API probes use the same public challenge contract as the browser worker: pay the missing proof, then
        # retry the exact request once. Test difficulty is lowered below, but the challenge is always solved/verified.
        if (status == 428 and not _pow_attempt and method == "POST" and isinstance(body, dict)
                and isinstance(parsed, dict) and parsed.get("error") == "challenge_required"):
            form = {"/api/account/register": "register", "/api/account/forgot": "forgot",
                    "/api/account/resend": "resend", "/api/account/reset": "reset",
                    "/api/account/login": "login"}.get(path.split("?", 1)[0])
            if form:
                challenge_status, challenge, _ = self.call("GET", f"/api/account/challenge?form={form}", ip=ip)
                if challenge_status != 200 or not isinstance(challenge, dict):
                    raise RuntimeError(f"proof challenge failed: {challenge_status} {challenge}")
                difficulty = int(challenge["bits"])
                nonce = 0
                while True:
                    candidate = str(nonce)
                    digest = hashlib.sha256(f"{challenge['c']}:{candidate}".encode()).digest()
                    if int.from_bytes(digest, "big").bit_length() <= 256 - difficulty:
                        break
                    nonce += 1
                return self.call(method, path, {**body, "pow": {"c": challenge["c"], "nonce": candidate}},
                                 cookie=cookie, ip=ip, headers=headers, _pow_attempt=True)
        return status, parsed, hdrs

    def login(self, ident: str, password: str, ip: str) -> tuple[int, object, str | None]:
        status, body, hdrs = self.call("POST", "/api/account/login", {"id": ident, "password": password}, ip=ip)
        cookie = None
        for line in hdrs["__cookies"].split("\n"):
            if line.startswith("knife_session=") and not line.startswith("knife_session=;"):
                cookie = line.split(";")[0]
        return status, body, cookie


class Outbox:
    def __init__(self, data_dir: Path) -> None:
        self.dir = data_dir / "mail-outbox"

    def messages(self, to: str) -> list[tuple[str, str, str]]:
        """(file name, subject, plain text) for every message to `to`, oldest first."""
        if not self.dir.exists():
            return []
        out = []
        for path in sorted(self.dir.glob("*.eml")):
            msg = email.message_from_bytes(path.read_bytes(), policy=email.policy.default)
            if to.lower() not in str(msg["To"]).lower():
                continue
            body = msg.get_body(preferencelist=("plain",))
            out.append((path.name, str(msg["Subject"]), body.get_content() if body else ""))
        return out

    def wait(self, to: str, count: int, timeout: float = 15.0) -> list[tuple[str, str, str]]:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            found = self.messages(to)
            if len(found) >= count:
                return found
            time.sleep(0.1)
        return self.messages(to)

    @staticmethod
    def link(text: str, path: str) -> str | None:
        match = re.search(rf"(https?://[^\s]+{re.escape(path)}\?token=([A-Za-z0-9_-]+))", text)
        return match.group(1) if match else None

    @staticmethod
    def token(link: str | None) -> str:
        return link.split("token=", 1)[1] if link else ""


def canonical(address: str) -> str:
    """Python twin of email-address.ts canonicalEmailKey for the providers used here."""
    local, _, domain = address.strip().lower().rpartition("@")
    domain = {"googlemail.com": "gmail.com"}.get(domain, domain)
    local = local.split("+", 1)[0]
    if domain == "gmail.com":
        local = local.replace(".", "")
    return f"{local}@{domain}"


def outbox_by_mailbox(data_dir: Path, mailbox: str) -> list[str]:
    """Every .eml whose recipient is a variant of `mailbox`."""
    found = []
    for path in sorted((data_dir / "mail-outbox").glob("*.eml")):
        msg = email.message_from_bytes(path.read_bytes(), policy=email.policy.default)
        if canonical(str(msg["To"])) == mailbox:
            found.append(path.name)
    return found


def mail_idle(api: Api, cookie: str, timeout: float = 20.0) -> dict:
    """The mail queue's stats once nothing is queued or in flight (GET /api/system/queue, admin)."""
    deadline = time.monotonic() + timeout
    mail: dict = {}
    while time.monotonic() < deadline:
        status, body, _ = api.call("GET", "/api/system/queue", cookie=cookie)
        mail = body.get("mail", {}) if status == 200 and isinstance(body, dict) else {}
        if mail and mail.get("queued") == 0 and mail.get("inFlight") == 0:
            return mail
        time.sleep(0.2)
    return mail


def accounts(data_dir: Path) -> dict[str, dict]:
    return {a["id"]: a for a in json.loads((data_dir / "accounts.json").read_text())["accounts"]}


def sessions_of(data_dir: Path, account_id: str) -> int:
    path = data_dir / "sessions.json"
    if not path.exists():
        return 0
    return sum(1 for s in json.loads(path.read_text())["sessions"] if s["accountId"] == account_id)


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def shot(page: Page, name: str) -> None:
    if not SHOTS:
        return
    Path(SHOTS).mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(Path(SHOTS) / f"{name}.png"), full_page=True)


def new_context(browser: Browser, base: str, ip: str, width: int = 1280) -> tuple[BrowserContext, Page]:
    ctx = browser.new_context(base_url=base, viewport={"width": width, "height": 900}, extra_http_headers={"X-Forwarded-For": ip})
    page = ctx.new_page()

    def on_console(msg) -> None:  # noqa: ANN001
        text = msg.text
        if msg.type == "error" and "Failed to load resource" not in text:
            CONSOLE.append(f"{page.url}: {text[:300]}")

    page.on("console", on_console)
    return ctx, page


def go(page: Page, path: str) -> None:
    """Navigate and wait until the page is hydrated (networkidle): typing into a controlled input before hydration is lost."""
    page.goto(path, wait_until="networkidle")


def ui_login(page: Page, ident: str, password: str) -> None:
    go(page, "/login")
    page.locator("input[autocomplete=username]").fill(ident)
    page.locator("input[autocomplete=current-password]").fill(password)
    page.get_by_role("button", name="Log in").click()


def cli(data_dir: Path, *args: str, stdin: str = "") -> subprocess.CompletedProcess[str]:
    env = {**os.environ, "KNIFE_DATA_DIR": str(data_dir), "KNIFE_AUTH_MODE": "public"}
    return subprocess.run(["node", str(ROOT / "scripts" / "accounts.mjs"), *args], input=stdin, capture_output=True, text=True, env=env, cwd=ROOT)


def run(server: ScratchServer, browser: Browser) -> None:
    base = server.url
    data = server.data_dir
    assert data is not None
    api = Api(base)
    box = Outbox(data)

    # ---------------------------------------------------------------------------------------------- 0. setup
    status, body, _ = api.call("GET", "/api/account", ip="198.51.100.1")
    check("anonymous GET /api/account -> 401, public mode, no account list (no default-account fallback)",
          status == 401 and isinstance(body, dict) and body.get("mode") == "public" and "accounts" not in body, (status, body))
    status, _, _ = api.call("POST", "/api/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, ip="198.51.100.1",
                            headers={"Accept": "application/json, text/event-stream"})
    check("MCP without an MCP key -> 401 (no default account in public mode)", status == 401, status)
    status, body, _ = api.login("genor", "", "198.51.100.1")
    check("the passwordless default account cannot log in", status == 401, (status, body))
    r = cli(data, "set-password", "genor", stdin=ADMIN_PW + "\n")
    check("CLI set-password for the owner", r.returncode == 0, r.stderr)
    r = cli(data, "set-email", "genor", "admin@knife.example.com")
    check("CLI set-email for the owner (verified)", r.returncode == 0, r.stderr)
    status, body, admin = api.login("genor", ADMIN_PW, "198.51.100.2")
    check("owner logs in by username, is admin (migrated v1 default = admin)",
          status == 200 and isinstance(body, dict) and body.get("isAdmin") is True and body.get("role") == "admin" and admin, (status, body))

    # ------------------------------------------------------------------------------------------- 1. register
    ctx_a, page_a = new_context(browser, base, "198.51.100.11")
    go(page_a, "/")
    expect(page_a.get_by_role("heading", level=1)).to_contain_text("in one sharp place", timeout=15_000)
    shot(page_a, "greeter")
    check("signed-out home is the welcome page: register + log in calls to action, no tool list, no app shell",
          page_a.locator("main a[href='/register']").count() >= 2 and page_a.locator("main a[href='/login']").count() >= 1
          and page_a.locator("[data-launcher-search]").count() == 0 and page_a.locator("aside").count() == 0
          and page_a.locator("[data-agent-pill]").count() == 0)
    for gated in ("/tools/json", "/tools/pdf?tab=tools", "/account"):
        r = ctx_a.request.get(base + gated, max_redirects=0)
        check(f"signed out, {gated} redirects to /login with next",
              r.status in (302, 303, 307, 308) and r.headers.get("location", "").startswith("/login?next="), (r.status, r.headers.get("location")))
    go(page_a, "/tools/json")
    page_a.wait_for_url(re.compile(r"/login\?next=%2Ftools%2Fjson$"), timeout=15_000)
    check("a guest opening a tool lands on the login page in the public frame",
          page_a.get_by_role("heading", name="Log in").is_visible() and page_a.locator("aside").count() == 0)
    go(page_a, "/")
    page_a.locator("main a[href='/register']").first.click()
    page_a.wait_for_url(base + "/register", timeout=15_000)
    check("the greeter's call to action opens /register with the account perks beside the form",
          page_a.get_by_role("heading", name="Everything in Smart Knife, kept for you").is_visible())
    shot(page_a, "register")
    page_a.locator("input[autocomplete=username]").fill("alice")
    page_a.locator("input[type=email]").fill("alice@example.com")
    page_a.locator("input[autocomplete=new-password]").nth(0).fill("alice password 1")
    page_a.locator("input[autocomplete=new-password]").nth(1).fill("alice password 1")
    page_a.get_by_role("button", name="Create account").click()
    expect(page_a.get_by_text(GENERIC_REGISTER)).to_be_visible(timeout=15_000)
    check("register in the UI shows the generic answer", True)
    mails = box.wait("alice@example.com", 1)
    verify_link = Outbox.link(mails[0][2], "/verify") if mails else None
    check("verification mail with a /verify link", bool(verify_link) and "Confirm your email" in mails[0][1], mails)
    alice = accounts(data).get("alice", {})
    raw = Outbox.token(verify_link)
    check("pending user account: role user, 1 GiB quota, token stored only as SHA-256 with 24 h expiry",
          alice.get("status") == "pending" and alice.get("role") == "user" and alice.get("storageQuotaBytes") == 1024 ** 3
          and alice.get("verifyToken", {}).get("hash") == hashlib.sha256(raw.encode()).hexdigest()
          and raw not in (data / "accounts.json").read_text(), alice)

    # ---------------------------------------------------------------------------------- 2. no login before verify
    ui_login(page_a, "alice", "alice password 1")
    expect(page_a.get_by_text("Confirm your email address first")).to_be_visible(timeout=15_000)
    check("login before verifying is refused in the UI with the reason", True)
    status, body, cookie = api.login("alice", "wrong password", "198.51.100.12")
    check("unverified + wrong password -> plain invalid_credentials (no state leak)", status == 401 and not cookie, (status, body))

    # ------------------------------------------------------------------------------------------------ 3. verify
    go(page_a, verify_link.replace(base, ""))
    page_a.get_by_role("button", name="Confirm my email").click()
    expect(page_a.get_by_text("Your email is confirmed, alice")).to_be_visible(timeout=15_000)
    shot(page_a, "verified")
    check("the /verify link from the .eml activates the account", accounts(data)["alice"]["status"] == "active")
    status, body, _ = api.call("POST", "/api/account/verify", {"token": raw}, ip="198.51.100.12")
    check("the verification link works once", status == 400 and isinstance(body, dict) and body.get("error") == "invalid_or_expired", (status, body))

    # ------------------------------------------------------------------------------------------------- 4. login
    ui_login(page_a, "ALICE@example.com", "alice password 1")
    page_a.wait_for_url(base + "/", timeout=15_000)
    expect(page_a.get_by_role("link", name="alice")).to_be_visible(timeout=15_000)
    check("login by email (any case) lands on / with the account in the top bar", True)
    check("signed-in home is the launcher, not the greeter",
          page_a.get_by_role("heading", level=1).inner_text() == "A private room of hand-made tools."
          and page_a.locator("main a[href='/register']").count() == 0)
    go(page_a, "/login?next=%2Ftools%2Fjson")
    page_a.wait_for_url(base + "/tools/json", timeout=15_000)
    check("signed in, /login goes straight on to next", True)
    go(page_a, "/")
    shot(page_a, "home-signed-in")
    jar = {c["name"]: c for c in ctx_a.cookies()}
    sess = jar.get("knife_session", {})
    check("session cookie: HttpOnly, SameSite=Lax, not Secure over plain http",
          sess.get("httpOnly") is True and sess.get("sameSite") == "Lax" and sess.get("secure") is False, sess)
    status, body, cookie2 = api.login("alice", "alice password 1", "198.51.100.13")
    check("a second session (another device)", status == 200 and cookie2 and api.call("GET", "/api/account", cookie=cookie2)[0] == 200, status)
    status, _, rotated = api.login("alice", "alice password 1", "198.51.100.13")
    # Rotation: a login from a browser that already holds a session revokes that one.
    s_rot, _, h_rot = api.call("POST", "/api/account/login", {"id": "alice", "password": "alice password 1"}, cookie=rotated, ip="198.51.100.13")
    check("login rotates: the session the browser sent is revoked", s_rot == 200 and api.call("GET", "/api/account", cookie=rotated)[0] == 401, s_rot)

    # --------------------------------------------------------------------- 5. change password revokes other sessions
    go(page_a, "/account")
    form = page_a.get_by_role("form", name="Change password")
    form.locator("input[autocomplete=current-password]").fill("alice password 1")
    form.locator("input[autocomplete=new-password]").fill("alice password 2")
    shot(page_a, "account")
    form.get_by_role("button", name="Change password").click()
    expect(page_a.get_by_text(re.compile(r"Password changed\. \d+ other session\(s\) were signed out\."))).to_be_visible(timeout=15_000)
    check("change password in the UI", True)
    check("the other session is revoked", api.call("GET", "/api/account", cookie=cookie2)[0] == 401)
    status = ctx_a.request.get(base + "/api/account").status
    check("this browser stays signed in (fresh session)", status == 200, status)
    check("old password no longer works", api.login("alice", "alice password 1", "198.51.100.14")[0] == 401)
    status, _, cookie3 = api.login("alice", "alice password 2", "198.51.100.14")
    check("new password works", status == 200 and cookie3, status)
    status, body, _ = api.call("POST", "/api/account/password", {"currentPassword": "nope nope nope", "newPassword": "whatever 1234"}, cookie=cookie3)
    check("change password needs the current one", status == 403 and body.get("error") == "wrong_password", (status, body))

    # --------------------------------------------------------------------------------------- 6. forgot / reset
    ctx_b, page_b = new_context(browser, base, "198.51.100.21")
    before = len(box.messages("alice@example.com"))
    go(page_b, "/forgot-password")
    page_b.locator("input[type=email]").fill("alice@example.com")
    page_b.get_by_role("button", name="Send reset link").click()
    expect(page_b.get_by_text(GENERIC_FORGOT)).to_be_visible(timeout=15_000)
    s_known, b_known, _ = api.call("POST", "/api/account/forgot", {"email": "alice@example.com"}, ip="198.51.100.22")
    s_unknown, b_unknown, _ = api.call("POST", "/api/account/forgot", {"email": "nobody@example.com"}, ip="198.51.100.22")
    check("forgot: known and unknown address get the identical answer", (s_known, b_known) == (s_unknown, b_unknown) == (202, {"ok": True, "message": GENERIC_FORGOT}), (s_known, b_known, s_unknown, b_unknown))
    mails = box.wait("alice@example.com", before + 2)
    check("no mail for an unknown address", box.messages("nobody@example.com") == [])
    reset_link = Outbox.link(mails[-1][2], "/reset-password") if mails else None
    reset_ttl = calendar.timegm(time.strptime(accounts(data)["alice"]["resetToken"]["expiresAt"][:19], "%Y-%m-%dT%H:%M:%S")) - time.time()
    check("reset mail with a 1 h single-use link", bool(reset_link) and 3500 < reset_ttl <= 3600, (reset_link, reset_ttl))
    first_reset = Outbox.link(mails[-2][2], "/reset-password")
    check("an older reset link stops working once a newer one exists", api.call("POST", "/api/account/reset", {"token": Outbox.token(first_reset), "password": "never used 123"})[0] == 400)
    go(page_b, reset_link.replace(base, ""))
    page_b.locator("input[autocomplete=new-password]").nth(0).fill("alice password 3")
    page_b.locator("input[autocomplete=new-password]").nth(1).fill("alice password 3")
    page_b.get_by_role("button", name="Set password").click()
    expect(page_b.get_by_text("Your password is set.")).to_be_visible(timeout=15_000)
    check("reset in the UI", True)
    check("reset ends every session (the first browser is signed out)", ctx_a.request.get(base + "/api/account").status == 401)
    check("reset ends every session (the API one too)", api.call("GET", "/api/account", cookie=cookie3)[0] == 401 and sessions_of(data, "alice") == 0, sessions_of(data, "alice"))
    check("the reset link works once", api.call("POST", "/api/account/reset", {"token": Outbox.token(reset_link), "password": "alice password 9"})[0] == 400)
    status, _, alice_cookie = api.login("alice", "alice password 3", "198.51.100.23")
    check("login with the reset password", status == 200 and alice_cookie, status)
    check("password-changed notice mailed", any("password changed" in subject.lower() for _, subject, _ in box.messages("alice@example.com")))
    key_status, key_body, _ = api.call("POST", "/api/account/mcp-keys", {"action": "create", "name": "logout test"}, cookie=alice_cookie)
    check("create MCP key before log out everywhere", key_status == 201 and bool(key_body.get("key")), (key_status, key_body))
    ui_login(page_a, "alice", "alice password 3")
    page_a.wait_for_url(base + "/", timeout=15_000)
    go(page_a, "/account")
    page_a.get_by_role("checkbox").check()
    check("log out everywhere offers MCP key revocation", page_a.get_by_role("checkbox").count() == 1)
    page_a.get_by_role("button", name="Log out everywhere").click()
    page_a.wait_for_url(re.compile(r"/login(?:\?|$)"), timeout=15_000)
    key_file = data / "mcp-keys.json"
    remaining_keys = json.loads(key_file.read_text()).get("keys", []) if key_file.exists() else []
    check("log out everywhere with the option revokes all of this account's MCP keys",
          key_status == 201 and not any(key.get("accountId") == "alice" for key in remaining_keys), remaining_keys)
    status, _, alice_cookie = api.login("alice", "alice password 3", "198.51.100.24")
    check("sign back in after log out everywhere", status == 200 and bool(alice_cookie), status)

    # ------------------------------------------------------------------------------------------------ 7. resend
    status, body, _ = api.call("POST", "/api/account/register", {"username": "bob", "email": "bob@example.com", "password": "bob password 1"}, ip="198.51.100.31")
    check("register bob through the API -> 202 generic", status == 202 and body.get("message") == GENERIC_REGISTER, (status, body))
    first = box.wait("bob@example.com", 1)
    go(page_b, "/verify")
    page_b.locator("input[type=email]").fill("bob@example.com")
    page_b.get_by_role("button", name="Send a new link").click()
    expect(page_b.get_by_text(GENERIC_RESEND)).to_be_visible(timeout=15_000)
    both = box.wait("bob@example.com", 2)
    old_link = Outbox.link(first[0][2], "/verify")
    release_text = both[-1][2] if len(both) > 1 else ""
    check("resend cancels the unverified sign-up and mails a fresh registration link",
          "Create my account" in release_text and "/register" in release_text and "/verify?token=" not in release_text, both)
    check("the squatter's verification link no longer works",
          api.call("POST", "/api/account/verify", {"token": Outbox.token(old_link)})[0] == 400)
    check("the unverified username and address are released", "bob" not in accounts(data))
    # Re-register as the actual address owner so the later login, role and deletion coverage uses an active account.
    status, body, _ = api.call("POST", "/api/account/register", {"username": "bob", "email": "bob@example.com", "password": "bob password 1"}, ip="198.51.100.33")
    fresh = box.wait("bob@example.com", 3)
    new_link = Outbox.link(fresh[-1][2], "/verify") if fresh else None
    status, body, _ = api.call("POST", "/api/account/verify", {"token": Outbox.token(new_link)}, ip="198.51.100.33")
    check("the released identity can register and verify afresh", status == 200 and body.get("username") == "bob", (status, body))
    alice_mails = len(box.messages("alice@example.com"))
    r_unknown = api.call("POST", "/api/account/resend", {"email": "ghost@example.com"}, ip="198.51.100.32")[:2]
    r_verified = api.call("POST", "/api/account/resend", {"email": "alice@example.com"}, ip="198.51.100.32")[:2]
    check("resend: unknown and already-verified addresses get the identical answer", r_unknown == r_verified == (202, {"ok": True, "message": GENERIC_RESEND}), (r_unknown, r_verified))
    time.sleep(0.5)
    check("resend mails nobody for those", box.messages("ghost@example.com") == [] and len(box.messages("alice@example.com")) == alice_mails)

    # ------------------------------------------------------------------------------- 8. generic register answers
    s1 = api.call("POST", "/api/account/register", {"username": "carol", "email": "ALICE@example.com", "password": "carol password 1"}, ip="198.51.100.41")[:2]
    s2 = api.call("POST", "/api/account/register", {"username": "alice", "email": "carol@example.com", "password": "carol password 1"}, ip="198.51.100.41")[:2]
    s3 = api.call("POST", "/api/account/register", {"username": "admin", "email": "dan@example.com", "password": "dan password 12"}, ip="198.51.100.41")[:2]
    check("register: taken email, taken username, reserved name -> the same 202 answer as a new account",
          s1 == s2 == s3 == (202, {"ok": True, "message": GENERIC_REGISTER}), (s1, s2, s3))
    col = box.wait("alice@example.com", alice_mails + 1)
    check("the owner of a taken address is told by mail instead", any("tried to sign up" in subject for _, subject, _ in col), [s for _, s, _ in col])
    check("a taken username is explained to the registrant's mailbox",
          any("not available" in text for _, _, text in box.wait("carol@example.com", 1)) and any("not available" in text for _, _, text in box.wait("dan@example.com", 1)))
    acc = accounts(data)
    check("no account was created for the collisions", "carol" not in acc and "admin" not in acc and acc["alice"]["email"] == "alice@example.com", sorted(acc))

    # ------------------------------------------------------------------------- 8b. email policy and mailbox budget
    before_files = set(p.name for p in (data / "mail-outbox").glob("*.eml"))
    refused = {}
    for i, address in enumerate(["temp@mailinator.com", "temp@inbox.sub.mailinator.com", "x@yopmail.com", "postmaster@example.org", "temp@host.invalid"]):
        refused[address] = api.call("POST", "/api/account/register", {"username": f"tmp{i}", "email": address, "password": "temp password 1"}, ip=f"198.51.100.{140 + i}")[:2]
    check("register: disposable (and every parent-domain match), role and reserved-TLD addresses -> 400 with one generic message",
          all(status == 400 and isinstance(body, dict) and body.get("error") == EMAIL_POLICY for status, body in refused.values()), refused)
    check("no account was created for them", not any(f"tmp{i}" in accounts(data) for i in range(5)))
    go(page_b, "/register")
    page_b.locator("input[autocomplete=username]").fill("tempui")
    page_b.locator("input[type=email]").fill("tempui@guerrillamail.com")
    page_b.locator("input[autocomplete=new-password]").nth(0).fill("temp password 1")
    page_b.locator("input[autocomplete=new-password]").nth(1).fill("temp password 1")
    page_b.get_by_role("button", name="Create account").click()
    expect(page_b.get_by_text(EMAIL_POLICY)).to_be_visible(timeout=15_000)
    check("the register page shows the generic refusal for a disposable address", True)
    shot(page_b, "register-disposable")
    status, body, _ = api.call("POST", "/api/account/email", {"password": "alice password 3", "email": "alice@10minutemail.com"}, cookie=alice_cookie)
    check("email change to a disposable address -> 400, nothing pending", status == 400 and body.get("error") == EMAIL_POLICY and "emailChange" not in accounts(data)["alice"], (status, body))

    variants = ["victim.e2e+1@gmail.com", "v.i.c.t.i.m.e2e@gmail.com", "VictimE2E@googlemail.com", "victim.e2e+shop@googlemail.com",
                "victime2e+2@gmail.com", "v.ictime2e@gmail.com"]
    codes = [api.call("POST", "/api/account/register", {"username": f"var{i}", "email": address, "password": "variant pw 123"}, ip=f"198.51.100.{160 + i}")[0]
             for i, address in enumerate(variants)]
    check("register: +tag / dot / googlemail variants share the per-address limit (3 per hour, then 429)", codes == [202] * 3 + [429] * 3, codes)
    status, _, admin = api.login("genor", ADMIN_PW, "198.51.100.150")
    stats = mail_idle(api, admin or "")
    delivered = outbox_by_mailbox(data, "victime2e@gmail.com")
    check(f"one mailbox got 3 mails for {len(variants)} sign-up attempts (and never more than its {MAILBOX_PER_HOUR}/h mail budget)", len(delivered) == 3, delivered)
    new_files = set(p.name for p in (data / "mail-outbox").glob("*.eml")) - before_files
    check("nothing was mailed to a refused address", not any(re.search(r"mailinator|yopmail|guerrilla|10minutemail|postmaster|invalid", n) for n in new_files), sorted(new_files)[:10])
    policy = stats.get("policy", {})
    check("the admin queue stats show the policy and the queue", policy.get("enforced") is True and policy.get("disposable", {}).get("domains", 0) > 5000
          and stats.get("transport") == "outbox" and policy.get("rejects", {}).get("disposable", 0) >= 4 and "budget" in stats, stats)

    # ---------------------------------------------------------------------------------------------- 9. rate limits
    codes = [api.login("alice", "wrong password", "198.51.100.51")[0] for _ in range(6)]
    check("login: 5 failures then 429", codes == [401] * 5 + [429], codes)
    status, body, hdrs = api.call("POST", "/api/account/login", {"id": "alice", "password": "alice password 3"}, ip="198.51.100.51")
    check("login limit also blocks the right password, with Retry-After", status == 429 and int(hdrs.get("retry-after") or body.get("retryAfterSeconds", 0)) > 0, (status, body, hdrs.get("retry-after")))
    check("another client address is not blocked by that bucket", api.login("alice", "alice password 3", "198.51.100.52")[0] == 200)
    codes = [api.call("POST", "/api/account/forgot", {"email": "dave@example.com"}, ip=f"198.51.100.{60 + i}")[0] for i in range(4)]
    check("forgot: 3 per address (across client addresses) then 429, unknown addresses included", codes == [202, 202, 202, 429], codes)
    codes = [api.call("POST", "/api/account/resend", {"email": "eve@example.com"}, ip=f"198.51.100.{70 + i}")[0] for i in range(4)]
    check("resend: 3 per address then 429", codes == [202, 202, 202, 429], codes)
    codes = [api.call("POST", "/api/account/register", {"username": f"r{i}", "email": f"r{i}@example.com", "password": "rate limit pw1"}, ip="198.51.100.80")[0] for i in range(11)]
    _, rl_body, rl_headers = api.call("POST", "/api/account/register", {"username": "rx", "email": "rx@example.com", "password": "rate limit pw1"}, ip="198.51.100.80")
    check("register: 10 per client address per hour then 429 (Retry-After)", codes == [202] * 10 + [429] and int(rl_headers.get("retry-after", 0)) > 0, (codes, rl_body))

    # ----------------------------------------------------------------------------------------- 10. roles, sidecars
    svc_dir = data / "services" / "learn-db"
    svc_dir.mkdir(parents=True, exist_ok=True)
    now_iso = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    (svc_dir / "state.json").write_text(json.dumps({
        "id": "learn-db", "image": "postgis/postgis:16-3.4", "bindHost": "127.0.0.1", "hostPort": free_port(),
        "idleStopMinutes": 0, "installedAt": now_iso, "updatedAt": now_iso,
    }))
    status, body, _ = api.call("POST", "/api/services/learn-db", {"action": "start"}, cookie=alice_cookie)
    check("non-admin start -> 403 admin_required", status == 403 and body.get("code") == "admin_required" and "administrator" in body.get("error", ""), (status, body))
    for action in ({"action": "stop"}, {"action": "install"}, {"action": "update"}, {"action": "remove"}, {"action": "configure", "idleStopMinutes": 5}):
        status, body, _ = api.call("POST", "/api/services/learn-db", action, cookie=alice_cookie)
        check(f"non-admin {action['action']} -> 403", status == 403 and body.get("code") == "admin_required", (status, body))
    status, body, _ = api.call("POST", "/api/services/learn-db", {"action": "ensure"}, cookie=alice_cookie)
    check("non-admin lazy start of a stopped sidecar -> 403 'An administrator has to start ...'",
          status == 403 and str(body.get("error", "")).startswith("An administrator has to start Course database"), (status, body))
    status, body, _ = api.call("GET", "/api/services/learn-db", cookie=alice_cookie)
    service = body.get("service", {}) if isinstance(body, dict) else {}
    check("non-admin status: installed, canManage false, no configuration", status == 200 and service.get("installed") is True
          and service.get("canManage") is False and service.get("state") is None, (status, service.get("canManage"), service.get("state")))
    status, body, _ = api.call("GET", "/api/services/learn-db", cookie=admin)
    check("admin status keeps the configuration", status == 200 and body["service"]["canManage"] is True and body["service"]["state"] is not None, status)
    check("non-admin: GET /api/system/queue -> 403", api.call("GET", "/api/system/queue", cookie=alice_cookie)[0] == 403)
    check("admin: GET /api/system/queue -> 200", api.call("GET", "/api/system/queue", cookie=admin)[0] == 200)
    check("non-admin: GET /api/admin/users -> 403", api.call("GET", "/api/admin/users", cookie=alice_cookie)[0] == 403)
    check("non-admin: rebuild course data -> 403", api.call("POST", "/api/learn/sql/setup", {"force": True}, cookie=alice_cookie)[0] == 403)
    # Global/admin settings: every admin action on one's own account and on another, then the record is unchanged.
    before = {k: {f: v.get(f) for f in ("role", "status", "storageQuotaBytes", "privateNetwork")} for k, v in accounts(data).items()}
    for target, body in (("alice", {"action": "role", "role": "admin"}), ("alice", {"action": "quota", "bytes": None}),
                         ("alice", {"action": "quota", "bytes": 50 * 1024 ** 3}), ("alice", {"action": "network", "privateNetwork": True}),
                         ("genor", {"action": "disable"}), ("genor", {"action": "delete"}), ("genor", {"action": "role", "role": "user"}),
                         ("alice", {"action": "resend-verification"})):
        status, answer, _ = api.call("POST", f"/api/admin/users/{target}", body, cookie=alice_cookie)
        check(f"non-admin: admin action {body['action']} on {target} -> 403", status == 403, (status, answer))
    after = {k: {f: v.get(f) for f in ("role", "status", "storageQuotaBytes", "privateNetwork")} for k, v in accounts(data).items()}
    check("non-admin admin actions changed no account record", before == after, (before, after))
    for extra in ({"role": "admin"}, {"privateNetwork": True}, {"storageQuotaBytes": None}):
        status, answer, _ = api.call("PUT", "/api/account/provider", {"baseUrl": "https://api.example.com/v1", "model": "m", **extra}, cookie=alice_cookie)
        check(f"provider PUT smuggling {next(iter(extra))} -> 400", status == 400, (status, answer))
    check("smuggled provider fields changed nothing", {k: {f: v.get(f) for f in ("role", "status", "storageQuotaBytes", "privateNetwork")} for k, v in accounts(data).items()} == before)

    ctx_c, page_c = new_context(browser, base, "198.51.100.91")
    ui_login(page_c, "alice", "alice password 3")
    page_c.wait_for_url(base + "/", timeout=15_000)
    go(page_c, "/tools/db-course")
    expect(page_c.get_by_text(re.compile(r"An administrator has to start Course database")).first).to_be_visible(timeout=60_000)
    check("non-admin sees 'An administrator has to start ...' on the course page", True)
    shot(page_c, "course-needs-admin")
    go(page_c, "/tools/sidecars")
    expect(page_c.get_by_text(re.compile(r"An administrator has to start Course database")).first).to_be_visible(timeout=60_000)
    check("sidecars page for a non-admin: messages, no lifecycle buttons",
          page_c.get_by_role("button", name=re.compile(r"^(Start|Stop|Install .*|Remove…|Update.*)$")).count() == 0)
    go(page_c, "/account/admin")
    expect(page_c.get_by_text("An administrator has to manage users.")).to_be_visible(timeout=15_000)
    check("admin page refuses a non-admin", True)

    # ------------------------------------------------------------------------------------ 11. admin disables a user
    ctx_d, page_d = new_context(browser, base, "198.51.100.92")
    ui_login(page_d, "genor", ADMIN_PW)
    page_d.wait_for_url(base + "/", timeout=15_000)
    go(page_d, "/account/admin")
    row = page_d.locator("tr[data-user=alice]")
    expect(row).to_be_visible(timeout=15_000)
    shot(page_d, "admin-users")
    check("admin list shows email, state and storage", "alice@example.com" in row.inner_text() and "active" in row.inner_text(), row.inner_text())
    row.get_by_role("button", name="Disable").click()
    expect(page_d.get_by_text(re.compile(r"alice disabled\. \(\d+ session\(s\) ended\)"))).to_be_visible(timeout=15_000)
    check("admin disables alice in the UI", accounts(data)["alice"]["status"] == "disabled")
    check("alice's browser session dies at once", ctx_c.request.get(base + "/api/account").status == 401)
    check("alice's API session dies too", api.call("GET", "/api/account", cookie=alice_cookie)[0] == 401 and sessions_of(data, "alice") == 0)
    status, body, _ = api.login("alice", "alice password 3", "198.51.100.93")
    check("a disabled account cannot log in", status == 403 and body.get("error") == "account_disabled", (status, body))
    status, body, _ = api.call("POST", "/api/admin/users/genor", {"action": "disable"}, cookie=admin)
    check("an admin cannot disable themselves", status == 409, (status, body))
    status, body, _ = api.call("POST", "/api/admin/users/alice", {"action": "quota", "bytes": 5 * 1024 ** 3}, cookie=admin)
    check("admin changes a quota", status == 200 and accounts(data)["alice"]["storageQuotaBytes"] == 5 * 1024 ** 3, (status, body))
    page_d.reload(wait_until="networkidle")
    page_d.locator("tr[data-user=alice]").get_by_role("button", name="Enable").click()
    expect(page_d.get_by_text("alice enabled.")).to_be_visible(timeout=15_000)
    check("admin re-enables alice", accounts(data)["alice"]["status"] == "active")

    # -------------------------------------------------------------------------------------- 12. delete own account
    ui_login(page_c, "alice", "alice password 3")
    page_c.wait_for_url(base + "/", timeout=15_000)
    alice_cookie = "knife_session=" + {c["name"]: c for c in ctx_c.cookies()}["knife_session"]["value"]
    status, body, _ = api.call("POST", "/api/office/docs", {"action": "create", "format": "docx", "name": "Notes"}, cookie=alice_cookie)
    check("alice creates an office document (real data through the API)", status in (200, 201), (status, body))
    planted = ["cv/alice.json", "cv/alice.photo.jpg", "cv/alice.snapshots/1.json", "conversations/alice/p.json", "learn/alice.json", "usage/alice.json"]
    for rel in planted:
        (data / rel).parent.mkdir(parents=True, exist_ok=True)
        (data / rel).write_text("{}")
    keep = ["cv/bob.json", "docs/bob/x", "cv/alice2.json"]
    for rel in keep:
        (data / rel).parent.mkdir(parents=True, exist_ok=True)
        (data / rel).write_text("{}")
    go(page_c, "/account")
    page_c.get_by_role("button", name="Delete my account…").click()
    form = page_c.get_by_role("form", name="Delete account")
    form.locator("input[type=password]").fill("not my password")
    form.get_by_role("button", name="Delete account and data").click()
    expect(page_c.get_by_text("The current password is not right.")).to_be_visible(timeout=15_000)
    check("delete needs the password", "alice" in accounts(data))
    form.locator("input[type=password]").fill("alice password 3")
    shot(page_c, "delete-confirm")
    form.get_by_role("button", name="Delete account and data").click()
    page_c.wait_for_url(re.compile(r"/\?account-deleted=1$"), timeout=15_000)
    gone = [rel for rel in planted + ["docs/alice"] if (data / rel).exists()]
    check("every data location of alice is removed", gone == [], gone)
    check("other accounts' data survives", all((data / rel).exists() for rel in keep))
    check("the account record and its sessions are gone", "alice" not in accounts(data) and sessions_of(data, "alice") == 0)
    check("a deleted account cannot log in (plain invalid_credentials)", api.login("alice", "alice password 3", "198.51.100.94")[0] == 401)
    check("deletion notice mailed", any("was deleted" in subject for _, subject, _ in box.wait("alice@example.com", 1)))
    status, body, _ = api.call("POST", "/api/account/delete", {"password": ADMIN_PW}, cookie=admin)
    check("the only administrator cannot delete their own account", status == 409, (status, body))

    # admin delete of another user (bob) through the API returns the removed locations
    status, body, _ = api.call("POST", "/api/admin/users/bob", {"action": "delete"}, cookie=admin)
    check("admin deletes bob, removed locations listed", status == 200 and "accounts.json (record)" in body.get("removed", []) and not (data / "cv/bob.json").exists() and (data / "cv/alice2.json").exists(), (status, body))

    if SHOTS:
        for width in (390,):
            ctx_m, page_m = new_context(browser, base, "198.51.100.99", width)
            for path, name in (("/login", "login-390"), ("/register", "register-390")):
                go(page_m, path)
                shot(page_m, name)
            ctx_m.close()
        go(page_b, "/login")
        shot(page_b, "login")
    for ctx in (ctx_a, ctx_b, ctx_c, ctx_d):
        ctx.close()
    check("no console errors on the account pages (hydration etc.)", CONSOLE == [], CONSOLE[:5])


def run_firefox_auth_smoke(server: ScratchServer, browser: Browser) -> None:
    """Exercise the real register/verify/login challenge UX in Firefox as well as Chromium."""
    data = server.data_dir
    assert data is not None
    base = server.url
    box = Outbox(data)
    ctx, page = new_context(browser, base, "198.51.100.111")
    try:
        go(page, "/register")
        page.locator("input[autocomplete=username]").fill("foxuser")
        page.locator("input[type=email]").fill("foxuser@example.com")
        password = "fox account password 1"
        page.locator("input[autocomplete=new-password]").nth(0).fill(password)
        page.locator("input[autocomplete=new-password]").nth(1).fill(password)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_text(GENERIC_REGISTER)).to_be_visible(timeout=20_000)
        mails = box.wait("foxuser@example.com", 1)
        verify_link = Outbox.link(mails[0][2], "/verify") if mails else None
        check("Firefox: register worker solves proof-of-work and gets the generic response", bool(verify_link), mails)
        if not verify_link:
            return
        go(page, verify_link.replace(base, ""))
        page.get_by_role("button", name="Confirm my email").click()
        expect(page.get_by_text("Your email is confirmed, foxuser")).to_be_visible(timeout=15_000)
        check("Firefox: verification form activates the account", accounts(data).get("foxuser", {}).get("status") == "active")
        ui_login(page, "foxuser", password)
        page.wait_for_url(base + "/", timeout=15_000)
        account_status = ctx.request.get(base + "/api/account").status
        check("Firefox: login succeeds after verification", account_status == 200,
              {"status": account_status, "url": page.url, "header": page.locator("main").inner_text()[:300]})
    finally:
        ctx.close()


def run_private(server: ScratchServer) -> None:
    """Private mode on the same code: none of the public-only surface exists, the default account is the implicit identity."""
    api = Api(server.url)
    for path in ("/api/account/register", "/api/account/forgot", "/api/account/resend", "/api/account/reset", "/api/account/verify"):
        status = api.call("POST", path, {"email": "x@example.com"})[0]
        check(f"private mode: POST {path} -> 404", status == 404, status)
    for path in ("/register", "/verify", "/forgot-password", "/reset-password"):
        try:
            urllib.request.urlopen(server.url + path, timeout=60)
            status = 200
        except urllib.error.HTTPError as err:
            status = err.code
        check(f"private mode: page {path} -> 404", status == 404, status)
    status, body, _ = api.call("GET", "/api/account")
    check("private mode: the passwordless default account is still the implicit identity",
          status == 200 and body.get("id") == "genor" and body.get("isAdmin") is True and body.get("authMode") == "private", (status, body))


def main() -> int:
    if "--firefox-only" in sys.argv:
        prefix = f"sk-acc-firefox-{secrets.token_hex(3)}"
        env = {"KNIFE_AUTH_MODE": "public", "KNIFE_MAIL_TRANSPORT": "outbox",
               "KNIFE_TRUSTED_PROXIES": "127.0.0.1,::1", "KNIFE_SIDECAR_PREFIX": prefix,
               "KNIFE_POW_BITS": "8", "KNIFE_POW_MAX_BITS": "16"}
        with ScratchServer() as server:
            server.start(env=env)
            with sync_playwright() as pw:
                browser = pw.firefox.launch(headless=not HEADED)
                try:
                    run_firefox_auth_smoke(server, browser)
                finally:
                    browser.close()
        print(f"\n{PASSES} passed, {len(FAILS)} failed")
        return 1 if FAILS else 0
    prefix = f"sk-acc-e2e-{secrets.token_hex(3)}"
    env = {
        "KNIFE_AUTH_MODE": "public",
        "KNIFE_MAIL_TRANSPORT": "outbox",
        "KNIFE_TRUSTED_PROXIES": "127.0.0.1,::1",
        "KNIFE_SIDECAR_PREFIX": prefix,
        "KNIFE_POW_BITS": "8",
        "KNIFE_POW_MAX_BITS": "16",
        # Keep this suite's register-IP test independent of the separately tested pending-prefix cap.
        "KNIFE_PENDING_PER_PREFIX": "100",
        # Production per-mailbox budget is 3/h,6/d; alice gets more than 3 links in this suite's first hour.
        "KNIFE_MAIL_MAILBOX_LIMITS": f"{MAILBOX_PER_HOUR}/h,12/d",
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
            try:
                firefox = pw.firefox.launch(headless=not HEADED)
                try:
                    run_firefox_auth_smoke(server, firefox)
                finally:
                    firefox.close()
            except Exception:  # noqa: BLE001
                traceback.print_exc()
                FAILS.append("Firefox auth smoke crashed: " + traceback.format_exc().strip().splitlines()[-1])
        try:
            server.restart(env={"KNIFE_AUTH_MODE": "private", "KNIFE_SIDECAR_PREFIX": prefix})
            run_private(server)
        except Exception:  # noqa: BLE001
            traceback.print_exc()
            FAILS.append("private crashed")
    print(f"\n{PASSES} passed, {len(FAILS)} failed")
    if FAILS:
        print(f"{len(FAILS)} FAILED: {FAILS}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
