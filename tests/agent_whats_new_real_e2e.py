#!/usr/bin/env python3
"""Does the in-app assistant answer "do you have new tools?" truthfully (src/lib/whats-new.ts, docs/MCP.md "What's new")?

Real provider, own scratch server (tests/scratch_server.py), the same question asked three times in fresh
conversations plus one about the Vercel link: every answer must name the new website/Vercel tools or the version, and
never claim that nothing changed.

  KNIFE_REAL_ACCOUNT=genortg python3 tests/agent_whats_new_real_e2e.py [--model deepseek-v4.1-flash]
"""
import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from tests.coverage.core import Case, Ctx, run_case  # noqa: E402
from tests.scratch_server import ScratchServer  # noqa: E402

NEW = ("vercel", "knife_site_previews", "knife_site_deploy", "preview", "podgląd", "0.13")
DENIAL = re.compile(r"(nie mam (żadnych )?nowych|no new tools|nothing (has )?changed|nic się nie zmieniło|nie ma nowych|brak nowych)", re.I)


def names_new(ctx: Ctx) -> str | None:
    ans = ctx.answer.lower()
    if DENIAL.search(ans) and not any(t in ans for t in ("vercel", "0.13")):
        return f"claimed nothing is new: {ctx.answer[:240]!r}"
    if not any(t in ans for t in NEW):
        return f"never named the new tools or the version: {ctx.answer[:240]!r}"
    return None


def vercel_yes(ctx: Ctx) -> str | None:
    ans = ctx.answer.lower()
    if "vercel" not in ans or not any(t in ans for t in ("preview", "podgląd", "knife_site_deploy", "deploy", "wdroż")):
        return f"did not explain the Vercel preview tools: {ctx.answer[:240]!r}"
    return None


CASES = [
    Case("-", None, "Masz jakieś nowe narzędzia po ostatniej aktualizacji?", names_new, note="new tools (pl) #1", answer_only=True),
    Case("-", None, "Masz jakieś nowe narzędzia po ostatniej aktualizacji?", names_new, note="new tools (pl) #2", answer_only=True),
    Case("-", None, "Do you have any new tools since the last update? What changed?", names_new, note="new tools (en) #3", answer_only=True),
    Case("-", None, "Czy możesz sprawdzać i deployować preview mojej strony na Vercelu z brancha, na którym pracujesz?", vercel_yes, note="vercel capability", answer_only=True),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="deepseek-v4.1-flash")
    args = ap.parse_args()
    from real_provider import configure
    from playwright.sync_api import sync_playwright
    failed = 0
    with ScratchServer() as server:
        server.start()
        configure(server.url, args.model)
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            for case in CASES:
                rec = run_case(browser, server.url, case)
                ok = rec["pass"]
                failed += not ok
                print(f"{'ok  ' if ok else 'FAIL'} {case.note}: calls={rec['calls']} {rec['wall_s']}s {rec['reason'][:160]}")
                print(f"       answer: {rec['answer'][:400]}")
            browser.close()
    print(f"\n{len(CASES) - failed}/{len(CASES)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
