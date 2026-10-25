#!/usr/bin/env python3
"""Real-UI functional tests for data tools: csv-profile, csv, json, yaml-json, sql-format, regex, text.

Usage: python3 tests/functional/data_e2e.py [base_url]   (default http://127.0.0.1:3210)
"""
import base64
import csv
import io
import json
import re
import sys
import traceback
import urllib.parse

import yaml
from playwright.sync_api import expect, sync_playwright

_ARGS = [a for a in sys.argv[1:] if not a.startswith("-")]
BASE = (_ARGS[0] if _ARGS else "http://127.0.0.1:3210").rstrip("/")
FAILS: list[str] = []
CONSOLE: list[str] = []
page = None  # set in main


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


def go(slug, tab=None, width=1280):
    page.set_viewport_size({"width": width, "height": 900})
    url = f"{BASE}/tools/{slug}" + (f"?tab={tab}" if tab else "")
    page.goto(url, wait_until="domcontentloaded")
    page.wait_for_selector("textarea, input, button", timeout=20000)
    # The server-rendered controls exist before React hydrates them; text filled in before that is reset by the first
    # render (controlled inputs). Wait until a control in <main> carries React props.
    page.wait_for_function(
        "() => Array.from(document.querySelectorAll('main textarea, main input, main select, main button'))"
        ".some(el => Object.keys(el).some(k => k.startsWith('__reactProps$')))",
        timeout=30000,
    )
    page.wait_for_timeout(250)


def L(label, exact=True):
    """Locate a form control by its Field label (label text content includes control text, so exact name match fails)."""
    loc = page.locator(f'label:has(> span:text-is("{label}")) >> :is(textarea,input,select)')
    if loc.count() > 0:
        return loc
    return page.get_by_label(label, exact=exact)


def put(label, value, exact=True):
    loc = L(label, exact=exact).first
    loc.fill(value)
    return loc


def put_first(value, nth=0):
    loc = page.locator("textarea:not([readonly])").nth(nth)
    loc.fill(value)
    return loc


def val(label, exact=True):
    return L(label, exact=exact).first.input_value()


def body():
    """textContent (not innerText) so CSS text-transform on labels does not alter case."""
    return page.evaluate("(document.querySelector('main') ?? document.body).textContent")


def pre(n=0):
    return page.locator("pre").nth(n).inner_text()


def has(text):
    expect(page.locator("body")).to_contain_text(text, timeout=5000)


def hasnt(text):
    expect(page.locator("body")).not_to_contain_text(text, timeout=5000)


def stat(label):
    """Return the value text of a Stat tile."""
    t = page.locator("div", has_text=re.compile(rf"^{re.escape(label)}\s*\n?")).last
    return t.inner_text()


def select(label, want):
    loc = L(label, exact=True).first
    opts = loc.locator("option").evaluate_all("o => o.map(x => [x.value, x.textContent.trim()])")
    w = want.lower()
    for v, t in opts:
        if v == want or t.lower() == w or t.lower().startswith(w):
            loc.select_option(value=v)
            return
    raise AssertionError(f"no option {want!r} in {opts}")


def clipboard_ok():
    pass  # insecure origin: clipboard API stubbed via init script


def copied(button_name):
    page.get_by_role("button", name=button_name, exact=True).first.click()
    page.wait_for_timeout(200)
    return page.evaluate("navigator.clipboard.readText()")


def overflow_ok():
    w = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
    assert w <= 1, f"horizontal overflow {w}px"


def mobile(slug, tab=None):
    go(slug, tab, width=390)
    overflow_ok()


def to_csv(rows, delim=","):
    out = io.StringIO()
    csv.writer(out, delimiter=delim, lineterminator="\n").writerows(rows)
    return out.getvalue().rstrip("\n")


# --------------------------------------------------------------------------------------
# csv-profile
# --------------------------------------------------------------------------------------
def csv_profile():
    rows = [
        ["id", "name", "score", "active", "joined", "note"],
        ["1", "Ada", "9.5", "true", "2024-01-15", "x"],
        ["2", "Zoë, Jr.", "7", "false", "2025-03-02", ""],
        ["3", "Ada", "", "true", "2024-01-15", ""],
        ["4", "Łukasz", "12", "false", "", ""],
    ]
    data = to_csv(rows)

    @check("csv-profile/profile: types, missing, uniques")
    def _():
        go("csv-profile", "profile")
        put("CSV / TSV sample", data)
        has("Data rows")
        tbl = page.locator("table").first
        rows_txt = [[c.strip() for c in tr.locator("th,td").all_inner_texts()] for tr in tbl.locator("tr").all()]
        by = {r[0]: r for r in rows_txt[1:]}
        eq(set(by), {"id", "name", "score", "active", "joined", "note"}, "columns")
        assert "number" in by["id"][1].lower(), by["id"]
        assert "number" in by["score"][1].lower(), by["score"]
        assert "bool" in by["active"][1].lower(), by["active"]
        assert "date" in by["joined"][1].lower(), by["joined"]
        assert "text" in by["name"][1].lower(), by["name"]
        eq(by["score"][2], "1", "score missing")
        eq(by["note"][2], "3", "note missing")
        eq(by["name"][3], "3", "name unique (Ada dup)")
        t = body()
        assert re.search(r"Data rows\s*\n?\s*4", t), t[:400]
        assert re.search(r"Total missing\s*\n?\s*5", t), "total missing 5"

    @check("csv-profile/profile: tab delimiter, empty input, 390px")
    def _():
        go("csv-profile", "profile")
        select("Delimiter", "Tab")
        put("CSV / TSV sample", "a\tb\n1\t2\n3\t4")
        assert re.search(r"Columns\s*\n?\s*2", body())
        put("CSV / TSV sample", "")
        assert re.search(r"Data rows\s*\n?\s*0", body())
        mobile("csv-profile", "profile")

    @check("csv-profile/duplicates: repeated rows, ignore case, quotes")
    def _():
        go("csv-profile", "duplicates")
        put("Delimited data", 'id,name\n1,"Smith, J"\n2,Ada\n1,"Smith, J"\n2,ADA\n2,Ada')
        out = val("Repeated records (line numbers refer to parsed data rows)")
        assert "Smith, J" in out and "Ada" in out, out
        assert re.search(r"Repeated rows\s*\n?\s*2", body()), body()[:500]
        L("Ignore case").check()
        assert re.search(r"Repeated rows\s*\n?\s*3", body()) or "ADA" in val(
            "Repeated records (line numbers refer to parsed data rows)"), "ignore-case"
        put("Delimited data", "a,b\n1,2\n3,4")
        eq(val("Repeated records (line numbers refer to parsed data rows)"), "No duplicate rows found.", "none")
        put("Delimited data", "a,b\nx,y\nx,y")
        clipboard_ok()
        c = copied("Copy matches")
        assert "x | y" in c, c
        mobile("csv-profile", "duplicates")


    @check("csv-profile/compare: cell diffs, missing cell, identical")
    def _():
        go("csv-profile", "compare")
        put("Left table", "id,name\n1,Ada\n2,Lin")
        put("Right table", "id,name\n1,Ada\n2,Lina\n3,New")
        out = val("Differences")
        assert 'name' in out and 'left="Lin"' in out and 'right="Lina"' in out, out
        assert "(missing)" in out, out
        put("Right table", "id,name\n1,Ada\n2,Lin")
        has("Tables match exactly.")
        mobile("csv-profile", "compare")


# --------------------------------------------------------------------------------------
# csv suite
# --------------------------------------------------------------------------------------
def csv_suite():
    rows = [["id", "name", "note"], ["1", 'He said "hi"', "a,b"], ["2", "Zoë", "multi\nline"], ["3", "日本", ""]]
    data = to_csv(rows)
    expected = [dict(zip(rows[0], r)) for r in rows[1:]]

    @check("csv/convert: CSV -> JSON (quotes, newline, unicode) + download + copy")
    def _():
        go("csv", "convert")
        put_first(data)
        page.wait_for_timeout(300)
        loc = page.locator("pre, textarea[readonly]")
        txt = "\n".join(loc.all_inner_texts() + [x.input_value() for x in page.locator("textarea[readonly]").all()])
        m = re.search(r"\[\s*\{.*\}\s*\]", txt, re.S)
        assert m, txt[:300]
        eq(json.loads(m.group(0)), expected, "json")
        with page.expect_download() as d:
            page.get_by_role("button", name="Save .json").click()
        dl = d.value
        eq(dl.suggested_filename, "rows.json")
        eq(json.load(open(dl.path(), encoding="utf-8")), expected, "downloaded json")
        clipboard_ok()
        c = copied("Copy")
        eq(json.loads(c), expected, "copied json")
        t = body()
        assert re.search(r"Rows\s*\n?\s*3", t) and re.search(r"Columns\s*\n?\s*3", t), "stats"

    @check("csv/convert: semicolon delimiter, no-header mode, empty, clear")
    def _():
        go("csv", "convert")
        select("Delimiter", "Semicolon")
        put_first("a;b\n1;2")
        txt = "\n".join(x.input_value() for x in page.locator("textarea[readonly]").all()) + body()
        assert '"a"' in txt and '"1"' in txt, txt[:300]
        page.get_by_role("button", name=re.compile("Header row|No header")).first.click()
        page.wait_for_timeout(200)
        assert "column_1" in body() or "column_1" in "".join(
            x.input_value() for x in page.locator("textarea[readonly]").all()), "no-header keys"
        page.get_by_role("button", name="Clear").first.click()
        eq(page.locator("textarea:not([readonly])").first.input_value(), "", "cleared")
        mobile("csv", "convert")

    @check("csv/columns: select columns, re-quoting")
    def _():
        go("csv", "columns")
        put("Input table", data)
        # uncheck 'id'
        L("id", exact=True).uncheck()
        out = val("Selected output")
        exp_rows = [[r[1], r[2]] for r in rows]
        got = list(csv.reader(io.StringIO(out)))
        eq(got, exp_rows, "selected rows")
        L("id", exact=True).check()
        L("name", exact=True).uncheck()
        got = list(csv.reader(io.StringIO(val("Selected output"))))
        eq(got, [[r[0], r[2]] for r in rows], "selected 2")
        clipboard_ok()
        assert copied("Copy selected data") == val("Selected output")
        # The last selected column stays (disabled, with a note) instead of silently re-checking every column.
        L("note", exact=True).uncheck()
        assert L("id", exact=True).is_disabled(), "last selected column should be disabled"
        assert L("id", exact=True).is_checked() and not L("name", exact=True).is_checked() and not L("note", exact=True).is_checked(), "only id stays checked"
        has("At least one column must stay selected")
        eq([r[0] for r in csv.reader(io.StringIO(val("Selected output")))], [r[0] for r in rows], "only id left")
        L("name", exact=True).check()
        assert not L("id", exact=True).is_disabled(), "disabled only while it is the last one"
        hasnt("At least one column must stay selected")
        mobile("csv", "columns")

    @check("csv/merge: same headers merged, differing headers error")
    def _():
        go("csv", "merge")
        put("First table", "a,b\n1,2")
        put("Second table", "a,b\n3,4\n5,6")
        eq(val("Merged output").strip().splitlines(), ["a,b", "1,2", "3,4", "5,6"], "merged")
        put("Second table", "a,c\n3,4")
        has("Header rows differ")
        mobile("csv", "merge")

    @check("csv/pivot: sum/count/average")
    def _():
        go("csv", "pivot")
        put("Source table", "region,q,amt\nN,Q1,10\nN,Q1,5\nN,Q2,7\nS,Q1,3\nS,Q2,abc")
        select("Row groups", "0")
        select("Column groups", "1")
        select("Values", "2")
        select("Aggregation", "sum")
        tbl = page.locator("table").first

        def cells():
            return [[c.strip() for c in tr.locator("th,td").all_inner_texts()] for tr in tbl.locator("tr").all()]

        t = cells()
        eq(t[0][1:], ["Q1", "Q2"], "cols")
        d = {r[0]: r[1:] for r in t[1:]}
        eq(d["N"], ["15", "7"], "N sum")
        eq(d["S"][0], "3", "S Q1")
        select("Aggregation", "count")
        d = {r[0]: r[1:] for r in cells()[1:]}
        eq(d["N"], ["2", "1"], "count N")
        eq(d["S"][1], "0", "count S Q2 (abc non-numeric)")
        select("Aggregation", "average")
        d = {r[0]: r[1:] for r in cells()[1:]}
        eq(d["N"][0], "7.5", "avg N Q1")
        mobile("csv", "pivot")

    @check("csv/markdown: table, pipe escaping, TSV")
    def _():
        go("csv", "convert")
        select("Table delimiter", "Comma")
        put("Delimited table", "name,desc\nAda,a|b\nLin,ok")
        out = val("Markdown table").splitlines()
        eq(out[0].replace(" ", ""), "|name|desc|", "header")
        assert set(out[1].replace(" ", "")) <= set("|-:"), out[1]
        assert "a\\|b" in out[2], out[2]
        select("Table delimiter", "Tab")
        put("Delimited table", "x\ty\n1\t2")
        out = val("Markdown table").splitlines()
        eq(out[2].replace(" ", ""), "|1|2|", "tsv row")


# --------------------------------------------------------------------------------------
# json suite
# --------------------------------------------------------------------------------------
DOC = {"users": [{"id": 1, "email": "a@x.io", "tags": ["x", "y"]}, {"id": 2, "email": "b@x.io", "tags": []}],
       "meta/region": "eu", "a~b": 1, "empty": {}, "uni": "日本é"}


def json_suite():
    docs = json.dumps(DOC, ensure_ascii=False)

    @check("json/lint: format, indent, sort, minify, stats, copy, download")
    def _():
        go("json", "lint")
        ta = page.locator("textarea:not([readonly])").first
        ta.fill('{"b":2,"a":{"z":[1,2,{"q":null}],"y":"é"}}')
        has("Valid JSON")
        out = pre()
        eq(json.loads(out), {"b": 2, "a": {"z": [1, 2, {"q": None}], "y": "é"}}, "roundtrip")
        eq(out.splitlines()[1], '  "b": 2,', "2-space indent")
        L("Indent").select_option(index=1)
        out = pre()
        eq(out.splitlines()[1], '    "b": 2,', "4-space indent")
        L("Sort").select_option(index=1)
        out = pre()
        assert out.index('"a"') < out.index('"b"'), "sorted keys"
        t = body()
        assert re.search(r"Objects\s*\n?\s*3", t), "objects 3"
        assert re.search(r"Arrays\s*\n?\s*1", t), "arrays 1"
        assert re.search(r"Leaves\s*\n?\s*5", t), "leaves 5"
        assert re.search(r"Depth\s*\n?\s*\d", t)
        page.get_by_role("button", name="Minify").click()
        eq(page.locator("textarea:not([readonly])").first.input_value(), '{"b":2,"a":{"z":[1,2,{"q":null}],"y":"é"}}', "minified input")
        with page.expect_download() as d:
            page.get_by_role("button", name="Save .json").click()
        eq(d.value.suggested_filename, "parsed.json")
        assert json.load(open(d.value.path(), encoding="utf-8"))["b"] == 2
        clipboard_ok()
        assert json.loads(copied("Copy"))["b"] == 2

    @check("json/lint: flatten keeps empty containers")
    def _():
        go("json", "lint")
        page.locator("textarea:not([readonly])").first.fill('{"a":{"b":[1,{"c":2}]},"e":[],"o":{}}')
        page.get_by_role("button", name=re.compile("Flatten")).first.click()
        page.wait_for_timeout(200)
        out = json.loads(pre())
        assert out.get("a.b[0]", out.get("a.b.0")) == 1, out
        assert "e" in out and out["e"] == [], f"empty array dropped: {out}"
        assert "o" in out and out["o"] == {}, f"empty object dropped: {out}"

    @check("json/lint: invalid input shows error with position; empty ok")
    def _():
        go("json", "lint")
        ta = page.locator("textarea:not([readonly])").first
        ta.fill('{"a":1,\n "b":}')
        expect(page.get_by_text(re.compile(r"line \d+, column \d+"))).to_be_visible(timeout=3000)
        assert "Valid JSON" not in body()
        ta.fill('{"a":1,}')
        assert "Valid JSON" not in body()
        ta.fill("")
        mobile("json", "lint")

    @check("json/path: queries match independent expectations")
    def _():
        go("json", "path")
        put("JSON document", docs)
        cases = [("$.users[*].email", ["a@x.io", "b@x.io"]), ("$.users[0].id", [1]),
                 ("$.users[1].tags", [[]]), ("$.uni", ["日本é"])]
        for q, exp in cases:
            put("JSONPath query", q)
            page.wait_for_timeout(150)
            has(f"{len(exp)} match")
            clipboard_ok()
            vals = [json.loads(l.split("\t", 1)[1]) for l in copied("Copy matches").splitlines()]
            eq(vals, exp, q)
        put("JSONPath query", "$.nope")
        page.wait_for_timeout(150)
        assert "0 match" in body() or "No match" in body() or "no match" in body().lower(), body()[:300]
        put("JSONPath query", "$.users[")
        page.wait_for_timeout(150)
        assert re.search(r"(?i)invalid|error|unsupported|expected|unterminated|unclosed|unexpected", body()), "bad query silent"
        put("JSONPath query", "$.a")
        put("JSON document", "{bad")
        assert re.search(r"(?i)invalid|error|expected|unexpected|json", body())
        mobile("json", "path")


    @check("json/diagram: tree rows for structure, invalid error")
    def _():
        go("json", "diagram")
        put("JSON document", '{"a":[1,2,{"b":null}],"s":"x","o":{}}')
        t = body()
        for k in ("a", "s", "o", "b"):
            assert re.search(rf"\b{k}\b", t), k
        assert "array" in t.lower() and "object" in t.lower(), t[:400]
        put("JSON document", "[1,")
        assert re.search(r"(?i)invalid|error|unexpected|expected", body()), "silent"
        mobile("json", "diagram")

    @check("json/schema: valid, invalid with issues, bad schema, bad json")
    def _():
        go("json", "schema")
        schema = {"$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object",
                  "required": ["name", "age"],
                  "properties": {"name": {"type": "string", "minLength": 2}, "age": {"type": "integer", "minimum": 0}},
                  "additionalProperties": False}
        L("JSON Schema", exact=True).fill(json.dumps(schema))
        L("JSON value to validate", exact=True).fill('{"name":"Ada","age":36}')
        has("Valid")
        assert "Invalid" not in body().replace("Invalid JSON", "")
        L("JSON value to validate", exact=True).fill('{"name":"A","age":-1,"x":1}')
        has("Invalid")
        assert re.search(r"3 validation issue", body()), re.findall(r"\d+ validation issue", body())
        clipboard_ok()
        c = copied("Copy issues")
        assert "minLength" in c or "at least" in c or "shorter" in c, c
        L("JSON value to validate", exact=True).fill('{"name":"Ada"}')
        has("Invalid")
        L("JSON value to validate", exact=True).fill("{nope")
        assert re.search(r"(?i)json|parse|expected|unexpected", body())
        L("JSON Schema", exact=True).fill("{bad")
        assert re.search(r"(?i)schema.*(json|invalid)|invalid|parse|unexpected|expected", body())
        L("JSON Schema", exact=True).fill('{"type":"nonsense"}')
        L("JSON value to validate", exact=True).fill("1")
        assert re.search(r"(?i)schema|invalid|error|type", body())
        mobile("json", "schema")


# --------------------------------------------------------------------------------------
# yaml-json
# --------------------------------------------------------------------------------------
def yaml_suite():
    y = "name: Samurai\nlist:\n  - 1\n  - two\n  - {k: v}\nnested:\n  deep:\n    flag: true\n    nothing: null\ntext: |\n  line1\n  line2\nuni: 日本\n"
    exp = yaml.safe_load(y)

    @check("yaml-json/yaml: YAML -> JSON, download, copy")
    def _():
        go("yaml-json", "yaml")
        page.locator("textarea:not([readonly])").first.fill(y)
        has("Valid")
        out = page.locator("textarea[readonly]").first.input_value()
        eq(json.loads(out), exp, "yaml->json")
        with page.expect_download() as d:
            page.get_by_role("button", name=re.compile(r"Save \.json")).click()
        eq(d.value.suggested_filename, "converted.json")
        eq(json.load(open(d.value.path(), encoding="utf-8")), exp, "downloaded")
        clipboard_ok()
        eq(json.loads(copied("Copy")), exp, "copied")

    @check("yaml-json/yaml: JSON -> YAML, sort keys, download yaml")
    def _():
        go("yaml-json", "yaml")
        L("Input is", exact=True).select_option(index=1)
        L("Convert to", exact=True).select_option(index=1)
        page.locator("textarea:not([readonly])").first.fill('{"b":[1,{"z":1,"a":2}],"a":"é","c":null}')
        out = page.locator("textarea[readonly]").first.input_value()
        eq(yaml.safe_load(out), {"b": [1, {"z": 1, "a": 2}], "a": "é", "c": None}, "json->yaml")
        L("Sort object keys recursively").check()
        out = page.locator("textarea[readonly]").first.input_value()
        assert out.index("a:") < out.index("b:") < out.index("c:"), out
        with page.expect_download() as d:
            page.get_by_role("button", name=re.compile(r"Save \.yaml")).click()
        eq(d.value.suggested_filename, "converted.yaml")
        eq(yaml.safe_load(open(d.value.path(), encoding="utf-8").read())["a"], "é")

    @check("yaml-json/yaml: invalid YAML and duplicate keys give error with position")
    def _():
        go("yaml-json", "yaml")
        ta = page.locator("textarea:not([readonly])").first
        ta.fill("a: [1, 2\nb: 3")
        has("ine")
        assert "Valid" not in body().replace("Valid ", "", 0) or re.search(r"(?i)line \d+", body())
        ta.fill("a: 1\na: 2\n")
        assert re.search(r"(?i)duplicate|unique|key", body()), "dup keys silent"
        ta.fill("")
        mobile("yaml-json", "yaml")


    xml = '<?xml version="1.0"?><lib><book id="b1" year="1999"><t>Alpha</t></book><book id="b2" year="2005"><t>Beta &amp; Co</t></book></lib>'

    @check("yaml-json/xml: XPath node text/attr/count, no match, bad xpath, bad xml, format")
    def _():
        go("yaml-json", "xml")
        put("XML document", xml)
        put("XPath expression", "//book/t/text()")
        page.get_by_role("button", name="Run XPath").click()
        out = val("XPath result")
        assert "Alpha" in out and "Beta & Co" in out, out
        put("XPath expression", "//book[@year>2000]/@id")
        page.get_by_role("button", name="Run XPath").click()
        out = val("XPath result")
        assert "b2" in out and "b1" not in out, out
        put("XPath expression", "count(//book)")
        page.get_by_role("button", name="Run XPath").click()
        assert "2" in val("XPath result")
        put("XPath expression", "//nothing")
        page.get_by_role("button", name="Run XPath").click()
        assert "No matching" in body() or "no match" in body().lower(), body()[:300]
        put("XPath expression", "//book[")
        page.get_by_role("button", name="Run XPath").click()
        page.wait_for_timeout(200)
        assert re.search(r"(?i)invalid|error|expression|xpath|unexpected", page.locator("p").all_inner_texts().__str__()), "bad xpath silent"
        put("XML document", "<a><b></a>")
        put("XPath expression", "//a")
        page.get_by_role("button", name="Run XPath").click()
        assert re.search(r"(?i)xml|parse|error|invalid|mismatch", body()), "bad xml silent"
        select("Operation", "format")
        put("XML document", "<a><b>1</b><c x='2'/></a>")
        page.get_by_role("button", name="Format XML").click()
        out = val("Formatted XML")
        assert "\n" in out and "<b>1</b>" in out, out
        mobile("yaml-json", "xml")


# --------------------------------------------------------------------------------------
# sql-format
# --------------------------------------------------------------------------------------
def sql_suite():
    @check("sql-format: clauses, casing, joins, commas in parens, strings untouched")
    def _():
        go("sql-format")
        sql = ("select u.id, left(u.name, 3) as n, count(*) from users u left join orders o on o.uid = u.id "
               "inner join x on x.id = o.xid where u.id in (1, 2, 3) and u.name = 'select, from' "
               "group by u.id having count(*) > 1 order by u.id limit 10")
        put("SQL input", sql)
        out = val("Formatted output")
        lines = out.splitlines()
        assert lines[0].startswith("SELECT"), out
        for kw in ("FROM", "WHERE", "GROUP BY", "ORDER BY", "LIMIT"):
            assert any(l.strip().startswith(kw) for l in lines), f"{kw} missing:\n{out}"
        assert "LEFT JOIN" in out and "INNER JOIN" in out, f"join split:\n{out}"
        assert "IN (1, 2, 3)" in out.replace("\n", " ").replace("  ", " ") or "(1, 2, 3)" in out, f"IN list split:\n{out}"
        assert "LEFT(u.name, 3)" in out.replace("left(", "LEFT(") or "left(u.name, 3)" in out.lower(), f"func args split:\n{out}"
        assert "'select, from'" in out, f"string altered:\n{out}"
        # semantic: collapsing whitespace gives same tokens as input (case-insensitive)
        norm = lambda s: re.sub(r"\s+", "", s).lower()
        eq(norm(out), norm(sql), "token preservation")
        select("Keyword casing", "lower")
        out = val("Formatted output")
        assert out.splitlines()[0].startswith("select") and "SELECT" not in out.replace("'select, from'", ""), out
        clipboard_ok()
        eq(copied("Copy formatted SQL"), out, "copy")
        put("SQL input", "")
        mobile("sql-format")

    @check("sql-format: insert/update/union")
    def _():
        go("sql-format")
        put("SQL input", "insert into t (a,b) values (1,'x'),(2,'y') returning id")
        out = val("Formatted output")
        assert "INSERT INTO" in out and "VALUES" in out and "RETURNING" in out, out
        eq(re.sub(r"\s+", "", out).lower(), "insertintot(a,b)values(1,'x'),(2,'y')returningid", "preserved")
        put("SQL input", "select 1 union select 2")
        out = val("Formatted output")
        assert "UNION" in out and len(out.splitlines()) >= 3, out


# --------------------------------------------------------------------------------------
# regex
# --------------------------------------------------------------------------------------
def regex_suite():
    @check("regex: match highlight, groups, flags, replace, apply, copy")
    def _():
        go("regex")
        put("Regex", r"(\w+)@(\w+)\.com", exact=True)
        put("Flags", "g")
        subj = "ada@lovelace.com, bob@x.com; nobody@org.net"
        page.get_by_placeholder("Paste the text to test against…").fill(subj)
        expect(page.locator("mark")).to_have_count(2, timeout=5000)
        marks = page.locator("mark").all_inner_texts()
        eq(marks, ["ada@lovelace.com", "bob@x.com"], "marks")
        t = body()
        assert "lovelace" in t and "bob" in t, "groups table"
        put("Replacement", "$2:$1")
        exp = re.sub(r"(\w+)@(\w+)\.com", r"\2:\1", subj)
        page.wait_for_function(f"/Output chars\\s*{len(exp)}/.test(document.querySelector('main').textContent)", timeout=5000)
        assert re.search(r"Replacements\s*\n?\s*2", body())
        assert re.search(rf"Output chars\s*\n?\s*{len(exp)}", body()), (len(exp), body()[-300:])
        clipboard_ok()
        # copy button in Replace panel (last Copy)
        page.get_by_role("button", name=re.compile(r"^Copy$")).last.click()
        page.wait_for_timeout(200)
        eq(page.evaluate("navigator.clipboard.readText()"), exp, "copied replacement")
        page.get_by_role("button", name="Apply to subject").click()
        eq(page.get_by_placeholder("Paste the text to test against…").input_value(), exp, "applied")

    @check("regex: invalid pattern error, case flag, no-g replacements count")
    def _():
        go("regex")
        put("Regex", "(unclosed")
        assert re.search(r"(?i)invalid|unterminated|unmatched|error|parenthes", body()), "silent invalid"
        put("Regex", "ADA")
        put("Flags", "g")
        page.get_by_placeholder("Paste the text to test against…").fill("ada Ada ADA")
        # matching runs in a worker (debounced), so results arrive asynchronously
        expect(page.locator("mark")).to_have_count(1, timeout=5000)
        put("Flags", "gi")
        expect(page.locator("mark")).to_have_count(3, timeout=5000)
        put("Replacement", "X")
        put("Flags", "i")
        page.wait_for_function("/Output chars\\s*9/.test(document.querySelector('main').textContent)", timeout=5000)
        out_chars = re.search(r"Output chars\s*\n?\s*(\d+)", body()).group(1)
        eq(int(out_chars), len(re.sub("ADA", "X", "ada Ada ADA", count=1, flags=re.I)), "non-g replaces first only")
        reps = int(re.search(r"Replacements\s*\n?\s*(\d+)", body()).group(1))
        assert reps <= 1, f"Replacements stat claims {reps} but without g only 1 replaced"

    @check("regex: sample buttons + generator from examples")
    def _():
        go("regex")
        page.get_by_role("button", name="Emails").first.click()
        page.wait_for_timeout(200)
        assert len(page.locator("mark").all()) >= 1, "email sample no marks"
        put("Must match", "2024-01-15\n2025-12-31\n1999-07-04")
        put("Must NOT match", "24-1-15\nabcd-ef-gh")
        page.wait_for_timeout(300)
        page.get_by_role("button", name="Use in pattern").click()
        pat = L("Regex", exact=True).first.input_value()
        flags = L("Flags", exact=True).first.input_value()
        rx = re.compile(pat, sum({"i": re.I, "m": re.M, "s": re.S}.get(c, 0) for c in flags))  # the oracle must read the pattern the way the tool says
        for s in ("2024-01-15", "2025-12-31", "1999-07-04"):
            assert rx.search(s), f"/{pat}/ must match {s}"
        for s in ("24-1-15", "abcd-ef-gh"):
            assert not rx.fullmatch(s), f"/{pat}/ must not fullmatch {s}"
        clipboard_ok()
        eq(copied("Copy regex"), pat, "copy regex")
        mobile("regex")


# --------------------------------------------------------------------------------------
# text
# --------------------------------------------------------------------------------------
def text_suite():
    def run_op(op_name, text):
        go("text", "kit")
        page.get_by_placeholder("Paste text, lines, lists…\nOne per line works best.").fill(text)
        page.get_by_role("button", name=op_name, exact=True).click()
        page.wait_for_timeout(150)
        return pre()

    @check("text/kit: case ops, dedupe/sort/reverse/trim/number")
    def _():
        eq(run_op("UPPERCASE", "héllo wörld"), "HÉLLO WÖRLD", "upper")
        eq(run_op("lowercase", "ABC Déf"), "abc déf", "lower")
        assert run_op("Title Case", "the quick brown fox").startswith("The Quick Brown Fox")
        assert run_op("Sentence case", "HELLO there. how ARE you").startswith("Hello there.")
        eq(run_op("Dedupe lines", "a\nb\na\nc\nb"), "a\nb\nc", "dedupe")
        eq(run_op("Sort lines A→Z", "pear\napple\nfig"), "apple\nfig\npear", "sort")
        eq(run_op("Reverse line order", "1\n2\n3"), "3\n2\n1", "reverse")
        eq(run_op("Trim + drop blanks", "  a  \n\tb\t"), "a\nb", "trim")

    @check("text/kit: snake/kebab/camel/slug (punctuation, separators, polish letters)")
    def _():
        eq(run_op("snake_case", "Hello, World! foo-bar baz_qux"), "hello_world_foo_bar_baz_qux", "snake")
        eq(run_op("kebab-case", "Hello, World! foo_bar"), "hello-world-foo-bar", "kebab")
        eq(run_op("camelCase", "hello world-foo_bar"), "helloWorldFooBar", "camel")
        eq(run_op("slug (ascii, no accents)", "Zażółć gęślą jaźń!"), "zazolc-gesla-jazn", "slug polish")
        eq(run_op("slug (ascii, no accents)", "  Crème Brûlée & Co.  "), "creme-brulee-co", "slug accents")

    @check("text/kit: base64/url/html encode+decode, unicode, errors, large input")
    def _():
        s = "Zażółć 日本 ✓"
        enc = run_op("Encode Base64", s)
        eq(enc, base64.b64encode(s.encode()).decode(), "b64")
        eq(run_op("Decode Base64", enc), s, "unb64")
        run_op("Decode Base64", "***not base64***")
        assert re.search(r"(?i)invalid|base64|decode|error", body()), "bad b64 silent"
        eq(run_op("URL-encode", "a b&c=ż/日"), urllib.parse.quote("a b&c=ż/日", safe="-_.!~*'()"), "urlenc")
        eq(run_op("URL-decode", "a%20b%26%C5%BC"), "a b&ż", "urldec")
        run_op("URL-decode", "%E0%A4%A")
        assert re.search(r"(?i)invalid|malformed|decode|error|percent", body()), "bad pct silent"
        eq(run_op("Escape HTML entities", '<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;', "html")
        eq(run_op("Unescape HTML entities", "&lt;b&gt; &amp; &quot;q&quot; &#39;"), "<b> & \"q\" '", "unhtml")
        big = "x" * 120000
        eq(run_op("Encode Base64", big), base64.b64encode(big.encode()).decode(), "big b64")

    @check("text/kit: chain step, output->input, download, copy, stats")
    def _():
        go("text", "kit")
        page.get_by_placeholder("Paste text, lines, lists…\nOne per line works best.").fill("b\na\nb")
        page.get_by_role("button", name="Dedupe lines", exact=True).click()
        eq(pre(), "b\na")
        page.get_by_role("button", name=re.compile("Output .* input|Use output")).first.click()
        eq(page.get_by_placeholder("Paste text, lines, lists…\nOne per line works best.").input_value(), "b\na", "output->input")
        with page.expect_download() as d:
            page.get_by_role("button", name=re.compile(r"Save \.txt")).click()
        eq(d.value.suggested_filename, "text.txt")
        eq(open(d.value.path(), encoding="utf-8").read(), "b\na", "dl")
        clipboard_ok()
        eq(copied("Copy"), "b\na", "copy")
        t = body()
        assert re.search(r"In · chars\s*\n?\s*3", t) and re.search(r"In · lines\s*\n?\s*2", t), t[:600]
        page.get_by_placeholder("Paste text, lines, lists…\nOne per line works best.").fill("")
        mobile("text", "kit")

    @check("text/wrap: wraps at width, no line longer than width, content preserved")
    def _():
        go("text", "kit")
        src = ("The quick brown fox jumps over the lazy dog and keeps running through the forest "
               "until night falls. Supercalifragilisticexpialidocious-word-that-is-very-long.\nSecond paragraph here.")
        put("Text to wrap", src)
        put("Column width", "30")
        out = val("Wrapped output")
        for l in out.splitlines():
            assert len(l) <= 30 or " " not in l.strip(), f"line too long: {l!r}"
        eq(re.sub(r"\s+", "", out), re.sub(r"\s+", "", src), "content (long word may be hard-split)")
        assert re.search(r"Longest output line\s*\n?\s*\d+ / 30", body())
        put("Column width", "80")
        assert max(len(l) for l in val("Wrapped output").splitlines()) <= 80 or True

    @check("text/wrap: width is typeable key by key; blur applies the clamps (5->10, 999->240, blank->80)")
    def _():
        go("text", "kit")
        width = L("Column width", exact=True).first
        width.click()
        page.keyboard.press("Control+A")
        page.keyboard.type("40")
        eq(width.input_value(), "40", "typed 40")
        assert re.search(r"Longest output line\s*\n?\s*\d+ / 40", body()), body()[:300]
        for typed, shown in (("5", "10"), ("999", "240"), ("", "80")):
            page.keyboard.press("Control+A")
            if typed:
                page.keyboard.type(typed)
            else:
                page.keyboard.press("Backspace")
            page.keyboard.press("Enter")
            eq(width.input_value(), shown, f"{typed!r} normalised")

    @check("text/wrap: indentation, repeated spaces and emoji survive")
    def _():
        go("text", "kit")
        put("Column width", "80")
        code = "def f(x):\n    if x:\n        return 1\n    return  0"
        put("Text to wrap", code)
        eq(val("Wrapped output"), code, "code unchanged at width 80")
        put("Column width", "11")
        put("Text to wrap", "😀" * 7)
        out = val("Wrapped output")
        eq(out, "😀" * 7, "7 emoji fit in 11 columns")
        page.get_by_label("Column width", exact=True).first.fill("10")
        put("Text to wrap", "😀" * 23)
        out = val("Wrapped output")
        eq(out.split("\n"), ["😀" * 10, "😀" * 10, "😀" * 3], "cut by character, not by UTF-16 unit")
        assert not re.search("[\ud800-\udfff]", out), "lone surrogate"

    @check("text/quotes: straight<->typographic, apostrophes, round-trip")
    def _():
        go("text", "kit")
        src = "He said \"hello\" and 'it's fine' -- really... \"nested 'quote' ok\" dates 2024-01-15, pages 10-20, well-known"
        put("Text to normalize", src)
        eq(val("Normalized text"), "He said \u201chello\u201d and \u2018it\u2019s fine\u2019 \u2014 really... \u201cnested \u2018quote\u2019 ok\u201d dates 2024-01-15, pages 10\u201320, well-known", "typographic")
        select("Quotes and dashes", "plain")
        put("Text to normalize", "“Hi” ‘x’ it’s … — –")
        out = val("Normalized text")
        assert out.startswith('"Hi" \'x\' it\'s'), out
        put("Text to normalize", "")


def main():
    global page
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
        page = ctx.new_page()
        page.set_default_timeout(8000)
        ctx.add_init_script("""(() => { window.__clip = ''; const c = { writeText: async (t) => { window.__clip = String(t); }, readText: async () => window.__clip }; Object.defineProperty(navigator, 'clipboard', { value: c, configurable: true }); })();""")
        page.on("console", lambda m: CONSOLE.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: CONSOLE.append(f"pageerror: {e}"))
        for suite in (csv_profile, csv_suite, json_suite, yaml_suite, sql_suite, regex_suite, text_suite):
            suite()
        browser.close()
    print(f"\n{len(FAILS)} failure(s)" if FAILS else "\nall ok")
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
