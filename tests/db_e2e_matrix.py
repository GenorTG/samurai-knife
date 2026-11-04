"""Runs the account-heavy e2e suites on each core-store backend and measures request latency (docs/DB-POSTGRES.md "Tests").

Backends:
  files   today's files (no KNIFE_DB_URL)
  pg0     Postgres 18 in a throwaway container (tests/pg_scratch.mjs), reached through the latency proxy at 0 ms
  pg35    the same through tests/latency_proxy.mjs with 35 ms injected round trip (the genorbox1 -> VPS path)
Every server start gets a fresh data dir AND a fresh migrated database (tests/scratch_server.py, KNIFE_TEST_PG_ADMIN_URL).
Suites that read accounts.json / sessions.json / mcp-keys.json as oracles run with KNIFE_DB_VERIFY=1 (the server
mirrors the database into the files after every commit and compares both); `--pure` runs without the mirror.

  python3 tests/db_e2e_matrix.py                                  all suites x files,pg0,pg35
  python3 tests/db_e2e_matrix.py --backends pg35 --suites roles_mcp,security_probe --pure
  python3 tests/db_e2e_matrix.py --bench-only --backends files,pg0,pg35

Suites: accounts_api (dev), accounts_public, roles_mcp (self-contained), prod_smoke, security_probe, cv_security_probe
(production build in public mode: `npm run build` first, or --build). Logs go to --logs (default a temp dir).
Ports: KNIFE_SCRATCH_PORTS (default 3401-3449). Only containers it started (sk-pg-test-*) are removed.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import signal
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from base64 import b64encode
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("KNIFE_SCRATCH_PORTS", "3401-3449")
from tests.scratch_server import MAIL_TEST_DEFAULTS, ScratchServer, free_port  # noqa: E402

SELF_CONTAINED = {
    "accounts_public": ["tests/functional/accounts_public_e2e.py"],
    "roles_mcp": ["tests/functional/roles_mcp_e2e.py"],
}
PROD = {"prod_smoke": "tests/prod_smoke.py", "security_probe": "tests/security_probe.py", "cv_security_probe": "tests/cv_security_probe.py"}
ALL_SUITES = ["accounts_api", "accounts_public", "roles_mcp", "prod_smoke", "security_probe", "cv_security_probe"]


def node(*args: str, **kw) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["node", *args], cwd=ROOT, capture_output=True, text=True, **kw)


class Postgres:
    def __init__(self) -> None:
        up = node("tests/pg_scratch.mjs", "up", check=True)
        info = json.loads(up.stdout.strip().splitlines()[-1])
        self.name, self.port, self.admin = info["name"], info["port"], info["url"]
        self.proxy: subprocess.Popen[str] | None = None
        self.proxy_port = 0

    def via(self, rtt: int) -> str:
        self.stop_proxy()
        port = free_port()
        self.proxy = subprocess.Popen(["node", "tests/latency_proxy.mjs", "--listen", f"127.0.0.1:{port}", "--target", f"127.0.0.1:{self.port}", "--rtt", str(rtt)],
                                      cwd=ROOT, stdout=subprocess.PIPE, text=True)
        assert self.proxy.stdout is not None
        self.proxy_port = json.loads(self.proxy.stdout.readline())["port"]
        return f"127.0.0.1:{self.proxy_port}"

    def stop_proxy(self) -> None:
        if self.proxy is not None:
            self.proxy.terminate()
            self.proxy.wait(timeout=10)
            self.proxy = None

    def newdb(self, name: str, via: str = "") -> str:
        env = {**os.environ, "KNIFE_TEST_PG_VIA": via} if via else {k: v for k, v in os.environ.items() if k != "KNIFE_TEST_PG_VIA"}
        return node("tests/pg_scratch.mjs", "newdb", self.admin, name, check=True, env=env).stdout.strip()

    def stop(self) -> None:
        self.stop_proxy()
        node("tests/pg_scratch.mjs", "down", self.name)


def backend_env(backend: str, pg: Postgres | None, pure: bool) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith(("KNIFE_TEST_PG_", "KNIFE_DB_"))}
    if backend == "files":
        return env
    assert pg is not None
    rtt = int(backend[2:])
    env["KNIFE_TEST_PG_ADMIN_URL"] = pg.admin
    env["KNIFE_TEST_PG_VIA"] = pg.via(rtt)
    if not pure:
        env["KNIFE_DB_VERIFY"] = "1"
    return env


def summarize(text: str, code: int) -> str:
    passed = len(re.findall(r"^(?:PASS|ok)\b", text, re.M))
    failed = len(re.findall(r"^FAIL\b", text, re.M))
    m = re.search(r"(\d+) passed, (\d+) failed", text)
    if m:
        passed, failed = int(m.group(1)), int(m.group(2))
    m = re.search(r"ALL PASS \((\d+)\)|(\d+)/(\d+) (?:passed|checks passed)", text)
    tail = f"; {m.group(0)}" if m else ""
    return f"exit {code}: {passed} pass, {failed} fail{tail}"


class ProdServer:
    """`npm run start` of this checkout's build, public mode, own data dir + own database."""

    def __init__(self, env: dict[str, str], pg: Postgres | None, public: bool = True) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="sk-db-prod-")
        self.data = Path(self.tmp.name) / "data"
        self.data.mkdir()
        self.port = free_port()
        self.url = f"http://127.0.0.1:{self.port}"
        child = {**env, **MAIL_TEST_DEFAULTS, "KNIFE_HOST": "127.0.0.1", "KNIFE_PORT": str(self.port), "KNIFE_DATA_DIR": str(self.data),
                 "KNIFE_MAIL_TRANSPORT": "outbox"}
        if public:
            child.update({"KNIFE_AUTH_MODE": "public", "KNIFE_PUBLIC_URL": self.url, "KNIFE_TRUSTED_PROXIES": "127.0.0.1/32"})
        self.db_url = ""
        if pg is not None and "KNIFE_TEST_PG_ADMIN_URL" in env:
            self.db_url = pg.newdb(f"skprod_{os.getpid()}_{secrets.token_hex(3)}", env.get("KNIFE_TEST_PG_VIA", ""))
            child["KNIFE_DB_URL"] = self.db_url
        self.env = child
        self.log = (Path(self.tmp.name) / "server.log").open("w+")
        self.proc = subprocess.Popen(["node", "scripts/serve.mjs", "start"], cwd=ROOT, env=child, stdout=self.log, stderr=subprocess.STDOUT, start_new_session=True)
        deadline = time.time() + 120
        while time.time() < deadline:
            if self.proc.poll() is not None:
                break
            try:
                urllib.request.urlopen(self.url, timeout=2).close()
                return
            except urllib.error.HTTPError:
                return
            except OSError:
                time.sleep(0.3)
        raise RuntimeError(f"production server did not start:\n{self.tail()}")

    def tail(self, chars: int = 4000) -> str:
        self.log.flush()
        self.log.seek(0)
        return self.log.read()[-chars:]

    def stop(self) -> None:
        try:
            os.killpg(self.proc.pid, signal.SIGTERM)
            self.proc.wait(timeout=15)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            try:
                os.killpg(self.proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        self.log.close()
        self.tmp.cleanup()


def run_suite(suite: str, env: dict[str, str], pg: Postgres | None, logs: Path, tag: str) -> str:
    log = logs / f"{tag}-{suite}.log"
    if suite in SELF_CONTAINED:
        r = subprocess.run([sys.executable, *SELF_CONTAINED[suite]], cwd=ROOT, env=env, capture_output=True, text=True, timeout=3600)
        log.write_text(r.stdout + r.stderr)
        return summarize(r.stdout + r.stderr, r.returncode)
    if suite == "accounts_api":
        saved = dict(os.environ)
        os.environ.clear()
        os.environ.update(env)
        mock_port = free_port()
        mock = subprocess.Popen(["node", "tests/mock_provider.mjs", str(mock_port)], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            with ScratchServer() as server:
                url = server.start()
                child = {**os.environ, "KNIFE_DATA_DIR": str(server.data_dir)}
                r = subprocess.run([sys.executable, "tests/accounts_api_e2e.py", url, f"http://127.0.0.1:{mock_port}"], cwd=ROOT, env=child, capture_output=True, text=True, timeout=1800)
                log.write_text(r.stdout + r.stderr + "\n--- server ---\n" + server.log_tail(20000))
                return summarize(r.stdout + r.stderr, r.returncode)
        finally:
            mock.terminate()
            os.environ.clear()
            os.environ.update(saved)
    if suite in PROD:
        server = ProdServer(env, pg)
        mock_port = free_port()
        mock = subprocess.Popen(["node", "tests/mock_provider.mjs", str(mock_port)], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            args = [server.url] + ([f"http://127.0.0.1:{mock_port}"] if suite == "prod_smoke" else [])
            child = {**server.env}
            r = subprocess.run([sys.executable, PROD[suite], *args], cwd=ROOT, env=child, capture_output=True, text=True, timeout=3600)
            log.write_text(r.stdout + r.stderr + "\n--- server ---\n" + server.tail(30000))
            return summarize(r.stdout + r.stderr, r.returncode)
        finally:
            mock.terminate()
            server.stop()
    raise ValueError(suite)


# ---------------------------------------------------------------------------------------------------------- benchmark

def percentile(values: list[float], p: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, round(p / 100 * (len(ordered) - 1))))]


def bench(env: dict[str, str], pg: Postgres | None, rounds: int) -> dict[str, dict[str, float]]:
    server = ProdServer(env, pg, public=False)
    try:
        cli_env = {**server.env}
        password = "bench-password-" + secrets.token_hex(4)
        users = [f"bench{i}" for i in range(4)]
        for user in users:
            r = subprocess.run(["node", "scripts/accounts.mjs", "add", user, "--name", user, "--password-prompt"], cwd=ROOT, env=cli_env, input=f"{password}\n{password}\n", capture_output=True, text=True)
            assert r.returncode == 0, r.stderr
        time.sleep(1.0)  # the server reloads after the CLI's NOTIFY (Postgres) / sees the file change (files)

        def request(method: str, path: str, body: object | None = None, headers: dict[str, str] | None = None) -> tuple[int, bytes, dict[str, list[str]], float]:
            data = json.dumps(body).encode() if body is not None else None
            req = urllib.request.Request(server.url + path, method=method, data=data, headers={"content-type": "application/json", "origin": server.url, **(headers or {})})
            started = time.perf_counter()
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    raw = resp.read()
                    return resp.status, raw, {"set-cookie": resp.headers.get_all("set-cookie") or []}, (time.perf_counter() - started) * 1000
            except urllib.error.HTTPError as error:
                return error.code, error.read(), {}, (time.perf_counter() - started) * 1000

        def cookie_of(headers: dict[str, list[str]]) -> str:
            return next(c.split(";")[0] for c in headers["set-cookie"] if c.startswith("knife_session="))

        out: dict[str, list[float]] = {"login": [], "session_check": [], "page_load": [], "mcp_call": [], "write": []}
        cookie = ""
        for i in range(min(rounds, 25 * len(users))):
            user = users[i % len(users)]
            status, _, headers, ms = request("POST", "/api/account/login", {"id": user, "password": password})
            assert status == 200, status
            out["login"].append(ms)
            cookie = cookie_of(headers)
        auth = {"cookie": cookie}
        status, raw, _, _ = request("POST", "/api/account/mcp-keys", {"action": "create", "name": "bench"}, auth)
        assert status == 201, (status, raw)
        key = json.loads(raw)["key"]
        me = json.loads(request("GET", "/api/account", None, auth)[1])["id"]
        basic = {"authorization": "Basic " + b64encode(f"{me}:{key}".encode()).decode(), "accept": "application/json, text/event-stream"}
        for _ in range(3):  # warm the routes (compiled already in a production build; first-hit caches)
            request("GET", "/api/account", None, auth)
            request("GET", "/", None, auth)
        for i in range(rounds):
            out["session_check"].append(request("GET", "/api/account", None, auth)[3])
            out["page_load"].append(request("GET", "/", None, auth)[3])
            status, raw, _, ms = request("POST", "/api/mcp", {"jsonrpc": "2.0", "id": i, "method": "tools/call", "params": {"name": "knife_count_text", "arguments": {"text": "hello world"}}}, basic)
            assert status == 200, (status, raw[:200])
            out["mcp_call"].append(ms)
            status, _, _, ms = request("PUT", "/api/account/seen", {}, auth)
            assert status == 200, status
            out["write"].append(ms)
        return {name: {"n": len(v), "p50": round(percentile(v, 50), 1), "p95": round(percentile(v, 95), 1), "mean": round(statistics.fmean(v), 1)} for name, v in out.items()}
    finally:
        server.stop()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--backends", default="files,pg0,pg35")
    parser.add_argument("--suites", default=",".join(ALL_SUITES))
    parser.add_argument("--pure", action="store_true", help="Postgres without the verify-mode file mirror")
    parser.add_argument("--bench", action="store_true")
    parser.add_argument("--bench-only", action="store_true")
    parser.add_argument("--bench-rounds", type=int, default=100)
    parser.add_argument("--build", action="store_true")
    parser.add_argument("--logs", default="")
    args = parser.parse_args()
    backends = [b for b in args.backends.split(",") if b]
    suites = [] if args.bench_only else [s for s in args.suites.split(",") if s]
    logs = Path(args.logs or tempfile.mkdtemp(prefix="sk-db-matrix-"))
    logs.mkdir(parents=True, exist_ok=True)
    print(f"logs: {logs}", flush=True)
    if args.build:
        subprocess.run(["npm", "run", "build"], cwd=ROOT, check=True)
    pg = Postgres() if any(b.startswith("pg") for b in backends) else None
    results: dict[str, dict[str, object]] = {}
    try:
        for backend in backends:
            env = backend_env(backend, pg, args.pure)
            tag = f"{backend}{'-pure' if args.pure else ''}"
            results[tag] = {}
            for suite in suites:
                started = time.time()
                try:
                    summary = run_suite(suite, env, pg, logs, tag)
                except Exception as error:  # noqa: BLE001
                    summary = f"crashed: {error}"
                results[tag][suite] = f"{summary} ({time.time() - started:.0f} s)"
                print(f"[{tag}] {suite}: {results[tag][suite]}", flush=True)
            if args.bench or args.bench_only:
                bench_env = {k: v for k, v in env.items() if k != "KNIFE_DB_VERIFY"}
                results[tag]["bench"] = bench(bench_env, pg, args.bench_rounds)
                print(f"[{tag}] bench: {json.dumps(results[tag]['bench'])}", flush=True)
    finally:
        if pg is not None:
            pg.stop()
    (logs / "results.json").write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
