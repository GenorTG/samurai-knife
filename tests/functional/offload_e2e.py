#!/usr/bin/env python3
"""Client-offloading e2e: heavy work runs in Web Workers, the page stays responsive, Cancel works, nothing is left half-done.

Every check measures main-thread long tasks (PerformanceObserver 'longtask', >50 ms) while the heavy operation runs and asserts
the worst one stays under LIMIT_MS, that the UI still answers clicks during the work, and that the page is usable afterwards.
Oracles are independent of the app: Python's sqlite3/csv/hashlib check what the browser produced.

Usage: python3 tests/functional/offload_e2e.py <base_url> [-v]     (default http://127.0.0.1:3302; scratch server, never :3210)
"""
import csv
import hashlib
import os
import random
import re
import sqlite3
import sys
import tempfile
import time
import traceback

from playwright.sync_api import expect, sync_playwright

_ARGS = [a for a in sys.argv[1:] if not a.startswith("-") and not a.endswith("_suite")]
ONLY = [a for a in sys.argv[1:] if a.endswith("_suite")]  # e.g. sql_suite regex_suite hash_suite
BASE = (_ARGS[0] if _ARGS else "http://127.0.0.1:3302").rstrip("/")
LIMIT_MS = 100  # max single main-thread long task allowed during a heavy operation
FAILS: list[str] = []
CONSOLE: list[str] = []
page = None
TMP = tempfile.mkdtemp(prefix="offload-")

WATCH = """
(() => {
  const S = window.__w = { lt: [], max: 0 };
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) { S.lt.push(e.duration); S.max = Math.max(S.max, e.duration); } }).observe({ type: 'longtask' }); } catch (e) {}
  S.reset = () => { S.lt = []; S.max = 0; };
})();
"""


def ok(name):
    print(f"ok   {name}", flush=True)


def fail(name, err):
    FAILS.append(name)
    print(f"FAIL {name}: {err}", flush=True)


def check(name):
    def deco(fn):
        before = len(CONSOLE)
        try:
            fn()
            if len(CONSOLE) > before:
                raise AssertionError("console/page errors: " + " | ".join(CONSOLE[before:])[:300])
            ok(name)
        except Exception as e:  # noqa: BLE001
            fail(name, f"{type(e).__name__}: {str(e).splitlines()[0] if str(e) else ''}")
            if "-v" in sys.argv:
                traceback.print_exc()
        return fn
    return deco


def eq(actual, expected, what=""):
    assert actual == expected, f"{what} expected {expected!r} got {actual!r}"


def go(slug, tab=None):
    page.set_viewport_size({"width": 1280, "height": 900})
    page.goto(f"{BASE}/tools/{slug}" + (f"?tab={tab}" if tab else ""), wait_until="domcontentloaded")
    page.wait_for_selector("main button, main input, main textarea", timeout=30000)
    page.wait_for_function("!document.querySelector('main [role=status]')?.textContent?.includes('Loading tool')", timeout=30000)
    page.wait_for_timeout(400)


def reset_watch():
    page.evaluate("window.__w.reset()")


def max_longtask():
    page.wait_for_timeout(200)
    return page.evaluate("window.__w.max")


def assert_smooth(what, limit=LIMIT_MS):
    m = max_longtask()
    assert m < limit, f"{what}: main thread blocked for {m:.0f} ms (limit {limit} ms)"


def put(label, text):
    """Set a textarea like a paste does (Playwright fill() is O(n^2) on long multi-line text)."""
    target = page.get_by_label(label, exact=True).first if label == "Subject text" else field(label)
    target.evaluate(
        "(el, t) => { const d = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value'); d.set.call(el, t); el.dispatchEvent(new Event('input', { bubbles: true })); }",
        text,
    )


def field(label):
    return page.locator(f'label:has(> span:text-is("{label}")) >> :is(textarea,input,select)').first


def btn(name, exact=True):
    return page.get_by_role("button", name=name, exact=exact).first


def main_text():
    return page.locator("main").inner_text()


def has(text, timeout=15000):
    expect(page.locator("main")).to_contain_text(text, timeout=timeout)


def run_status():
    return page.locator('[data-agent-region="run-status"]').first.inner_text()


def make_csv(path, rows):
    random.seed(11)
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["id", "grp", "val", "txt"])
        for i in range(rows):
            w.writerow([i, i % 100, f"{random.random():.4f}", f"word{i % 977}"])


ROWS = 200_000
CSV_BIG = os.path.join(TMP, "big.csv")


def sql_suite():
    make_csv(CSV_BIG, ROWS)

    @check("sql: importing a 200k-row CSV runs in the worker (no long task > limit), shows progress, UI stays clickable")
    def _():
        go("sql-lab", "run")
        has("Tables")
        page.wait_for_function("document.querySelector('[data-agent-region=database-status]')?.textContent?.includes('Open')", timeout=30000)
        reset_watch()
        page.locator("input[type=file]").first.set_input_files(CSV_BIG)
        seen_status = ""
        clicked = False
        deadline = time.time() + 120
        while time.time() < deadline:
            t = run_status()
            if "Importing file" in t:
                seen_status = t
                if not clicked:
                    # the page must answer while the import runs
                    t0 = time.time()
                    btn("Example query").click()
                    assert time.time() - t0 < 1.5, "click took too long during import"
                    clicked = True
            if "Imported big.csv" in main_text():
                break
            page.wait_for_timeout(100)
        has(f"Imported big.csv as table big: {ROWS} rows")
        assert seen_status, "never saw the Importing status text"
        assert clicked, "import finished before the UI could be clicked (file too small?)"
        assert_smooth("CSV import")

    @check("sql: 60k-row SELECT renders a windowed grid (few DOM rows), scrolls to the end, exports every row")
    def _():
        reset_watch()
        field("SQL to run").fill("SELECT id, grp, val, txt FROM big ORDER BY id LIMIT 60000;")
        btn("Run query").click()
        has("Statement 1: SELECT: 60,000 rows")
        grid = page.get_by_role("region", name="Statement 1 rows")
        expect(grid).to_be_visible()
        n_dom = page.locator('section[aria-label="Statement 1 result"] tbody tr').count()
        assert 10 < n_dom < 300, f"expected a windowed grid, found {n_dom} body rows in the DOM"
        has("Rows 1–")
        # scroll to the very end: the last row must appear (fetched from the worker)
        grid.evaluate("el => { el.scrollTop = el.scrollHeight; }")
        page.wait_for_function("document.querySelector('section[aria-label=\"Statement 1 result\"]')?.textContent?.includes('59999')", timeout=15000)
        has("of 60,000")
        assert_smooth("60k-row select + scroll")
        with page.expect_download() as dl:
            btn("Export statement 1 as CSV").click()
        path = os.path.join(TMP, "out60k.csv")
        dl.value.save_as(path)
        rows = list(csv.reader(open(path, newline="")))
        eq(len(rows) - 1, 60000, "exported rows")
        eq(rows[60000][0], "59999", "last exported id")
        eq(rows[0], ["id", "grp", "val", "txt"], "header")

    @check("sql: jump-to-row lands on the requested row")
    def _():
        page.get_by_label("Jump to row in statement 1", exact=True).fill("30001")
        page.wait_for_function("document.querySelector('section[aria-label=\"Statement 1 result\"]')?.textContent?.includes('30000')", timeout=15000)

    @check("sql: a 5,000,000-step recursive CTE can be cancelled; page stays smooth; database restored from snapshot")
    def _():
        go("sql-lab", "run")
        page.wait_for_function("document.querySelector('[data-agent-region=database-status]')?.textContent?.includes('Open')", timeout=30000)
        # a write batch -> snapshot, so Cancel has something to come back to
        field("SQL to run").fill("CREATE TABLE keep(x INTEGER); INSERT INTO keep VALUES (1),(2),(3);")
        btn("Run query").click()
        has("Statement 2: INSERT: 3 rows affected")
        reset_watch()
        field("SQL to run").fill(
            "INSERT INTO keep VALUES (99); WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 50000000) SELECT count(*) FROM n;"
        )
        btn("Run query").click()
        page.wait_for_function("document.querySelector('[data-agent-region=run-status]')?.textContent?.includes('Running query')", timeout=15000)
        txt = run_status()
        assert "elapsed" in txt and "Cancel" in txt, txt
        # UI answers while the engine is stuck in the CTE
        t0 = time.time()
        btn("Clear SQL").click()
        assert time.time() - t0 < 1.5, "UI unresponsive during the query"
        expect(field("SQL to run")).to_have_value("")
        btn("Cancel running query").click()
        has("Cancelled running query")
        has("restored from its")
        assert_smooth("cancelled CTE")
        # restored: table keep exists with the 3 snapshot rows, the cancelled INSERT (99) is gone
        has("keep")
        field("SQL to run").fill("SELECT count(*) AS n, max(x) AS m FROM keep;")
        btn("Run query").click()
        has("Statement 1: SELECT: 1 row")
        cells = [c.strip() for c in page.locator('section[aria-label="Statement 1 result"] tbody tr').first.locator("td").all_inner_texts()]
        eq(cells, ["3", "3"], "restored table state (insert before the cancelled CTE must be rolled back)")
        assert "cancelled" in page.locator('[data-agent-region="query-history"]').inner_text()

    @check("sql: a slow query that finishes shows elapsed/progress text and then the result")
    def _():
        go("sql-lab", "run")
        page.wait_for_function("document.querySelector('[data-agent-region=database-status]')?.textContent?.includes('Open')", timeout=30000)
        reset_watch()
        field("SQL to run").fill("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 3000000) SELECT count(*) AS c FROM n;")
        btn("Run query").click()
        page.wait_for_function("document.querySelector('[data-agent-region=run-status]')?.textContent?.includes('elapsed')", timeout=15000)
        has("Statement 1: WITH: 1 row", timeout=60000)
        eq(page.locator('section[aria-label="Statement 1 result"] tbody td').first.inner_text().strip(), "3000000", "count")
        assert_smooth("3e6 CTE")

    @check("sql: opening a .sqlite file in the worker keeps it as the restore point; exported db matches sqlite3")
    def _():
        db = os.path.join(TMP, "fx.sqlite")
        con = sqlite3.connect(db)
        con.executescript("CREATE TABLE t(a INTEGER, b TEXT); INSERT INTO t VALUES (1,'x'),(2,'y');")
        con.commit()
        con.close()
        go("sql-lab", "run")
        page.wait_for_function("document.querySelector('[data-agent-region=database-status]')?.textContent?.includes('Open')", timeout=30000)
        page.locator("input[type=file]").first.set_input_files(db)
        has("Opened fx.sqlite")
        field("SQL to run").fill("INSERT INTO t VALUES (3,'z');")
        btn("Run query").click()
        has("1 row affected")
        with page.expect_download() as dl:
            btn("Export database (.sqlite)").click()
        out = os.path.join(TMP, "fx-out.sqlite")
        dl.value.save_as(out)
        eq(sqlite3.connect(out).execute("select a,b from t order by a").fetchall(), [(1, "x"), (2, "y"), (3, "z")], "exported rows")


def regex_suite():
    @check("regex: catastrophic (a+)+$ stops within ~1.5 s with the 'too slow' message and the page stays smooth")
    def _():
        go("regex")
        page.wait_for_timeout(800)  # let the worker boot
        put("Subject text", "a" * 40 + "!")
        reset_watch()
        t0 = time.time()
        field("Regex").fill("(a+)+$")
        has("Pattern too slow (possible catastrophic backtracking)", timeout=5000)
        took = time.time() - t0
        assert took < 2.0, f"timeout message took {took:.2f}s"
        assert_smooth("catastrophic regex")
        page.get_by_role("alert").filter(has_text="Pattern too slow").first.wait_for(state="visible", timeout=2000)

    @check("regex: after a timeout the lab works again (new pattern matches, worker respawned)")
    def _():
        field("Regex").fill("a+")
        put("Subject text", "caaat aa a")
        has("3 matches", timeout=5000)
        assert "too slow" not in main_text()

    @check("regex: a running match can be cancelled; the message says so and the lab recovers")
    def _():
        go("regex")
        page.wait_for_timeout(800)
        put("Subject text", "a" * 40 + "!")
        field("Regex").fill("(a+)+$")
        btn("Cancel matching").click(timeout=3000)
        has("Matching cancelled", timeout=3000)
        field("Regex").fill("a")
        has("matches", timeout=3000)

    @check("regex: ordinary patterns still highlight, group and replace (worker path = old behaviour)")
    def _():
        go("regex")
        page.get_by_role("button", name="ISO dates", exact=True).click()
        has("3 matches", timeout=5000)
        has("Capture groups")

    @check("regex: an 8 MB subject with a plain pattern does not block the main thread")
    def _():
        go("regex")
        page.wait_for_timeout(800)
        field("Regex").fill("word12\\d")
        reset_watch()
        put("Subject text", " ".join(f"word{i}" for i in range(800000)))
        has("matches", timeout=20000)
        # typing a 5 MB string into a native textarea is its own cost; only app-induced tasks must stay small after it settled
        page.wait_for_timeout(1500)
        reset_watch()
        field("Regex").fill("word13\\d")
        page.wait_for_timeout(2500)
        # dev server: React's jsxDEV captures a stack per <mark> (~0.2 ms each, up to 1000); production has no such cost, so allow 250 ms
        assert_smooth("re-running an 8 MB subject", limit=250)


def hash_suite():
    mb = 1024 * 1024
    chunk = os.urandom(mb)
    mid = os.path.join(TMP, "mid.bin")
    big = os.path.join(TMP, "big.bin")
    for path, n in ((mid, 160), (big, 480)):
        with open(path, "wb") as fh:
            for _ in range(n):
                fh.write(chunk)

    def sha(path, algo="sha256"):
        h = hashlib.new(algo)
        with open(path, "rb") as fh:
            while True:
                b = fh.read(8 * mb)
                if not b:
                    break
                h.update(b)
        return h.hexdigest()

    @check("ids: a 160 MB file is hashed in the worker (progress text, clickable page, digest equals hashlib)")
    def _():
        go("ids")
        reset_watch()
        page.locator("input[type=file]").first.set_input_files(mid)
        seen = ""
        clicked = False
        deadline = time.time() + 120
        digest = ""
        while time.time() < deadline:
            t = page.locator('[data-agent-region="hash-status"]').inner_text()
            if "Hashing mid.bin" in t:
                seen = t
                if not clicked:
                    t0 = time.time()
                    btn("UUID v4").click()
                    assert time.time() - t0 < 1.5, "click blocked while hashing"
                    clicked = True
            inputs = page.locator("input[readonly]").all()
            digest = next((i.input_value() for i in inputs if re.fullmatch(r"[0-9a-f]{64}", i.input_value() or "")), "")
            if digest:
                break
            page.wait_for_timeout(100)
        assert seen, "never saw the hashing progress text"
        eq(digest, sha(mid), "sha256 of the file")
        assert_smooth("160 MB hash")

    @check("ids: hashing a 480 MB file can be cancelled; the page works afterwards (small text hash still right)")
    def _():
        go("ids")
        reset_watch()
        page.locator("input[type=file]").first.set_input_files(big)
        btn("Cancel hashing").click(timeout=15000)
        has("Hashing big.bin was cancelled")
        assert_smooth("cancelled hash")
        page.get_by_label("Text", exact=True).fill("abc")
        page.wait_for_function("[...document.querySelectorAll('input[readonly]')].some(i => i.value === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')", timeout=5000)


def image_suite():
    from PIL import Image

    path = os.path.join(TMP, "24mp.jpg")
    Image.linear_gradient("L").resize((6000, 4000)).convert("RGB").save(path, quality=80)

    @check("image-resize: a 24 MP JPEG is decoded, resized and re-encoded in a worker (long task < 200 ms); output has the asked size")
    def _():
        go("image-resize")
        reset_watch()
        page.locator("input[type=file]").first.set_input_files(path)
        has("Source")
        field("Width").fill("1200")
        page.wait_for_selector('img[alt="Resized result"]', timeout=60000)
        has("1200×800")
        with page.expect_download() as dl:
            btn("Download").click()
        out = os.path.join(TMP, "resized.jpg")
        dl.value.save_as(out)
        with Image.open(out) as im:
            eq(im.size, (1200, 800), "output size")
        assert_smooth("24 MP resize", limit=200)


def main():
    global page
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
        ctx.add_init_script(WATCH)
        page = ctx.new_page()
        page.set_default_timeout(20000)
        page.on("console", lambda m: CONSOLE.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: CONSOLE.append(f"pageerror: {e}"))
        for suite in (sql_suite, regex_suite, hash_suite, image_suite):
            if not ONLY or suite.__name__ in ONLY:
                suite()
        browser.close()
    print(f"\n{len(FAILS)} failure(s)" if FAILS else "\nall ok")
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
