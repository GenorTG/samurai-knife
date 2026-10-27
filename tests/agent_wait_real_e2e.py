#!/usr/bin/env python3
"""Real provider: for the user's OWN file the agent opens the tool and waits instead of faking data.

SCRATCH server only:  python3 tests/agent_wait_real_e2e.py http://127.0.0.1:3243 [--model deepseek-v4.1-flash]
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright  # noqa: E402
from real_provider import configure  # noqa: E402

PROMPTS = [
    "I want to compress my own PDF. Set up the right tool and let me pick the file.",
    "I have a CSV export of my own that I need to profile. Open the right tool for it; I will give you the file.",
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("--model", default="deepseek-v4.1-flash")
    args = ap.parse_args()
    configure(args.base, args.model)
    failed = 0
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        for prompt in PROMPTS:
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            page.goto(args.base + "/", wait_until="networkidle")
            page.keyboard.press("Control+j")
            box = page.locator("textarea[aria-label='Message the assistant']")
            box.wait_for()
            box.fill(prompt)
            box.press("Enter")
            try:
                page.wait_for_selector("[data-agent-wait]", timeout=120_000)
                msgs = page.evaluate("fetch('/api/agent/conversation').then(r => r.json()).then(c => c.messages)")
                calls = [c["function"]["name"] for m in msgs if m["role"] == "assistant" for c in m.get("tool_calls", [])]
                card = page.locator("[data-agent-wait]").inner_text().replace("\n", " ")
                pulsing = page.locator("[data-agent-await]").count()
                ok = "wait_for_user" in calls and "upload_file" not in calls and page.url != args.base + "/"
                print(f"{'ok  ' if ok else 'FAIL'} calls={calls} url={page.url.replace(args.base, '')} pulsing_control={pulsing}\n       card: {card[:160]}")
                failed += not ok
            except Exception as exc:
                msgs = page.evaluate("fetch('/api/agent/conversation').then(r => r.json()).then(c => c.messages)")
                last = next((m.get("content") for m in reversed(msgs) if m["role"] == "assistant" and m.get("content")), "")
                print(f"FAIL never waited ({type(exc).__name__}); last assistant text: {str(last)[:200]!r}")
                failed += 1
            page.close()
        browser.close()
    print(f"\n{len(PROMPTS) - failed}/{len(PROMPTS)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
