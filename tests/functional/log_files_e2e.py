"""Log files end to end (src/lib/logs/, GET /api/admin/logs, /account/admin/logs) on a public-mode scratch server with its
own KNIFE_DATA_DIR, KNIFE_LOG_DIR, KNIFE_LEGAL_DIR (logRetentionDays 5) and port:

- the server's output lands in app/app-<UTC day>.log (and the passwords it handled never do);
- at startup, day files older than the retention are removed, past days gzipped, a symlink is left alone;
- the size cap rotates the live file to .1, .2 ... (KNIFE_LOG_MAX_BYTES=16384);
- a sidecar op writes sidecars/<id>/ops-<day>.log;
- the API: 401 signed out, 403 for a user, the admin lists and tails files (plain, gzip, the updater's, security events),
  downloads them as stored, and every traversal (.., absolute, encoded, double-encoded, NUL, symlinked file or folder,
  foreign names, unknown sources) is refused without leaking the target;
- the page in Playwright Firefox: the admin sees sources/files, the tail, the text and level filters and live refresh; a
  user sees the refusal and the page never calls the API.

Run: python3 tests/functional/log_files_e2e.py [--headed]
"""
from __future__ import annotations

import gzip
import json
import os
import secrets
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from playwright.sync_api import Browser, expect, sync_playwright  # noqa: E402

from tests.functional.accounts_public_e2e import Api, Outbox, cli, go, new_context, ui_login  # noqa: E402
from tests.scratch_server import ScratchServer  # noqa: E402

HEADED = "--headed" in sys.argv
PASSES = 0
FAILS: list[str] = []
ADMIN_PW = "admin password 12"
USER_PW = "alice password 1"
SECRET = "TOPSECRET-storage-key-" + secrets.token_hex(4)


def check(name: str, ok: object, detail: object = "") -> bool:
    global PASSES
    if ok:
        PASSES += 1
        print(f"  ok   {name}", flush=True)
    else:
        FAILS.append(name)
        print(f"  FAIL {name}  {str(detail)[:400]}", flush=True)
    return bool(ok)


def day(offset: int = 0) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=offset)).strftime("%Y-%m-%d")


def seed(base: Path) -> tuple[Path, Path]:
    logs, legal = base / "logs", base / "legal"
    for d in (logs / "app", logs / "update", logs / "sidecars" / "office", legal, base / "outside"):
        d.mkdir(parents=True, exist_ok=True)
    (legal / "legal.json").write_text(json.dumps({"logRetentionDays": "5"}))
    app = logs / "app"
    (app / f"app-{day(-10)}.log").write_text("ten days old\n")
    (app / f"app-{day(-5)}.log").write_text("five days old: past a 5-day retention\n")
    (app / f"app-{day(-4)}.log").write_text(f"{day(-4)}T10:00:00.000Z out four days old, kept\n")
    (app / f"app-{day(-1)}.1.log").write_text(f"{day(-1)}T10:00:00.000Z err yesterday part 1 warning\n")
    (logs / "update" / f"update-{day()}.log").write_text(
        f"{day()}T08:00:00.000Z out building v9.9.9.9 (abcdef0)\n{day()}T08:01:00.000Z err FAILED: npm run build\n")
    (logs / "sidecars" / "office" / f"ops-{day(-30)}.log").write_text("old op\n")
    secret = base / "secret.txt"
    secret.write_text(SECRET + "\n")
    os.symlink(secret, app / f"app-{day(-2)}.log")
    (base / "outside" / f"ops-{day()}.log").write_text(SECRET + "\n")
    os.symlink(base / "outside", logs / "sidecars" / "evil")
    return logs, legal


def raw_get(base: str, path: str, cookie: str | None = None) -> tuple[int, bytes, dict[str, str]]:
    req = urllib.request.Request(base + path)
    if cookie:
        req.add_header("Cookie", cookie)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, resp.read(), {k.lower(): v for k, v in resp.headers.items()}
    except urllib.error.HTTPError as err:
        return err.code, err.read(), {k.lower(): v for k, v in err.headers.items()}


def q(**params: str) -> str:
    return "/api/admin/logs?" + urllib.parse.urlencode(params)


def register(api: Api, box: Outbox, name: str, password: str, ip: str) -> str:
    api.call("POST", "/api/account/register", {"username": name, "email": f"{name}@example.com", "password": password}, ip=ip)
    mails = box.wait(f"{name}@example.com", 1)
    token = Outbox.token(Outbox.link(mails[0][2], "/verify")) if mails else ""
    api.call("POST", "/api/account/verify", {"token": token}, ip=ip)
    status, _, cookie = api.login(name, password, ip)
    check(f"{name} registered, verified and logged in", status == 200 and bool(cookie), status)
    return cookie or ""


def run(server: ScratchServer, browser: Browser, logs: Path) -> None:
    base = server.url
    data = server.data_dir
    assert data is not None
    api = Api(base)
    box = Outbox(data)
    app = logs / "app"
    today = app / f"app-{day()}.log"

    # ------------------------------------------------------------------------------------------ 1. files at startup
    check("the server's output is in app/app-<today>.log", today.exists() and "[serve] next dev on" in today.read_text(), sorted(os.listdir(app)))
    first = today.read_text().splitlines()[0] if today.exists() else ""
    check("line shape `<ISO time> <out|err> <text>`", len(first.split(" ", 2)) == 3 and first.split(" ")[0].endswith("Z") and first.split(" ")[1] in ("out", "err"), first)
    check("log file has no group-write / other bits", today.exists() and (today.stat().st_mode & 0o027) == 0, oct(today.stat().st_mode))
    names = sorted(os.listdir(app))
    check("retention 5 days (legal.json): files of day -10 and day -5 removed at startup", f"app-{day(-10)}.log" not in names and f"app-{day(-5)}.log" not in names, names)
    check("past days gzipped at startup, today plain", f"app-{day(-4)}.log.gz" in names and f"app-{day(-1)}.1.log.gz" in names and f"app-{day()}.log" in names, names)
    check("a symlink named like a log file is left alone (never followed, never deleted)", os.path.islink(app / f"app-{day(-2)}.log"), names)
    check("old sidecar op file removed", not (logs / "sidecars" / "office" / f"ops-{day(-30)}.log").exists())

    # ------------------------------------------------------------------------------------------ 2. accounts
    check("CLI set-password + set-email for the admin",
          cli(data, "set-password", "genor", stdin=ADMIN_PW + "\n").returncode == 0 and cli(data, "set-email", "genor", "admin@knife.example.com").returncode == 0)
    status, _, admin = api.login("genor", ADMIN_PW, "203.0.113.2")
    check("admin logs in", status == 200 and bool(admin), status)
    alice = register(api, box, "alice", USER_PW, "203.0.113.3")

    # ------------------------------------------------------------------------------------------ 3. API authorization
    status, body, _ = api.call("GET", "/api/admin/logs", ip="203.0.113.9")
    check("signed out -> 401", status == 401, (status, body))
    for path in ("/api/admin/logs", q(source="app", file=f"app-{day()}.log"), q(source="app", file=f"app-{day()}.log", download="1")):
        status, body, _ = api.call("GET", path, cookie=alice)
        check(f"a user -> 403 admin_required ({path[:60]})", status == 403 and isinstance(body, dict) and body.get("code") == "admin_required", (status, body))
    for method in ("POST", "PUT", "DELETE"):
        status, _, _ = api.call(method, q(source="app", file=f"app-{day()}.log"), {}, cookie=admin)
        check(f"admin {method} -> 405 (read-only API)", status == 405, status)

    # ------------------------------------------------------------------------------------------ 4. listing + tails
    status, body, _ = api.call("GET", "/api/admin/logs", cookie=admin)
    sources = {s["id"]: s for s in body.get("sources", [])} if isinstance(body, dict) else {}
    check("admin lists sources: app, update, sidecar:office, security; retention 5 and the root",
          {"app", "update", "sidecar:office", "security"} <= set(sources) and body.get("retentionDays") == 5 and body.get("root") == str(logs), (status, body))
    check("a symlinked sidecar folder is not a source", "sidecar:evil" not in sources, list(sources))
    app_files = [f["name"] for f in sources.get("app", {}).get("files", [])]
    check("app files newest first, symlink not listed", app_files[:1] == [f"app-{day()}.log"] and f"app-{day(-2)}.log" not in app_files, app_files)
    status, body, _ = api.call("GET", q(source="app", file=f"app-{day()}.log", lines="50"), cookie=admin)
    check("tail of today's app log", status == 200 and isinstance(body, dict) and 0 < len(body["lines"]) <= 50 and any("[serve]" in line for line in body["lines"]), (status, body))
    status, body, _ = api.call("GET", q(source="app", file=f"app-{day(-4)}.log.gz"), cookie=admin)
    check("tail of a gzipped day", status == 200 and isinstance(body, dict) and body["lines"] == [f"{day(-4)}T10:00:00.000Z out four days old, kept"], (status, body))
    status, body, _ = api.call("GET", q(source="update", file=f"update-{day()}.log"), cookie=admin)
    check("the updater's file", status == 200 and isinstance(body, dict) and body["lines"][-1].endswith("FAILED: npm run build"), (status, body))
    status, body, _ = api.call("GET", q(source="app", file=f"app-{day()}.log", lines="999999"), cookie=admin)
    check("tail is bounded (lines param capped)", status == 200 and isinstance(body, dict) and len(body["lines"]) <= 5000, status)

    # ------------------------------------------------------------------------------------------ 5. traversal
    probes = [
        ("../../etc/passwd as file", "/api/admin/logs?source=app&file=../../etc/passwd", 400),
        ("absolute file", "/api/admin/logs?source=app&file=/etc/passwd", 400),
        ("encoded ../ file", "/api/admin/logs?source=app&file=..%2F..%2Fsecret.txt", 400),
        ("double-encoded file", "/api/admin/logs?source=app&file=%252e%252e%252fsecret.txt", 400),
        ("encoded traversal in a log-looking name", f"/api/admin/logs?source=app&file=app-{day()}.log%2F..%2F..%2F..%2Fsecret.txt", 400),
        ("NUL in the name", f"/api/admin/logs?source=app&file=app-{day()}.log%00", 400),
        ("foreign name", "/api/admin/logs?source=app&file=secret.txt", 400),
        ("another source's name", f"/api/admin/logs?source=app&file=update-{day()}.log", 400),
        ("../ source", f"/api/admin/logs?source=..%2Fapp&file=app-{day()}.log", 400),
        ("sidecar traversal source", f"/api/admin/logs?source=sidecar:..%2F..%2Fapp&file=app-{day()}.log", 400),
        ("absolute source", f"/api/admin/logs?source=%2Fetc&file=app-{day()}.log", 400),
        ("unknown source", f"/api/admin/logs?source=etc&file=app-{day()}.log", 400),
        ("symlinked file", f"/api/admin/logs?source=app&file=app-{day(-2)}.log", 404),
        ("symlinked file, download", f"/api/admin/logs?source=app&file=app-{day(-2)}.log&download=1", 404),
        ("symlinked sidecar folder", f"/api/admin/logs?source=sidecar:evil&file=ops-{day()}.log", 404),
        ("missing file", "/api/admin/logs?source=app&file=app-2001-01-01.log", 404),
        ("only a source", "/api/admin/logs?source=app", 400),
    ]
    for label, path, expected in probes:
        status, raw, _ = raw_get(base, path, admin)
        check(f"refused: {label} -> {expected}", status == expected and SECRET.encode() not in raw and b"root:" not in raw, (status, raw[:200]))

    # ------------------------------------------------------------------------------------------ 6. download
    status, raw, hdrs = raw_get(base, q(source="app", file=f"app-{day(-4)}.log.gz", download="1"), admin)
    check("download a .gz as stored", status == 200 and hdrs.get("content-type") == "application/gzip" and gzip.decompress(raw).decode().startswith(day(-4))
          and f'filename="app-{day(-4)}.log.gz"' in hdrs.get("content-disposition", ""), (status, hdrs))
    status, raw, hdrs = raw_get(base, q(source="update", file=f"update-{day()}.log", download="1"), admin)
    check("download a plain file", status == 200 and hdrs.get("content-type", "").startswith("text/plain") and raw.endswith(b"FAILED: npm run build\n"), (status, raw[-80:]))

    # ------------------------------------------------------------------------------------------ 7. sidecar op log
    status, body, _ = api.call("POST", "/api/services/learn-db", {"action": "start"}, cookie=admin)
    op_id = body.get("op", {}).get("opId") if isinstance(body, dict) else None
    check("admin starts a not-installed sidecar (op accepted)", status == 202 and bool(op_id), (status, body))
    ops_file = logs / "sidecars" / "learn-db" / f"ops-{day()}.log"
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline and not (ops_file.exists() and "failed" in ops_file.read_text()):
        time.sleep(0.3)
    text = ops_file.read_text() if ops_file.exists() else ""
    check("sidecar op written to sidecars/learn-db/ops-<today>.log (start + failure)", f"[{op_id} start] started" in text and "failed: learn-db is not installed" in text, text[-400:])
    status, body, _ = api.call("GET", "/api/admin/logs", cookie=admin)
    check("the new sidecar folder is listed", isinstance(body, dict) and any(s["id"] == "sidecar:learn-db" for s in body.get("sources", [])), body)

    # ------------------------------------------------------------------------------------------ 8. size rotation
    for i in range(400):
        raw_get(base, f"/api/admin/logs?source=app&file=app-{day()}.log&lines=1&n={i}", admin)
        if (app / f"app-{day()}.2.log").exists():
            break
    names = sorted(os.listdir(app))
    sizes = {n: (app / n).stat().st_size for n in names if n.startswith(f"app-{day()}")}
    check("size cap (16384) rotated today's file to .1/.2", f"app-{day()}.1.log" in names and f"app-{day()}.2.log" in names and all(s <= 16384 for s in sizes.values()), sizes)
    status, body, _ = api.call("GET", "/api/admin/logs", cookie=admin)
    parts = [f["name"] for f in next((s for s in body.get("sources", []) if s["id"] == "app"), {}).get("files", [])] if isinstance(body, dict) else []
    check("rotated parts listed after the live file (.1 newest part first)", parts[:3] == [f"app-{day()}.log", f"app-{day()}.1.log", f"app-{day()}.2.log"], parts[:4])

    # ------------------------------------------------------------------------------------------ 9. nothing secret in the files
    everything = b"".join(p.read_bytes() for p in logs.rglob("*") if p.is_file() and not p.is_symlink() and not p.name.endswith(".gz"))
    check("no password or session cookie in any log file", ADMIN_PW.encode() not in everything and USER_PW.encode() not in everything and admin.split("=", 1)[-1].encode() not in everything)

    # ------------------------------------------------------------------------------------------ 10. the page (Firefox)
    ctx, page = new_context(browser, base, "203.0.113.20")
    ui_login(page, "genor", ADMIN_PW)
    page.wait_for_url(lambda url: "/login" not in url, timeout=30_000)
    go(page, "/account/admin/logs")
    status_line = page.locator("main [role=status]").filter(has_text="lines shown")
    expect(status_line).to_be_visible(timeout=30_000)
    # (the size step above rotated the startup lines into .N parts: today's live file holds the recent requests)
    check("admin page: the newest file of the first source with files is shown", page.locator(f"[data-log-file='app-{day()}.log']").count() == 1 and "GET /account/admin/logs" in page.get_by_label("Log lines").inner_text())
    page.get_by_role("combobox", name="Source", exact=True).select_option("update")
    expect(page.get_by_label("Log lines")).to_contain_text("FAILED: npm run build", timeout=15_000)
    check("admin page: switching the source shows the updater's file", True)
    page.get_by_role("combobox", name="Source", exact=True).select_option("app")
    expect(page.locator(f"[data-log-file='app-{day(-4)}.log.gz']")).to_be_visible(timeout=15_000)
    page.get_by_role("button", name=f"Show app-{day(-4)}.log.gz").click()
    expect(page.get_by_label("Log lines")).to_have_text(f"{day(-4)}T10:00:00.000Z out four days old, kept", timeout=15_000)
    check("admin page: a gzipped file opens", True)
    page.get_by_role("button", name=f"Show app-{day()}.log", exact=True).click()
    expect(page.get_by_label("Log lines")).to_contain_text("GET /account/admin/logs", timeout=15_000)
    page.locator("main").get_by_role("searchbox").fill("GET /account/admin/logs")
    lines = page.locator("[aria-label='Log lines'] [data-level]")
    expect(lines.first).to_be_visible()
    texts = lines.all_inner_texts()
    check("text filter keeps only matching lines", texts and all("GET /account/admin/logs" in t for t in texts), texts[:3])
    page.locator("main").get_by_role("searchbox").fill("")
    page.get_by_role("radio", name="Errors", exact=True).click()
    levels = set(page.locator("[aria-label='Log lines'] [data-level]").evaluate_all("els => els.map(e => e.dataset.level)"))
    check("level filter Errors shows error lines only", levels <= {"error"}, levels)
    page.get_by_role("radio", name="All", exact=True).click()
    page.get_by_label("Live refresh").check()
    before = page.get_by_label("Log lines").inner_text()
    for i in range(30):
        raw_get(base, f"/api/admin/logs?source=app&file=app-{day()}.log&lines=1&live={i}", admin)
    page.wait_for_timeout(4000)
    expect(status_line).to_contain_text("refreshing every 3 s")
    check("live refresh picks up new lines", page.get_by_label("Log lines").inner_text() != before)
    page.get_by_label("Live refresh").uncheck()
    with page.expect_download() as info:
        page.get_by_role("link", name="Download").click()
    check("download link saves the shown file", info.value.suggested_filename == f"app-{day()}.log", info.value.suggested_filename)
    ctx.close()

    ctx, page = new_context(browser, base, "203.0.113.21")
    calls: list[str] = []
    page.on("request", lambda req: calls.append(req.url) if "/api/admin/logs" in req.url else None)
    ui_login(page, "alice", USER_PW)
    page.wait_for_url(lambda url: "/login" not in url, timeout=30_000)
    go(page, "/account/admin/logs")
    check("user page: the refusal, no viewer", page.get_by_text("An administrator has to read the server logs.").is_visible() and page.get_by_label("Log lines").count() == 0)
    check("user page: never calls the logs API", calls == [], calls)
    ctx.close()


def main() -> int:
    base = Path(tempfile.mkdtemp(prefix="sk-logs-e2e-"))
    logs, legal = seed(base)
    env = {
        "KNIFE_AUTH_MODE": "public",
        "KNIFE_MAIL_TRANSPORT": "outbox",
        "KNIFE_LOG_DIR": str(logs),
        "KNIFE_LEGAL_DIR": str(legal),
        "KNIFE_LOG_MAX_BYTES": "16384",
        "KNIFE_SIDECAR_PREFIX": f"sk-logs-e2e-{secrets.token_hex(3)}",
    }
    try:
        with ScratchServer() as server:
            server.start(env=env)
            print(f"scratch server {server.url} data {server.data_dir} logs {logs}", flush=True)
            with sync_playwright() as pw:
                browser = pw.firefox.launch(headless=not HEADED)
                try:
                    run(server, browser, logs)
                except Exception:  # noqa: BLE001
                    traceback.print_exc()
                    FAILS.append("crashed: " + traceback.format_exc().strip().splitlines()[-1])
                    print(server.log_tail(3000))
                finally:
                    browser.close()
    finally:
        import shutil
        shutil.rmtree(base, ignore_errors=True)
    print(f"\n{PASSES} passed, {len(FAILS)} failed")
    if FAILS:
        print(f"{len(FAILS)} FAILED: {FAILS}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
