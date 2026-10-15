"""Database course (SQL & PostGIS) end to end, against REAL docker: install the `learn-db` sidecar (PostgreSQL 16 +
PostGIS 3.4) from the course page, let the app seed the course data, then

- run EVERY lesson's reference solution through POST /api/learn/sql/check and require it to pass its own check (and
  the starter query not to);
- probe the learner sandbox: refused statements, the learner role's privileges, writes always rolled back, the time
  limit and the row cap, the schema browser;
- drive the page with Playwright: lesson 1 checked wrong (feedback, hint, solution unlocks) then right (Ctrl+Enter
  runs), the error position of a typo, progress (done mark, counter, last query) surviving a reload;
- stop the database and reopen the page (lazy start), then remove it with its volume.

Isolation: own scratch worktree server (tests/scratch_server.py) bound to the Tailscale/LAN address (KNIFE_HOST; a
container cannot reach the host's loopback), own KNIFE_DATA_DIR and port, own compose project
(KNIFE_SIDECAR_PREFIX=sk-e2e-<pid>): never the live :3210 app or its `samurai-knife-learn-db` project, never other
containers. The image (~600 MB) stays cached unless --remove-image.

    python3 tests/learn_db_e2e.py [--host <tailscale-or-LAN-ip>] [--hold] [--remove-image] [--shots DIR]
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scratch_server import ROOT, ScratchServer  # noqa: E402

from playwright.sync_api import Page, sync_playwright  # noqa: E402

RESULTS: list[tuple[str, bool, str]] = []
METRICS: dict[str, object] = {}
SERVICE = "learn-db"
# New modules a fresh checkout may not have committed yet (the scratch worktree holds tracked files only).
OVERLAY = ["src/lib/learn", "src/app/api/learn", "src/tools/learn", "src/lib/mcp/tools-learn.ts"]


def check(name: str, ok: bool, detail: str = "") -> bool:
    RESULTS.append((name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{f' — {detail}' if detail else ''}", flush=True)
    return ok


def default_host() -> str | None:
    """KNIFE_E2E_HOST / KNIFE_HOST from the environment, else KNIFE_HOST from the gitignored .env.local."""
    host = os.environ.get("KNIFE_E2E_HOST") or os.environ.get("KNIFE_HOST")
    if host:
        return host
    env = ROOT / ".env.local"
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("KNIFE_HOST="):
                return line.split("=", 1)[1].strip().strip('"') or None
    return None


class Api:
    def __init__(self, base: str) -> None:
        self.base = base

    def call(self, method: str, path: str, body: object | None = None, timeout: float = 60) -> tuple[int, dict]:
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Origin", self.base)
        if body is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return res.status, json.loads(res.read() or b"{}")
        except urllib.error.HTTPError as err:
            raw = err.read()
            try:
                return err.code, json.loads(raw)
            except json.JSONDecodeError:
                return err.code, {"raw": raw.decode(errors="replace")}

    def wait_op(self, op: dict, timeout: float) -> dict:
        deadline = time.monotonic() + timeout
        last = ""
        while time.monotonic() < deadline:
            _, body = self.call("GET", f"/api/services/ops/{op['opId']}")
            op = body["op"]
            if op["phase"] != last:
                print(f"    op {op['kind']}: {op['phase']} {op.get('percent', '')}", flush=True)
                last = op["phase"]
            if op["status"] != "running":
                return op
            time.sleep(1)
        raise TimeoutError(f"op {op['kind']} still running after {timeout}s")

    def run(self, sql: str, lesson: str | None = None) -> dict:
        status, body = self.call("POST", "/api/learn/sql/run", {"sql": sql, **({"lessonId": lesson} if lesson else {})})
        assert status == 200, (status, body)
        return body["run"]


def docker_lines(*args: str) -> list[str]:
    out = subprocess.run(["docker", *args], capture_output=True, text=True)
    return [line for line in out.stdout.split() if line]


def lessons_from_source() -> list[dict]:
    """Lesson ids/titles/solutions/starters, read through Node from the TypeScript source (single source of truth)."""
    script = (
        "const { SQL_LESSONS } = await import(process.argv[1]);"
        "console.log(JSON.stringify(SQL_LESSONS.map((l) => ({ id: l.id, title: l.title, solution: l.solution, starter: l.starter, kind: l.check.kind }))));"
    )
    out = subprocess.run(
        ["node", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--disable-warning=ExperimentalWarning", "--import", "./tests/ts-resolve.mjs",
         "--input-type=module", "-e", script, str(ROOT / "src/lib/learn/sql/lessons.ts")],
        cwd=ROOT, capture_output=True, text=True, check=True,
    )
    return json.loads(out.stdout)


def wait_workspace(page: Page, timeout_s: float, statuses: list[str]) -> bool:
    """Waits for the lesson list, recording every distinct role=status text seen meanwhile."""
    deadline = time.monotonic() + timeout_s
    nav = page.locator('nav[aria-label="Lessons"]')
    while time.monotonic() < deadline:
        if nav.count() and nav.is_visible():
            return True
        for text in page.locator('[role="status"]').all_inner_texts():
            text = text.strip()
            if text and (not statuses or statuses[-1] != text):
                statuses.append(text)
        time.sleep(0.5)
    return False


def editor(page: Page):
    return page.get_by_label("SQL editor")


def status_text(page: Page) -> str:
    return page.locator('[data-agent-region="learn-status"]').inner_text().strip()


def wait_status(page: Page, prefix: str, timeout_ms: int = 30_000) -> str:
    page.wait_for_function(
        "(p) => (document.querySelector('[data-agent-region=\"learn-status\"]')?.textContent ?? '').startsWith(p)", arg=prefix, timeout=timeout_ms,
    )
    return status_text(page)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=default_host())
    parser.add_argument("--hold", action="store_true", help="before cleanup, keep server + database up until Enter")
    parser.add_argument("--remove-image", action="store_true")
    parser.add_argument("--shots", default=str(ROOT / ".tmp" / "learn-db-e2e"))
    args = parser.parse_args()
    if not args.host:
        print("Need --host (the Tailscale/LAN address; a container cannot reach loopback).")
        return 2
    shots = Path(args.shots)
    shots.mkdir(parents=True, exist_ok=True)

    prefix = f"sk-e2e-{os.getpid()}"
    project = f"{prefix}-{SERVICE}"
    lessons = lessons_from_source()
    server = ScratchServer(host=args.host)
    url = server.start(env={"KNIFE_SIDECAR_PREFIX": prefix}, overlay=OVERLAY)
    api = Api(url)
    print(f"scratch server {url}, data dir {server.data_dir}, compose project {project}, {len(lessons)} lessons", flush=True)
    console: list[str] = []
    try:
        status, body = api.call("GET", f"/api/services/{SERVICE}")
        svc = body["service"]
        check("status before install: runtime ok, not installed", status == 200 and svc["runtime"]["ok"] and not svc["installed"], json.dumps(svc["runtime"]))
        status, body = api.call("POST", "/api/learn/sql/run", {"sql": "SELECT 1"})
        check("run before install: 409 not_installed", status == 409 and body.get("code") == "not_installed", str(body))
        req = urllib.request.Request(url + "/api/learn/sql/run", data=b'{"sql":"SELECT 1"}', method="POST", headers={"Content-Type": "application/json", "Origin": "http://evil.example"})
        try:
            urllib.request.urlopen(req, timeout=10)
            check("run refused from a foreign Origin", False)
        except urllib.error.HTTPError as err:
            check("run refused from a foreign Origin", err.code == 403, str(err.code))
        req = urllib.request.Request(url + "/api/learn/sql/run", data=b'{"sql":"SELECT 1"}', method="POST", headers={"Content-Type": "text/plain", "Origin": url})
        try:
            urllib.request.urlopen(req, timeout=10)
            check("run refused with a non-JSON body (415)", False)
        except urllib.error.HTTPError as err:
            check("run refused with a non-JSON body (415)", err.code == 415, str(err.code))

        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            page = browser.new_page(viewport={"width": 1500, "height": 1000})
            page.on("console", lambda m: console.append(f"{m.type}: {m.text}") if m.type == "error" else None)

            # ------------------------------------------------------------ install from the course page
            page.goto(f"{url}/tools/db-course", wait_until="networkidle")
            install = page.get_by_role("button", name="Install course database")
            install.wait_for(timeout=60_000)
            check("course page shows the install card while the database is missing", install.is_visible())
            page.screenshot(path=str(shots / "01-install-card.png"), full_page=True)
            t0 = time.monotonic()
            install.click()
            statuses: list[str] = []
            ready = wait_workspace(page, 900, statuses)
            METRICS["install_to_lessons_s"] = round(time.monotonic() - t0, 1)
            check("install -> start -> seed -> lessons appear", ready, f"{METRICS['install_to_lessons_s']} s")
            check("progress was shown as role=status text meanwhile", any(s for s in statuses), " | ".join(statuses[:6]))
            if not ready:
                page.screenshot(path=str(shots / "01b-stuck.png"), full_page=True)
                print(server.log_tail())
                return 1
            page.screenshot(path=str(shots / "02-workspace.png"), full_page=True)

            status, body = api.call("GET", f"/api/services/{SERVICE}")
            svc = body["service"]
            check("sidecar installed, running, healthy (postgres probe)", svc["installed"] and svc["ready"] and svc["container"]["state"] == "running", json.dumps(svc["container"]))
            names = docker_lines("ps", "-a", "--filter", f"label=com.docker.compose.project={project}", "--format", "{{.Names}}")
            check("exactly one container in the e2e compose project", len(names) == 1, str(names))
            ports = subprocess.run(["docker", "port", names[0]], capture_output=True, text=True).stdout.strip() if names else ""
            check("port bound to the scratch host only, not 0.0.0.0", args.host in ports and "0.0.0.0" not in ports, ports)
            state_dir = Path(server.data_dir) / "services" / SERVICE
            secrets_mode = oct((state_dir / "secrets.env").stat().st_mode & 0o777)
            check("secrets.env is private (600) and not in compose.yaml", secrets_mode == "0o600" and "PASSWORD=" not in (state_dir / "compose.yaml").read_text(), secrets_mode)

            # ------------------------------------------------------------ every lesson's reference solution
            failures = []
            starter_passes = []
            t_all = time.monotonic()
            for lesson in lessons:
                status, body = api.call("POST", "/api/learn/sql/check", {"lessonId": lesson["id"], "sql": lesson["solution"]})
                if status != 200 or not body.get("pass"):
                    failures.append(f"{lesson['id']}: {status} {body.get('message') or body.get('error')}")
                if lesson["starter"].strip():
                    status, body = api.call("POST", "/api/learn/sql/check", {"lessonId": lesson["id"], "sql": lesson["starter"]})
                    if status == 200 and body.get("pass"):
                        starter_passes.append(lesson["id"])
            METRICS["check_all_lessons_s"] = round(time.monotonic() - t_all, 1)
            check(f"every reference solution passes its own check ({len(lessons)} lessons)", not failures, "; ".join(failures[:5]))
            check("no starter query passes as is", not starter_passes, ", ".join(starter_passes))
            status, body = api.call("POST", "/api/learn/sql/check", {"lessonId": "no-such-lesson", "sql": "SELECT 1"})
            check("unknown lesson -> 404", status == 404, str(status))
            status, body = api.call("GET", "/api/learn/progress?course=sql")
            done = sum(1 for entry in body["progress"]["lessons"].values() if entry.get("completedAt"))
            check("the sweep recorded progress for every lesson", done == len(lessons), f"{done} done")
            status, body = api.call("POST", "/api/learn/progress", {"action": "reset-course", "course": "sql"})
            check("reset-course forgets the course progress", status == 200 and body["progress"] == {"lessons": {}}, str(body)[:120])

            # ------------------------------------------------------------ the learner sandbox
            run = api.run("COMMIT")
            check("COMMIT is refused before reaching the database", (run["error"] or {}).get("code") == "knife_refused", str(run["error"]))
            run = api.run("UPDATE products SET price = 0.01; SELECT min(price) AS p FROM products")
            check("a write is visible inside its own run", not run["error"] and run["results"][-1]["rows"] == [["0.01"]], str(run["results"][-1:]))
            run = api.run("SELECT min(price) AS p FROM products")
            check("...and rolled back afterwards (data never drifts)", run["results"][0]["rows"] == [["2.40"]], str(run["results"]))
            run = api.run("SELECT current_user, current_setting('search_path')")
            check("queries run as the low-privilege learner role", run["results"][0]["rows"][0][0] == "knife_learner", str(run["results"][0]["rows"]))
            for sql, expect in [
                ("SELECT pg_read_file('/etc/hostname')", "42501"),
                ("SELECT * FROM pg_authid", "42501"),
                ("CREATE INDEX ON events (customer_id)", "42501"),
                ("INSERT INTO geo.chains VALUES (99, 'X', 'y')", "42501"),
                ("SELECT * FROM knife_admin.meta", "42501"),
            ]:
                run = api.run(sql)
                check(f"privileges: {sql[:40]} -> {expect}", (run["error"] or {}).get("code") == expect, str(run["error"]))
            t1 = time.monotonic()
            run = api.run("SELECT pg_sleep(10)")
            took = time.monotonic() - t1
            check("statement time limit (~5 s)", (run["error"] or {}).get("code") == "57014" and took < 8, f"{took:.1f} s {run['error']}")
            t1 = time.monotonic()
            run = api.run("SELECT set_config('statement_timeout', '0', true); SELECT pg_sleep(15)")
            took = time.monotonic() - t1
            check("a learner who switches the limit off is still stopped (backend terminated)", run["error"] is not None and took < 10, f"{took:.1f} s {run['error']}")
            run = api.run("SELECT g FROM generate_series(1, 2000000) AS g")
            check("row cap: first 500 rows, flagged truncated", len(run["results"][0]["rows"]) == 500 and run["results"][0]["truncated"], str(len(run["results"][0]["rows"])))
            run = api.run("SELECT 1;\nSELECT nme FROM products")
            check("error position is mapped to line/column of the learner's text", (run["error"] or {}).get("position", {}).get("line") == 2 and run["error"]["position"]["column"] == 8, str(run["error"]))
            status, body = api.call("GET", "/api/learn/sql/schema")
            tables = {f"{t['schema']}.{t['name']}": t for t in body.get("tables", [])}
            geom = next((c for c in tables.get("geo.stores", {}).get("columns", []) if c["name"] == "geom"), None)
            check("schema browser lists both schemas with PostGIS types", {"shop.orders", "shop.events", "geo.stores", "geo.population_grid"} <= set(tables) and geom and geom["type"] == "geometry(Point,4326)", str(sorted(tables))[:200])

            # ------------------------------------------------------------ lesson 1 in the page: wrong, hint, right
            page.reload(wait_until="networkidle")
            wait_workspace(page, 120, [])
            page.locator('nav[aria-label="Lessons"]').get_by_role("button", name="Your first SELECT").click()
            box = editor(page)
            box.fill("SELECT name FROM categories;")
            page.get_by_role("button", name="Check", exact=True).click()
            wait_status(page, "Check failed.")
            feedback = page.locator('[data-agent-region="learn-check"]').inner_text()
            check("wrong answer: 'Not yet' with a column explanation", "Not yet" in feedback and "Expected 3 columns" in feedback, feedback[:200])
            solution_btn = page.get_by_role("button", name="Show solution")
            check("Show solution unlocks after a failed check", solution_btn.is_enabled())
            page.get_by_role("button", name="Hint (1 of 3)").click()
            page.get_by_text("Hint 1:").wait_for(timeout=10_000)
            check("progressive hint 1 shown, button moves to hint 2", page.get_by_role("button", name="Hint (2 of 3)").is_visible())
            box.fill("SELECT * FROM categories;")
            box.press("Control+Enter")
            ran = wait_status(page, "Ran in")
            rows = page.locator('[data-agent-region="learn-sql-results"] tbody tr').count()
            check("Ctrl+Enter runs the query: 11 category rows", rows == 11, f"{ran}, {rows} rows")
            page.get_by_role("button", name="Check", exact=True).click()
            wait_status(page, "Check passed.")
            feedback = page.locator('[data-agent-region="learn-check"]').inner_text()
            check("right answer: 'Correct!'", "Correct!" in feedback, feedback[:120])
            check("progress counter moves to 1 done", page.get_by_text(f"1 of {len(lessons)} lessons done").is_visible())
            page.screenshot(path=str(shots / "03-lesson1-correct.png"), full_page=True)

            page.reload(wait_until="networkidle")
            wait_workspace(page, 120, [])
            done_item = page.locator('nav[aria-label="Lessons"]').get_by_role("button", name="Your first SELECT (done)")
            check("after reload: lesson 1 is marked done", done_item.count() == 1)
            check("after reload: counter still 1 done", page.get_by_text(f"1 of {len(lessons)} lessons done").is_visible())
            check("after reload: lesson 1 is current and its last query is back", editor(page).input_value() == "SELECT * FROM categories;", editor(page).input_value())
            files = list((Path(server.data_dir) / "learn").glob("*.json"))
            saved = json.loads(files[0].read_text()) if files else {}
            entry = saved.get("courses", {}).get("sql", {}).get("lessons", {}).get("select-all", {})
            check("progress file in the data dir (600) records completion, attempts, hints", bool(files) and oct(files[0].stat().st_mode & 0o777) == "0o600" and entry.get("completedAt") and entry.get("hintsShown") == 1 and entry.get("failedChecks") == 1, json.dumps(entry)[:200])

            # error position in the page
            page.get_by_role("button", name="Pick columns and rename them").click()
            editor(page).fill("SELECT nme FROM products")
            page.get_by_role("button", name="Run", exact=True).click()
            wait_status(page, "Query failed")
            err = page.locator('[data-agent-region="learn-sql-error"]').inner_text()
            check("typo: error names the column and its position", 'column "nme" does not exist' in err and "line 1, column 8" in err, err[:160])
            page.get_by_role("button", name="Reset query").click()
            wait_status(page, "Query reset")
            check("Reset query brings the starter back", editor(page).input_value().startswith("SELECT\nFROM products"), editor(page).input_value())
            page.screenshot(path=str(shots / "04-error-position.png"), full_page=True)

            # ------------------------------------------------------------ tutor tools (widget/MCP surface)
            def tool(name: str, args: dict) -> dict:
                status, body = api.call("POST", "/api/agent/tool", {"name": name, "args": args})
                return json.loads(body["content"]) if status == 200 and body.get("ok") else {"_error": body}
            listing = tool("knife_learn_lessons", {})
            check("knife_learn_lessons: progress and current lesson", listing.get("done") == 1 and listing.get("current") == "select-columns" and listing.get("total") == len(lessons), json.dumps(listing)[:160])
            current = tool("knife_learn_lesson", {"lessonId": "select-all"})
            check("knife_learn_lesson: learner state, no solution unless asked", current.get("learner", {}).get("lastQuery") == "SELECT * FROM categories;" and "solution" not in current and len(current.get("hintsOpened", [])) == 1, json.dumps(current)[:200])
            check("knife_learn_lesson revealSolution returns it", tool("knife_learn_lesson", {"lessonId": "select-all", "revealSolution": True}).get("solution") == "SELECT * FROM categories;")
            tried = tool("knife_learn_run", {"sql": "SELECT name FROM chains ORDER BY chain_id"})
            check("knife_learn_run runs in the sandbox", tried.get("results", [{}])[0].get("rows", [[None]])[0] == ["FreshMart"], json.dumps(tried)[:160])

            # ------------------------------------------------------------ lazy start after a stop
            status, body = api.call("POST", f"/api/services/{SERVICE}", {"action": "stop"})
            op = api.wait_op(body["op"], 120)
            check("stop op done", op["status"] == "done", op.get("error") or op["phase"])
            status, body = api.call("POST", "/api/learn/sql/run", {"sql": "SELECT 1"})
            check("run while stopped: 409 not_running", status == 409 and body.get("code") == "not_running", str(body))
            t2 = time.monotonic()
            page.goto(f"{url}/tools/db-course", wait_until="domcontentloaded")
            statuses = []
            ready = wait_workspace(page, 180, statuses)
            METRICS["lazy_start_s"] = round(time.monotonic() - t2, 1)
            check("opening the course starts the stopped database (lazy start)", ready and any("Starting the course database" in s for s in statuses), f"{METRICS['lazy_start_s']} s; {' | '.join(statuses[:4])}")
            run = api.run("SELECT count(*) FROM orders")
            check("course data survived stop/start (named volume)", run["results"][0]["rows"] == [[1200]], str(run["results"]))
            status, body = api.call("POST", "/api/learn/sql/setup", {"force": True})
            check("Rebuild course data (force seed) works", status == 200 and body["seed"]["built"], str(body))
            METRICS["seed_ms"] = body.get("seed", {}).get("ms")
            browser.close()

        check("no console errors on the course page", not console, "; ".join(console[:3]))
        if args.hold:
            input(f"Holding {url} (project {project}); press Enter to clean up… ")
    finally:
        status, body = api.call("POST", f"/api/services/{SERVICE}", {"action": "remove", "purge": True, **({"removeImage": True} if args.remove_image else {})})
        if status == 202:
            try:
                op = api.wait_op(body["op"], 300)
                check("remove + purge op done", op["status"] == "done", op.get("error") or op["phase"])
            except TimeoutError as err:
                check("remove + purge op done", False, str(err))
        if status != 202:
            check("remove + purge accepted", False, str(body)[:200])
        # Backstop when the API could not clean up: only this run's own project label is ever touched.
        for name in docker_lines("ps", "-a", "--filter", f"label=com.docker.compose.project={project}", "--format", "{{.Names}}"):
            if name.startswith(prefix):
                subprocess.run(["docker", "rm", "-f", name], capture_output=True)
        for kind in ("volume", "network"):
            for name in docker_lines(kind, "ls", "--filter", f"label=com.docker.compose.project={project}", "--format", "{{.Name}}"):
                if name.startswith(prefix):
                    subprocess.run(["docker", kind, "rm", name], capture_output=True)
        left = docker_lines("ps", "-a", "--filter", f"label=com.docker.compose.project={project}", "--format", "{{.Names}}")
        volumes = docker_lines("volume", "ls", "--filter", f"label=com.docker.compose.project={project}", "--format", "{{.Name}}")
        check("no container or volume of the e2e project left", not left and not volumes, f"{left} {volumes}")
        server.stop()

    failed = [name for name, ok, _ in RESULTS if not ok]
    print(f"\nmetrics: {json.dumps(METRICS)}")
    print(f"{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    if failed:
        print(f"{len(failed)} FAILED: {failed}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
