#!/usr/bin/env python3
"""Run every Samurai Knife suite that needs no provider key, on servers this runner owns. One command, one table, exit 1 on any failure.

    python3 tests/run_all.py                 # static checks + unit + every e2e/functional suite (mock provider), ~60-90 min
    python3 tests/run_all.py --list          # what would run
    python3 tests/run_all.py --only unit,smoke,accounts --skip offload_text
    python3 tests/run_all.py --real          # + the real-model suites (needs KNIFE_REAL_ACCOUNT, default `openclaw`; spends quota)
    python3 tests/run_all.py --full-hydration --out .tmp/run-today

Ownership (docs/TESTING.md): the runner starts a throwaway server (worktree of the current tree + temp data dir + free port, see
tests/scratch_server.py) and the scripted mock provider, restarts the server with a FRESH data dir before every suite that needs one,
and stops/deletes only what it started. It never touches the live instance (:3210, PM2) or its data. The exit code of each suite is
what counts (nothing is piped through `tail`); a suite that exits 0 but whose output ends with a failure summary is flagged SUSPECT.

The AI-coverage run (tests/agent_coverage_e2e.py, real model, ~115 cases) is separate on purpose: it is long and spends quota.
"""
from __future__ import annotations

import argparse
import atexit
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.scratch_server import ScratchServer, free_port  # noqa: E402

VENV_PY = os.environ.get("KNIFE_PYTHON") or str(ROOT.parent / "samurai-knife-py" / "venv" / "bin" / "python")
# Only the closing summary lines count (a passing check can be NAMED "5 failures then 429"): "3 FAILED: [...]", "1 failure(s)", "FAILED (2)".
SUSPECT = re.compile(r"^\s*(?:[1-9]\d* (?:FAILED|failures?|failure\(s\))\b|FAILED\b)", re.MULTILINE | re.IGNORECASE)


@dataclass
class Suite:
    name: str
    argv: list[str]
    kind: str = "server"          # "static" (no server), "server" (fresh server per suite), "queue" (server with the queue env)
    mock: bool = False             # needs the scripted mock provider ({mock})
    data_env: bool = False         # also needs KNIFE_DATA_DIR={data} in the SUITE's environment (it edits accounts through the CLI)
    timeout: int = 1200
    real: bool = False
    env: dict[str, str] = field(default_factory=dict)


def py(script: str, *args: str) -> list[str]:
    return ["python3", script, *args]


def venv(script: str, *args: str) -> list[str]:
    return [VENV_PY, script, *args]


F = "tests/functional"
SUITES: list[Suite] = [
    Suite("tsc", ["npx", "tsc", "--noEmit"], "static", timeout=600),
    Suite("lint", ["npm", "run", "lint"], "static", timeout=600),
    Suite("unit", ["npm", "run", "test:unit"], "static", timeout=600),
    Suite("nosql_snippets", py("tests/nosql_snippets_e2e.py"), "static"),
    Suite("cv_docx", venv("tests/cv_docx_test.py"), "static"),
    Suite("smoke", py("tests/smoke_sweep.py", "{url}")),
    Suite("hydration", py("tests/hydration_e2e.py", "{url}", "--quick"), timeout=1500),
    Suite("shell_overlay", py("tests/shell_overlay_e2e.py", "{url}")),
    Suite("mcp_base_tools", py("tests/mcp_base_tools_e2e.py", "{url}")),
    Suite("ui_bridge", py("tests/ui_bridge_e2e.py", "{url}")),
    Suite("sql_tools", py("tests/sql_tools_e2e.py", "{url}")),
    Suite("nosql_tools", py("tests/nosql_tools_e2e.py", "{url}")),
    Suite("sql_engine", venv("tests/sql_engine_e2e.py", "{url}"), timeout=2400),
    Suite("pdf_api", venv("tests/pdf_api_e2e.py", "{url}"), timeout=1200),
    # Real OCRmyPDF/Tesseract on generated scans; needs the worker venv plus tesseract eng+pol+osd.
    Suite("pdf_ocr", venv("tests/pdf_ocr_test.py"), "static", timeout=900),
    Suite("pdf_ocr_api", venv("tests/pdf_ocr_api_e2e.py"), timeout=1200),
    Suite("f_docs", py(f"{F}/docs_e2e.py", "{url}"), timeout=1800),
    Suite("f_searchable", py(f"{F}/pdf_searchable_e2e.py", "{url}"), timeout=1800),
    Suite("f_media", py(f"{F}/media_e2e.py", "{url}"), timeout=1800),
    Suite("f_data", py(f"{F}/data_e2e.py", "{url}"), timeout=1800),
    Suite("f_css_time", py(f"{F}/css_time_e2e.py", "{url}"), timeout=1800),
    Suite("f_web", py(f"{F}/web_e2e.py", "{url}"), timeout=1800),
    Suite("f_cv_studio", py(f"{F}/cv_studio_e2e.py", "{url}"), timeout=1200),
    Suite("cv_photo", py("tests/cv_photo_e2e.py", "{url}")),
    Suite("f_sql_lab", py(f"{F}/sql_lab_e2e.py", "{url}"), timeout=1500),
    Suite("f_nosql_lab", py(f"{F}/nosql_lab_e2e.py", "{url}"), timeout=1200),
    Suite("offload", py(f"{F}/offload_e2e.py", "{url}"), timeout=2400),
    Suite("offload_json", py(f"{F}/offload_json_e2e.py", "{url}"), timeout=2400),
    Suite("offload_text", py(f"{F}/offload_text_e2e.py", "{url}"), timeout=3600),
    Suite("accounts", py("tests/accounts_api_e2e.py", "{url}", "{mock}"), mock=True, data_env=True),
    # Self-contained: starts its own public-mode scratch server (KNIFE_AUTH_MODE=public, outbox mail).
    Suite("accounts_public", py(f"{F}/accounts_public_e2e.py"), "static", timeout=1200),
    Suite("ui_gaps", py("tests/ui_gaps_e2e.py", "{url}", "{mock}"), mock=True, data_env=True),
    Suite("agent_widget", py("tests/agent_widget_e2e.py", "{url}", "{mock}"), mock=True, timeout=1500),
    Suite("agent_responses", py("tests/agent_responses_e2e.py", "{url}"), timeout=900),
    Suite("agent_trust_modes", py("tests/agent_trust_modes_e2e.py", "{url}", "{mock}"), mock=True, timeout=1500),
    Suite("agent_interaction", py("tests/agent_interaction_e2e.py", "{url}", "{mock}"), mock=True, timeout=1500),
    Suite("agent_chain", py("tests/agent_chain_e2e.py", "{url}", "{mock}"), mock=True, timeout=1500),
    Suite("agent_runtime", py("tests/agent_runtime_e2e.py", "{url}", "{mock}"), mock=True, timeout=1800),
    Suite("agent_usage", py("tests/agent_usage_e2e.py", "{url}", "{mock}"), mock=True),
    Suite("agent_wait_for", py("tests/agent_wait_for_e2e.py", "{url}", "{mock}"), mock=True),
    Suite("agent_toolgroups", py("tests/agent_toolgroups_e2e.py", "{url}", "{mock}"), mock=True),
    Suite("shell_agent", py("tests/shell_agent_e2e.py", "{url}", "{mock}"), mock=True),
    Suite("cv_ui_agent", py("tests/cv_ui_agent_e2e.py", "{url}", "{mock}"), mock=True),
    Suite("cv_agent_anywhere", py("tests/cv_agent_anywhere_e2e.py", "{url}", "{mock}"), mock=True),
    Suite("queue", venv("tests/queue_e2e.py", "{url}"), "queue", data_env=True, timeout=1200),
    Suite("pdf_queue_ui", py(f"{F}/pdf_queue_ui_e2e.py", "{url}"), "queue", timeout=900),
    # real model (opt-in): the harness copies the account's provider from the live accounts file, read-only
    Suite("real_probe", py("tests/gateway_probe.py"), "static", real=True, timeout=600),
    Suite("real_advice", py("tests/agent_advice_e2e.py", "{url}"), real=True),
    Suite("real_chain", py("tests/agent_chain_real_e2e.py", "{url}"), real=True, timeout=1800),
    Suite("real_sql", py("tests/agent_sql_real_e2e.py", "{url}"), real=True, timeout=2400),
    Suite("real_ocr_chain", py("tests/agent_ocr_chain_real_e2e.py", "{url}", "--runs", "1"), real=True, timeout=1800),
    Suite("real_wait", py("tests/agent_wait_real_e2e.py", "{url}"), real=True, timeout=1800),
    Suite("real_responses", py("tests/agent_responses_real_e2e.py", "{url}"), real=True, timeout=1800),
    Suite("real_cv", py("tests/cv_agent_real_e2e.py", "{url}"), real=True, timeout=1800),
]


class Mock:
    """The scripted OpenAI-compatible provider (tests/mock_provider.mjs, key `mock-key`)."""

    def __init__(self) -> None:
        self.proc: subprocess.Popen[bytes] | None = None
        self.url = ""
        atexit.register(self.stop)

    def start(self) -> str:
        if self.proc is None:
            port = free_port()
            self.proc = subprocess.Popen(["node", "tests/mock_provider.mjs", str(port)], cwd=ROOT, stdout=subprocess.DEVNULL,
                                         stderr=subprocess.DEVNULL, start_new_session=True)
            self.url = f"http://127.0.0.1:{port}"
            for _ in range(60):
                try:
                    urllib.request.urlopen(self.url + "/__stats", timeout=1)
                    break
                except OSError:
                    time.sleep(0.25)
        return self.url

    def reset(self) -> None:
        try:
            urllib.request.urlopen(urllib.request.Request(self.url + "/__stats", method="DELETE"), timeout=5)  # cumulative peak counters
        except OSError:
            pass

    def stop(self) -> None:
        proc, self.proc = self.proc, None
        if proc is not None:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
                proc.wait(timeout=10)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                pass


def select(args: argparse.Namespace) -> list[Suite]:
    only = {s for s in (args.only or "").split(",") if s}
    skip = {s for s in (args.skip or "").split(",") if s}
    chosen = []
    for suite in SUITES:
        if suite.real and not (args.real or only & {suite.name}):
            continue
        if only and suite.name not in only and not any(suite.name.startswith(o) for o in only):
            continue
        if suite.name in skip:
            continue
        chosen.append(suite)
    unknown = [o for o in only if not any(s.name == o or s.name.startswith(o) for s in SUITES)]
    if unknown:
        sys.exit(f"unknown suite(s): {', '.join(unknown)} (see --list)")
    return chosen


def run_suite(suite: Suite, server: ScratchServer | None, mock: Mock, out_dir: Path, args: argparse.Namespace) -> dict[str, object]:
    env = os.environ.copy()
    env.setdefault("KNIFE_PYTHON", VENV_PY)  # suites and the server must agree on the engine venv whatever checkout they run from
    url, data, tmp = "", "", None
    if suite.real:
        env.setdefault("KNIFE_REAL_ACCOUNT", "openclaw")
    if suite.kind in ("server", "queue"):
        assert server is not None
        server_env: dict[str, str] = {}
        if suite.kind == "queue":
            tmp = tempfile.mkdtemp(prefix="knife-queue-tmp-")
            server_env = {"TMPDIR": tmp, "KNIFE_PY_LIGHT": "4", "KNIFE_PY_HEAVY": "1", "KNIFE_PY_HEAVY_DEPTH": "8", "KNIFE_JOB_TTL_SEC": "3"}
            env["TMPDIR"] = tmp
        url = server.restart(server_env)
        data = str(server.data_dir)
        if suite.data_env:
            env["KNIFE_DATA_DIR"] = data
    mock_url = mock.start() if suite.mock else ""
    if suite.mock:
        mock.reset()
    argv = [a.format(url=url, mock=mock_url, data=data) for a in suite.argv]
    if suite.name == "hydration" and args.full_hydration:
        argv = [a for a in argv if a != "--quick"]
    log = out_dir / f"{suite.name}.log"
    started = time.monotonic()
    timed_out = False
    with log.open("w") as handle:
        # queue_e2e samples the process table for THIS checkout's python scripts: it must run from the checkout the server runs from
        cwd = server.cwd if (server is not None and suite.kind == "queue") else ROOT
        proc = subprocess.Popen(argv, cwd=cwd, env=env, stdout=handle, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            rc = proc.wait(timeout=suite.timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(proc.pid, signal.SIGKILL)
            rc = proc.wait()
    seconds = time.monotonic() - started
    text = log.read_text(errors="replace")
    tail = "\n".join(text.strip().splitlines()[-25:])
    status = "TIMEOUT" if timed_out else "PASS" if rc == 0 else "FAIL"
    if status == "PASS" and SUSPECT.search("\n".join(tail.splitlines()[-3:])):
        status = "SUSPECT"
    if tmp:
        shutil.rmtree(tmp, ignore_errors=True)
    return {"name": suite.name, "status": status, "rc": rc, "seconds": round(seconds, 1), "log": str(log), "tail": tail if status != "PASS" else ""}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--only", help="comma-separated suite names or prefixes")
    ap.add_argument("--skip", help="comma-separated suite names")
    ap.add_argument("--real", action="store_true", help="also run the real-model suites (spends quota)")
    ap.add_argument("--full-hydration", action="store_true", help="hydration over every page (default: --quick)")
    ap.add_argument("--fail-fast", action="store_true")
    ap.add_argument("--in-place", action="store_true", help="serve this checkout instead of a throwaway worktree (only if nothing else runs from it)")
    ap.add_argument("--out", help="directory for logs and the report (default .tmp/run-all-<timestamp>)")
    args = ap.parse_args()

    chosen = select(args)
    if args.list:
        for s in chosen:
            print(f"{s.name:<22} {s.kind:<7} {'mock ' if s.mock else '     '}{'REAL' if s.real else '    '} {' '.join(s.argv)}")
        print(f"\n{len(chosen)} suites")
        return 0

    out_dir = Path(args.out) if args.out else ROOT / ".tmp" / f"run-all-{time.strftime('%Y%m%d-%H%M%S')}"
    out_dir.mkdir(parents=True, exist_ok=True)
    mock = Mock()
    server = ScratchServer(in_place=args.in_place) if any(s.kind != "static" for s in chosen) else None
    results: list[dict[str, object]] = []
    try:
        for index, suite in enumerate(chosen, 1):
            print(f"[{index}/{len(chosen)}] {suite.name} ...", flush=True)
            result = run_suite(suite, server, mock, out_dir, args)
            results.append(result)
            print(f"[{index}/{len(chosen)}] {suite.name}: {result['status']} in {result['seconds']}s", flush=True)
            if result["status"] != "PASS" and args.fail_fast:
                break
    finally:
        if server is not None:
            server.stop()
        mock.stop()

    lines = ["| suite | result | seconds | log |", "|---|---|---:|---|"]
    lines += [f"| {r['name']} | {r['status']} | {r['seconds']} | {Path(str(r['log'])).name} |" for r in results]
    bad = [r for r in results if r["status"] != "PASS"]
    summary = f"{len(results) - len(bad)}/{len(results)} suites passed" + (f"; NOT PASSED: {', '.join(str(r['name']) for r in bad)}" if bad else "")
    (out_dir / "report.md").write_text("\n".join(lines) + f"\n\n{summary}\n")
    (out_dir / "report.json").write_text(json.dumps(results, indent=2))
    print("\n" + "\n".join(lines) + f"\n\n{summary}\nlogs: {out_dir}")
    for r in bad:
        print(f"\n--- {r['name']} ({r['status']}) tail ---\n{r['tail']}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
