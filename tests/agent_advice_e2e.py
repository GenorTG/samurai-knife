#!/usr/bin/env python3
"""Does the agent answer "what tools exist?" and route "I have X, I need Y" to the right tools?

Real provider, SCRATCH server only (same setup as agent_coverage_e2e.py):
  KNIFE_DATA_DIR=<throwaway> KNIFE_PORT=3243 npm run dev   # then:
  python3 tests/agent_advice_e2e.py http://127.0.0.1:3243 [--model deepseek-v4-flash]
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from tests.coverage.core import Case, Ctx, run_case, used  # noqa: E402


def norm(text: str) -> str:
    """Lower-case and fold typographic quotes: models write isn\u2019t, the oracles compare isn't."""
    return text.lower().replace("\u2019", "'").replace("\u2018", "'")


def mentions(*groups: tuple[str, ...]):
    """Pass when the answer names at least one term from EVERY group (case-insensitive)."""
    def oracle(ctx: Ctx) -> str | None:
        ans = norm(ctx.answer)
        for group in groups:
            if not any(term.lower() in ans for term in group):
                return f"answer never mentions any of {group}: {ctx.answer[:200]!r}"
        return None
    return oracle


def honest_no(ctx: Ctx) -> str | None:
    ans = norm(ctx.answer)
    if used(ctx, "open_tool"):
        return "opened a tool for a request nothing in the toolbox can do"
    if not any(w in ans for w in ("no ", "not ", "don't", "doesn't", "can't", "cannot", "isn't", "n't")):
        return f"did not say plainly that video editing is unsupported: {ctx.answer[:200]!r}"
    return None


CASES = [
    Case("-", None, "What tools do you have for working with PDFs?", mentions(("pdf toolkit", "pdf")), note="catalog question"),
    Case("-", None, "I have a scanned PDF contract. I need the text out of it and then a smaller file to email. Which tools should I use, in what order?",
         mentions(("pdf",), ("ocr", "editor"), ("compress",)), note="multi-step doc routing"),
    Case("-", None, "I have a CSV export with duplicate rows. I want to find the duplicates and then turn the clean data into JSON. What should I use?",
         mentions(("table inspector", "csv-profile", "duplicate"), ("csv workbench", "csv")), note="data routing"),
    Case("-", None, "I have a huge JPG photo. I need it smaller, as webp, plus a favicon from it. Which tool?",
         mentions(("image export", "image-resize")), note="image routing"),
    Case("-", None, "Can you edit and trim videos here?", honest_no, note="honest about gaps"),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("--model", default="deepseek-v4-flash")
    args = ap.parse_args()
    from real_provider import configure
    configure(args.base, args.model)
    from playwright.sync_api import sync_playwright
    failed = 0
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        for case in CASES:
            rec = run_case(browser, args.base, case)
            ok = rec["pass"]
            failed += not ok
            print(f"{'ok  ' if ok else 'FAIL'} {case.note}: calls={rec['calls']} {rec['wall_s']}s {rec['reason'][:140]}")
            print(f"       answer: {rec['answer'][:260]}")
        browser.close()
    print(f"\n{len(CASES) - failed}/{len(CASES)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
