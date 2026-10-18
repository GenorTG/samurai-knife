#!/usr/bin/env python3
"""Public-mode load budgets end to end over real HTTP (abuse audit #7, #8, #14; docs/ARCHITECTURE.md "Server work"):

1. upload slots (src/lib/upload-budget.ts): a user holding 2 uploads open gets 429 + Retry-After for a third before any
   byte of it is read; with the ordinary share of the server-wide slots used, another user gets 503 + Retry-After; the
   administrator still uploads (reserved slot); a client that walks away gives its slot back; no scratch dir is left.
2. job rate (src/lib/python-admission.ts): a new account's heavy (PDF) and light (SQL) jobs per 10 minutes, 429 +
   Retry-After, refused before the upload is read; the administrator has no rate.
3. free-space floor (src/lib/storage/disk-floor.ts): with the floor above the free space, a user's upload is refused 503
   (scratch) and a user's saved draft 507 `storage_full` with a generic message, the administrator's draft is saved.

Self-contained: a public-mode scratch server (tests/scratch_server.py: worktree of the current tree, fresh KNIFE_DATA_DIR,
own TMPDIR); accounts via the CLI. Never touches the live server, its data or any container.

Usage: ../samurai-knife-py/venv/bin/python tests/functional/load_budgets_e2e.py   (needs reportlab: the engine venv)
Env: KNIFE_SCRATCH_PORTS=<range> on a shared host.
"""
from __future__ import annotations

import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from tests.scratch_server import ScratchServer  # noqa: E402

FAILS: list[str] = []
PASSES = 0
PASSWORD = "load budgets password 1"


def check(name: str, ok: bool, detail: object = "") -> bool:
    global PASSES
    print(("ok   " if ok else "FAIL ") + name + ("" if ok else f" | {str(detail)[:400]}"), flush=True)
    if ok:
        PASSES += 1
    else:
        FAILS.append(name)
    return ok


def make_pdf(pages: int = 1) -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    for i in range(pages):
        c.drawString(100, 700, f"page {i}")
        c.showPage()
    c.save()
    return buf.getvalue()


def multipart(action: str, data: bytes) -> tuple[bytes, str]:
    boundary = "----knife" + uuid.uuid4().hex
    parts = [
        f'--{boundary}\r\nContent-Disposition: form-data; name="action"\r\n\r\n{action}\r\n'.encode(),
        f'--{boundary}\r\nContent-Disposition: form-data; name="params"\r\n\r\n{{}}\r\n'.encode(),
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n'.encode() + data + b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ]
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


class Api:
    def __init__(self, base: str) -> None:
        self.base = base
        self.host, port = base.split("//", 1)[1].split(":")
        self.port = int(port)

    def call(self, method: str, path: str, body: object | None = None, cookie: str | None = None, ip: str = "203.0.113.10",
             raw: bytes | None = None, ctype: str | None = None) -> tuple[int, object, dict[str, str], float]:
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Content-Type", ctype or "application/json")
        if method != "GET":
            req.add_header("Origin", self.base)
        if cookie:
            req.add_header("Cookie", cookie)
        req.add_header("X-Forwarded-For", ip)
        started = time.monotonic()
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                status, text, hdrs = resp.status, resp.read().decode(errors="replace"), resp.headers
        except urllib.error.HTTPError as err:
            status, text, hdrs = err.code, err.read().decode(errors="replace"), err.headers
        out = {key.lower(): value for key, value in hdrs.items()}
        out["__cookies"] = "\n".join(hdrs.get_all("Set-Cookie") or [])
        try:
            parsed: object = json.loads(text)
        except ValueError:
            parsed = text
        return status, parsed, out, time.monotonic() - started

    def login(self, ident: str, ip: str) -> str:
        status, body, hdrs, _ = self.call("POST", "/api/account/login", {"id": ident, "password": PASSWORD}, ip=ip)
        for line in hdrs["__cookies"].split("\n"):
            if line.startswith("knife_session=") and not line.startswith("knife_session=;"):
                return line.split(";")[0]
        raise RuntimeError(f"login {ident} failed: {status} {body}")

    def pdf(self, cookie: str, data: bytes | None = None) -> tuple[int, object, dict[str, str], float]:
        body, ctype = multipart("info", data if data is not None else make_pdf())
        return self.call("POST", "/api/pdf", raw=body, ctype=ctype, cookie=cookie)

    def hold_upload(self, cookie: str, declared: int = 2 * 1024 * 1024) -> socket.socket:
        """A PDF upload that declares `declared` bytes, sends its first part and then stalls (keeps its slot)."""
        body, ctype = multipart("info", b"%PDF-1.4\n" + b"0" * (declared - 400))
        sock = socket.create_connection((self.host, self.port), timeout=30)
        head = (f"POST /api/pdf HTTP/1.1\r\nHost: {self.host}:{self.port}\r\nContent-Type: {ctype}\r\nContent-Length: {len(body)}\r\n"
                f"Origin: {self.base}\r\nCookie: {cookie}\r\nX-Forwarded-For: 203.0.113.50\r\n\r\n")
        sock.sendall(head.encode() + body[:4096])
        return sock


def cli(data_dir: Path, *args: str, stdin: str = "") -> subprocess.CompletedProcess[str]:
    env = {**os.environ, "KNIFE_DATA_DIR": str(data_dir), "KNIFE_AUTH_MODE": "public"}
    return subprocess.run(["node", str(ROOT / "scripts" / "accounts.mjs"), *args], input=stdin, capture_output=True, text=True, env=env, cwd=ROOT)


def accounts(server: ScratchServer, api: Api, users: list[str]) -> dict[str, str]:
    data = server.data_dir
    assert data is not None
    cookies: dict[str, str] = {}
    for n, (ident, role) in enumerate([("owner", "admin"), *[(user, "user") for user in users]]):
        r = cli(data, "add", ident, "--name", ident.title(), "--password-prompt", "--email", f"{ident}@example.com", "--role", role, stdin=f"{PASSWORD}\n")
        if r.returncode != 0:
            raise RuntimeError(f"CLI add {ident}: {r.stderr}")
        cookies[ident] = api.login(ident, f"203.0.113.{20 + n}")
    return cookies


def scratch_dirs(tmp: Path) -> list[str]:
    return sorted(p.name for p in tmp.iterdir() if p.name.startswith("knife-pdf-"))


def retry_after(hdrs: dict[str, str]) -> bool:
    return hdrs.get("retry-after", "").isdigit() and int(hdrs["retry-after"]) >= 1


def run_budgets(server: ScratchServer, tmp: Path) -> None:
    api = Api(server.url)
    c = accounts(server, api, ["bob", "carol", "dave"])

    s, body, _, _ = api.pdf(c["owner"])  # also compiles the route before anything is timed
    check("warm-up: the administrator's PDF info works", s == 200 and isinstance(body, dict) and body.get("ok") is True, (s, body))

    print("== 1. upload slots")
    held = [api.hold_upload(c["bob"]), api.hold_upload(c["bob"])]
    time.sleep(1.0)
    s, body, hdrs, took = api.pdf(c["bob"])
    check("bob's third upload while two are streaming -> 429", s == 429, (s, body))
    check("429 carries Retry-After and a readable message", retry_after(hdrs) and "uploads in progress" in str(body), (hdrs.get("retry-after"), body))
    check("refused before the body was read (fast)", took < 3, took)
    s, body, hdrs, _ = api.pdf(c["carol"])
    check("carol with the ordinary share of the server's slots in use -> 503 + Retry-After", s == 503 and retry_after(hdrs) and "Too many uploads" in str(body), (s, body))
    s, body, _, _ = api.pdf(c["owner"])
    check("the administrator still uploads (reserved slot)", s == 200, (s, body))
    s, body, _, _ = api.call("GET", "/api/system/queue", cookie=c["owner"])
    uploads = body.get("uploads", {}) if isinstance(body, dict) else {}
    check("queue stats show the 2 uploads in flight and the public settings", uploads.get("inFlight") == 2 and uploads.get("perAccount") == 2 and uploads.get("max") == 3, uploads)
    for sock in held:
        sock.close()
    time.sleep(1.5)
    s, body, _, _ = api.pdf(c["bob"])
    check("after bob's clients walked away his slots are back", s == 200, (s, body))
    s, body, _, _ = api.call("GET", "/api/system/queue", cookie=c["owner"])
    check("nothing in flight afterwards", isinstance(body, dict) and body.get("uploads", {}).get("inFlight") == 0 and body.get("uploads", {}).get("reservedBytes") == 0, body)
    check("no upload scratch dir left behind", scratch_dirs(tmp) == [], scratch_dirs(tmp))
    stalled = api.hold_upload(c["carol"])
    time.sleep(1.0)
    s, body, _, _ = api.call("GET", "/api/system/queue", cookie=c["owner"])
    check("a stalled upload holds a slot at first", isinstance(body, dict) and body.get("uploads", {}).get("inFlight") == 1, body)
    stalled.settimeout(30)
    started = time.monotonic()
    answer = b""
    try:
        while b"\r\n\r\n" not in answer:
            chunk = stalled.recv(4096)
            if not chunk:
                break
            answer += chunk
    except OSError as err:
        answer += f"<{err}>".encode()
    stalled.close()
    waited = time.monotonic() - started
    check("after KNIFE_UPLOAD_IDLE_SEC without a byte it is answered 408", answer.startswith(b"HTTP/1.1 408"), answer[:200])
    check("... after the idle window, not at once and not after Node's 5-minute timeout", 3 < waited < 20, waited)
    s, body, _, _ = api.call("GET", "/api/system/queue", cookie=c["owner"])
    check("and its slot is free again", isinstance(body, dict) and body.get("uploads", {}).get("inFlight") == 0, body)
    check("no scratch dir left by the stalled upload", scratch_dirs(tmp) == [], scratch_dirs(tmp))

    print("== 2. job rate for a new account")
    statuses = [api.pdf(c["dave"])[0] for _ in range(3)]
    check("dave (new account) runs his 3 heavy jobs", statuses == [200, 200, 200], statuses)
    s, body, hdrs, took = api.pdf(c["dave"])
    check("the 4th heavy job in 10 minutes -> 429 + Retry-After, named as a rate", s == 429 and retry_after(hdrs) and "last 10 minutes" in str(body), (s, body, hdrs.get("retry-after")))
    check("rate refusal comes before the upload is read", took < 3, took)
    statuses = [api.call("POST", "/api/sql", {"action": "format", "params": {"sql": "select 1", "dialect": "sqlite"}}, cookie=c["dave"])[0] for _ in range(5)]
    check("dave's 5 light (SQL) jobs run", statuses == [200] * 5, statuses)
    s, body, hdrs, _ = api.call("POST", "/api/sql", {"action": "format", "params": {"sql": "select 1", "dialect": "sqlite"}}, cookie=c["dave"])
    check("the 6th light job -> 429 + Retry-After", s == 429 and retry_after(hdrs) and isinstance(body, dict) and body.get("lane") == "light", (s, body))
    statuses = [api.pdf(c["owner"])[0] for _ in range(5)]
    check("the administrator has no job rate", statuses == [200] * 5, statuses)
    check("another account's allowance is its own", api.pdf(c["carol"])[0] == 200)


def run_floor(server: ScratchServer, tmp: Path) -> None:
    api = Api(server.url)
    c = accounts(server, api, ["erin"])
    print("== 3. free-space floor above the free space")
    s, body, hdrs, _ = api.pdf(c["erin"])
    check("a user's upload -> 503 (scratch space) + Retry-After", s == 503 and retry_after(hdrs) and "scratch space" in str(body), (s, body))
    check("no scratch dir was created for it", scratch_dirs(tmp) == [], scratch_dirs(tmp))
    draft = {"tool": "word-counter", "fields": {"text": "hello " * 50}}
    s, body, _, _ = api.call("PATCH", "/api/workspace", draft, cookie=c["erin"])
    check("a user's saved draft -> 507 storage_full", s == 507 and isinstance(body, dict) and body.get("code") == "storage_full", (s, body))
    check("the message is generic (no numbers about the server's disk)", isinstance(body, dict) and not any(unit in str(body.get("message", body.get("error", ""))) for unit in ("GB", "MB", "%")), body)
    s, body, _, _ = api.call("PATCH", "/api/workspace", draft, cookie=c["owner"])
    check("the administrator's draft is saved", s == 200, (s, body))


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="knife-budgets-tmp-"))
    base_env = {
        "KNIFE_AUTH_MODE": "public",
        "KNIFE_MAIL_TRANSPORT": "outbox",
        "KNIFE_TRUSTED_PROXIES": "127.0.0.1,::1",
        "KNIFE_SIDECAR_PREFIX": "knife-test-budgets",
        "TMPDIR": str(tmp),
        "KNIFE_UPLOADS_MAX": "3",
        "KNIFE_UPLOAD_IDLE_SEC": "6",
        "KNIFE_PY_HEAVY_PER_10MIN_NEW": "3",
        "KNIFE_PY_LIGHT_PER_10MIN_NEW": "5",
        # Only the floor scenario raises it; the first run must not depend on this machine's free space.
        "KNIFE_DISK_FLOOR_GB": "0",
        "KNIFE_DISK_FLOOR_PERCENT": "0",
    }
    try:
        with ScratchServer() as server:
            server.start(env=base_env)
            print(f"scratch server {server.url} data {server.data_dir} tmp {tmp}", flush=True)
            try:
                run_budgets(server, tmp)
                server.restart({**base_env, "KNIFE_DISK_FLOOR_PERCENT": "100"})
                run_floor(server, tmp)
            except Exception:  # noqa: BLE001
                traceback.print_exc()
                FAILS.append("crashed: " + traceback.format_exc().strip().splitlines()[-1])
                print(server.log_tail(3000))
    finally:
        subprocess.run(["rm", "-rf", str(tmp)], check=False)
    print(f"\n{PASSES} passed, {len(FAILS)} failed")
    if FAILS:
        print(f"{len(FAILS)} FAILED: {FAILS}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
