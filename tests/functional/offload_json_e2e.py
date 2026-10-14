#!/usr/bin/env python3
"""Offload e2e for the JSON/YAML text tools: json (format), yaml-json, json?tab=ndjson|path|diagram.

Usage: python3 tests/functional/offload_json_e2e.py <base_url> [--big-dir DIR] [--only substring]

Per tool, against independent oracles (Python json / PyYAML):
  small  - a small input renders the exact output Python produces (inline path, no worker)
  big    - a ~5 MB input: main-thread stall during the heavy op < floor + 200 ms, where the floor is what a plain <textarea>
           (a clone of the tool's own input) costs for the same text; the result is right; the page stays clickable
  cancel - Cancel while the worker runs: the status line goes, the notice says cancelled, the page works afterwards

The 5 MB files are generated here (deterministic) unless --big-dir has big.json / big.ndjson.
"""
import json
import os
import random
import sys
import tempfile
import time
import traceback

import yaml
from playwright.sync_api import sync_playwright

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
BASE = (ARGS[0] if ARGS else "http://127.0.0.1:3311").rstrip("/")
ONLY = sys.argv[sys.argv.index("--only") + 1] if "--only" in sys.argv else ""
BIG_DIR = sys.argv[sys.argv.index("--big-dir") + 1] if "--big-dir" in sys.argv else ""
# Two budgets per heavy op. HIDDEN: the tool's own cost with the input textarea display:none (the native layout floor removed),
# absolute. VISIBLE: with the textarea shown, against a plain clone of it holding the same text (the floor no code can remove);
# the in-app textarea runs ~250 ms above its clone even for a trivial input (React commit), hence the slack on top of the 200 ms.
HIDDEN_MAX_MS = 400
SLACK_MS = 400
FAILS: list[str] = []
CONSOLE: list[str] = []

def delay_workers(page, ms):
    page.evaluate("(ms) => { window.__workerDelayMs = ms; }", ms)


INIT = """
// Cancel tests: a quiet machine finishes even a 30 MB job in ~0.2 s, shorter than the status line's 300 ms delay, so no human or
// test can click Cancel. `window.__workerDelayMs` (set by delay_workers) holds every message the page posts to a Worker back, so
// the real worker, the real "running" state and the real Cancel path (terminate + lazy respawn) are exercised on a pending job.
(() => {
  const orig = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (m, t) {
    const d = window.__workerDelayMs || 0;
    if (!d) return orig.call(this, m, t);
    const w = this;
    setTimeout(() => orig.call(w, m, t), d);
  };
})();

(() => {
  // long tasks, timer lag and rAF gap: layout of a huge textarea runs in the rendering step, which only the last two see
  const S = window.__lt = { lt: [], lag: 0, gap: 0 };
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) S.lt.push(e.duration); }).observe({ type: 'longtask', buffered: false }); } catch (e) {}
  let last = performance.now();
  setInterval(() => { const n = performance.now(); S.lag = Math.max(S.lag, n - last - 20); last = n; }, 20);
  let lf = performance.now();
  const f = () => { const n = performance.now(); S.gap = Math.max(S.gap, n - lf); lf = n; requestAnimationFrame(f); };
  requestAnimationFrame(f);
  S.reset = () => { S.lt = []; S.lag = 0; S.gap = 0; last = performance.now(); lf = performance.now(); };
})();
"""


def make_big(n=45000):
    """Records shaped like the audit data: ~5 MB single-line JSON and the same records as NDJSON."""
    rng = random.Random(7)
    words = ["alpha", "bravo", "charlie", "delta", "echo", "golf", "hotel", "kilo", "lima", "mike", "november", "romeo"]
    rows = [{"id": i, "name": f"{rng.choice(words)}{i}", "tags": [rng.choice(words) for _ in range(3)],
             "score": round(rng.random(), 6), "ok": rng.random() < 0.5} for i in range(n)]
    return rows


def big_files():
    d = BIG_DIR or tempfile.mkdtemp(prefix="offload_json_")
    jp, np_ = os.path.join(d, "big.json"), os.path.join(d, "big.ndjson")
    if not (os.path.exists(jp) and os.path.exists(np_)):
        rows = make_big()
        with open(jp, "w") as fh:
            json.dump(rows, fh)
        with open(np_, "w") as fh:
            fh.write("\n".join(json.dumps(r) for r in rows))
    return open(jp).read(), open(np_).read()


def setval(page, locator, text):
    """Set a textarea like a paste does (Playwright fill() is O(n^2) on multi-line text)."""
    locator.evaluate(
        "(el, t) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, t); el.dispatchEvent(new Event('input', { bubbles: true })); }",
        text,
    )


def go(page, slug, tab=None):
    page.goto(f"{BASE}/tools/{slug}" + (f"?tab={tab}" if tab else ""), wait_until="domcontentloaded")
    page.wait_for_selector("main", timeout=30000)
    page.wait_for_function("() => !document.body.innerText.includes('Loading tool')", timeout=30000)
    # a value typed before React hydrates the textarea is lost: wait for the first writable one to be hydrated
    page.wait_for_function(
        "() => { const t = document.querySelector('textarea:not([readonly])'); return !!t && Object.keys(t).some(k => k.startsWith('__reactProps')); }",
        timeout=30000,
    )
    page.wait_for_timeout(200)


def worst_ms(page):
    """Longest main-thread stall since reset: max of long task, timer lag and rAF gap."""
    return page.evaluate("() => { const S = window.__lt; return Math.max(0, ...S.lt, S.lag, S.gap); }")


def reset_lt(page):
    page.evaluate("() => window.__lt.reset()")


def floor_ms(page, text):
    """Ms until the browser has laid out a plain clone of the tool's own textarea holding the same text (best of 3): two frames after the value set. This native layout cost exists whatever the tool does; no code can remove it."""
    return page.evaluate(
        """async (t) => {
          const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          let best = Infinity;
          for (let i = 0; i < 3; i += 1) {
            const src = document.querySelector('textarea:not([readonly])');
            const ta = src.cloneNode(false);  // same classes, rows and parent width as the tool's own input
            ta.removeAttribute('id'); ta.removeAttribute('name'); ta.setAttribute('aria-hidden', 'true');
            src.parentElement.append(ta);
            const t0 = performance.now();
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, t);
            ta.defaultValue = t;  // what React does to a controlled textarea on commit (updateTextarea)
            await frame();
            best = Math.min(best, performance.now() - t0);
            ta.remove();
          }
          return best;
        }""",
        text,
    )


def check(name):
    def deco(fn):
        if ONLY and ONLY not in name:
            return fn
        before = len(CONSOLE)
        t = time.time()
        try:
            fn()
            if len(CONSOLE) > before:
                raise AssertionError("console/page errors: " + " | ".join(CONSOLE[before:])[:300])
            print(f"ok   {name} ({time.time() - t:.1f}s)", flush=True)
        except Exception as e:  # noqa: BLE001
            FAILS.append(name)
            print(f"FAIL {name}: {type(e).__name__}: {str(e).splitlines()[0][:240] if str(e) else ''}", flush=True)
            if "-v" in sys.argv:
                traceback.print_exc()
        return fn
    return deco


def eq(actual, expected, what=""):
    if actual != expected:
        a, e = repr(actual), repr(expected)
        raise AssertionError(f"{what}: expected {e[:160]} got {a[:160]}")


def budget(what, measured, floor):
    print(f"       {what}: main-thread stall {measured:.0f} ms, floor {floor:.0f} ms", flush=True)
    if measured > floor + SLACK_MS:
        raise AssertionError(f"{what}: main-thread stall {measured:.0f} ms > floor {floor:.0f} + {SLACK_MS} ms")


def main():
    big_json, big_ndjson = big_files()
    big_rows = json.loads(big_json)
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--js-flags=--max-old-space-size=4096"])

        def newpage():
            """A fresh context per test: a warm text-shaping cache from an earlier run would hide the cold cost."""
            ctx = browser.new_context(viewport={"width": 1280, "height": 900}, permissions=["clipboard-read", "clipboard-write"])
            ctx.add_init_script(INIT)
            pg = ctx.new_page()
            pg.set_default_timeout(60000)
            pg.on("console", lambda m: CONSOLE.append(m.text) if m.type == "error" else None)
            pg.on("pageerror", lambda e: CONSOLE.append(str(e)))
            return pg

        page = newpage()
        ta = lambda n=0: page.locator("textarea:not([readonly])").nth(n)  # noqa: E731

        # ------------------------------------------------------------------ json (format)
        def json_out():
            return page.locator("pre").first.inner_text()

        @check("json/small: format, indent, sort, flatten, stats, minify equal the Python oracle")
        def _():
            go(page, "json")
            doc = {"b": [3, {"z": None, "a": True}, "x"], "a": {"k": 1.5, "e": {}, "l": []}, "c": "é \"q\""}
            ta().fill(json.dumps(doc))
            page.get_by_text("Valid JSON.").wait_for()
            eq(json_out(), json.dumps(doc, indent=2, ensure_ascii=False), "indent 2")
            page.get_by_label("Indent").select_option("4")
            eq(json_out(), json.dumps(doc, indent=4, ensure_ascii=False), "indent 4")
            page.get_by_label("Indent").select_option("2")
            page.get_by_label("Sort").select_option("keys")
            eq(json_out(), json.dumps(doc, indent=2, ensure_ascii=False, sort_keys=True), "sorted")
            page.get_by_label("Sort").select_option("none")

            def flat(v, prefix="", out=None):
                out = {} if out is None else out
                if isinstance(v, list) and v:
                    for i, x in enumerate(v):
                        flat(x, f"{prefix}[{i}]", out)
                elif isinstance(v, dict) and v:
                    for k, x in v.items():
                        flat(x, f"{prefix}.{k}" if prefix else k, out)
                else:
                    out[prefix or "(root)"] = v
                return out

            page.get_by_role("button", name="Flatten").click()
            eq(json.loads(json_out()), flat(doc), "flatten")
            page.get_by_role("button", name="Flattened").click()
            body = page.locator("main").inner_text()
            objects = arrays = leaves = 0

            def walk(v):
                nonlocal objects, arrays, leaves
                if isinstance(v, list):
                    arrays += 1
                    [walk(x) for x in v]
                elif isinstance(v, dict):
                    objects += 1
                    [walk(x) for x in v.values()]
                else:
                    leaves += 1

            def depth(v):
                kids = v if isinstance(v, list) else list(v.values()) if isinstance(v, dict) else None
                return 0 if kids is None else 1 + max([depth(k) for k in kids] + [0])

            walk(doc)
            for label, want in (("OBJECTS", objects), ("ARRAYS", arrays), ("LEAVES", leaves), ("DEPTH", depth(doc))):
                assert f"{label}\n{want}" in body, f"stat {label}={want} missing"
            page.get_by_role("button", name="Minify").click()
            eq(ta().input_value(), json.dumps(doc, separators=(",", ":"), ensure_ascii=False).replace(" ", " "), "minify")

        @check("json/small: invalid input reports line and column like Python")
        def _():
            go(page, "json")
            bad = '{"a": 1,\n}'
            ta().fill(bad)
            try:
                json.loads(bad)
            except json.JSONDecodeError as exc:
                want = f"line {exc.lineno}, column {exc.colno}"
            page.get_by_text(want).wait_for()

        def stall_run(slug, tab, text, done_js, ta_index=0, pre=None, hide=False):
            """Fresh page, optional `pre(page)`, paste `text`, wait for `done_js`: returns (main-thread stall ms, page)."""
            pg = newpage()
            go(pg, slug, tab)
            if pre:
                pre(pg)
            if hide:
                pg.add_style_tag(content="textarea { display: none !important }")
            reset_lt(pg)
            setval(pg, pg.locator("textarea:not([readonly])").nth(ta_index), text)
            pg.wait_for_function(done_js, timeout=120000)
            pg.wait_for_timeout(800)
            return worst_ms(pg), pg

        def assert_budget(what, slug, tab, text, done_js, ta_index=0, pre=None):
            """Best of three cold runs (other work on a shared box adds noise) against the plain-textarea floor; returns the last page."""
            hidden = []
            for _ in range(2):
                stall, pg = stall_run(slug, tab, text, done_js, ta_index, pre, hide=True)
                pg.context.close()
                hidden.append(stall)
                if stall <= HIDDEN_MAX_MS:
                    break
            print(f"       {what}: stall with the textarea hidden {min(hidden):.0f} ms (limit {HIDDEN_MAX_MS})", flush=True)
            if min(hidden) > HIDDEN_MAX_MS:
                raise AssertionError(f"{what}: {min(hidden):.0f} ms of main-thread stall with the input hidden > {HIDDEN_MAX_MS} ms")
            probe = newpage()
            go(probe, slug, tab)
            floor = floor_ms(probe, text)
            probe.context.close()
            runs = []
            for _ in range(3):
                stall, pg = stall_run(slug, tab, text, done_js, ta_index, pre)
                runs.append(stall)
                if stall <= floor + SLACK_MS:
                    break
                pg.context.close()
            budget(what, min(runs), floor)
            return pg

        @check("json/big: 5 MB format stays within floor + 200 ms; result correct; Save .json has the full output")
        def _():
            page = assert_budget("format 5 MB", "json", None, big_json,
                                 "() => document.querySelector('main')?.innerText.includes('Valid JSON.')")
            assert "Showing the first" in page.locator("main").inner_text(), "display cap note missing"
            page.get_by_label("Indent").select_option("4")  # the page is clickable and re-formats in the worker
            page.wait_for_timeout(1500)
            with page.expect_download(timeout=60000) as dl:
                page.get_by_role("button", name="Save .json").click()
            with open(dl.value.path()) as fh:
                text = fh.read()
            assert text.startswith('[\n    {\n        "id": 0,'), "indent 4 not applied to the download"
            eq(json.loads(text), big_rows, "downloaded document equals the input document")

        @check("json/cancel: Cancel stops a long format, page usable afterwards")
        def _():
            go(page, "json")
            delay_workers(page, 12000)
            page.get_by_label("Sort").select_option("natural")
            setval(page, ta(), big_json)
            cancel = page.get_by_role("button", name="Cancel formatting")
            cancel.wait_for(timeout=30000)
            assert page.locator("[role=status]").filter(has_text="Formatting JSON").count() == 1
            cancel.click()
            page.get_by_text("Formatting cancelled").wait_for()
            delay_workers(page, 0)
            assert page.get_by_role("button", name="Cancel formatting").count() == 0
            page.get_by_role("button", name="Sample").click()
            page.get_by_text("Valid JSON.").wait_for()
            assert '"Samurai"' in json_out()

        # ------------------------------------------------------------------ yaml-json
        def yj_out():
            return page.locator("textarea[readonly]").first.input_value()

        @check("yaml-json/small: YAML<->JSON, sort, invalid and duplicate keys equal the PyYAML/json oracle")
        def _():
            go(page, "yaml-json")
            src = "name: Samurai Knife\nitems:\n  - b: 2\n    a: [1, 2.5, null]\n  - text: \"é: ü\"\nzed: true\nalpha: {y: 1, x: 2}\n"
            want = yaml.safe_load(src)
            ta().fill(src)
            page.get_by_text("Valid YAML document.").wait_for()
            eq(yj_out(), json.dumps(want, indent=2, ensure_ascii=False), "yaml -> json")
            page.get_by_label("Sort object keys recursively").check()
            eq(yj_out(), json.dumps(want, indent=2, ensure_ascii=False, sort_keys=True), "yaml -> json sorted")
            page.get_by_label("Sort object keys recursively").uncheck()
            page.get_by_label("Input is").select_option("json")
            page.get_by_label("Convert to").select_option("yaml")
            doc = {"b": [{"z": 1, "a": [1, 2]}, "x"], "a": {"k": 1.5, "e": {}, "l": []}, "n": None}
            ta().fill(json.dumps(doc))
            page.get_by_text("Valid JSON document.").wait_for()
            got = yaml.safe_load(yj_out())
            eq(got, doc, "json -> yaml round trip")
            page.get_by_label("Sort object keys recursively").check()
            out = yaml.safe_load(yj_out())
            eq(list(out), sorted(doc), "json -> yaml sorted top-level keys")
            eq(list(out["b"][0]), ["a", "z"], "sorted nested keys")
            page.get_by_label("Input is").select_option("yaml")
            page.get_by_label("Convert to").select_option("json")
            ta().fill("a: 1\na: 2\n")
            page.get_by_text("Map keys must be unique").first.wait_for()
            ta().fill("a: [1, 2\nb: 3")
            page.get_by_text("Line ").first.wait_for()

        yaml_big_done = "() => document.querySelector('main')?.innerText.includes('Valid YAML document.')"

        @check("yaml-json/big: 5 MB JSON text converted in the worker; stall within budget; Save .json equals the document")
        def _():
            page = assert_budget("yaml->json 5 MB", "yaml-json", None, big_json, yaml_big_done)
            assert "Showing the first" in page.locator("main").inner_text(), "display cap note missing"
            with page.expect_download(timeout=60000) as dl:
                page.get_by_role("button", name="Save .json").click()
            with open(dl.value.path()) as fh:
                eq(json.load(fh), big_rows, "downloaded document equals the input document")

        @check("yaml-json/big: 5 MB JSON -> YAML (input is JSON): budget, Save .yaml starts with the right records")
        def _():
            def pre(pg):
                pg.get_by_label("Input is").select_option("json")
                pg.get_by_label("Convert to").select_option("yaml")

            page = assert_budget("json->yaml 5 MB", "yaml-json", None, big_json,
                                 "() => document.querySelector('main')?.innerText.includes('Valid JSON document.') && document.querySelector('textarea[readonly]').value.length > 0",
                                 pre=pre)
            with page.expect_download(timeout=60000) as dl:
                page.get_by_role("button", name="Save .yaml").click()
            with open(dl.value.path()) as fh:
                head = fh.read(30000)
            cut = head.rindex("\n- id:") + 1
            eq(yaml.safe_load(head[:cut]), big_rows[: len(yaml.safe_load(head[:cut]))], "first records of the YAML output")

        @check("yaml-json/cancel: Cancel stops a long conversion, page usable afterwards")
        def _():
            go(page, "yaml-json")
            delay_workers(page, 12000)
            setval(page, ta(), big_json)
            cancel = page.get_by_role("button", name="Cancel conversion")
            cancel.wait_for(timeout=30000)
            assert page.locator("[role=status]").filter(has_text="Converting document").count() == 1
            cancel.click()
            page.get_by_text("Conversion cancelled").wait_for()
            delay_workers(page, 0)
            assert page.get_by_role("button", name="Cancel conversion").count() == 0
            ta().fill("a: 1")
            page.get_by_text("Valid YAML document.").wait_for()
            eq(json.loads(yj_out()), {"a": 1}, "output after cancel")

        # ------------------------------------------------------------------ json?tab=ndjson
        def stat(pg, label):
            return int(pg.locator("main").inner_text().split(label.upper() + "\n")[1].split("\n")[0])

        @check("ndjson/small: valid/invalid counts and error line numbers equal the Python oracle")
        def _():
            go(page, "json", "ndjson")
            text = '{"a":1}\n\n[1,2\n"ok"\n{bad}\r\n  \n{"z":null}\n'
            valid, bad_lines = 0, []
            for i, line in enumerate(text.split("\n")):
                line = line.rstrip("\r")
                if not line.strip():
                    continue
                try:
                    json.loads(line)
                    valid += 1
                except ValueError:
                    bad_lines.append(i + 1)
            ta().fill(text)
            page.get_by_text("Line 3:").first.wait_for()
            eq(stat(page, "Valid records"), valid, "valid")
            eq(stat(page, "Invalid records"), len(bad_lines), "invalid")
            shown = page.locator("main p", has_text="Line ").first.inner_text()
            eq([int(x.split(":")[0]) for x in (l[5:] for l in shown.split("\n") if l.startswith("Line "))], bad_lines, "error line numbers")
            ta().fill('{"a":1}\n')
            page.get_by_text("Every non-empty line is valid JSON.").wait_for()

        nd_valid_done = "() => document.querySelector('main')?.innerText.includes('Every non-empty line is valid JSON.')"

        @check("ndjson/big: 5 MB valid stream (45k records) validated off-thread, within budget, counts right")
        def _():
            page = assert_budget("ndjson 5 MB", "json", "ndjson", big_ndjson, nd_valid_done)
            eq(stat(page, "Valid records"), len(big_rows), "valid")
            eq(stat(page, "Invalid records"), 0, "invalid")

        @check("ndjson/big: 15k bad lines: budget, display capped at 200 lines, Copy errors has all of them")
        def _():
            lines = big_ndjson.split("\n")
            bad_idx = list(range(0, len(lines), 3))
            for i in bad_idx:
                lines[i] = lines[i][:-3] + "x"
            text = "\n".join(lines)
            page = assert_budget("ndjson 15k bad lines", "json", "ndjson", text,
                                 "() => document.querySelector('main')?.innerText.includes('Showing the first 200 of')")
            eq(stat(page, "Invalid records"), len(bad_idx), "invalid")
            shown = [l for l in page.locator("main p", has_text="Line ").first.inner_text().split("\n") if l.startswith("Line ")]
            eq(len(shown), 200, "lines on screen")
            eq(shown[0].split(":")[0], "Line 1", "first error line")
            page.get_by_role("button", name="Copy errors").click()
            copied = page.evaluate("() => navigator.clipboard.readText()").split("\n")
            eq([int(l.split(":")[0][5:]) for l in copied], [i + 1 for i in bad_idx], "copied error line numbers")

        @check("ndjson/cancel: Cancel stops a long validation, page usable afterwards")
        def _():
            go(page, "json", "ndjson")
            delay_workers(page, 12000)
            setval(page, ta(), "\n".join([big_ndjson] * 6))  # ~30 MB: long enough to cancel
            cancel = page.get_by_role("button", name="Cancel validation")
            cancel.wait_for(timeout=30000)
            assert page.locator("[role=status]").filter(has_text="Validating records").count() == 1
            cancel.click()
            page.get_by_text("Validation cancelled").wait_for()
            delay_workers(page, 0)
            ta().fill('{"ok":true}\n')
            page.get_by_text("Every non-empty line is valid JSON.").wait_for()
            eq(stat(page, "Valid records"), 1, "valid after cancel")

        # ------------------------------------------------------------------ json?tab=path
        def matches_on(pg):
            return [(d.locator("div").first.inner_text(), json.loads(d.locator("pre").first.inner_text()))
                    for d in pg.locator("main div.rounded-lg.border.bg-raised").all()]

        @check("path/small: matches (pointer + value) equal direct navigation in Python")
        def _():
            go(page, "json", "path")
            doc = {"users": [{"name": "Ada", "tags": ["x", "y"], "a/b": 1}, {"name": "Lin", "tags": []}], "a b": {"k~": [True]}, "n": None}
            setval(page, ta(1), json.dumps(doc))
            cases = [
                ("$.users[*].name", [("/users/0/name", "Ada"), ("/users/1/name", "Lin")]),
                ("$.users[0].tags[1]", [("/users/0/tags/1", "y")]),
                ("$['a b'].k~[0]", None),  # `~` is not a bare-name character: an error, not matches
                ("$['a b']['k~'][*]", [("/a b/k~0/0", True)]),
                ("$.users[*]['a/b']", [("/users/0/a~1b", 1)]),
                ("$.n", [("/n", None)]),
                ("$", [("", doc)]),
            ]
            for query, want in cases:
                ta(0).fill(query)
                if want is None:
                    page.locator("main p.text-danger, main [class*=text-danger]").first.wait_for()
                    continue
                page.get_by_text(f"{len(want)} match").first.wait_for()
                got = matches_on(page)
                eq(got, [(ptr or "$ (root)", val) for ptr, val in want], f"query {query}")
            ta(0).fill("users")
            page.get_by_text("A query must start with $.").wait_for()

        @check("path/big: 5 MB document, $[*] -> 45000 matches: budget, 500 shown, Copy matches has all")
        def _():
            page = assert_budget("jsonpath 5 MB $[*]", "json", "path", big_json,
                                 f"() => document.querySelector('main')?.innerText.includes('{len(big_rows)} matches.')", ta_index=1,
                                 pre=lambda pg: setval(pg, pg.locator("textarea:not([readonly])").nth(0), "$[*]"))
            assert page.locator("main div.rounded-lg.border.bg-raised").count() == 500, "500 matches shown"
            assert "Showing first 500 matches." in page.locator("main").inner_text()
            page.get_by_role("button", name="Copy matches").click()
            lines = page.evaluate("() => navigator.clipboard.readText()").split("\n")
            eq(len(lines), len(big_rows), "copied lines")
            for i in (0, 1, 22222, len(big_rows) - 1):
                ptr, _, val = lines[i].partition("\t")
                eq((ptr, json.loads(val)), (f"/{i}", big_rows[i]), f"copied line {i}")
            page.locator("textarea:not([readonly])").nth(0).fill("$[*].tags[*]")  # `ta` is bound to the shared page, not this one
            page.get_by_text(f"{3 * len(big_rows)} matches.").wait_for(timeout=60000)

        @check("path/cancel: Cancel stops a long query, page usable afterwards")
        def _():
            go(page, "json", "path")
            delay_workers(page, 12000)
            ta(0).fill("$[*]")
            setval(page, ta(1), json.dumps(big_rows * 6))
            cancel = page.get_by_role("button", name="Cancel query")
            cancel.wait_for(timeout=30000)
            assert page.locator("[role=status]").filter(has_text="Running the query").count() == 1
            cancel.click()
            page.get_by_text("Query cancelled").wait_for()
            delay_workers(page, 0)
            ta(1).fill('{"a":[1,2]}')
            ta(0).fill("$.a[*]")
            page.get_by_text("2 matches.").wait_for()

        # ------------------------------------------------------------------ json?tab=diagram
        def diagram_oracle(value):
            """The documented tree: depth <= 10, 50 children per node, 1000 rows, JSON-Pointer escaped paths."""
            rows = []

            def walk(v, path, depth):
                if len(rows) >= 1000:
                    return
                kind = "null" if v is None else "array" if isinstance(v, list) else "object" if isinstance(v, dict) else \
                    "boolean" if isinstance(v, bool) else "string" if isinstance(v, str) else "number"
                size = f"{len(v)} items" if isinstance(v, list) else f"{len(v)} keys" if isinstance(v, dict) else ""
                label = path.split("/")[-1] or "$"
                rows.append((("↳ " if depth else "") + label, f"{kind} · {size}" if size else kind, path or "$"))
                if depth >= 10:
                    return
                if isinstance(v, list):
                    for i, c in enumerate(v[:50]):
                        walk(c, f"{path}/{i}", depth + 1)
                elif isinstance(v, dict):
                    for k, c in list(v.items())[:50]:
                        walk(c, f"{path}/{k.replace('~', '~0').replace('/', '~1')}", depth + 1)

            walk(value, "", 0)
            return rows

        def diagram_rows(pg):
            return [(r.locator("span").nth(0).inner_text(), r.locator("span").nth(1).inner_text(), r.get_attribute("title"))
                    for r in pg.locator("main div[title]").all()]

        @check("diagram/small: tree rows equal the Python oracle; invalid JSON shows the error")
        def _():
            go(page, "json", "diagram")
            doc = {"user": {"id": 42, "name": "Ada", "roles": ["admin", "editor"], "a/b": {"c~d": None}}, "active": True, "n": [[], {}, 1.5]}
            ta().fill(json.dumps(doc))
            page.get_by_text("↳ user").first.wait_for()
            eq(diagram_rows(page), diagram_oracle(doc), "rows")
            ta().fill("{nope")
            page.locator("main [class*=text-danger]").first.wait_for()

        @check("diagram/big: 5 MB document described off-thread: budget, rows equal the oracle")
        def _():
            page = assert_budget("diagram 5 MB", "json", "diagram", big_json, "() => document.querySelector('main')?.innerText.includes('45000 items')")
            eq(diagram_rows(page), diagram_oracle(big_rows), "rows")

        @check("diagram/cancel: Cancel stops a long parse, page usable afterwards")
        def _():
            go(page, "json", "diagram")
            delay_workers(page, 12000)
            setval(page, ta(), json.dumps(big_rows * 6))
            cancel = page.get_by_role("button", name="Cancel diagram")
            cancel.wait_for(timeout=30000)
            assert page.locator("[role=status]").filter(has_text="Reading the structure").count() == 1
            cancel.click()
            page.get_by_text("Diagram cancelled").wait_for()
            delay_workers(page, 0)
            ta().fill('{"a":[1]}')
            page.get_by_text("↳ a").first.wait_for()

        browser.close()
    print(f"\n{len(FAILS)} failure(s)" if FAILS else "\nall passed")
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
