#!/usr/bin/env python3
"""Offloading e2e for the text / CSV tools (heavy compute runs in a Web Worker).

Usage: python3 tests/functional/offload_text_e2e.py <base_url> [--only text,csv-profile,...] [-v]

Per tool:
  * equality: small input (inline path) and a medium input above the worker threshold (worker path) give the output an
    independent oracle (Python str/csv/difflib) predicts;
  * long task: the max long task while a multi-MB input is pasted and processed stays within `floor + SLACK` ms, where the
    floor is what copies of the tool's own <textarea>s holding the same texts cost, without React (native layout nobody can remove).
    Best of OFFLOAD_RUNS runs for both (the sum of all long tasks is bounded too: the textareas' summed floors + 1000 ms), because the box is shared and noisy;
  * Cancel: the status line offers a named Cancel button, it stops the work, and the tool is usable afterwards.
Big text is set with the native setter + input event (Playwright fill() is O(n^2) on multi-line text).
"""
import csv
import io
import os
import random
import sys
import traceback

from playwright.sync_api import expect, sync_playwright

ARGV = [a for a in sys.argv[1:] if not a.startswith("-")]
BASE = (ARGV[0] if ARGV else "http://127.0.0.1:3312").rstrip("/")
ONLY = None
if "--only" in sys.argv:
    ONLY = set(sys.argv[sys.argv.index("--only") + 1].split(","))
    ARGV = [a for a in ARGV if a not in ONLY and "," not in a]
RUNS = int(os.environ.get("OFFLOAD_RUNS", "3"))
SLACK_MS = int(os.environ.get("OFFLOAD_SLACK_MS", "200"))
FAILS: list[str] = []
PASSES = [0]
CONSOLE: list[str] = []

INIT = """
(() => {
  const S = window.__stress = { lt: [], gap: 0 };
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) S.lt.push(e.duration); }).observe({ type: 'longtask', buffered: false }); } catch (e) {}
  // a running rAF loop is what a real visible page has: without it headless Chromium defers the textarea layout and the long task is not attributed
  let lf = performance.now();
  const f = () => { const n = performance.now(); S.gap = Math.max(S.gap, n - lf); lf = n; requestAnimationFrame(f); };
  requestAnimationFrame(f);
  S.reset = () => { S.lt = []; S.gap = 0; lf = performance.now(); };
})();
"""
# Readiness probes for the long-task checks must not read the big input back: main.textContent includes every textarea's
# text (React keeps a controlled textarea's defaultValue, i.e. its text content, in sync with its value), so polling it once
# per frame copies the 8 MB paste on the main thread over and over and the probe's own work shows up as the tool's long tasks.
STAT_IS = "([label, value]) => [...document.querySelectorAll('main .sk-label')].some(l => l.textContent.trim() === label && l.nextElementSibling?.textContent.trim() === value)"
PUT_JS = "(el, t) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, t); el.dispatchEvent(new Event('input', { bubbles: true })); }"
FLOOR_JS = """async (texts) => {
  const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  // copies of the tool's own textareas (same classes, width, rows), without React, filled one after the other like the tool is:
  // the native cost of holding these texts, including re-layout of the neighbours
  const srcs = [...document.querySelectorAll('textarea:not([readonly])')].slice(0, texts.length);
  const els = srcs.map(src => { const el = src.cloneNode(false); el.removeAttribute('id'); el.value = ''; src.insertAdjacentElement('afterend', el); return el; });
  await frame();
  const steps = [];
  for (let i = 0; i < texts.length; i++) {
    const t0 = performance.now();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(els[i], texts[i]);
    await frame();
    steps.push(Math.round(performance.now() - t0));
  }
  els.forEach(el => el.remove());
  return [Math.max(...steps), steps.reduce((a, b) => a + b, 0)]; }"""

browser = None
page = None


def ok(name):
    PASSES[0] += 1
    print(f"ok   {name}", flush=True)


def fail(name, err):
    FAILS.append(name)
    print(f"FAIL {name}: {err}", flush=True)


def check(name, fn):
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


def eq(actual, expected, what=""):
    assert actual == expected, f"{what} expected {expected[:80]!r} got {actual[:80]!r} (len {len(expected)} vs {len(actual)})"


# --- data ---------------------------------------------------------------------------------------------------------
NATO = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango".split()


def prose(nbytes, seed=7, newline_every=0):
    """Deterministic `word123 word45 ...` text of about nbytes; `newline_every` words per line (0 = one line, like a pasted blob)."""
    rnd = random.Random(seed)
    out, size, n = [], 0, 0
    while size < nbytes:
        w = f"{rnd.choice(NATO)}{rnd.randrange(3000)}"
        n += 1
        sep = "\n" if newline_every and n % newline_every == 0 else " "
        out.append(w + sep)
        size += len(w) + 1
    return "".join(out)


def big_csv(rows, seed=3):
    rnd = random.Random(seed)
    lines = ["id,name,city,score,note"]
    for i in range(rows):
        lines.append(f"{i},{rnd.choice(NATO)}{i},{rnd.choice(NATO)},{rnd.random():.5f},{rnd.choice(NATO)} {rnd.choice(NATO)} {rnd.choice(NATO)}")
    return "\n".join(lines)


# --- browser plumbing ---------------------------------------------------------------------------------------------
def new_page():
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
    ctx.add_init_script(INIT)
    pg = ctx.new_page()
    pg.set_default_timeout(90000)
    pg.on("console", lambda m: CONSOLE.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
    pg.on("pageerror", lambda e: CONSOLE.append(f"pageerror: {e}"))
    return ctx, pg


def goto(pg, slug, tab=None):
    pg.goto(f"{BASE}/tools/{slug}" + (f"?tab={tab}" if tab else ""), wait_until="domcontentloaded")
    pg.wait_for_selector("main")
    pg.wait_for_function("() => !document.body.innerText.includes('Loading tool')")
    pg.wait_for_timeout(600)


def put(pg, n, text):
    pg.locator("textarea:not([readonly])").nth(n).evaluate(PUT_JS, text)


def long_task_vs_floor(slug, tab, texts, settle_ms=6000, ready=None):
    """Best-of-RUNS max long task while `texts` go into the writable textareas, against a plain textarea with texts[0]."""
    floors, floor_sums, tools, totals = [], [], [], []
    for _ in range(RUNS):
        # the floor gets its own browser context: a warm text-shaping cache from the floor run would make the tool run look free
        ctx, pg = new_page()
        try:
            goto(pg, slug, tab)
            fl = pg.evaluate(FLOOR_JS, texts)
            floors.append(fl[0])
            floor_sums.append(fl[1])
        finally:
            ctx.close()
        ctx, pg = new_page()
        try:
            goto(pg, slug, tab)
            pg.evaluate("() => window.__stress.reset()")
            for i, t in enumerate(texts):
                put(pg, i, t)
            if ready:
                ready(pg)
            pg.wait_for_timeout(settle_ms)
            lts = pg.evaluate("() => window.__stress.lt")
            tools.append(round(max(lts)) if lts else 0)
            totals.append(round(sum(lts)))
        finally:
            ctx.close()
    floor, floor_sum, tool, total = min(floors), min(floor_sums), min(tools), min(totals)
    print(f"     {slug}{('/' + tab) if tab else ''}: floor {floors} -> {floor} ms (summed {floor_sum}), max long task {tools} -> {tool} ms, all long tasks summed {totals} -> {total} ms", flush=True)
    assert tool <= floor + SLACK_MS, f"max long task {tool} ms > floor {floor} + {SLACK_MS} ms"
    # a compute that runs as its own task right after the layout would hide from the max, not from the sum
    allowed = floor_sum + 5 * SLACK_MS  # every pasted textarea pays its own native layout
    assert total <= allowed, f"long tasks sum to {total} ms > {allowed} ms"
    return floor, tool


def status_text(pg):
    return pg.locator('[role="status"]').all_inner_texts()


# --- Text kit -----------------------------------------------------------------------------------------------------
def py_number(t):
    return "\n".join(f"{str(i + 1).rjust(2)}. {line}" for i, line in enumerate(t.split("\n")))


def py_dedupe(t):
    seen, out = set(), []
    for line in t.split("\n"):
        k = line.strip()
        if k not in seen:
            seen.add(k)
            out.append(line)
    return "\n".join(out)


TEXT_ORACLES = {
    "UPPERCASE": lambda t: t.upper(),
    "lowercase": lambda t: t.lower(),
    "Dedupe lines": py_dedupe,
    "Reverse line order": lambda t: "\n".join(reversed(t.split("\n"))),
    "Trim + drop blanks": lambda t: "\n".join(x for x in (l.strip() for l in t.split("\n")) if x),
    "Number lines": py_number,
    "Strip all whitespace": lambda t: "".join(t.split()),
    "Escape HTML entities": lambda t: t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;").replace("'", "&#39;"),
}


PREVIEW = 200_000  # the output pane's cap, see TEXTKIT_PREVIEW_LIMIT


def text_output(pg):
    return pg.locator("pre").first.text_content() or ""


def wait_idle(pg, timeout=60000):
    """No Cancel button and no 'running' status left."""
    pg.wait_for_function("() => !document.querySelector('[data-agent-region=work-status] button')", timeout=timeout)


def text_equal(text, label):
    ctx, pg = new_page()
    try:
        goto(pg, "text")
        put(pg, 0, text)
        for name, oracle in TEXT_ORACLES.items():
            pg.get_by_role("button", name=name, exact=True).click()
            expected = oracle(text)[:PREVIEW]
            pg.wait_for_function("(e) => { const p = document.querySelector('pre'); return p && p.textContent === e; }", arg=expected, timeout=60000)
            eq(text_output(pg), expected, f"{label} {name}")
    finally:
        ctx.close()


def text_kit():
    lines = "  Hello <World> & \"quote\" it's\n\nalpha  \n  alpha\nBeta beta\n\tTab\t line  \nlast line"
    check("text: small input (inline path) matches Python oracles for 8 transforms", lambda: text_equal(lines, "small"))
    # ~230 kB, multi-line: above the 200 kB inline threshold, so this runs in the worker (outputs are compared up to the preview cap)
    medium = prose(230_000, seed=11, newline_every=7).replace("alpha", "Alpha &", 50)
    check("text: 230 kB input (worker path) matches Python oracles for 8 transforms", lambda: text_equal(medium, "medium"))

    def sort_and_stats():
        ctx, pg = new_page()
        try:
            goto(pg, "text")
            items = [f"item{k}" for k in random.Random(5).sample(range(1, 60000), 26000)]  # ~230 kB, distinct, natural order = numeric order
            body = "\n".join(items)
            assert len(body) > 200_000
            put(pg, 0, body)
            pg.get_by_role("button", name="Sort lines A→Z", exact=True).click()
            expected = "\n".join(sorted(items, key=lambda s: int(s[4:])))[:PREVIEW]
            pg.wait_for_function("(e) => document.querySelector('pre')?.textContent === e", arg=expected, timeout=60000)
            txt = pg.locator("main").text_content() or ""
            assert f"In · lines{len(items)}" in txt and f"In · chars{len(body)}" in txt, "stats tiles"
        finally:
            ctx.close()

    check("text: natural sort of 26000 lines in the worker matches numeric order", sort_and_stats)

    def preview_cap():
        ctx, pg = new_page()
        try:
            goto(pg, "text")
            text = prose(400_000, seed=2)
            put(pg, 0, text)
            pg.get_by_role("button", name="UPPERCASE", exact=True).click()
            pg.wait_for_function("() => document.querySelector('pre')?.textContent.length >= 200000", timeout=60000)
            assert (pg.locator("pre").first.text_content() or "") == text.upper()[:200_000]
            assert "Showing the first 200,000 of 400" in (pg.locator("main").text_content() or "")
            wait_idle(pg)
            # Copy uses the full output, not the preview
            pg.evaluate("() => { window.__clip = ''; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__clip = String(t); } }, configurable: true }); }")
            pg.get_by_role("button", name="Copy", exact=True).first.click()
            pg.wait_for_timeout(300)
            assert pg.evaluate("window.__clip.length") >= len(text), "copy did not use the full output"
        finally:
            ctx.close()

    check("text: output pane is capped at 200,000 chars with a note; Copy uses the full output", preview_cap)

    def invalid_b64():
        ctx, pg = new_page()
        try:
            goto(pg, "text")
            put(pg, 0, "not base64!!")
            pg.get_by_role("button", name="Decode Base64", exact=True).click()
            pg.get_by_text("That is not valid Base64.").wait_for()
        finally:
            ctx.close()

    check("text: transform error is still shown (invalid Base64)", invalid_b64)

    def heavy_textarea_is_usable():
        ctx, pg = new_page()
        try:
            goto(pg, "text")
            put(pg, 0, prose(2_000_000, seed=4, newline_every=9))
            pg.get_by_role("button", name="Number lines", exact=True).click()
            pg.get_by_role("button", name="lowercase", exact=True).click()
            wait_idle(pg)
            put(pg, 0, "Hello")
            pg.wait_for_function("() => document.querySelector('pre')?.textContent === 'hello'", timeout=30000)
        finally:
            ctx.close()

    check("text: buttons stay clickable during a 2 MB run; shrinking the text returns to the inline path", heavy_textarea_is_usable)

    def cancel():
        ctx, pg = new_page()
        try:
            goto(pg, "text")
            body = "\n".join(f"line{random.Random(i).randrange(10**9)}" for i in range(700_000))
            for label in ("Lines · Sort lines A→Z", "Lines · Dedupe lines", "Lines · Sort lines A→Z", "Lines · Sort lines A→Z"):
                pg.locator("select").first.select_option(label=label)
            put(pg, 0, body)
            btn = pg.get_by_role("button", name="Cancel transform")
            btn.wait_for(timeout=30000)
            assert any("Transforming text" in s for s in status_text(pg)), status_text(pg)
            btn.click()
            pg.get_by_text("Transform cancelled.").wait_for(timeout=10000)
            assert pg.get_by_role("button", name="Cancel transform").count() == 0
            put(pg, 0, "Abc")
            pg.get_by_role("button", name="UPPERCASE", exact=True).click()
            pg.wait_for_function("() => document.querySelector('pre')?.textContent !== 'Pick a transform.' && document.querySelector('pre')?.textContent.length < 30", timeout=30000)
        finally:
            ctx.close()

    check("text: Cancel transform stops a heavy chain; the tool works afterwards", cancel)

    def long_task_blob():
        long_task_vs_floor("text", None, [prose(8_800_000, seed=1)], ready=lambda pg: wait_idle(pg, 120000))

    check("text: 8.8 MB single-line paste + title case: max long task <= floor + 200 ms", long_task_blob)

    def long_task_lines():
        text = prose(6_000_000, seed=9, newline_every=6)

        def ready(pg):
            pg.get_by_role("button", name="Sort lines A→Z", exact=True).click()
            wait_idle(pg, 120000)

        long_task_vs_floor("text", None, [text], ready=ready, settle_ms=6000)

    check("text: 6 MB multi-line paste + sort lines: max long task <= floor + 200 ms", long_task_lines)

# --- CSV profiler -------------------------------------------------------------------------------------------------
import re
from pathlib import Path
from datetime import datetime


def py_guess(values):
    present = [v for v in values if v.strip() != ""]
    if not present:
        return "empty"
    if all(re.fullmatch(r"(?i)true|false", v) for v in present):
        return "boolean"
    if all(re.fullmatch(r"\s*[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*", v, re.I) for v in present):
        return "number"
    if all(re.match(r"\d{4}-\d{2}-\d{2}(?:$|T)", v) and _valid_date(v[:10]) for v in present):
        return "date"
    return "text"


def _valid_date(s):
    try:
        datetime.strptime(s, "%Y-%m-%d")
        return True
    except ValueError:
        return False


def py_profile(text, delim=","):
    rows = [r for r in csv.reader(io.StringIO(text), delimiter=delim) if not (len(r) == 1 and r[0].strip() == "")]
    header, body = rows[0], rows[1:]
    out = []
    for i, name in enumerate(header):
        values = [r[i] if i < len(r) else "" for r in body]
        present = [v for v in values if v.strip() != ""]
        out.append((name or f"Column {i + 1}", py_guess(values), str(len(values) - len(present)), str(len(set(present))), len(values)))
    return out


def profile_csv_text(rnd_seed, rows):
    rnd = random.Random(rnd_seed)
    lines = ["id,name,flag,joined,score,note,empty_col,mixed"]
    for i in range(rows):
        flag = rnd.choice(["true", "FALSE", "", "True"])
        joined = rnd.choice(["2024-01-15", "2025-03-02T10:00:00Z", "", "2023-12-31"])
        score = rnd.choice([f"{rnd.random():.4f}", "", "-3", "1e3"])
        note = rnd.choice(["plain", '"quoted, with comma"', '"say ""hi"""', ""])
        mixed = rnd.choice(["12", "x", "3.5", ""])
        lines.append(f"{i},{rnd.choice(NATO)}{rnd.randrange(500)},{flag},{joined},{score},{note},,{mixed}")
    return "\n".join(lines)


def read_profile_table(pg):
    rows = pg.locator("table tbody tr").evaluate_all("trs => trs.map(tr => [...tr.children].map(td => td.textContent))")
    return [(r[0], r[1], r[2], r[3]) for r in rows]


def csv_profile_equal(text, label, delim=","):
    ctx, pg = new_page()
    try:
        goto(pg, "csv-profile")
        put(pg, 0, text)
        exp = py_profile(text, delim)
        want = [(n, t, m, u) for n, t, m, u, _ in exp]
        pg.wait_for_function("(n) => document.querySelectorAll('table tbody tr').length === n", arg=len(want), timeout=60000)
        wait_idle(pg)
        pg.wait_for_timeout(300)
        eq(str(read_profile_table(pg)), str(want), f"{label} profile")
        assert f"Data rows{exp[0][4]}" in (pg.locator("main").text_content() or ""), "Data rows tile"
    finally:
        ctx.close()


def csv_profile():
    check("csv-profile: default sample (inline path) shows the expected profile", _default_sample)
    check("csv-profile: 400-row quoted CSV (inline) matches csv + type rules", lambda: csv_profile_equal(profile_csv_text(1, 400), "small"))
    check("csv-profile: 5000-row CSV above the inline limit (worker) matches csv + type rules", lambda: csv_profile_equal(profile_csv_text(2, 5000), "worker"))

    def semicolon():
        ctx, pg = new_page()
        try:
            goto(pg, "csv-profile")
            put(pg, 0, "a;b\n1;x\n2;\n")
            pg.get_by_label("Delimiter").first.select_option(label="Semicolon")
            pg.wait_for_function("() => document.querySelectorAll('table tbody tr').length === 2")
            eq(str(read_profile_table(pg)), str([("a", "number", "0", "2"), ("b", "text", "1", "1")]), "semicolon")
        finally:
            ctx.close()

    check("csv-profile: delimiter change re-profiles", semicolon)

    def long_task():
        long_task_vs_floor("csv-profile", None, [big_csv(160_000)], ready=lambda pg: pg.wait_for_function("(a) => document.querySelector('table tbody tr td')?.textContent === 'id' && (" + STAT_IS + ")(a)", arg=["Data rows", "160000"], timeout=120000))

    check("csv-profile: 8 MB CSV paste: max long task <= floor + 200 ms", long_task)

    def cancel():
        ctx, pg = new_page()
        try:
            goto(pg, "csv-profile")
            put(pg, 0, big_csv(260_000))
            btn = pg.get_by_role("button", name="Cancel profiling")
            btn.wait_for(timeout=60000)
            assert any("Profiling columns" in x for x in status_text(pg)), status_text(pg)
            btn.click()
            pg.get_by_text("Profiling cancelled.").wait_for(timeout=10000)
            put(pg, 0, "a,b\n1,2\n3,\n")
            pg.wait_for_function("() => document.querySelectorAll('table tbody tr').length === 2")
            eq(str(read_profile_table(pg)), str([("a", "number", "0", "2"), ("b", "number", "1", "1")]), "after cancel")
        finally:
            ctx.close()

    check("csv-profile: Cancel profiling stops the run; the tool works afterwards", cancel)


def _default_sample():
    ctx, pg = new_page()
    try:
        goto(pg, "csv-profile")
        got = read_profile_table(pg)
        eq(str(got), str([("name", "text", "0", "2"), ("age", "number", "0", "2"), ("active", "boolean", "0", "2"), ("joined", "date", "1", "2")]), "default sample")
    finally:
        ctx.close()


# --- Diff -----------------------------------------------------------------------------------------------------------
def lcs_len(a, b):
    prev = [0] * (len(b) + 1)
    for x in a:
        cur = [0]
        for j, y in enumerate(b):
            cur.append(prev[j] + 1 if x == y else max(prev[j + 1], cur[j]))
        prev = cur
    return prev[-1]


def diff_lines(n, prefix, seed, change=0.5):
    rnd = random.Random(seed)
    return [f"{prefix}{rnd.choice(NATO)} {rnd.randrange(10**6)}" for _ in range(n)]


def diff_pair(n, seed, change=0.1, prefix=""):
    a = diff_lines(n, prefix, seed)
    rnd = random.Random(seed + 1)
    b = []
    for line in a:
        r = rnd.random()
        if r < change / 2:
            continue
        b.append(line if r > change else prefix + f"changed {rnd.randrange(10**6)}")
        if rnd.random() < change / 4:
            b.append(prefix + f"inserted {rnd.randrange(10**6)}")
    return a, b


def read_diff_stats(pg):
    t = pg.locator("main").text_content() or ""
    m = re.search(r"(\d+) addeds? \u00b7 (\d+) removeds? \u00b7 (\d+) unchangeds?", t)
    assert m, "no stats line"
    return tuple(int(x) for x in m.groups())


def apply_unified_patch(left: str, patch: str) -> str:
    """Apply `patch` to `left` with the system patch(1) and return the result."""
    import subprocess
    import tempfile
    if not patch.strip():
        return left
    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp) / "left.txt"
        target.write_text(left)
        (Path(tmp) / "p.diff").write_text(patch)
        done = subprocess.run(["patch", "--no-backup-if-mismatch", "-s", str(target), str(Path(tmp) / "p.diff")], capture_output=True, text=True)
        assert done.returncode == 0, f"patch failed: {done.stdout[:200]} {done.stderr[:200]}"
        return target.read_text()


def diff_check(a_lines, b_lines, label, timeout=90000):
    """Stats must be minimal (LCS oracle) and the unified patch must rebuild both sides exactly."""
    ctx, pg = new_page()
    try:
        goto(pg, "diff")
        put(pg, 0, "\n".join(a_lines))
        put(pg, 1, "\n".join(b_lines))
        lcs = lcs_len(a_lines, b_lines)
        want = (len(b_lines) - lcs, len(a_lines) - lcs, lcs)
        pg.wait_for_function("(w) => { const t = document.querySelector('main').textContent; return t.includes(w[0] + ' added') && t.includes(w[1] + ' removed') && t.includes(w[2] + ' unchanged'); }", arg=[str(x) for x in want], timeout=timeout)
        wait_idle(pg)
        eq(str(read_diff_stats(pg)), str(want), f"{label} stats")
        # patch: copy via the button with a stubbed clipboard
        pg.evaluate("() => { window.__clip = ''; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__clip = String(t); } }, configurable: true }); }")
        pg.get_by_role("button", name="Copy patch").click()
        pg.wait_for_function("() => window.__clip.length > 0")
        patch_text = pg.evaluate("window.__clip")
        assert patch_text.startswith("--- left\n+++ right\n") or patch_text == "", patch_text[:60]
        # the oracle is the system `patch` tool: the copied patch must turn left into right exactly (real unified diff, hunk headers)
        eq(apply_unified_patch("\n".join(a_lines), patch_text), "\n".join(b_lines), f"{label} `patch` turns left into right")
        return pg, ctx
    except Exception:
        ctx.close()
        raise


def diff_small():
    a, b = diff_pair(60, 5, 0.3)
    ctx = diff_check(a, b, "small")[1]
    ctx.close()


def diff_worker():
    a, b = diff_pair(1500, 6, 0.2, prefix="line of some text: ")  # > 400 lines: worker path
    ctx = diff_check(a, b, "worker")[1]
    ctx.close()


def diff_default_marks():
    ctx, pg = new_page()
    try:
        goto(pg, "diff")
        cells = pg.locator("table tbody tr").evaluate_all("trs => trs.map(tr => [...tr.children].map(td => td.textContent))")
        eq(str(cells), str([["shared setup", "shared setup"], ["old implementation", "new implementation, refined"], ["keep this line", "keep this line"], ["final line", "appended line"]]), "default rows")
        marked = pg.locator('table tbody tr span[class*="bg-danger/25"]').evaluate_all("els => els.map(e => e.textContent)")
        assert "old" in marked and "new" in marked, marked
    finally:
        ctx.close()


def diff_paging():
    ctx, pg = new_page()
    try:
        goto(pg, "diff")
        a, b = diff_lines(1200, "x", 1), diff_lines(1200, "y", 2)  # every line differs
        put(pg, 0, "\n".join(a))
        put(pg, 1, "\n".join(b))
        pg.get_by_text("Showing the first").wait_for(timeout=60000)
        first = pg.locator("table tbody tr").count()
        assert 20 < first < 600, first
        pg.get_by_role("button", name="Show more rows").click()
        pg.wait_for_function("(n) => document.querySelectorAll('table tbody tr').length > n", arg=first)
        pg.get_by_role("button", name="Show all rows (can be slow)").click()
        pg.wait_for_function("() => document.querySelectorAll('table tbody tr').length === 1200", timeout=60000)
        assert pg.get_by_text("Showing the first").count() == 0
        # unified patch view is capped for huge patches only; this one (~40 kB) is shown whole
        pg.get_by_role("combobox").first.select_option("patch")
        txt = pg.locator("pre").first.text_content() or ""
        lines = txt.split("\n")
        assert txt.startswith("--- left\n+++ right\n@@ -1,1200 +1,1200 @@\n-x"), txt[:80]
        assert sum(1 for l in lines if l.startswith("-x")) == 1200 and sum(1 for l in lines if l.startswith("+y")) == 1200, "every line is listed"
    finally:
        ctx.close()


def diff_over_cap():
    ctx, pg = new_page()
    try:
        goto(pg, "diff")
        put(pg, 0, "\n".join(f"a{i}" for i in range(2500)))
        put(pg, 1, "b")
        pg.get_by_text("Too many lines (2500); the cap is 2000 per side.").wait_for()
    finally:
        ctx.close()


def diff_cancel():
    ctx, pg = new_page()
    try:
        goto(pg, "diff")
        # the comparison itself takes well under a second, which is shorter than the 300 ms + one status tick it takes for the
        # Cancel button to show; a slow CPU is exactly when Cancel matters, so emulate one with busy-loop workers fighting for the cores
        pg.evaluate("() => { window.__hogs = Array.from({ length: 24 }, () => new Worker(URL.createObjectURL(new Blob(['for(;;){}'])))); }")
        a = [f"left line {i:05d} " + "word " * 20 for i in range(2000)]
        b = [f"right line {i:05d} " + "term " * 20 for i in range(2000)]
        # the Cancel button only lives for a moment: a MutationObserver clicks it the instant it appears (a real DOM click on the real button)
        pg.evaluate("""() => {
          window.__cancelClicks = 0;
          new MutationObserver(() => {
            const b = [...document.querySelectorAll('[data-agent-region=work-status] button')].find(x => x.textContent.trim() === 'Cancel diff');
            if (b) { window.__cancelClicks += 1; b.click(); }
          }).observe(document.body, { childList: true, subtree: true });
        }""")
        put(pg, 0, "\n".join(a))
        put(pg, 1, "\n".join(b))
        pg.wait_for_function("() => window.__cancelClicks > 0", timeout=60000)
        pg.get_by_text("Diff cancelled.").wait_for(timeout=15000)
        assert pg.get_by_role("button", name="Cancel diff").count() == 0
        pg.evaluate("() => window.__hogs.forEach(w => w.terminate())")
        put(pg, 0, "a\nb")
        put(pg, 1, "a\nc")
        pg.wait_for_function("() => /1 addeds? \\u00b7 1 removeds? \\u00b7 1 unchangeds?/.test(document.querySelector('main').textContent)", timeout=30000)
    finally:
        ctx.close()


def diff():
    check("diff: default texts (inline) render the same rows and word marks", diff_default_marks)
    check("diff: 60-line diff (inline) is minimal (LCS oracle) and the patch rebuilds both sides", diff_small)
    check("diff: 1500-line diff (worker) is minimal (LCS oracle) and the patch rebuilds both sides", diff_worker)
    check("diff: over 2000 lines still shows the cap message", diff_over_cap)
    check("diff: huge diffs are paged (Show more rows / Show all rows) and the patch view lists everything", diff_paging)
    check("diff: Cancel diff stops a heavy comparison; the tool works afterwards", diff_cancel)

    def lt_over_cap():
        rnd = random.Random(1)
        a = "\n".join(f"line {i} {rnd.choice(NATO)} {rnd.randrange(10**5)}" for i in range(200_000))
        b = "\n".join(f"line {i} {rnd.choice(NATO)} {rnd.randrange(10**5)}" for i in range(200_000))
        long_task_vs_floor("diff", None, [a, b], settle_ms=4000)

    check("diff: 2 x 200k lines (over the cap): max long task <= floor + 200 ms", lt_over_cap)

    def lt_heavy(width):
        a, b = diff_lines(2000, "", 1), diff_lines(2000, "", 2)
        pad = "word " * (width // 5)
        a = [pad + x for x in a]
        b = [pad[:-1] + "!" + x for x in b]  # all lines differ, late in the line
        long_task_vs_floor("diff", None, ["\n".join(a), "\n".join(b)], settle_ms=6000, ready=lambda pg: wait_idle(pg, 120000))

    check("diff: 2000 x 300 chars, every line changed: max long task <= floor + 200 ms", lambda: lt_heavy(300))
    check("diff: 2000 x 1500 chars, every line changed: max long task <= floor + 200 ms", lambda: lt_heavy(1500))



# --- CSV converter (csv slug, tab convert) --------------------------------------------------------------------------
import json as _json

CSV_JSON_PANE = 500_000  # the JSON pane's cap, see JSON_PANE_LIMIT


def py_csv_json(text, delim=",", header=True):
    rows = [r for r in csv.reader(io.StringIO(text), delimiter=delim) if r and not (len(r) == 1 and r[0].strip() == "")]
    if header:
        keys = rows[0]
        recs = [{(k or f"column_{i + 1}"): (r[i] if i < len(r) else "") for i, k in enumerate(keys)} for r in rows[1:]]
    else:
        recs = [{**{f"column_{i + 1}": c for i, c in enumerate(r)}, "row": str(n + 1)} for n, r in enumerate(rows)]
    return _json.dumps(recs, indent=2, ensure_ascii=False), rows


def csv_convert_equal(text, label, delim=",", header=True):
    ctx, pg = new_page()
    try:
        goto(pg, "csv", "convert")
        if not header:
            pg.get_by_role("button", name="Header row").click()
        if delim != ",":
            pg.get_by_label("Delimiter").first.select_option(value=delim)
        put(pg, 0, text)
        want, rows = py_csv_json(text, delim, header)
        shown = want[:CSV_JSON_PANE]
        pg.wait_for_function("(e) => document.querySelector('pre')?.textContent === e", arg=shown, timeout=90000)
        wait_idle(pg)
        txt = pg.locator("main").text_content() or ""
        n_data = len(rows) - (1 if header else 0)
        cols = max(len(r) for r in rows)
        assert f"Rows{n_data}" in txt and f"Columns{cols}" in txt and f"Cells{sum(len(r) for r in rows)}" in txt, f"{label}: stat tiles"
        trs = pg.locator("table tbody tr").count()
        eq(str(trs), str(min(200, n_data)), f"{label} preview rows")
        first = pg.locator("table tbody tr").first.evaluate("tr => [...tr.children].map(td => td.textContent)")
        body = rows[1:] if header else rows
        eq(str(first), str([(body[0][i] if i < len(body[0]) else "") for i in range(cols)]), f"{label} first preview row")
        if n_data > 200:
            assert f"Showing first 200 of {n_data} rows." in txt, "preview note"
        if len(want) > CSV_JSON_PANE:
            assert f"Showing the first {CSV_JSON_PANE:,} of {len(want):,} characters" in txt, "json cap note"
        pg.evaluate("() => { window.__clip = ''; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__clip = String(t); } }, configurable: true }); }")
        pg.get_by_role("button", name="Copy", exact=True).first.click()
        pg.wait_for_function("() => window.__clip.length > 0")
        assert pg.evaluate("window.__clip") == want, f"{label}: Copy is not the whole JSON"
    finally:
        ctx.close()


def csv_convert_text(rows, seed):
    rnd = random.Random(seed)
    lines = ["id,name,note,city"]
    for i in range(rows):
        note = rnd.choice(["plain", '"quoted, with comma"', '"say ""hi"""', '"two\nlines"', ""])
        lines.append(f"{i},{rnd.choice(NATO)}{rnd.randrange(900)},{note},{rnd.choice(NATO)}")
    return "\n".join(lines)


def csv_convert():
    check("csv: small CSV (inline) matches Python csv + json", lambda: csv_convert_equal(csv_convert_text(40, 1), "small"))
    check("csv: no-header mode (inline) matches the column_n / row shape", lambda: csv_convert_equal("a;b;c\r\n1;2\r\n\r\n4;5;6;7\r\n", "no header", ";", False))
    check("csv: 6000-row CSV (worker): JSON pane capped with a note, preview 200 rows, Copy is the whole JSON", lambda: csv_convert_equal(csv_convert_text(6000, 2), "worker"))

    def delimiter_and_clear():
        ctx, pg = new_page()
        try:
            goto(pg, "csv", "convert")
            put(pg, 0, "a|b\n1|2")
            pg.get_by_label("Delimiter").first.select_option(label="Pipe |")
            pg.wait_for_function("() => document.querySelector('pre')?.textContent.includes('\"b\": \"2\"')")
            pg.get_by_role("button", name="Clear").click()
            pg.wait_for_function("() => document.querySelector('pre')?.textContent === '[]'")
            assert "Rows" not in (pg.locator("main").text_content() or "")
        finally:
            ctx.close()

    check("csv: delimiter change re-converts; Clear returns to the empty state", delimiter_and_clear)

    def parse_export():
        # CsvTool's parseDelimited is still imported by the Markdown table converter on the Convert tab
        ctx, pg = new_page()
        try:
            goto(pg, "csv", "convert")  # the Markdown table now sits under the converter on the same tab
            pg.get_by_label("Delimited table").fill("a\tb\n1\t2")
            expect(pg.get_by_label("Markdown table")).to_have_value(re.compile(r"\|\s*a\s*\|\s*b\s*\|"), timeout=15000)
        finally:
            ctx.close()

    check("csv: other tabs that import parseDelimited from CsvTool still work (TSV to Markdown)", parse_export)

    def long_task():
        long_task_vs_floor("csv", "convert", [big_csv(160_000)], ready=lambda pg: pg.wait_for_function(STAT_IS, arg=["Rows", "160000"], timeout=180000), settle_ms=3000)

    check("csv: 8 MB CSV paste: max long task <= floor + 200 ms", long_task)

    def cancel():
        ctx, pg = new_page()
        try:
            goto(pg, "csv", "convert")
            pg.evaluate("() => { window.__hogs = Array.from({ length: 16 }, () => new Worker(URL.createObjectURL(new Blob(['for(;;){}'])))); }")
            pg.evaluate("""() => {
              window.__cancelClicks = 0;
              new MutationObserver(() => {
                const b = [...document.querySelectorAll('[data-agent-region=work-status] button')].find(x => x.textContent.trim() === 'Cancel conversion');
                if (b) { window.__cancelClicks += 1; b.click(); }
              }).observe(document.body, { childList: true, subtree: true });
            }""")
            put(pg, 0, big_csv(160_000))
            pg.wait_for_function("() => window.__cancelClicks > 0", timeout=120000)
            pg.get_by_text("Conversion cancelled.").wait_for(timeout=15000)
            pg.evaluate("() => window.__hogs.forEach(w => w.terminate())")
            put(pg, 0, "a,b\n1,2")
            pg.wait_for_function("() => document.querySelector('pre')?.textContent.includes('\"b\": \"2\"')", timeout=30000)
        finally:
            ctx.close()

    check("csv: Cancel conversion stops a heavy run; the tool works afterwards", cancel)


SUITES = [("text", text_kit), ("csv-profile", csv_profile), ("diff", diff), ("csv", csv_convert)]


def main():
    global browser
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--js-flags=--max-old-space-size=4096"])
        for name, suite in SUITES:
            if ONLY is None or name in ONLY:
                print(f"== {name}", flush=True)
                suite()
        browser.close()
    print(f"\n{PASSES[0]} passed, {len(FAILS)} failed" + (": " + ", ".join(FAILS) if FAILS else ""))
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
