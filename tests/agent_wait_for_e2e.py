"""wait_for: block until slow page work is done (scripted mock provider, real browser).

A fake long task is injected into the tool page (a role=status "Working… N%" line that is replaced by
"Report ready" after 8 s, optionally with a blob download), then the mock model calls wait_for with each
condition. Independent oracles: the wall clock, the page itself, and the pill text sampled while waiting.

  node tests/mock_provider.mjs 3299
  KNIFE_DATA_DIR=$(mktemp -d) KNIFE_PORT=3238 npm run dev
  python3 tests/agent_wait_for_e2e.py http://127.0.0.1:3238 http://127.0.0.1:3299
"""
import json
import re
import sys
import time
import urllib.request

from playwright.sync_api import Page, sync_playwright

BASE, MOCK = sys.argv[1].rstrip("/"), sys.argv[2].rstrip("/")
failures: list[str] = []
errors: list[str] = []
n_user = 0

TASK_JS = """({ms, mode}) => {
  document.getElementById('fake-task')?.remove();
  const box = document.createElement('section');
  box.id = 'fake-task'; box.setAttribute('data-agent-region', 'fake');
  const h = document.createElement('h3'); h.textContent = 'Fake long task'; box.append(h);
  const p = document.createElement('p'); p.setAttribute('role', 'status'); p.textContent = 'Working… 0%'; box.append(p);
  document.querySelector('main').append(box);
  const t0 = Date.now(); let n = 0;
  const iv = setInterval(() => {
    const f = (Date.now() - t0) / ms;
    if (mode === 'ticker') { p.textContent = 'tick ' + (++n); if (f >= 1) { clearInterval(iv); p.textContent = 'ticker stopped'; } return; }
    if (f < 1) { p.textContent = 'Working… ' + Math.round(f * 100) + '%'; return; }
    clearInterval(iv); p.remove();
    const d = document.createElement('p'); d.textContent = 'Report ready: 3 rows'; box.append(d);
    if (mode === 'file') {
      const a = document.createElement('a'); a.download = 'report.txt';
      a.href = URL.createObjectURL(new Blob(['hello report'], {type: 'text/plain'}));
      document.body.append(a); a.click(); a.remove();
    }
  }, 200);
}"""


def check(name: str, ok: bool, detail: object = "") -> None:
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + ("" if ok else f"  -> {detail}"))
    if not ok:
        failures.append(name)


def put_provider() -> None:
    body = {"baseUrl": f"{MOCK}/v1", "model": "mock-model", "apiKey": "mock-key"}
    req = urllib.request.Request(BASE + "/api/account/provider", data=json.dumps(body).encode(), method="PUT",
                                 headers={"content-type": "application/json", "Origin": BASE})
    urllib.request.urlopen(req, timeout=30).read()


def key(page: Page) -> str:
    return page.evaluate("fetch('/api/account').then(r => r.json()).then(a => `sk.agent.chat.v1.${a.id}:${encodeURIComponent(a.provider?.baseUrl ?? '')}:${encodeURIComponent(a.provider?.model ?? '')}`)")


def results(page: Page, k: str, name: str) -> list[dict]:
    ms = json.loads(page.evaluate("k => localStorage.getItem(k) || '[]'", k))
    ids = {c["id"] for m in ms if m["role"] == "assistant" for c in m.get("tool_calls", []) if c["function"]["name"] == name}
    out = []
    for m in ms:
        if m["role"] == "tool" and m["tool_call_id"] in ids:
            try:
                out.append(json.loads(m["content"]))
            except ValueError:
                pass
    return out


DONE = """([k, n]) => { const m = JSON.parse(localStorage.getItem(k) || '[]');
    if (m.filter(x => x.role === 'user').length < n) return false;
    const l = m[m.length - 1]; return (l.role === 'assistant' && !l.tool_calls) || l.role === 'notice'; }"""


def send(page: Page, text: str) -> None:
    global n_user
    n_user += 1
    box = page.locator("textarea[aria-label='Message the assistant']")
    box.fill(text)
    box.press("Enter")


def finish(page: Page, k: str, samples: list[str] | None = None, timeout_s: int = 60) -> float:
    """Wait for the run to end, sampling the pill text; returns seconds taken."""
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        if samples is not None and page.locator("[data-agent-pill]").count():
            samples.append(page.locator("[data-agent-pill]").first.inner_text().replace("\n", " "))
        if page.evaluate(DONE, [k, n_user]):
            return time.time() - t0
        page.wait_for_timeout(250)
    raise SystemExit("run did not finish")


def call(name: str, **args: object) -> str:
    return f"CALL:{name}:{json.dumps(args)}"


put_provider()
with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True).new_page()
    page.on("console", lambda m: errors.append(m.text[:200]) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)[:200]))
    page.goto(BASE + "/tools/qr", wait_until="networkidle")
    page.keyboard.press("Control+j")
    page.wait_for_selector("[role=dialog][aria-label='Toolbox assistant']")
    k = key(page)

    # ---- busy_done: blocks ~8 s, live pill counts up, reports what changed -----------------------
    page.evaluate(TASK_JS, {"ms": 8000, "mode": "plain"})
    started = time.time()
    send(page, call("wait_for", until="busy_done", timeout_s=30))
    samples: list[str] = []
    took = finish(page, k, samples)
    r = results(page, k, "wait_for")[-1]
    check("busy_done blocked until the work finished (7-11 s)", 7 <= time.time() - started <= 11, time.time() - started)
    check("result: met, not timed out, waited_s about 8", r["ok"] and r["met"] and not r["timed_out"] and 6.5 <= r["waited_s"] <= 10, r)
    check("result carries what changed (Report ready)", "Report ready" in json.dumps(r.get("changed", {})), r.get("changed"))
    secs = sorted({int(m.group(1)) for s in samples if (m := re.search(r"Waiting for the page to finish working \((\d+) s\)", s))})
    check("pill showed 'Waiting for the page to finish working (N s)' counting up", len(secs) >= 4 and secs == sorted(secs) and secs[-1] >= 5, (secs, samples[:3]))

    # ---- text: regex and plain ----------------------------------------------------------------
    page.evaluate(TASK_JS, {"ms": 5000, "mode": "plain"})
    send(page, call("wait_for", regex="report\\s+ready: \\d+ rows", timeout_s=30))
    finish(page, k)
    r = results(page, k, "wait_for")[-1]
    check("regex condition met after ~5 s", r["met"] and 3.5 <= r["waited_s"] <= 8, r)

    # ---- new_file ------------------------------------------------------------------------------
    page.evaluate(TASK_JS, {"ms": 4000, "mode": "file"})
    send(page, call("wait_for", until="new_file", timeout_s=30))
    finish(page, k)
    r = results(page, k, "wait_for")[-1]
    files = r.get("new_files") or []
    check("new_file returned the produced file handle", r["met"] and files and files[0]["name"] == "report.txt", r)

    # ---- change (id from a real snapshot) ----------------------------------------------------------
    page.evaluate(TASK_JS, {"ms": 3000, "mode": "plain"})
    send(page, call("page_snapshot"))
    finish(page, k)
    snap = results(page, k, "page_snapshot")[-1]
    rid = next((x["id"] for x in snap["regions"] if "Fake long task" in x.get("text", "") or x.get("title") == "Fake long task"), None)
    check("snapshot exposes the fake task as a region with an id", rid is not None, snap["regions"][:3])
    send(page, call("wait_for", until="change", id=rid, timeout_s=20))
    finish(page, k)
    r = results(page, k, "wait_for")[-1]
    check("change on a region id returns as soon as its text changes", r["ok"] and r["met"] and r["waited_s"] < 4, r)

    # ---- idle: ticker keeps mutating for ~5 s, then stops ---------------------------------------
    page.evaluate(TASK_JS, {"ms": 5000, "mode": "ticker"})
    send(page, call("wait_for", until="idle", idle_ms=1000, timeout_s=30))
    finish(page, k)
    r = results(page, k, "wait_for")[-1]
    check("idle waited out the ticker (>= 5 s) and then returned", r["met"] and 5.0 <= r["waited_s"] <= 9, r)

    # ---- timeout is reported, not an error -----------------------------------------------------
    page.evaluate(TASK_JS, {"ms": 600_000, "mode": "plain"})
    send(page, call("wait_for", until="busy_done", timeout_s=2))
    took = finish(page, k)
    r = results(page, k, "wait_for")[-1]
    check("timeout: ok but timed_out, with still_busy and a hint", r["ok"] and r["timed_out"] and not r["met"] and r["still_busy"] and "again" in r["hint"], r)
    check("timeout honoured (~2 s)", 1.8 <= r["waited_s"] <= 4, r["waited_s"])

    # ---- bad arguments --------------------------------------------------------------------------
    send(page, call("wait_for"))
    finish(page, k)
    r = results(page, k, "wait_for")[-1]
    check("no arguments -> a usage error naming the options", not r["ok"] and "busy_done" in r["error"], r)
    send(page, call("wait_for", until="change", id="c9999"))
    finish(page, k)
    check("unknown id -> not-found error", not results(page, k, "wait_for")[-1]["ok"])

    # ---- Stop aborts a long wait --------------------------------------------------------------
    send(page, call("wait_for", until="busy_done", timeout_s=120))
    page.wait_for_selector("[data-agent-pill]")
    page.wait_for_timeout(1500)
    pill = page.locator("[data-agent-pill]").first.inner_text()
    check("pill shows the wait while it runs", "Waiting for the page to finish working" in pill, pill)
    t0 = time.time()
    page.get_by_role("button", name="Stop the assistant").click()
    page.wait_for_function("() => !document.documentElement.hasAttribute('data-agent-active')", timeout=5000)
    check("Stop ends the wait within 3 s", time.time() - t0 < 3, time.time() - t0)
    check("the fake task was still running (the wait did not just time out)", "Working" in page.locator("#fake-task").inner_text())

    browser.close()

check("zero console errors", not errors, errors[:3])
print("\nall checks passed" if not failures else f"\n{len(failures)} FAILED: {failures}")
sys.exit(1 if failures else 0)
