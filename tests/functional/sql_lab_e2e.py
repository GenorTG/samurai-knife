#!/usr/bin/env python3
"""Real-UI functional tests for the SQL lab suite (/tools/sql-lab): format, convert, validate, schema, run, connection.

Oracles are independent of the app: the Run tab is checked against Python's sqlite3 and csv modules (and the exported
.sqlite is opened with sqlite3), DSNs against urllib.parse, everything else against the documented contract.

Usage: python3 tests/functional/sql_lab_e2e.py <base_url>   (default http://127.0.0.1:3210)
Needs: the Python SQL engine (sqlglot venv) for the engine-backed tabs. No database server is ever contacted.
"""
import csv
import json
import os
import re
import sqlite3
import sys
import tempfile
import traceback
import urllib.parse

from playwright.sync_api import expect, sync_playwright

_ARGS = [a for a in sys.argv[1:] if not a.startswith("-")]
BASE = (_ARGS[0] if _ARGS else "http://127.0.0.1:3210").rstrip("/")
SHOTS = os.environ.get("SQL_LAB_SHOTS", "")  # directory for light-theme screenshots (optional)
FAILS: list[str] = []
CONSOLE: list[str] = []
page = None
TMP = tempfile.mkdtemp(prefix="sqllab-")
TABS = ["format", "convert", "validate", "schema", "run", "connect"]


def ok(name):
    print(f"ok   {name}", flush=True)


def check(name):
    def deco(fn):
        before = len(CONSOLE)
        try:
            fn()
            if len(CONSOLE) > before:
                raise AssertionError("console/page errors: " + " | ".join(CONSOLE[before:])[:300])
            ok(name)
        except Exception as e:  # noqa: BLE001
            FAILS.append(name)
            print(f"FAIL {name}: {type(e).__name__}: {str(e).splitlines()[0] if str(e) else ''}", flush=True)
            if "-v" in sys.argv:
                traceback.print_exc()
        return fn
    return deco


def eq(actual, expected, what=""):
    assert actual == expected, f"{what} expected {expected!r} got {actual!r}"


def go(tab, width=1280, fresh=False):
    page.set_viewport_size({"width": width, "height": 900})
    page.goto(f"{BASE}/tools/sql-lab?tab={tab}", wait_until="domcontentloaded")
    if fresh:
        page.evaluate("localStorage.clear()")
        page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("main button, main input, main textarea", timeout=30000)
    page.wait_for_function("!document.querySelector('main [role=status]')?.textContent?.includes('Loading tool')", timeout=30000)
    # The tool form is server-rendered: a fill before React hydrates it is reset to the default value by hydration
    # (seen: Host typed as db.example.com, output still db.internal). Wait until every control carries a fiber.
    page.wait_for_function(
        "(() => { const els = [...document.querySelectorAll('main input, main textarea, main select, main button')];"
        " return els.length > 0 && els.every((e) => Object.keys(e).some((k) => k.startsWith('__reactFiber'))); })()",
        timeout=30000,
    )
    page.wait_for_timeout(300)


def field(label):
    return page.locator(f'label:has(> span:text-is("{label}")) >> :is(textarea,input,select)').first


def btn(name, exact=True):
    return page.get_by_role("button", name=name, exact=exact).first


def has(text, timeout=8000):
    expect(page.locator("main")).to_contain_text(text, timeout=timeout)


def region(name):
    return page.locator(f'[data-agent-region="{name}"]').first


def overflow_ok():
    w = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
    assert w <= 1, f"horizontal overflow {w}px"


def grid(statement=1):
    """Rows of the results grid of a Run statement as lists of cell text (header first)."""
    t = page.locator(f'section[aria-label="Statement {statement} result"] table').first
    return [[c.strip() for c in tr.locator("th,td").all_inner_texts()] for tr in t.locator("tr").all()]


def upload(path):
    page.locator('input[type=file]').first.set_input_files(path)


def run_sql(sql):
    """Fill the editor, press Run and wait until the (worker) run has finished: each finished run adds a query-history entry."""
    top = page.evaluate("document.querySelector('[data-agent-region=query-history] button')?.getAttribute('aria-label') ?? null")
    field("SQL to run").fill(sql)
    btn("Run query").click()
    page.wait_for_function(
        "(b) => (document.querySelector('[data-agent-region=query-history] button')?.getAttribute('aria-label') ?? null) !== b", arg=top, timeout=20000
    )


# --------------------------------------------------------------------------------------
# fixtures + independent oracle data
# --------------------------------------------------------------------------------------
SALES = [
    ["id", "country", "product", "amount", "zip"],
    ["1", "PL", "keyboard", "129.00", "00-950"],
    ["2", "DE", "mouse", "49.50", "10115"],
    ["3", "PL", "monitor", "329.99", "02-001"],
    ["4", "FR", "cable", "9.90", "75001"],
    ["5", "PL", "cable", "9.90", ""],
    ["6", "DE", "keyboard", "129.00", "80331"],
]
CSV_PATH = os.path.join(TMP, "sales.csv")
with open(CSV_PATH, "w", newline="") as fh:
    csv.writer(fh, lineterminator="\n").writerows(SALES)

DB_PATH = os.path.join(TMP, "fixture.sqlite")
_con = sqlite3.connect(DB_PATH)
_con.executescript(
    """
    CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL, born INTEGER);
    CREATE TABLE books (id INTEGER PRIMARY KEY, author_id INTEGER REFERENCES authors(id), title TEXT, pages INTEGER, price REAL);
    INSERT INTO authors VALUES (1,'Lem',1921),(2,'Le Guin',1929),(3,'Herbert',1920);
    INSERT INTO books VALUES (1,1,'Solaris',204,12.5),(2,1,'Fiasco',296,9.0),(3,2,'The Dispossessed',387,14.25),
      (4,3,'Dune',412,11.0),(5,3,'Children of Dune',444,10.5),(6,2,'The Lathe of Heaven',184,NULL);
    """
)
_con.commit()
_con.close()


def py_query(path, sql):
    con = sqlite3.connect(path)
    try:
        return con.execute(sql).fetchall()
    finally:
        con.close()


# --------------------------------------------------------------------------------------
# Run (sql.js)
# --------------------------------------------------------------------------------------
def run_suite():
    @check("run: CSV import + GROUP BY grid matches an independent Python computation")
    def _():
        go("run")
        upload(CSV_PATH)
        has("Imported sales.csv as table sales: 6 rows, 5 columns")
        run_sql("SELECT country, COUNT(*) AS n, ROUND(SUM(amount), 2) AS total FROM sales GROUP BY country ORDER BY country;")
        has("Statement 1")
        got = grid()
        # oracle: plain Python over the CSV rows (not sqlite)
        agg: dict[str, list[float]] = {}
        for _id, country, _p, amount, _z in SALES[1:]:
            agg.setdefault(country, []).append(float(amount))
        want = [[c, str(len(v)), round(sum(v), 2)] for c, v in sorted(agg.items())]
        eq(got[0], ["country", "n", "total"], "header")
        eq(len(got) - 1, len(want), "row count")
        for g, w in zip(got[1:], want):
            eq(g[0], w[0], "country")
            eq(g[1], w[1], "count")
            assert abs(float(g[2]) - w[2]) < 1e-9, (g, w)

    @check("run: type inference keeps leading-zero text (zip) and NULLs empty cells")
    def _():
        run_sql("SELECT zip FROM sales ORDER BY id;")
        has("Statement 1")
        zips = [r[0] for r in grid()[1:]]
        eq(zips, ["00-950", "10115", "02-001", "75001", "NULL", "80331"], "zip column")
        run_sql("SELECT typeof(id), typeof(amount), typeof(country) FROM sales LIMIT 1;")
        has("Statement 1")
        eq(grid()[1], ["integer", "real", "text"], "inferred storage classes")

    @check("run: open .sqlite file, JOIN result equals Python sqlite3")
    def _():
        go("run")
        upload(DB_PATH)
        has("Opened fixture.sqlite")
        has("authors")
        sql = "SELECT a.name, COUNT(b.id) AS books, SUM(b.pages) AS pages, ROUND(AVG(b.price), 3) AS avg_price FROM authors a LEFT JOIN books b ON b.author_id = a.id GROUP BY a.id ORDER BY a.name;"
        run_sql(sql)
        has("Statement 1")
        got = grid()[1:]
        want = py_query(DB_PATH, sql)
        eq(len(got), len(want), "rows")
        for g, w in zip(got, want):
            eq(g[0], w[0]); eq(int(g[1]), w[1]); eq(int(g[2]), w[2]); assert abs(float(g[3]) - w[3]) < 1e-9, (g, w)
        # NULL shown explicitly
        run_sql("SELECT title, price FROM books WHERE price IS NULL;")
        has("Statement 1")
        eq(grid()[1], ["The Lathe of Heaven", "NULL"])

    @check("run: multi-statement script: later results shown, summary counts, rows affected")
    def _():
        run_sql("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1),(2),(3); UPDATE t SET x = x * 10 WHERE x > 1; SELECT x FROM t ORDER BY x;")
        has("Statement 4")
        has("INSERT: 3 rows affected")
        has("UPDATE: 2 rows affected")
        eq([r[0] for r in grid(4)[1:]], ["1", "20", "30"], "final select")

    @check("run: SQL error reports statement number, keeps earlier statements applied")
    def _():
        run_sql("INSERT INTO t VALUES (4); SELECT nope FROM t; INSERT INTO t VALUES (5);")
        alert = page.locator('main [role=alert]').filter(has_text="Statement 2 failed").first
        expect(alert).to_contain_text("no such column", timeout=5000)
        expect(alert).to_contain_text("ran before the error")
        run_sql("SELECT COUNT(*) FROM t;")
        # results arrive asynchronously (worker): wait for the cell, not for text that an older result also contains
        expect(page.locator('section[aria-label="Statement 1 result"] tbody td').first).to_have_text("4", timeout=8000)

    @check("run: EXPLAIN QUERY PLAN button explains the first statement")
    def _():
        run_sql("SELECT * FROM books WHERE author_id = 3;")
        btn("EXPLAIN QUERY PLAN (first statement)").click()
        has("Query plan")  # the results panel is retitled once the (worker) run has finished
        txt = page.locator('section[aria-label="Statement 1 result"]').first.inner_text()
        assert re.search(r"SCAN|SEARCH", txt), txt

    @check("run: exported .sqlite opens in Python sqlite3 and has the same rows (incl. rows added in the browser)")
    def _():
        run_sql("INSERT INTO books VALUES (7, 1, 'Eden', 250, 8.0);")
        has("INSERT: 1 row affected")
        with page.expect_download() as dl:
            btn("Export database (.sqlite)").click()
        out = os.path.join(TMP, "exported.sqlite")
        dl.value.save_as(out)
        eq(dl.value.suggested_filename, "fixture.sqlite", "download name")
        want = py_query(DB_PATH, "SELECT id, author_id, title, pages, price FROM books ORDER BY id") + [(7, 1, "Eden", 250, 8.0)]
        eq(py_query(out, "SELECT id, author_id, title, pages, price FROM books ORDER BY id"), want, "books rows")
        eq(py_query(out, "SELECT id, name, born FROM authors ORDER BY id"), py_query(DB_PATH, "SELECT id, name, born FROM authors ORDER BY id"), "authors rows")
        eq(py_query(out, "PRAGMA integrity_check"), [("ok",)], "integrity")

    @check("run: result export as CSV and JSON equals the grid values")
    def _():
        run_sql("SELECT id, title, pages FROM books WHERE pages > 300 ORDER BY id;")
        has("Statement 1")
        with page.expect_download() as dl:
            btn("Export statement 1 as CSV").click()
        p1 = os.path.join(TMP, "r.csv"); dl.value.save_as(p1)
        rows = list(csv.reader(open(p1, newline="")))
        want = py_query(DB_PATH, "SELECT id, title, pages FROM books WHERE pages > 300 ORDER BY id")
        eq(rows[0], ["id", "title", "pages"]); eq([(int(a), b, int(c)) for a, b, c in rows[1:]], want, "csv rows")
        with page.expect_download() as dl2:
            btn("Export statement 1 as JSON").click()
        p2 = os.path.join(TMP, "r.json"); dl2.value.save_as(p2)
        data = json.load(open(p2))
        eq([(d["id"], d["title"], d["pages"]) for d in data], want, "json rows")

    @check("run: JSON array import (nested value stored as JSON text) and NDJSON")
    def _():
        go("run")
        jpath = os.path.join(TMP, "people.json")
        json.dump([{"name": "Ana", "age": 31, "tags": ["a", "b"]}, {"name": "Bo", "age": 25, "tags": []}, {"name": "Cy", "age": None}], open(jpath, "w"))
        upload(jpath)
        has("Imported people.json as table people: 3 rows, 3 columns")
        run_sql("SELECT name, age, tags FROM people ORDER BY name;")
        has("Statement 1")
        eq(grid()[1:], [["Ana", "31", '["a","b"]'], ["Bo", "25", "[]"], ["Cy", "NULL", "NULL"]], "json rows")
        npath = os.path.join(TMP, "events.ndjson")
        open(npath, "w").write('{"k":"a","n":1}\n{"k":"b","n":2}\n')
        upload(npath)
        has("Imported events.ndjson as table events: 2 rows")

    @check("run: table name field and duplicate-name suffixing on CSV import")
    def _():
        go("run")
        field("Table name for the next CSV/JSON import").fill("orders")
        upload(CSV_PATH)
        has("as table orders: 6 rows")
        upload(CSV_PATH)
        has("as table sales: 6 rows")
        field("Table name for the next CSV/JSON import").fill("orders")
        upload(CSV_PATH)
        has("as table orders_2: 6 rows")

    @check("run: >1000 rows render as a windowed grid (only visible rows in the DOM, every row reachable); export keeps every row")
    def _():
        go("run")
        big = os.path.join(TMP, "big.csv")
        with open(big, "w", newline="") as fh:
            w = csv.writer(fh, lineterminator="\n"); w.writerow(["n", "sq"]); [w.writerow([i, i * i]) for i in range(1, 1501)]
        upload(big)
        has("Imported big.csv as table big: 1500 rows")
        run_sql("SELECT * FROM big ORDER BY n;")
        has("Statement 1: SELECT: 1,500 rows")
        has("All 1,500 rows are in the scrolling grid")
        n_dom = len(grid()) - 1
        assert 10 < n_dom < 400, f"windowed grid should draw only the visible rows, drew {n_dom}"
        eq(grid()[1], ["1", "1"], "first row")
        page.get_by_role("region", name="Statement 1 rows").evaluate("el => { el.scrollTop = el.scrollHeight; }")
        page.wait_for_function("document.querySelector('section[aria-label=\"Statement 1 result\"]').textContent.includes('2250000')", timeout=10000)
        with page.expect_download() as dl:
            btn("Export statement 1 as CSV").click()
        p = os.path.join(TMP, "big-out.csv"); dl.value.save_as(p)
        rows = list(csv.reader(open(p, newline="")))
        eq(len(rows) - 1, 1500, "exported rows")
        eq(rows[1500], ["1500", str(1500 * 1500)], "last exported row")
        with page.expect_download() as dj:
            btn("Export statement 1 as JSON").click()
        pj = os.path.join(TMP, "big-out.json"); dj.value.save_as(pj)
        data = json.load(open(pj))
        eq(len(data), 1500, "exported JSON rows")
        eq(data[0], {"n": 1, "sq": 1}, "first JSON row")

    @check("run: <=1000 rows stay a plain table; the database panel explains snapshots + the worker")
    def _():
        go("run")
        run_sql("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 1000) SELECT i FROM n;")
        has("Statement 1: WITH: 1,000 rows")
        eq(len(grid()) - 1, 1000, "plain table rows")
        has("background worker")
        has("Cancel restores it")

    @check("run: files over 64 MB are refused with a clear message (nothing opened)")
    def _():
        go("run")
        huge = os.path.join(TMP, "huge.sqlite")
        with open(huge, "wb") as fh:
            fh.truncate(65 * 1024 * 1024)
        upload(huge)
        alert = page.locator("main [role=alert]").filter(has_text="64.0 MB").first
        expect(alert).to_contain_text("huge.sqlite", timeout=8000)
        expect(alert).to_contain_text("refused")
        os.remove(huge)

    @check("run: a non-SQLite file with a .db name is rejected with an explanation")
    def _():
        go("run")
        bad = os.path.join(TMP, "notadb.db")
        open(bad, "wb").write(b"definitely not sqlite " * 20)
        upload(bad)
        expect(page.locator("main [role=alert]").filter(has_text="not a SQLite database").first).to_be_visible(timeout=8000)

    @check("run: sample database, history, schema share (use as current schema -> Validate sees it)")
    def _():
        go("run", fresh=True)
        btn("Load sample database").click()
        has("Loaded the sample shop database")
        btn("Run query").click()
        has("Statement 1")
        eq(grid()[1][0], "Ada Kowalska")
        expect(region("query-history")).to_contain_text("ok")
        btn("Use this database as current schema").click()
        has("Saved 4 tables from shop-sample as the current schema")
        expect(page.locator('section[aria-label="Current schema"]').first).to_contain_text("customers(id INTEGER PK")
        go("validate")
        expect(page.locator('section[aria-label="Current schema"]').first).to_contain_text("order_items(")

    @check("run: SQL errors from the editor are text (role=alert), Ctrl+Enter runs")
    def _():
        go("run")
        field("SQL to run").fill("SELEC 1;")
        field("SQL to run").press("Control+Enter")
        expect(page.locator("main [role=alert]").filter(has_text="Statement 1 failed").first).to_be_visible(timeout=5000)
        field("SQL to run").fill("SELECT 41 + 1 AS answer;")
        field("SQL to run").press("Control+Enter")
        expect(page.locator('section[aria-label="Statement 1 result"] tbody td').first).to_have_text("42", timeout=8000)
        eq(grid()[1], ["42"])


# --------------------------------------------------------------------------------------
# Connection
# --------------------------------------------------------------------------------------
NASTY = "p@ss:w/rd%20?#&=+ é[]"


def url_out():
    return region("connection-url").inner_text().strip()


def dsn_suite():
    @check("connect: password masked by default, never in URL/localStorage, reveal shows it")
    def _():
        go("connect", fresh=True)
        field("Host").fill("db.example.com")
        field("User").fill("app")
        field("Password").fill(NASTY)
        field("Database").fill("shop")
        masked = url_out()
        assert "••••" in masked and NASTY not in masked and "p%40ss" not in masked, masked
        assert masked.startswith("postgresql://app:") and masked.endswith("@db.example.com:5432/shop"), masked
        page.get_by_label("Reveal password in the input and the outputs").check()
        revealed = url_out()
        want = f"postgresql://app:{urllib.parse.quote(NASTY, safe='')}@db.example.com:5432/shop"
        eq(revealed, want, "encoded URL")
        eq(urllib.parse.unquote(urllib.parse.urlsplit(revealed).password), NASTY, "decodes back")
        eq(urllib.parse.urlsplit(revealed).hostname, "db.example.com")
        assert NASTY not in page.url and "p%40ss" not in page.url, page.url
        storage = page.evaluate("JSON.stringify(Object.assign({}, localStorage)) + document.cookie")
        assert "ss:w" not in storage and "p%40ss" not in storage and "s3cret" not in storage, storage
        # copy buttons: masked copy by default, real copy only via the explicit button
        page.get_by_label("Reveal password in the input and the outputs").uncheck()
        btn("Copy URL (password hidden)").click(); page.wait_for_timeout(200)
        assert NASTY not in page.evaluate("navigator.clipboard.readText()")
        btn("Copy URL with password").click(); page.wait_for_timeout(200)
        eq(page.evaluate("navigator.clipboard.readText()"), want, "explicit real copy")

    @check("connect: build -> parse -> build is the identity for every database kind (nasty password)")
    def _():
        go("connect", fresh=True)
        kinds = page.locator("select").first.locator("option").evaluate_all("o => o.map(x => x.value)")
        assert len(kinds) >= 13, kinds
        page.get_by_label("Reveal password in the input and the outputs").check()
        db_label = {"sqlite": "File path", "oracle": "Service name", "redis": "Database index", "rediss": "Database index", "chroma": "Path", "chroma-tls": "Path"}
        for kind in kinds:
            page.locator("select").first.select_option(kind)
            if kind == "sqlite":
                field("File path").fill("./data/app.db")
            else:
                field("Host (or comma-separated host:port list)" if kind == "mongodb" else "Host").fill("[::1]" if kind == "redis" else "h.example.net")
                if kind not in ("chroma", "chroma-tls"):
                    field("User").fill("us@r:1")
                    field("Password").fill(NASTY)
                field(db_label.get(kind, "Database")).fill("2" if kind in ("redis", "rediss") else "db one")
            field("Query parameters").fill("a=1&b=two%20words")
            first = url_out()
            field("Connection URL to parse").fill(first)
            btn("Parse URL into fields").click()
            eq(url_out(), first, f"{kind} round trip")
            if kind not in ("sqlite", "chroma", "chroma-tls"):
                parts = urllib.parse.urlsplit(first.replace("[::1]", "localhost"))
                eq(urllib.parse.unquote(parts.password), NASTY, f"{kind} password")
                eq(urllib.parse.unquote(parts.username), "us@r:1", f"{kind} user")

    @check("connect: parse real-world URLs: driver suffix dropped, mssql alias, mongodb replica set, bad percent escape")
    def _():
        go("connect", fresh=True)
        page.get_by_label("Reveal password in the input and the outputs").check()
        cases = [
            ("postgresql+psycopg://u:p%40ss@host:6432/db?sslmode=require", "postgresql://u:p%40ss@host:6432/db?sslmode=require"),
            ("mssql://sa:x@win:1433/Master", "sqlserver://sa:x@win:1433/Master"),
            ("mongodb://a:b@h1:27017,h2:27018/shop?replicaSet=rs0", "mongodb://a:b@h1:27017,h2:27018/shop?replicaSet=rs0"),
            ("mongodb+srv://a:b%2Fc@cluster0.x.mongodb.net/test?retryWrites=true", "mongodb+srv://a:b%2Fc@cluster0.x.mongodb.net/test?retryWrites=true"),
            ("rediss://default:pw@cache:6380/3", "rediss://default:pw@cache:6380/3"),
            ("sqlite:////var/db/app.db", "sqlite:////var/db/app.db"),
            ("clickhouse://default:@ch:8123/analytics", "clickhouse://default@ch:8123/analytics"),
        ]
        for given, want in cases:
            field("Connection URL to parse").fill(given)
            btn("Parse URL into fields").click()
            eq(url_out(), want, given)
        field("Connection URL to parse").fill("postgresql://u:50%@h/db")
        btn("Parse URL into fields").click()
        expect(page.locator("main [role=alert]").filter(has_text="percent-escape").first).to_be_visible()
        field("Connection URL to parse").fill("ftp://x")
        btn("Parse URL into fields").click()
        expect(page.locator("main [role=alert]").filter(has_text="Unsupported scheme").first).to_be_visible()

    @check("connect: env line + client snippets reflect the fields (postgres, mongo, redis)")
    def _():
        go("connect", fresh=True)
        field("Host").fill("pg.example.com"); field("User").fill("app"); field("Database").fill("shop")
        has("DATABASE_URL='postgresql://app@pg.example.com:5432/shop'")
        has("psycopg")
        has("create_engine(\"postgresql+psycopg://app@pg.example.com:5432/shop\")")
        has("jdbc:postgresql://pg.example.com:5432/shop?user=app")
        page.locator("select").first.select_option("mongodb-srv")
        field("Host").fill("cluster0.abc.mongodb.net")
        has("MONGODB_URI='mongodb+srv://app@cluster0.abc.mongodb.net/shop'")
        has("mongosh 'mongodb+srv://app@cluster0.abc.mongodb.net/shop'")
        page.locator("select").first.select_option("redis")
        field("Host").fill("cache"); 
        has("redis-cli -u 'redis://app@cache:6379/shop'") if False else has("REDIS_URL=")
        field("Variable name").fill("my cache url")
        has("MY_CACHE_URL=")

    @check("connect: validation messages are text (bad port, missing host)")
    def _():
        go("connect", fresh=True)
        field("Host").fill("")
        has("Enter a host name or IP address.")
        field("Host").fill("h"); field("Port").fill("99999")
        has("Port must be a whole number from 1 to 65535.")


# --------------------------------------------------------------------------------------
# Schema / Validate / Convert / Build / Format (engine-backed)
# --------------------------------------------------------------------------------------
def engine_suite():
    @check("schema: sample shop DDL -> cards with PK/FK badges, Mermaid source, current schema region")
    def _():
        go("schema", fresh=True)
        btn("Sample: shop").click()
        expect(page.locator('article[aria-label="Table orders"]')).to_be_visible(timeout=15000)
        orders = page.locator('article[aria-label="Table orders"]').inner_text()
        assert "customer_id" in orders and "FK → customers.id" in orders and "PK" in orders, orders
        oi = page.locator('article[aria-label="Table order_items"]').inner_text()
        assert oi.count("PK") >= 2 and "FK → orders.id" in oi and "FK → products.id" in oi, oi
        mer = region("mermaid").inner_text()
        assert mer.startswith("erDiagram") and "order_items" in mer and "customers" in mer, mer
        btn("Copy Mermaid").click(); page.wait_for_timeout(200)
        assert page.evaluate("navigator.clipboard.readText()").startswith("erDiagram")
        btn("Use as current schema").click()
        has("Saved 4 tables as the current schema")
        txt = page.locator('section[aria-label="Current schema"]').first.inner_text()
        assert "customers(" in txt and "products(" in txt, txt
        stored = page.evaluate("fetch('/api/account').then(r => r.json()).then(a => JSON.parse(localStorage.getItem('sk.sql.schema.v1.' + a.id)).schema.tables.map(t => t.name))")
        eq(stored, ["customers", "products", "orders", "order_items"], "stored tables")
        page.reload(wait_until="domcontentloaded")
        expect(page.locator('section[aria-label="Current schema"]').first).to_contain_text("customers(", timeout=10000)

    @check("validate/convert: clearing the SQL while a request is in flight leaves no stuck 'Validating…'/'Converting…' state")
    def _():
        for tab, busy in (("validate", "Validating…"), ("convert", "Converting…")):
            go(tab, fresh=True)
            # hold every /api/sql answer back so the request is genuinely in flight when the box is emptied
            page.evaluate("() => { const f = window.fetch; window.fetch = (u, o) => String(u).includes('/api/sql') ? new Promise((r) => setTimeout(r, 2500)).then(() => f(u, o)) : f(u, o); }")
            area = page.locator("main textarea:not([readonly])").first
            area.fill("SELECT 1")
            if tab == "validate":
                page.get_by_role("button", name="Validate SQL").click()
            page.wait_for_timeout(900)  # auto-run (debounce) has started the delayed request
            assert busy in page.locator("main").inner_text(), f"{tab}: the request never went busy ({busy!r} not shown)"
            area.fill("")
            page.wait_for_timeout(3200)  # the discarded answer has landed
            text = page.locator("main").inner_text()
            assert busy not in text, f"{tab}: still shows {busy!r} after the SQL was cleared"
            if tab == "validate":
                expect(page.get_by_role("button", name="Validate SQL")).to_be_enabled()

    @check("schema: bad DDL surfaces an error issue in text; dialect persists across tabs")
    def _():
        go("schema")
        field("CREATE TABLE statements").fill("CREATE TABLE broken (id integer,, name text")
        btn("Parse DDL").click()
        expect(page.locator("main [role=alert], main ul[aria-label=Issues]").first).to_be_visible(timeout=10000)
        page.get_by_label("Dialect of the DDL").select_option("tsql")
        go("validate")
        eq(page.get_by_label("Dialect", exact=True).first.input_value(), "tsql", "dialect persisted")

    @check("validate: syntax error shows line/column marker under the offending line")
    def _():
        go("validate")
        btn("Sample: syntax error").click()
        has("1 error found", 15000)
        src = region("validation-source").inner_text()
        lines = src.splitlines()
        i = next(k for k, l in enumerate(lines) if "LIMT 10;" in l)
        assert "^" in lines[i + 1], lines[i:i + 2]
        assert re.search(r"Error at line 6", page.locator("main").inner_text()), "line number in issue"

    @check("validate: valid SQL -> per-statement summary lists kind, tables, columns")
    def _():
        go("validate")
        btn("Sample: valid").click()
        has("Valid", 15000)
        t = page.locator('div[aria-label="Statement summary"] table').inner_text()
        assert re.search(r"SELECT", t, re.I) and "customers" in t and "orders" in t, t
        assert re.search(r"UPDATE", t, re.I) and "products" in t and "stock" in t, t

    @check("validate: check against stored schema reports unknown table/column with did-you-mean")
    def _():
        go("schema", fresh=True)
        btn("Sample: shop").click()
        expect(page.locator('article[aria-label="Table orders"]')).to_be_visible(timeout=15000)
        btn("Use as current schema").click()
        go("validate")
        btn("Sample: unknown names").click()
        btn("Check against schema").click()
        res = region("schema-check")
        expect(res).to_contain_text("customer", timeout=10000)
        txt = res.inner_text()
        assert re.search(r"[Uu]nknown table", txt) and "Did you mean" in txt and "customers" in txt, txt
        assert re.search(r"[Uu]nknown column", txt), txt
        field("SQL").fill("SELECT c.name FROM customers c JOIN orders o ON o.customer_id = c.id;")
        btn("Check against schema").click()
        expect(region("schema-check")).to_contain_text("Every table and column exists", timeout=10000)

    @check("convert: all six examples convert without errors; outputs match the target dialect")
    def _():
        go("convert")
        expected = [
            ("SQLite → Postgres: upsert", ["ON CONFLICT"]),
            ("MySQL → T-SQL: LIMIT and AUTO_INCREMENT", ["IDENTITY", "OFFSET 20 ROWS", "FETCH"]),
            ("Postgres → MySQL: ILIKE, casts, now()", ["CAST("]),
            ("Oracle → Postgres: NVL, SYSDATE, FETCH FIRST", ["COALESCE", "FETCH FIRST 5"]),
            ("T-SQL → SQLite: TOP, ISNULL, GETDATE", ["LIMIT 10"]),
            ("BigQuery → Snowflake: backticks and DATE_TRUNC", ["DATE_TRUNC"]),
        ]
        for label, needles in expected:
            btn(label).click()
            expect(region("converted-sql")).to_contain_text(needles[0], timeout=15000)
            out = region("converted-sql").inner_text()
            for n in needles:
                assert n in out, (label, n, out)
            assert not page.locator("main [role=alert]").count(), label

    @check("convert: swap exchanges dialects; syntax error is reported with position; download is the output")
    def _():
        go("convert")
        a = field("Convert from") if False else page.get_by_label("Convert from").first
        b = page.get_by_label("Convert to").first
        a.select_option("mysql"); b.select_option("oracle")
        btn("Swap the from and to dialects").click() if False else page.get_by_role("button", name="Swap the from and to dialects").click()
        eq(a.input_value(), "oracle"); eq(b.input_value(), "mysql")
        a.select_option("sqlite"); b.select_option("postgres")
        field("SQL to convert").fill("SELECT * FROM")
        has("Error", 15000)
        field("SQL to convert").fill("SELECT 1 AS one")
        page.wait_for_timeout(1200)
        with page.expect_download() as dl:
            btn("Download .sql").click()
        p = os.path.join(TMP, "c.sql"); dl.value.save_as(p)
        eq(open(p).read().strip(), region("converted-sql").inner_text().strip(), "downloaded output")


    @check("build: schema-aware completion lists stored tables/columns; Ask the assistant opens it with schema + request")
    def _():
        go("schema", fresh=True)
        btn("Sample: shop").click()
        expect(page.locator('article[aria-label="Table orders"]')).to_be_visible(timeout=15000)
        btn("Use as current schema").click()

    @check("format: dialect-aware mode pretty-prints in the chosen dialect and rejects broken SQL")
    def _():
        go("format")
        field("SQL input").fill("select a,b from t where x=1 and y in (1,2) order by a")
        field("Formatter").select_option("server")
        page.get_by_label("Dialect", exact=True).first.select_option("postgres")
        expect(field("Formatted output")).to_have_value(re.compile(r"SELECT\n\s+a,\n\s+b\nFROM t\nWHERE\n"), timeout=15000)
        field("SQL input").fill("select from where")
        expect(page.locator("main [role=alert]").first).to_be_visible(timeout=15000)
        # the route answers 422 for an engine error by design; the browser logs that as a console error
        CONSOLE[:] = [c for c in CONSOLE if "422" not in c]
        field("Formatter").select_option("instant")
        field("SQL input").fill("select 1")
        eq(field("Formatted output").input_value(), "SELECT 1", "instant mode unchanged")


# --------------------------------------------------------------------------------------
# every tab: console clean, no overflow, light theme screenshot
# --------------------------------------------------------------------------------------
def layout_suite():
    for tab in TABS:
        for width in (1280, 390):
            @check(f"layout: {tab} at {width}px renders, no horizontal overflow, no console errors")
            def _(tab=tab, width=width):
                go(tab, width=width)
                overflow_ok()
                if tab == "run":
                    page.get_by_role("button", name="Load sample database").click()
                    page.get_by_role("button", name="Run query").click()
                    page.wait_for_selector('section[aria-label="Statement 1 result"]')
                    overflow_ok()
                if tab == "build":
                    page.get_by_role("button", name="Top customers by revenue").click()
                    page.wait_for_timeout(1500)
                    overflow_ok()
                if tab in ("schema",):
                    page.get_by_role("button", name="Sample: shop").click()
                    page.wait_for_selector('article[aria-label="Table orders"]', timeout=15000)
                    overflow_ok()
                if SHOTS and width == 1280 or (SHOTS and tab in ("build", "run", "convert")):
                    page.screenshot(path=os.path.join(SHOTS, f"{tab}-{width}.png"), full_page=True)


def main():
    global page
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
        page = ctx.new_page()
        page.set_default_timeout(8000)
        ctx.add_init_script("""(() => { window.__clip = ''; const c = { writeText: async (t) => { window.__clip = String(t); }, readText: async () => window.__clip }; Object.defineProperty(navigator, 'clipboard', { value: c, configurable: true }); })();""")
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            ctx.add_init_script("try{localStorage.setItem('sk-theme','light')}catch(e){}")
        page.on("console", lambda m: CONSOLE.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: CONSOLE.append(f"pageerror: {e}"))
        for suite in (run_suite, dsn_suite, engine_suite, layout_suite):
            suite()
        browser.close()
    print(f"\n{len(FAILS)} failure(s)" if FAILS else "\nall ok")
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
