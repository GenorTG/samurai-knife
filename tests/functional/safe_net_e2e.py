#!/usr/bin/env python3
"""Public-mode safety net end to end: SSRF refusals for a user's provider (save, Test, chat) and page fetches, the admin
private-network opt-out, the outbound budget, strict extra headers, streaming body limits (Content-Length and chunked,
JSON and PDF multipart), provider keys sealed on disk, security headers.

Self-contained: a scratch server (tests/scratch_server.py: worktree of the current tree, fresh KNIFE_DATA_DIR) in public
mode with KNIFE_SSRF_DENY_CIDRS standing in for "this server's public IP", and the mock provider on loopback (which a
user may never reach and the opted-in admin may). Never touches the live server, its data or any container.

Usage: python3 tests/functional/safe_net_e2e.py
Env: KNIFE_SCRATCH_PORTS=3330-3349 (shared host: scratch server and mock provider ports), MOCK_PORT (default: a free one).
"""
from __future__ import annotations

import http.client
import json
import os
import socket
import stat
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from tests.scratch_server import ScratchServer, free_port  # noqa: E402

FAILS: list[str] = []
PASSES = 0
PASSWORD = "safe-net password 1"
# Stand-in for the host's own public IPv4 (hairpin NAT): any address listed here must be refused like a private one.
OWN_PUBLIC = "1.1.1.1"


def check(name: str, ok: bool, detail: object = "") -> bool:
    global PASSES
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'' if ok else '  -> ' + str(detail)[:500]}", flush=True)
    if ok:
        PASSES += 1
    else:
        FAILS.append(name)
    return ok


class Api:
    def __init__(self, base: str) -> None:
        self.base = base

    def call(self, method: str, path: str, body: object | None = None, cookie: str | None = None, ip: str = "203.0.113.10",
             raw: bytes | None = None, headers: dict[str, str] | None = None) -> tuple[int, object, dict[str, str]]:
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if data is not None and raw is None:
            req.add_header("Content-Type", "application/json")
        if method != "GET":
            req.add_header("Origin", self.base)
        if cookie:
            req.add_header("Cookie", cookie)
        req.add_header("X-Forwarded-For", ip)
        for key, value in (headers or {}).items():
            req.add_header(key, value)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                status, text, hdrs = resp.status, resp.read().decode(errors="replace"), resp.headers
        except urllib.error.HTTPError as err:
            status, text, hdrs = err.code, err.read().decode(errors="replace"), err.headers
        cookies = hdrs.get_all("Set-Cookie") or []
        out = {key.lower(): value for key, value in hdrs.items()}
        out["__cookies"] = "\n".join(cookies)
        try:
            parsed: object = json.loads(text)
        except ValueError:
            parsed = text
        return status, parsed, out

    def login(self, ident: str, ip: str) -> str:
        status, body, hdrs = self.call("POST", "/api/account/login", {"id": ident, "password": PASSWORD}, ip=ip)
        for line in hdrs["__cookies"].split("\n"):
            if line.startswith("knife_session=") and not line.startswith("knife_session=;"):
                return line.split(";")[0]
        raise RuntimeError(f"login {ident} failed: {status} {body}")

    def chunked(self, path: str, content_type: str, chunks: list[bytes], cookie: str, method: str = "POST") -> tuple[int, str, int]:
        """POST with Transfer-Encoding: chunked (no Content-Length). Returns (status, body, chunks the server let us send)."""
        host, port = self.base.split("//", 1)[1].split(":")
        conn = http.client.HTTPConnection(host, int(port), timeout=60)
        sent = 0

        def body():
            nonlocal sent
            for chunk in chunks:
                sent += 1
                yield chunk

        try:
            conn.request(method, path, body=body(), headers={"Content-Type": content_type, "Origin": self.base, "Cookie": cookie, "X-Forwarded-For": "203.0.113.11"}, encode_chunked=True)
            resp = conn.getresponse()
            return resp.status, resp.read().decode(errors="replace"), sent
        except (BrokenPipeError, ConnectionResetError) as err:
            # The server answered 413 and closed while we were still sending: read what it said if we can.
            try:
                resp = conn.getresponse()
                return resp.status, resp.read().decode(errors="replace"), sent
            except Exception:  # noqa: BLE001
                return 413 if sent < len(chunks) else 0, f"connection closed: {err}", sent
        finally:
            conn.close()


def cli(data_dir: Path, *args: str, stdin: str = "") -> subprocess.CompletedProcess[str]:
    env = {**os.environ, "KNIFE_DATA_DIR": str(data_dir), "KNIFE_AUTH_MODE": "public"}
    return subprocess.run(["node", str(ROOT / "scripts" / "accounts.mjs"), *args], input=stdin, capture_output=True, text=True, env=env, cwd=ROOT)


def mock_stats(mock: str) -> int:
    with urllib.request.urlopen(f"{mock}/__stats", timeout=10) as resp:
        return int(json.loads(resp.read())["requests"])


def run(server: ScratchServer, mock: str) -> None:
    api = Api(server.url)
    data = server.data_dir
    assert data is not None
    for ident, email, role in (("owner", "owner@example.com", "admin"), ("bob", "bob@example.com", "user")):
        r = cli(data, "add", ident, "--name", ident.title(), "--password-prompt", "--email", email, "--role", role, stdin=f"{PASSWORD}\n")
        check(f"CLI add {ident} ({role})", r.returncode == 0, r.stderr)
    check("CLI set-network owner private", cli(data, "set-network", "owner", "private").returncode == 0)
    owner = api.login("owner", "203.0.113.20")
    bob = api.login("bob", "203.0.113.21")

    # -- a user's provider base URL: every internal target refused at save time -------------------------------------
    hostname = socket.gethostname()
    targets = {
        "loopback": f"https://127.0.0.1:{mock.rsplit(':', 1)[1]}/v1",
        "10/8": "https://10.0.0.1/v1",
        "192.168/16": "https://192.168.1.1:8080/api",
        "Tailscale CGNAT": "https://100.64.0.1/v1",
        "IPv6 loopback": "https://[::1]/v1",
        "IPv6 ULA": "https://[fd12:3456:789a::1]/v1",
        "Tailscale IPv6": "https://[fd7a:115c:a1e0::1]/v1",
        "mapped IPv6": "https://[::ffff:127.0.0.1]/v1",
        "metadata": "https://169.254.169.254/latest",
        "host public IP (deny list)": f"https://{OWN_PUBLIC}/v1",
        "localhost name": "https://localhost/v1",
        f"DNS name to a private address ({hostname})": f"https://{hostname}/v1",
        "plain http": "http://example.com/v1",
    }
    for label, url in targets.items():
        status, body, _ = api.call("PUT", "/api/account/provider", {"baseUrl": url, "model": "mock-model", "apiKey": "mock-key"}, cookie=bob)
        # Public accounts first need an allow-listed or admin-approved provider host. A disallowed host is
        # rejected before DNS/address policy, which is an equally safe early refusal; SSRF address checks
        # themselves are covered by the safe-fetch unit matrix.
        ok = status == 400 and isinstance(body, dict) and body.get("code") in {"address_not_allowed", "provider_not_allowed"}
        if label == "plain http":
            ok = status == 400 and ("only https" in str(body) or (isinstance(body, dict) and body.get("code") == "provider_not_allowed"))
        check(f"user baseUrl refused: {label}", ok, (status, body))
    status, body, _ = api.call("PUT", "/api/account/provider", {"baseUrl": "https://api.example.com/v1", "model": "m", "extraHeaders": {"X-Forwarded-For": "10.0.0.1"}}, cookie=bob)
    check("user extra header X-Forwarded-For refused", status == 400 and "not allowed" in str(body), (status, body))

    # -- a private base URL stored behind the server's back (CLI): Test and chat still refuse, nothing reaches the mock --
    r = cli(data, "set-provider", "bob", "--base-url", f"{mock}/v1", "--model", "mock-model", "--key-stdin", stdin="mock-key")
    check("CLI stores a loopback provider for the user", r.returncode == 0, r.stderr)
    r = cli(data, "approve-provider", "bob", f"{mock}/v1")
    check("admin explicitly approves the custom provider URL", r.returncode == 0, r.stderr)
    before = mock_stats(mock)
    status, body, _ = api.call("POST", "/api/account/provider/test", {}, cookie=bob)
    check("user provider Test refused (no connection)", status == 200 and isinstance(body, dict) and body.get("ok") is False and "not allowed" in str(body.get("error")), (status, body))
    status, body, _ = api.call("POST", "/api/agent/chat", {"messages": [{"role": "user", "content": "hi"}]}, cookie=bob)
    check("user chat refused (502, reason)", status == 502 and "not allowed" in str(body), (status, body))
    status, body, _ = api.call("POST", "/api/agent/chat", {"messages": [{"role": "user", "content": "hi"}], "stream": True}, cookie=bob)
    check("user streamed chat refused", status == 502 and "not allowed" in str(body), (status, body))
    check("the mock provider received nothing from the user", mock_stats(mock) == before, mock_stats(mock) - before)

    # -- the admin's opt-out: loopback allowed, Test and chat work; switching it off refuses again --------------------
    status, body, _ = api.call("PUT", "/api/account/provider", {"baseUrl": f"{mock}/v1", "model": "mock-model", "apiKey": "mock-key"}, cookie=owner)
    check("admin (privateNetwork) saves a loopback provider", status == 200, (status, body))
    status, body, _ = api.call("POST", "/api/account/provider/test", {}, cookie=owner)
    check("admin provider Test ok", status == 200 and isinstance(body, dict) and body.get("ok") is True, (status, body))
    status, body, _ = api.call("POST", "/api/agent/chat", {"messages": [{"role": "user", "content": "ping safe net"}]}, cookie=owner)
    check("admin chat answered by the mock", status == 200 and "ECHO: ping safe net" in json.dumps(body), (status, body))
    status, body, _ = api.call("POST", "/api/admin/users/owner", {"action": "network", "privateNetwork": False}, cookie=owner)
    check("admin API network off", status == 200, (status, body))
    status, body, _ = api.call("POST", "/api/account/provider/test", {}, cookie=owner)
    check("admin without the opt-out is refused too", isinstance(body, dict) and body.get("ok") is False and "not allowed" in str(body.get("error")), (status, body))
    status, body, _ = api.call("POST", "/api/admin/users/bob", {"action": "network", "privateNetwork": True}, cookie=owner)
    check("the opt-out cannot be given to a user", status == 409, (status, body))
    api.call("POST", "/api/admin/users/owner", {"action": "network", "privateNetwork": True}, cookie=owner)

    # -- page fetches (job posting) for a user: guarded and budgeted -----------------------------------------------------
    status, body, _ = api.call("POST", "/api/cv/jobs/fetch", {"urlOrText": "http://127.0.0.1/v1/models"}, cookie=bob)
    check("user job fetch of a loopback URL refused", status in (400, 422) and "not a public address" in str(body), (status, body))

    # -- outbound budget: 20 provider Tests per 10 min for a user -----------------------------------------------------
    codes = [api.call("POST", "/api/account/provider/test", {}, cookie=bob)[0] for _ in range(20)]
    status, body, hdrs = api.call("POST", "/api/account/provider/test", {}, cookie=bob)
    check("user provider Test budget runs out (429 + Retry-After)", status == 429 and "retry-after" in hdrs, (codes[-3:], status, body))
    status, _, _ = api.call("POST", "/api/account/provider/test", {}, cookie=owner)
    check("admins have no outbound budget", status == 200)

    # -- body limits ---------------------------------------------------------------------------------------------------
    status, body, _ = api.call("PUT", "/api/account/provider", raw=b"{" + b" " * 70_000 + b"}", cookie=bob, headers={"Content-Type": "application/json"})
    check("JSON over the cap with Content-Length: 413 + message", status == 413 and "larger than" in str(body), (status, body))
    status, text, sent = api.chunked("/api/account/provider", "application/json", [b" " * 16_384] * 400, bob, method="PUT")
    check("chunked JSON over the cap: 413 before the whole 6.5 MB is sent", status == 413, (status, text[:200], sent))
    boundary = "safenetBoundary"
    head = f"--{boundary}\r\nContent-Disposition: form-data; name=\"action\"\r\n\r\nmerge\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.pdf\"\r\nContent-Type: application/pdf\r\n\r\n".encode()
    chunks = [head] + [b"%" * 65_536] * 64  # 4 MB, over the 1 MB KNIFE_PDF_UPLOAD_MAX_MB of this server
    status, text, sent = api.chunked("/api/pdf", f"multipart/form-data; boundary={boundary}", chunks, bob)
    check("chunked PDF upload over KNIFE_PDF_UPLOAD_MAX_MB: 413", status == 413 and ("Upload is over" in text or "connection closed" in text), (status, text[:200], sent))
    status, body, _ = api.call("POST", "/api/pdf", raw=b"x" * 10, cookie=bob, headers={"Content-Type": f"multipart/form-data; boundary={boundary}", "Content-Length": str(50 * 1024 * 1024)})
    check("PDF upload declared over the cap: 413 before reading", status == 413, (status, body))
    tmp_uploads = [p for p in Path(os.environ.get("TMPDIR", "/tmp")).glob("knife-pdf-*") if time.time() - p.stat().st_mtime < 120]
    check("refused uploads leave no scratch dir behind", not tmp_uploads, tmp_uploads[:3])

    # -- keys at rest, headers -------------------------------------------------------------------------------------------
    raw = (data / "accounts.json").read_text()
    check("no provider key in accounts.json", "mock-key" not in raw and "enc:v1:" in raw)
    key_file = data / "provider-keys.key"
    check("provider-keys.key is 0600", key_file.exists() and stat.S_IMODE(key_file.stat().st_mode) == 0o600)
    status, _, hdrs = api.call("GET", "/login")
    csp = hdrs.get("content-security-policy", "")
    check("public pages carry CSP with frame-ancestors and connect-src 'self'", status == 200 and "frame-ancestors 'self'" in csp and "connect-src 'self'" in csp, csp)
    check("nosniff, referrer policy, no X-Powered-By", hdrs.get("x-content-type-options") == "nosniff" and "referrer-policy" in hdrs and "x-powered-by" not in hdrs, hdrs)


def main() -> int:
    mock_port = int(os.environ.get("MOCK_PORT") or free_port())
    mock_proc = subprocess.Popen(["node", str(ROOT / "tests" / "mock_provider.mjs"), str(mock_port)], stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT, start_new_session=True)
    mock = f"http://127.0.0.1:{mock_port}"
    try:
        for _ in range(50):
            try:
                mock_stats(mock)
                break
            except OSError:
                time.sleep(0.1)
        env = {
            "KNIFE_AUTH_MODE": "public",
            "KNIFE_MAIL_TRANSPORT": "outbox",
            "KNIFE_TRUSTED_PROXIES": "127.0.0.1,::1",
            "KNIFE_SSRF_DENY_CIDRS": OWN_PUBLIC,
            # Let the loopback fixture pass the provider-host allow-list so this suite reaches the separate
            # SSRF/address check and can exercise provider-purpose budgets without a real outbound connection.
            "KNIFE_PROVIDER_HOSTS": "127.0.0.1",
            "KNIFE_PDF_UPLOAD_MAX_MB": "1",
            "KNIFE_SIDECAR_PREFIX": "knife-test-safenet",
        }
        with ScratchServer() as server:
            server.start(env=env)
            print(f"scratch server {server.url} data {server.data_dir} mock {mock}", flush=True)
            try:
                run(server, mock)
            except Exception:  # noqa: BLE001
                traceback.print_exc()
                FAILS.append("crashed: " + traceback.format_exc().strip().splitlines()[-1])
                print(server.log_tail(3000))
    finally:
        mock_proc.terminate()
        mock_proc.wait(timeout=10)
    print(f"\n{PASSES} passed, {len(FAILS)} failed")
    if FAILS:
        print(f"{len(FAILS)} FAILED: {FAILS}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
