"""Real model + real OCR engine: scanned PDF -> OCR text -> compressed .gz, all driven by the assistant.

SCRATCH server only (own KNIFE_DATA_DIR, own port); the key is read at runtime by tests/real_provider.py.
  KNIFE_DATA_DIR=$(mktemp -d) KNIFE_PORT=3303 npm run dev   # then:
  python3 tests/agent_ocr_chain_real_e2e.py http://127.0.0.1:3303 [--model deepseek-v4.1-flash] [--runs 1]

The harness plays the user: when the assistant parks on wait_for_user it chooses the scanned PDF on the
pulsing file input, like a person picking a file. Oracles are independent of the model: the files Playwright
really downloaded, compared with the known text (word accuracy) and with gunzip.
"""
import argparse
import gzip
import json
import re
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ocr_fixtures import build  # noqa: E402
from real_provider import configure  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("base")
ap.add_argument("--model", default="deepseek-v4.1-flash")
ap.add_argument("--runs", type=int, default=1)
ap.add_argument("--min-accuracy", type=float, default=0.90)
ap.add_argument("--max-seconds", type=int, default=420)
ap.add_argument("--pages", type=int, default=1, help="pages in the scanned PDF; >1 makes OCR slow enough to need wait_for")
args = ap.parse_args()
BASE = args.base.rstrip("/")

PROMPT = (
    "OCR this scanned page, then compress the extracted text file and give me the .gz"
    if args.pages == 1
    else "OCR every page of this scanned document, then compress the extracted text file and give me the .gz"
)


def words(text: str) -> list[str]:
    return re.findall(r"[A-Za-z0-9$%][A-Za-z0-9$%.,'\-]*", text.replace("--- Page 1 ---", " "))


def accuracy(truth: str, got: str) -> float:
    """1 - word error rate (Levenshtein over words), floored at 0."""
    a, b = [w.strip(".,;:?!").lower() for w in words(truth)], [w.strip(".,;:?!").lower() for w in words(got)]
    prev = list(range(len(b) + 1))
    for i, wa in enumerate(a, 1):
        cur = [i]
        for j, wb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (wa != wb)))
        prev = cur
    return max(0.0, 1 - prev[-1] / max(1, len(a)))


def history(page: Page, k: str) -> list[dict]:
    return json.loads(page.evaluate("k => localStorage.getItem(k) || '[]'", k))


def calls(page: Page, k: str) -> list[tuple[str, dict]]:
    out = []
    for m in history(page, k):
        if m["role"] == "assistant":
            for c in m.get("tool_calls", []):
                try:
                    out.append((c["function"]["name"], json.loads(c["function"]["arguments"] or "{}")))
                except ValueError:
                    out.append((c["function"]["name"], {}))
    return out


def run_once(idx: int, pdf: Path, truth: str) -> dict:
    result: dict = {"run": idx, "checks": {}, "trace": []}
    failures: list[str] = []
    errors: list[str] = []

    def check(name: str, ok: bool, detail: object = "") -> None:
        result["checks"][name] = bool(ok)
        print(f"{'ok  ' if ok else 'FAIL'} {name}" + ("" if ok else f"  -> {detail}"))
        if not ok:
            failures.append(name)

    configure(BASE, args.model)
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True).new_page()
        page.on("console", lambda m: errors.append(m.text[:200]) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)[:200]))
        t_start = time.time()
        page.on("crash", lambda _p: print(f"!! PAGE CRASHED at {time.time() - t_start:.1f}s", flush=True))
        page.on("close", lambda _p: print(f"!! PAGE CLOSED at {time.time() - t_start:.1f}s", flush=True))
        browser.on("disconnected", lambda _b: print(f"!! BROWSER DISCONNECTED at {time.time() - t_start:.1f}s", flush=True))
        downloads: list[tuple[str, bytes]] = []
        page.on("download", lambda d: downloads.append((d.suggested_filename, Path(d.path()).read_bytes())))

        page.goto(BASE + "/tools/qr", wait_until="networkidle")
        page.keyboard.press("Control+j")
        page.wait_for_selector("[role=dialog][aria-label='Toolbox assistant']")
        k = page.evaluate("fetch('/api/account').then(r => r.json()).then(a => `sk.agent.chat.v1.${a.id}:${encodeURIComponent(a.provider?.baseUrl ?? '')}:${encodeURIComponent(a.provider?.model ?? '')}`)")

        started = time.time()
        box = page.locator("textarea[aria-label='Message the assistant']")
        box.fill(PROMPT)
        box.press("Enter")
        approvals: list[str] = []
        picked = 0
        seen_calls = 0
        waits_seen: list[str] = []
        done = """k => { const m = JSON.parse(localStorage.getItem(k) || '[]');
            const l = m[m.length - 1]; return !!l && ((l.role === 'assistant' && !l.tool_calls) || l.role === 'notice'); }"""
        finished = False
        last_poll = 0.0
        while time.time() - started < args.max_seconds:
            if page.locator("[data-agent-approval]").count():
                approvals.append(page.locator("[data-agent-approval] p").first.inner_text())
                page.get_by_role("button", name="Deny", exact=True).click()
            wait_card = page.locator("[data-agent-wait]")
            if wait_card.count():
                target = page.locator("main input[type=file][data-agent-await]")
                text = wait_card.first.inner_text().replace("\n", " ")[:80]
                if target.count() and picked == 0:
                    waits_seen.append(text)
                    target.first.set_input_files(str(pdf))  # the user chooses their scan
                    picked += 1
                    result["trace"].append(f"{time.time() - started:6.1f}s  [user picks {pdf.name}]")
                elif not target.count() and text not in waits_seen:
                    waits_seen.append(text)
                    page.get_by_role("button", name="Continue").first.click()
            if time.time() - last_poll > 0.5:
                last_poll = time.time()
                now = calls(page, k)
                for name, a in now[seen_calls:]:
                    brief = {kk: (str(v)[:40]) for kk, v in a.items() if kk not in ("base64", "text")}
                    result["trace"].append(f"{last_poll - started:6.1f}s  {name} {brief}")
                seen_calls = len(now)
                if len(history(page, k)) > 1 and page.evaluate(done, k):
                    finished = True
                    break
            page.wait_for_timeout(100)
        result["seconds"] = round(time.time() - started, 1)
        reply = ""
        msgs = history(page, k)
        if msgs and msgs[-1]["role"] in ("assistant", "notice"):
            reply = str(msgs[-1].get("content", ""))[:200]

        used = [c for c, _ in calls(page, k)]
        names = [n for n, _ in downloads]
        txt = next((b for n, b in downloads if n.endswith(".txt")), None)
        gz = next((b for n, b in downloads if n.endswith(".gz")), None)
        check("run finished inside the time budget", finished, f"{result['seconds']}s; last calls {used[-6:]}")
        check("assistant parked on wait_for_user and the harness chose the file", picked == 1 and "wait_for_user" in used, (picked, used))
        check("OCR text really downloaded", txt is not None, names)
        acc = accuracy(truth, txt.decode("utf-8", "replace")) if txt else 0.0
        result["accuracy"] = round(acc, 3)
        check(f"OCR word accuracy >= {args.min_accuracy:.0%} ({acc:.1%})", acc >= args.min_accuracy)
        check(".gz really downloaded", gz is not None, names)
        check("the .gz gunzips to exactly the extracted text", bool(gz and txt) and gzip.decompress(gz) == txt)
        uploads = [a for c, a in calls(page, k) if c == "upload_file"]
        check("every upload used from_file or the user's own pick, never model-sent bytes", all("base64" not in a and "text" not in a for a in uploads), uploads)
        check("the compressor got the text via from_file", any("from_file" in a for a in uploads), uploads)
        check("no approval prompt in Risky", not approvals, approvals)

        result["wait_for_calls"] = used.count("wait_for")
        if args.pages > 1:
            check("slow OCR was awaited with wait_for, not polled", used.count("wait_for") >= 1 and used.count("wait") <= 3, (used.count("wait_for"), used.count("wait")))
        check("zero console errors", not errors, errors[:3])
        result["calls"] = used
        dump = Path(tempfile.gettempdir()) / f"ocr-chain-run{idx}.json"
        dump.write_text(json.dumps(history(page, k), indent=1))
        result["history"] = str(dump)
        result["reply"] = reply
        result["pass"] = not failures
        browser.close()
    print(f"      run {idx}: {result['seconds']}s, accuracy {result.get('accuracy')}, {len(result['calls'])} calls ({result['wait_for_calls']} wait_for), history {result['history']}")
    for line in result["trace"]:
        print("        " + line)
    return result


tmp = Path(tempfile.mkdtemp(prefix="ocr-fx-"))
fx = build(tmp, pages=args.pages)
truth_text = fx["truth"].read_text()
runs = []
for i in range(args.runs):
    try:
        runs.append(run_once(i + 1, fx["pdf"], truth_text))
    except Exception as exc:  # a browser crash is a harness error, reported as a failed run (never retried silently)
        print(f"FAIL run {i + 1} harness error: {type(exc).__name__}: {str(exc)[:160]}")
        runs.append({"run": i + 1, "pass": False})
passed = sum(r["pass"] for r in runs)
print(f"\nPASS RATE {passed}/{len(runs)}")
sys.exit(0 if passed == len(runs) else 1)
