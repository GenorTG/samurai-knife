#!/usr/bin/env python3
"""Can the AI agent drive every tool and tab? Drives the REAL widget with the REAL provider.

Usage (never the live server):
  python3 tests/agent_coverage_e2e.py [--group docs] [--only slug[:tab] ...]
      [--model deepseek-v4-flash] [--concurrency 2] [--retry 1] [--out report.json] [--list]
  # Or pass an existing scratch URL as the first argument.
The API key is read at runtime by tests/real_provider.py and never printed or written.
"""
import argparse
import json
import statistics
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from tests.coverage.core import GROUPS, all_targets, group_of, load_cases, run_case  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
_server = None


def stop_scratch_server() -> None:
    if _server is not None:
        _server.stop()


def start_scratch_server(in_place: bool = False) -> str:
    """Own isolated server (worktree + data dir + free port), removed on exit; see tests/scratch_server.py."""
    global _server
    from tests.scratch_server import ScratchServer
    _server = ScratchServer(in_place=in_place)
    url = _server.start()
    print(f"Started isolated scratch server at {url}", flush=True)
    return url


def scrub(text: str) -> str:
    try:
        from real_provider import _read_key
        key = _read_key()
    except Exception:
        return text
    return text.replace(key, "[redacted]") if key else text


def select(cases, skips, args):
    groups = tuple(args.group) if args.group else GROUPS
    chosen = [c for c in cases if group_of(c) in groups]
    if args.only:
        wanted = set(args.only)
        chosen = [c for c in chosen if c.key in wanted or c.slug in wanted]
    return chosen


def run_shard(args, cases) -> list[dict]:
    from playwright.sync_api import sync_playwright
    out = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        for i, case in enumerate(cases, 1):
            rec = run_case(browser, args.base, case)
            rec["attempt"] = 1
            if not rec["pass"] and args.retry > 0:
                first = rec
                rec = run_case(browser, args.base, case)
                rec["attempt"] = 2
                rec["first_attempt"] = first
            print(f"[{i}/{len(cases)}] {'PASS' if rec['pass'] else 'FAIL'} {case.key} rounds={rec['rounds']} "
                  f"calls={rec['tool_calls']} {rec['wall_s']}s {scrub(rec['reason'])[:100]}", flush=True)
            out.append(rec)
        browser.close()
    return out


def summarize(results, skips, targets, covered_keys=()) -> dict:
    by_group: dict[str, dict] = {}
    for r in results:
        g = by_group.setdefault(r["group"], {"total": 0, "passed": 0, "rounds": []})
        g["total"] += 1
        g["passed"] += r["pass"]
        if r["pass"]:
            g["rounds"].append(r["rounds"])
    for g in by_group.values():
        g["median_rounds"] = statistics.median(g.pop("rounds")) if g["rounds"] else None
    covered = {r["key"] for r in results} | set(covered_keys)
    skipped = {(f"{s}:{t}" if t else s): why for (s, t), why in skips.items()}
    missing = [f"{s}:{t}" if t else s for s, t in targets if (f"{s}:{t}" if t else s) not in covered and (f"{s}:{t}" if t else s) not in skipped]
    return {"groups": by_group, "not_drivable": skipped, "no_case_defined": missing}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("base", nargs="?", help="existing scratch app URL; omitted to start an isolated server")
    ap.add_argument("--group", action="append", choices=GROUPS)
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--in-place", action="store_true", help="start the scratch server in this checkout instead of a throwaway worktree (only when nothing else runs from it)")
    ap.add_argument("--model", default="deepseek-v4-flash")
    ap.add_argument("--concurrency", type=int, default=2)
    ap.add_argument("--retry", type=int, default=1)
    ap.add_argument("--out", default="coverage_report.json")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--shard", help=argparse.SUPPRESS)
    ap.add_argument("--no-configure", action="store_true", help=argparse.SUPPRESS)
    args = ap.parse_args()
    args.base = (args.base or "").rstrip("/")

    cases, skips = load_cases()
    chosen = select(cases, skips, args)
    targets = all_targets()
    if args.list:
        for c in chosen:
            print(f"{group_of(c):9} {c.key}")
        info = summarize([], skips, targets, [c.key for c in cases])
        print("not drivable:", len(info["not_drivable"]), "| no case yet:", len(info["no_case_defined"]), info["no_case_defined"])
        return 0

    if not args.base:
        args.base = start_scratch_server(args.in_place)

    if args.shard:
        i, n = (int(x) for x in args.shard.split("/"))
        results = run_shard(args, chosen[i::n])
        Path(args.out).write_text(json.dumps(results))
        return 0

    from real_provider import configure
    configure(args.base, args.model)
    if args.concurrency <= 1 or len(chosen) <= 1:
        results = run_shard(args, chosen)
    else:
        n = min(args.concurrency, len(chosen))
        tmp = Path(tempfile.mkdtemp(prefix="skcov-"))
        procs = []
        for i in range(n):
            cmd = [sys.executable, __file__, args.base, "--shard", f"{i}/{n}", "--out", str(tmp / f"{i}.json"), "--retry", str(args.retry)]
            for g in args.group or []:
                cmd += ["--group", g]
            if args.only:
                cmd += ["--only", *args.only]
            procs.append(subprocess.Popen(cmd))
        for p in procs:
            p.wait()
        results = []
        for i in range(n):
            f = tmp / f"{i}.json"
            if f.exists():
                results += json.loads(f.read_text())
                f.unlink()
        tmp.rmdir()

    report = {"model": args.model, "summary": summarize(results, skips, targets), "results": results}
    Path(args.out).write_text(scrub(json.dumps(report, indent=2)))
    s = report["summary"]
    print("\n== coverage ==")
    for g, v in s["groups"].items():
        print(f"{g:9} {v['passed']}/{v['total']} pass, median rounds {v['median_rounds']}")
    print("not drivable:", len(s["not_drivable"]), "| no case defined:", len(s["no_case_defined"]))
    for r in results:
        if not r["pass"]:
            print("FAIL", r["key"], "-", scrub(r["reason"])[:140])
    return 0 if all(r["pass"] for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
