#!/usr/bin/env python3
"""SQL engine end-to-end: sqlglot-backed `server/py/scripts/sql_tool.py`, directly and through `POST /api/sql`.

Usage: python3 tests/sql_engine_e2e.py [base_url]
  no base_url -> only the script is exercised (needs the venv: ../samurai-knife-py/venv, or KNIFE_PYTHON)
  base_url    -> every section also runs through the live server (POST /api/sql, Origin = base_url)

Oracles (what makes the assertions independent of sqlglot printing something plausible):
  * SQLite execution: every sqlite compile and every transpile-to-sqlite case that can run is executed in
    Python's stdlib sqlite3 against a fixture database and compared with hand-computed rows.
  * Hand-reviewed known-answer corpus (tests/sql_engine_corpus.py): expected SQL asserted verbatim.
  * Re-parse: every compiled statement for all 14 dialects must parse back with zero errors.
  * check/spec rejection: invented tables/columns, typos, ambiguity, arity, malformed specs.
No database server is ever contacted.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sql_engine_corpus import FORMAT, TRANSPILE, TRANSPILE2  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else None
SCRIPT = ROOT / "server" / "py" / "scripts" / "sql_tool.py"
PY = os.environ.get("KNIFE_PYTHON") or str(ROOT.parent / "samurai-knife-py" / "venv" / "bin" / "python")
if not Path(PY).exists():
    sys.exit(f"python with sqlglot not found at {PY}; set KNIFE_PYTHON")

DIALECTS = ["sqlite", "postgres", "mysql", "mariadb", "tsql", "oracle", "bigquery", "snowflake", "duckdb", "redshift", "clickhouse", "trino", "spark", "hive"]
results: dict[str, list[int]] = {}
failures: list[str] = []
_section = "?"


def section(name: str) -> None:
    global _section
    _section = name
    results.setdefault(name, [0, 0])
    print(f"\n== {name}")


def check(name: str, ok: bool, detail: Any = "") -> None:
    results[_section][1] += 1
    if ok:
        results[_section][0] += 1
    else:
        failures.append(f"[{_section}] {name}")
        print(f"FAIL {name} | {str(detail)[:600]}")


# ------------------------------------------------------------------ transports

def direct(action: str, params: dict[str, Any]) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="sqle2e-") as tmp:
        req, resp = Path(tmp, "request.json"), Path(tmp, "response.json")
        req.write_text(json.dumps({"action": action, "params": params}))
        proc = subprocess.run([PY, str(SCRIPT), str(req), str(resp)], capture_output=True, text=True, timeout=60, cwd=str(SCRIPT.parent))
        if not resp.exists():
            return {"ok": False, "error": f"no response.json (exit {proc.returncode}): {proc.stderr[-400:]}"}
        return json.loads(resp.read_text())


def http(action: str, params: dict[str, Any]) -> dict[str, Any]:
    assert BASE
    data = json.dumps({"action": action, "params": params}).encode()
    req = urllib.request.Request(f"{BASE}/api/sql", data, {"Content-Type": "application/json", "Origin": BASE}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as err:
        body = json.loads(err.read() or b"{}")
        body.setdefault("ok", False)
        body["_status"] = err.code
        return body


TRANSPORTS = {"direct": direct, **({"http": http} if BASE else {})}


def pmap(fn, items):
    with ThreadPoolExecutor(max_workers=8) as pool:
        return list(pool.map(fn, items))


def issues_of(resp: dict[str, Any]) -> list[tuple[str, str]]:
    return [(i["level"], i["message"]) for i in resp["data"]["issues"]]


def errors_of(resp: dict[str, Any]) -> list[str]:
    return [m for lv, m in issues_of(resp) if lv == "error"]


# ------------------------------------------------------------------ fixture database

FIXTURE_SQL = """
CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, age INTEGER, org_id INTEGER, active INTEGER DEFAULT 1, created TEXT);
CREATE TABLE orgs (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER, total REAL, status TEXT);
INSERT INTO users VALUES (1,'Alice','alice@x.io',30,1,1,'2024-01-05'),(2,'bob','bob@y.com',25,1,0,'2024-02-10'),
  (3,'Carol','carol@x.io',41,2,1,'2024-03-15'),(4,'alan','alan@z.org',19,NULL,1,NULL),(5,'Dave','dave@y.com',25,2,1,'2024-05-01');
INSERT INTO orgs VALUES (1,'Acme'),(2,'Globex'),(3,'Initech');
INSERT INTO orders VALUES (1,1,10.0,'paid'),(2,1,25.5,'paid'),(3,2,7.25,'open'),(4,3,100.0,'paid'),(5,3,5.0,'refunded'),(6,5,60.0,'open');
"""
FIXTURE_DDL = FIXTURE_SQL.split("INSERT")[0]


def fresh_db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.executescript(FIXTURE_SQL)
    return conn


def col(name: str) -> dict[str, str]:
    return {"col": name}


def eq(name: str, value: Any) -> dict[str, Any]:
    return {"col": name, "op": "=", "value": value}


def compile_req(spec: dict[str, Any], dialect: str, **extra: Any) -> dict[str, Any]:
    return {"spec": spec, "dialect": dialect, **extra}


def bind(params: list[str], values: dict[str, Any]) -> list[Any]:
    return [values[name] for name in params]


# ------------------------------------------------------------------ (a) known-answer corpus

def suite_corpus(via: str, call) -> None:
    section(f"a. transpile/format known-answer [{via}]")
    check("corpus ids are unique", len({r[0] for r in TRANSPILE + TRANSPILE2}) == len(TRANSPILE + TRANSPILE2))
    check("second corpus has >= 60 conversions across >= 10 target dialects", len(TRANSPILE2) >= 60 and len({r[2] for r in TRANSPILE2}) >= 10, (len(TRANSPILE2), sorted({r[2] for r in TRANSPILE2})))

    def run(row):
        _, frm, to, sql, _, _ = row
        return call("transpile", {"sql": sql, "from": frm, "to": to})

    for row, resp in zip(TRANSPILE + TRANSPILE2, pmap(run, TRANSPILE + TRANSPILE2)):
        n, frm, to, sql, expected, issues = row
        ok = resp["ok"] and resp["data"]["sql"] == expected and [tuple(i) for i in issues] == issues_of(resp)
        check(f"#{n} {frm}->{to}: {sql}", ok, resp if not resp["ok"] else (resp["data"]["sql"], issues_of(resp)))

    def run_fmt(row):
        return call("format", {"sql": row[1], "dialect": row[0]})

    for (dialect, sql, expected), resp in zip(FORMAT, pmap(run_fmt, FORMAT)):
        check(f"format {dialect}: {sql[:40]}", resp["ok"] and resp["data"]["sql"] == expected, resp)
    # formatting is idempotent: formatting formatted SQL changes nothing
    again = pmap(lambda row: call("format", {"sql": row[2], "dialect": row[0]}), FORMAT)
    for (dialect, _, expected), resp in zip(FORMAT, again):
        check(f"format idempotent {dialect}", resp["ok"] and resp["data"]["sql"] == expected, resp)

    resp = call("transpile", {"sql": "SELECT a FROM t; SELECT b FROM u", "from": "postgres", "to": "tsql"})
    check("multi-statement transpile: each ends with ;", resp["ok"] and resp["data"]["sql"] == "SELECT a FROM t;\nSELECT b FROM u;", resp)
    resp = call("transpile", {"sql": "SELEC a FROM", "from": "postgres", "to": "mysql"})
    check("transpile parse error -> empty sql + positioned error issue", resp["ok"] and resp["data"]["sql"] == "" and resp["data"]["issues"][0]["level"] == "error" and resp["data"]["issues"][0].get("line") == 1, resp)
    resp = call("transpile", {"sql": "SELECT 1", "from": "mariadb", "to": "mysql"})
    check("mariadb source is noted as MySQL", resp["ok"] and any("MariaDB" in m for _, m in issues_of(resp)), resp)
    # sqlglot internals must not reach users or models: no class names, no 'SENTINEL' marker (coverage triage 2026-10-10)
    for sql, expected in (("SELECT id, FROM orders WHERE;", "WHERE is incomplete"), ("SELECT (1 + FROM t", "The '+' operator is missing an operand"),
                          ("SELECT a FROM t WHERE a =", "The '=' operator is missing an operand"), ("SELECT a FROM t JOIN", "end of the statement")):
        resp = call("validate", {"sql": sql, "dialect": "postgres"})
        text = " | ".join(i["message"] for i in resp["data"].get("issues", [])) if resp["ok"] else resp.get("error", "")
        check(f"validate message is plain language: {sql}", resp["ok"] and expected in text and "sqlglot" not in text and "SENTINEL" not in text and "<class" not in text, text)
    resp = call("format", {"sql": "select from where", "dialect": "sqlite"})
    check("format parse error -> ok:false naming line/column", not resp["ok"] and "line 1" in resp["error"], resp)
    resp = call("transpile", {"sql": "SELECT 1", "from": "klingon", "to": "mysql"})
    check("unknown dialect rejected", not resp["ok"] and "params.from" in resp["error"], resp)


# ------------------------------------------------------------------ (b/c) compile

def sel(**kw: Any) -> dict[str, Any]:
    return {"op": "select", **kw}


# name -> (spec, {param: value}, expected rows, order matters)
SELECT_EXEC: list[tuple[str, dict[str, Any], dict[str, Any], list[tuple]]] = [
    ("plain order", sel(**{"from": "users", "columns": ["id", "name"], "orderBy": [{"expr": col("id")}]}), {},
     [(1, "Alice"), (2, "bob"), (3, "Carol"), (4, "alan"), (5, "Dave")]),
    ("star default", sel(**{"from": "orgs", "where": eq("id", 2)}), {}, [(2, "Globex")]),
    ("and/or with param", sel(**{"from": "users", "columns": ["id"], "where": {"and": [
        {"col": "age", "op": ">=", "value": {"param": "min_age"}},
        {"or": [eq("active", 1), {"col": "name", "op": "like", "value": "b%"}]}]}, "orderBy": [{"expr": col("id")}]}),
     {"min_age": 25}, [(1,), (2,), (3,), (5,)]),
    ("ilike", sel(**{"from": "users", "columns": ["id"], "where": {"col": "name", "op": "ilike", "value": "A%"}, "orderBy": [{"expr": col("id")}]}), {}, [(1,), (4,)]),
    ("in with param", sel(**{"from": "users", "columns": ["id"], "where": {"col": "id", "op": "in", "value": [1, 3, {"param": "p"}]}, "orderBy": [{"expr": col("id")}]}), {"p": 5}, [(1,), (3,), (5,)]),
    ("not in", sel(**{"from": "users", "columns": ["id"], "where": {"col": "id", "op": "not in", "value": [1, 2]}, "orderBy": [{"expr": col("id")}]}), {}, [(3,), (4,), (5,)]),
    ("between params", sel(**{"from": "users", "columns": ["id"], "where": {"col": "age", "op": "between", "value": [{"param": "lo"}, 30]}, "orderBy": [{"expr": col("id")}]}), {"lo": 20}, [(1,), (2,), (5,)]),
    ("is null", sel(**{"from": "users", "columns": ["id"], "where": {"col": "org_id", "op": "is null"}}), {}, [(4,)]),
    ("is not null", sel(**{"from": "users", "columns": [{"expr": "*", "agg": "count", "as": "n"}], "where": {"col": "created", "op": "is not null"}}), {}, [(4,)]),
    ("group by + having on aggregate alias", sel(**{"from": "orders", "columns": ["status", {"expr": "*", "agg": "count", "as": "n"}, {"expr": col("total"), "agg": "sum", "as": "s"}],
        "groupBy": [col("status")], "having": {"col": "n", "op": ">", "value": 1}, "orderBy": [{"expr": col("status")}]}), {}, [("open", 2, 67.25), ("paid", 3, 135.5)]),
    ("inner join", sel(**{"from": {"name": "users", "as": "u"}, "columns": ["u.name", {"expr": col("o.name"), "as": "org"}],
        "joins": [{"type": "inner", "table": {"name": "orgs", "as": "o"}, "on": {"col": "u.org_id", "op": "=", "value": col("o.id")}}], "orderBy": [{"expr": col("u.id")}]}), {},
     [("Alice", "Acme"), ("bob", "Acme"), ("Carol", "Globex"), ("Dave", "Globex")]),
    ("left join keeps unmatched", sel(**{"from": {"name": "users", "as": "u"}, "columns": ["u.id", "o.name"],
        "joins": [{"type": "left", "table": {"name": "orgs", "as": "o"}, "on": {"col": "u.org_id", "op": "=", "value": col("o.id")}}], "orderBy": [{"expr": col("u.id")}]}), {},
     [(1, "Acme"), (2, "Acme"), (3, "Globex"), (4, None), (5, "Globex")]),
    ("anti join", sel(**{"from": {"name": "users", "as": "u"}, "columns": ["u.id", "u.name"],
        "joins": [{"type": "left", "table": {"name": "orders", "as": "o"}, "on": {"col": "o.user_id", "op": "=", "value": col("u.id")}}], "where": {"col": "o.id", "op": "is null"}}), {}, [(4, "alan")]),
    ("right join", sel(**{"from": {"name": "users", "as": "u"}, "columns": ["u.name", "o.name"],
        "joins": [{"type": "right", "table": {"name": "orgs", "as": "o"}, "on": {"col": "u.org_id", "op": "=", "value": col("o.id")}}], "orderBy": [{"expr": col("o.id")}, {"expr": col("u.id")}]}), {},
     [("Alice", "Acme"), ("bob", "Acme"), ("Carol", "Globex"), ("Dave", "Globex"), (None, "Initech")]),
    ("cross join count", sel(**{"from": "users", "columns": [{"expr": "*", "agg": "count", "as": "n"}], "joins": [{"type": "cross", "table": "orgs"}]}), {}, [(15,)]),
    ("cte", sel(**{"from": "big", "columns": ["user_id", "spent"], "where": {"col": "spent", "op": ">", "value": {"param": "floor"}}, "orderBy": [{"expr": col("user_id")}],
        "ctes": [{"name": "big", "query": sel(**{"from": "orders", "columns": ["user_id", {"expr": col("total"), "agg": "sum", "as": "spent"}], "groupBy": [col("user_id")]})}]}),
     {"floor": 50}, [(3, 105.0), (5, 60.0)]),
    ("distinct", sel(**{"from": "orders", "columns": ["status"], "distinct": True, "orderBy": [{"expr": col("status")}]}), {}, [("open",), ("paid",), ("refunded",)]),
    ("limit/offset", sel(**{"from": "users", "columns": ["id"], "orderBy": [{"expr": col("id")}], "limit": 2, "offset": 1}), {}, [(2,), (3,)]),
    ("desc nulls", sel(**{"from": "users", "columns": ["id"], "orderBy": [{"expr": col("created"), "dir": "desc"}]}), {}, [(5,), (3,), (2,), (1,), (4,)]),
    ("asc nulls last", sel(**{"from": "users", "columns": ["id"], "orderBy": [{"expr": col("created"), "dir": "asc", "nulls": "last"}]}), {}, [(1,), (2,), (3,), (5,), (4,)]),
    ("fn upper/length", sel(**{"from": "users", "columns": [{"expr": {"fn": "upper", "args": [col("name")]}, "as": "u"}, {"expr": {"fn": "length", "args": [col("email")]}, "as": "l"}], "where": eq("id", 1)}), {}, [("ALICE", 10)]),
    ("fn || concat", sel(**{"from": "users", "columns": [{"expr": {"fn": "||", "args": [col("name"), " <", col("email"), ">"]}, "as": "c"}], "where": eq("id", 2)}), {}, [("bob <bob@y.com>",)]),
    ("arithmetic nesting", sel(**{"from": "orders", "columns": [{"expr": {"fn": "+", "args": [{"fn": "*", "args": [col("total"), 2]}, 1]}, "as": "a"}, {"expr": {"fn": "*", "args": [{"fn": "+", "args": [col("total"), 1]}, 2]}, "as": "b"}], "where": eq("id", 1)}), {}, [(21.0, 22.0)]),
    ("coalesce", sel(**{"from": "users", "columns": [{"expr": {"fn": "coalesce", "args": [col("org_id"), 0]}, "as": "o"}], "where": eq("id", 4)}), {}, [(0,)]),
    ("cast", sel(**{"from": "users", "columns": [{"expr": {"fn": "cast", "args": [col("age"), "text"]}, "as": "a"}], "where": eq("id", 1)}), {}, [("30",)]),
    ("not/or", sel(**{"from": "users", "columns": ["id"], "where": {"not": {"or": [{"col": "age", "op": "<", "value": 20}, eq("active", 0)]}}, "orderBy": [{"expr": col("id")}]}), {}, [(1,), (3,), (5,)]),
    ("boolean literal", sel(**{"from": "users", "columns": ["id"], "where": eq("active", True), "orderBy": [{"expr": col("id")}]}), {}, [(1,), (3,), (4,), (5,)]),
    ("count distinct", sel(**{"from": "orders", "columns": [{"expr": col("status"), "agg": "count", "distinct": True, "as": "n"}]}), {}, [(3,)]),
    ("min/max/avg", sel(**{"from": "orders", "columns": [{"expr": col("total"), "agg": "min"}, {"expr": col("total"), "agg": "max"}, {"expr": col("total"), "agg": "avg"}]}), {}, [(5.0, 100.0, 34.625)]),
    ("schema-qualified table", sel(**{"from": "main.users", "columns": ["id"], "where": eq("id", 3)}), {}, [(3,)]),
    ("string literal with quote", sel(**{"from": "users", "columns": ["id"], "where": eq("name", "O'Brien")}), {}, []),
    ("table star", sel(**{"from": {"name": "orgs", "as": "o"}, "columns": ["o.*"], "where": eq("o.id", 1)}), {}, [(1, "Acme")]),
]


def exec_rows(conn: sqlite3.Connection, sql: str, params: list[Any]) -> list[tuple]:
    return conn.execute(sql, params).fetchall()


def suite_compile_sqlite(via: str, call) -> None:
    section(f"b. compile -> sqlite execution oracle [{via}]")
    resp_all = pmap(lambda row: call("compile", compile_req(row[1], "sqlite")), SELECT_EXEC)
    for (name, _, values, expected), resp in zip(SELECT_EXEC, resp_all):
        if not resp["ok"]:
            check(f"select: {name}", False, resp)
            continue
        data = resp["data"]
        try:
            rows = exec_rows(fresh_db(), data["sql"], bind(data["params"], values))
        except sqlite3.Error as error:
            check(f"select: {name}", False, f"{error} | {data['sql']}")
            continue
        check(f"select: {name}", rows == expected, f"{rows} != {expected} | {data['sql']}")

    # ---- DML / DDL with verification queries
    def run_dml(spec, dialect="sqlite"):
        return call("compile", compile_req(spec, dialect))

    conn = fresh_db()
    r = run_dml({"op": "insert", "table": "orgs", "columns": ["id", "name"], "rows": [[10, "X"], [11, {"param": "n"}]]})
    conn.execute(r["data"]["sql"], bind(r["data"]["params"], {"n": "Y"}))
    check("insert multi-row + param", conn.execute("SELECT id, name FROM orgs WHERE id >= 10 ORDER BY id").fetchall() == [(10, "X"), (11, "Y")], r)

    conn = fresh_db()
    r = run_dml({"op": "insert", "table": "users", "columns": ["id", "name"], "rows": [[1, "Alicia"]], "onConflict": {"target": ["id"], "action": "update"}})
    conn.execute(r["data"]["sql"])
    check("upsert update (all non-target columns from excluded)", conn.execute("SELECT name, age FROM users WHERE id = 1").fetchall() == [("Alicia", 30)], r)

    conn = fresh_db()
    r = run_dml({"op": "insert", "table": "users", "columns": ["id", "name"], "rows": [[1, "Zed"]], "onConflict": {"target": ["id"], "action": "nothing"}})
    conn.execute(r["data"]["sql"])
    check("upsert do nothing", conn.execute("SELECT name FROM users WHERE id = 1").fetchall() == [("Alice",)], r)

    conn = fresh_db()
    r = run_dml({"op": "insert", "table": "users", "columns": ["id", "name"], "rows": [[1, "Q"]],
                 "onConflict": {"target": ["id"], "action": "update", "set": {"age": {"fn": "+", "args": [col("users.age"), 1]}}}})
    conn.execute(r["data"]["sql"])
    check("upsert explicit set referencing the existing row", conn.execute("SELECT name, age FROM users WHERE id = 1").fetchall() == [("Alice", 31)], r)

    conn = fresh_db()
    r = run_dml({"op": "insert", "table": "orgs", "columns": ["id", "name"], "rows": [[20, "N"]], "returning": ["id", "name"]})
    check("insert returning", conn.execute(r["data"]["sql"]).fetchall() == [(20, "N")], r)

    conn = fresh_db()
    r = run_dml({"op": "update", "table": "orders", "set": {"total": {"fn": "+", "args": [col("total"), {"param": "d"}]}}, "where": {"col": "status", "op": "=", "value": {"param": "s"}}, "returning": ["id", "total"]})
    rows = conn.execute(r["data"]["sql"], bind(r["data"]["params"], {"d": 1, "s": "open"})).fetchall()
    check("update arithmetic + params + returning (param order = text order)", sorted(rows) == [(3, 8.25), (6, 61.0)] and r["data"]["params"] == ["d", "s"], (rows, r))

    conn = fresh_db()
    r = run_dml({"op": "delete", "table": "orders", "where": {"col": "id", "op": "in", "value": [1, 2, 3]}})
    conn.execute(r["data"]["sql"])
    check("delete where in", [x[0] for x in conn.execute("SELECT id FROM orders ORDER BY id")] == [4, 5, 6], r)

    conn = fresh_db()
    r = run_dml({"op": "delete", "table": "orders"})
    conn.execute(r["data"]["sql"])
    check("delete without where empties the table and warns", conn.execute("SELECT count(*) FROM orders").fetchone() == (0,) and any("DELETE without where" in m for _, m in issues_of(r)), r)

    big = {"op": "create_table", "name": "accounts", "ifNotExists": True, "columns": [
        {"name": "id", "type": "serial", "primaryKey": True},
        {"name": "email", "type": "varchar(80)", "nullable": False, "unique": True},
        {"name": "bio", "type": "text"},
        {"name": "active", "type": "boolean", "default": True},
        {"name": "created", "type": "timestamp", "default": {"fn": "now"}},
        {"name": "org", "type": "integer", "references": {"table": "orgs", "column": "id", "onDelete": "cascade"}},
        {"name": "score", "type": "numeric(10,2)", "default": 0}]}
    conn = fresh_db()
    r = run_dml(big)
    conn.execute(r["data"]["sql"])
    conn.execute(r["data"]["sql"])  # IF NOT EXISTS: second run is a no-op
    info = {row[1]: row for row in conn.execute("PRAGMA table_info(accounts)")}
    check("create_table: columns, NOT NULL and PK", list(info) == ["id", "email", "bio", "active", "created", "org", "score"] and info["email"][3] == 1 and info["id"][5] == 1, info)
    conn.execute("INSERT INTO accounts (email, org) VALUES ('a@x', 1)")
    conn.execute("INSERT INTO accounts (email) VALUES ('b@x')")
    ids = [row[0] for row in conn.execute("SELECT id FROM accounts ORDER BY id")]
    check("create_table: serial -> AUTOINCREMENT assigns 1,2", ids == [1, 2], r["data"]["sql"])
    row = conn.execute("SELECT active, score, created FROM accounts WHERE id = 1").fetchone()
    check("create_table: defaults (true, 0, now)", row[0] == 1 and row[1] == 0 and re.match(r"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d", row[2] or ""), row)
    try:
        conn.execute("INSERT INTO accounts (email) VALUES ('a@x')")
        dup = False
    except sqlite3.IntegrityError:
        dup = True
    check("create_table: unique enforced", dup)
    fk = conn.execute("PRAGMA foreign_key_list(accounts)").fetchall()
    check("create_table: foreign key with ON DELETE CASCADE", len(fk) == 1 and fk[0][2] == "orgs" and fk[0][6] == "CASCADE", fk)

    conn = fresh_db()
    r = run_dml({"op": "create_table", "name": "order", "columns": [{"name": "group", "type": "integer", "nullable": False}, {"name": "my col", "type": "text"}, {"name": "select", "type": "text"}], "primaryKey": ["group"]})
    conn.execute(r["data"]["sql"])
    ins = run_dml({"op": "insert", "table": "order", "columns": ["group", "my col", "select"], "rows": [[1, "a", "b"]]})
    conn.execute(ins["data"]["sql"])
    q = run_dml(sel(**{"from": "order", "columns": ["group", "my col", "select"], "where": eq("group", 1)}))
    check("reserved words and spaces are quoted only where needed", conn.execute(q["data"]["sql"]).fetchall() == [(1, "a", "b")] and '"my col"' in q["data"]["sql"] and "FROM users" not in q["data"]["sql"], q)
    plain = run_dml(sel(**{"from": "users", "columns": ["id", "name"]}))
    check("plain identifiers stay unquoted", plain["data"]["sql"] == "SELECT id, name FROM users", plain)

    conn = fresh_db()
    r = run_dml({"op": "create_table", "name": "pairs", "columns": [{"name": "a", "type": "integer"}, {"name": "b", "type": "integer"}, {"name": "id", "type": "bigint", "autoIncrement": False}], "primaryKey": ["a", "b"]})
    conn.execute(r["data"]["sql"])
    pk = sorted((row[5], row[1]) for row in conn.execute("PRAGMA table_info(pairs)") if row[5])
    check("create_table composite primary key", pk == [(1, "a"), (2, "b")], r)
    r = run_dml({"op": "create_table", "name": "t2", "columns": [{"name": "id", "type": "bigint", "primaryKey": True, "autoIncrement": True}, {"name": "n", "type": "text"}]})
    conn.execute(r["data"]["sql"])
    conn.execute("INSERT INTO t2 (n) VALUES ('x')")
    conn.execute("INSERT INTO t2 (n) VALUES ('y')")
    check("autoIncrement flag on a bigint PK works in sqlite", [x[0] for x in conn.execute("SELECT id FROM t2 ORDER BY id")] == [1, 2], r)


# transpile-to-sqlite cases that are executed: (from dialect, sql, setup statements, verify query or None, expected rows)
SQLITE_TRANSPILE_EXEC: list[tuple[str, str, str | None, list[tuple]]] = [
    ("postgres", "SELECT name FROM users WHERE name ILIKE 'a%' ORDER BY id", None, [("Alice",), ("alan",)]),
    ("mysql", "SELECT CONCAT(name, '-', id) FROM users WHERE id < 3 ORDER BY id", None, [("Alice-1",), ("bob-2",)]),
    ("tsql", "SELECT TOP 2 id FROM users ORDER BY id DESC", None, [(5,), (4,)]),
    ("oracle", "SELECT NVL(org_id, -1) FROM users ORDER BY id FETCH FIRST 5 ROWS ONLY", None, [(1,), (1,), (2,), (-1,), (2,)]),
    ("postgres", "SELECT TRUE, FALSE", None, [(1, 0)]),
    ("postgres", "SELECT id FROM users ORDER BY id LIMIT 2 OFFSET 2", None, [(3,), (4,)]),
    ("mysql", "SELECT IFNULL(created, 'n/a') FROM users WHERE id IN (1, 4) ORDER BY id", None, [("2024-01-05",), ("n/a",)]),
    ("postgres", "SELECT id::text FROM orgs ORDER BY id", None, [("1",), ("2",), ("3",)]),
    ("postgres", "SELECT COALESCE(org_id, 0) FROM users WHERE id = 4", None, [(0,)]),
    ("postgres", "INSERT INTO orgs (id, name) VALUES (1, 'Acme2') ON CONFLICT (id) DO UPDATE SET name = excluded.name", "SELECT name FROM orgs WHERE id = 1", [("Acme2",)]),
    ("sqlite", "INSERT INTO orgs (id, name) VALUES (1, 'Acme2') ON CONFLICT(id) DO NOTHING", "SELECT name FROM orgs WHERE id = 1", [("Acme",)]),
    ("duckdb", "SELECT CAST(age AS BIGINT) FROM users WHERE id = 1", None, [(30,)]),
    ("snowflake", "SELECT IFF(age > 26, 'old', 'young') FROM users ORDER BY id LIMIT 2", None, [("old",), ("young",)]),
    ("bigquery", "SELECT IFNULL(org_id, 0), CAST(age AS STRING) FROM users WHERE id = 4", None, [(0, "19")]),
    ("postgres", "SELECT SUBSTRING(name, 2, 3) FROM users WHERE id = 1", None, [("lic",)]),
    ("postgres", "CREATE TABLE t (id SERIAL PRIMARY KEY, n TEXT); INSERT INTO t (n) VALUES ('a'), ('b')", "SELECT id, n FROM t ORDER BY id", [(1, "a"), (2, "b")]),
    ("mysql", "CREATE TABLE t (id INT AUTO_INCREMENT PRIMARY KEY, n VARCHAR(10)); INSERT INTO t (n) VALUES ('a'), ('b')", "SELECT id, n FROM t ORDER BY id", [(1, "a"), (2, "b")]),
    ("tsql", "CREATE TABLE t (id INT IDENTITY(1,1) PRIMARY KEY, n VARCHAR(MAX)); INSERT INTO t (n) VALUES ('a'), ('b')", "SELECT id, n FROM t ORDER BY id", [(1, "a"), (2, "b")]),
    ("postgres", "UPDATE users SET age = age + 1 WHERE id = 1 RETURNING age", None, [(31,)]),
    ("tsql", "SELECT ISNULL(org_id, 0) + LEN(name) FROM users WHERE id = 1", None, [(6,)]),
    ("postgres", "SELECT id FROM users WHERE name ILIKE 'D%' AND age = 25 ORDER BY 1", None, [(5,)]),
]


def suite_transpile_sqlite(via: str, call) -> None:
    section(f"b2. transpile -> sqlite execution oracle [{via}]")
    resp_all = pmap(lambda row: call("transpile", {"sql": row[1], "from": row[0], "to": "sqlite"}), SQLITE_TRANSPILE_EXEC)
    for (frm, sql, verify, expected), resp in zip(SQLITE_TRANSPILE_EXEC, resp_all):
        label = f"{frm}->sqlite: {sql[:60]}"
        if not resp["ok"] or errors_of(resp):
            check(label, False, resp)
            continue
        conn = fresh_db()
        try:
            cur = None
            for part in [p for p in resp["data"]["sql"].split(";\n") if p.strip()] or [resp["data"]["sql"]]:
                cur = conn.execute(part.rstrip(";"))
            rows = conn.execute(verify).fetchall() if verify else (cur.fetchall() if cur else [])
        except sqlite3.Error as error:
            check(label, False, f"{error} | {resp['data']['sql']}")
            continue
        check(label, rows == expected, f"{rows} != {expected} | {resp['data']['sql']}")


# ------------------------------------------------------------------ (b3/c) compile known answers, placeholders, round trip

COMPILE_KAT: list[tuple[str, dict[str, Any], str, str, list[str]]] = []


def _kat() -> None:
    users = sel(**{"from": "users", "columns": ["id", "name"], "where": {"and": [{"col": "age", "op": ">", "value": {"param": "min"}}, {"col": "name", "op": "ilike", "value": "a%"}]},
                   "orderBy": [{"expr": col("id"), "dir": "desc"}], "limit": 10, "offset": 5})
    ins = {"op": "insert", "table": "users", "columns": ["id", "name"], "rows": [[1, "a"], [2, {"param": "n"}]], "onConflict": {"target": ["id"], "action": "update"}}
    rows = [
        ("select limit/offset", users, "sqlite", "SELECT id, name FROM users WHERE age > ? AND LOWER(name) LIKE LOWER('a%') ORDER BY id DESC LIMIT 10 OFFSET 5", ["min"]),
        ("select limit/offset", users, "postgres", "SELECT id, name FROM users WHERE age > $1 AND name ILIKE 'a%' ORDER BY id DESC LIMIT 10 OFFSET 5", ["min"]),
        ("select limit/offset", users, "mysql", "SELECT id, name FROM users WHERE age > ? AND LOWER(name) LIKE LOWER('a%') ORDER BY id DESC LIMIT 10 OFFSET 5", ["min"]),
        ("select limit/offset", users, "mariadb", "SELECT id, name FROM users WHERE age > ? AND LOWER(name) LIKE LOWER('a%') ORDER BY id DESC LIMIT 10 OFFSET 5", ["min"]),
        ("select limit/offset", users, "tsql", "SELECT id, name FROM users WHERE age > @min AND LOWER(name) LIKE LOWER('a%') ORDER BY id DESC OFFSET 5 ROWS FETCH FIRST 10 ROWS ONLY", ["min"]),
        ("select limit/offset", users, "oracle", "SELECT id, name FROM users WHERE age > :min AND LOWER(name) LIKE LOWER('a%') ORDER BY id DESC OFFSET 5 ROWS FETCH FIRST 10 ROWS ONLY", ["min"]),
        ("select limit/offset", users, "bigquery", "SELECT id, name FROM users WHERE age > @min AND LOWER(name) LIKE LOWER('a%') ORDER BY id DESC LIMIT 10 OFFSET 5", ["min"]),
        ("select limit/offset", users, "snowflake", "SELECT id, name FROM users WHERE age > ? AND name ILIKE 'a%' ORDER BY id DESC LIMIT 10 OFFSET 5", ["min"]),
        ("select limit/offset", users, "duckdb", "SELECT id, name FROM users WHERE age > ? AND name ILIKE 'a%' ORDER BY id DESC LIMIT 10 OFFSET 5", ["min"]),
        ("select limit/offset", users, "redshift", "SELECT id, name FROM users WHERE age > $1 AND name ILIKE 'a%' ORDER BY id DESC LIMIT 10 OFFSET 5", ["min"]),
        ("select limit/offset", users, "trino", "SELECT id, name FROM users WHERE age > ? AND LOWER(name) LIKE LOWER('a%') ORDER BY id DESC OFFSET 5 LIMIT 10", ["min"]),
        ("select top only", sel(**{"from": "users", "limit": 3}), "tsql", "SELECT TOP 3 * FROM users", []),
        ("select first-n", sel(**{"from": "users", "limit": 3}), "oracle", "SELECT * FROM users FETCH FIRST 3 ROWS ONLY", []),
        ("upsert", ins, "sqlite", "INSERT INTO users (id, name) VALUES (1, 'a'), (2, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name", ["n"]),
        ("upsert", ins, "postgres", "INSERT INTO users (id, name) VALUES (1, 'a'), (2, $1) ON CONFLICT(id) DO UPDATE SET name = excluded.name", ["n"]),
        ("upsert", ins, "mysql", "INSERT INTO users (id, name) VALUES (1, 'a'), (2, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)", ["n"]),
        ("upsert", ins, "duckdb", "INSERT INTO users (id, name) VALUES (1, 'a'), (2, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name", ["n"]),
        ("insert oracle multi-row", {"op": "insert", "table": "t", "columns": ["a"], "rows": [[1], [2]]}, "oracle", "INSERT ALL INTO t (a) VALUES (1) INTO t (a) VALUES (2) SELECT 1 FROM DUAL", []),
        ("quoting", sel(**{"from": "order", "columns": ["group", "my col"]}), "mysql", "SELECT `group`, `my col` FROM `order`", []),
        ("quoting", sel(**{"from": "order", "columns": ["group", "my col"]}), "tsql", "SELECT [group], [my col] FROM [order]", []),
        ("quoting", sel(**{"from": "order", "columns": ["group", "my col"]}), "postgres", 'SELECT "group", "my col" FROM "order"', []),
        ("quoting", sel(**{"from": "order", "columns": ["group", "my col"]}), "bigquery", "SELECT `group`, `my col` FROM `order`", []),
        ("bool literal", sel(**{"from": "t", "where": eq("flag", True)}), "tsql", "SELECT * FROM t WHERE flag = 1", []),
        ("bool literal", sel(**{"from": "t", "where": eq("flag", True)}), "postgres", "SELECT * FROM t WHERE flag = TRUE", []),
        ("now()", sel(**{"from": "t", "columns": [{"expr": {"fn": "now"}, "as": "n"}]}), "tsql", "SELECT GETDATE() AS n FROM t", []),
        ("now()", sel(**{"from": "t", "columns": [{"expr": {"fn": "now"}, "as": "n"}]}), "sqlite", "SELECT CURRENT_TIMESTAMP AS n FROM t", []),
        ("concat", sel(**{"from": "t", "columns": [{"expr": {"fn": "||", "args": [col("a"), col("b")]}, "as": "c"}]}), "mysql", "SELECT CONCAT(a, b) AS c FROM t", []),
        ("concat", sel(**{"from": "t", "columns": [{"expr": {"fn": "||", "args": [col("a"), col("b")]}, "as": "c"}]}), "tsql", "SELECT a + b AS c FROM t", []),
        ("having alias -> aggregate", sel(**{"from": "orders", "columns": ["status", {"expr": "*", "agg": "count", "as": "n"}], "groupBy": [col("status")], "having": {"col": "n", "op": ">", "value": 1}}), "postgres",
         "SELECT status, COUNT(*) AS n FROM orders GROUP BY status HAVING COUNT(*) > 1", []),
        ("ddl identity", {"op": "create_table", "name": "t", "columns": [{"name": "id", "type": "serial", "primaryKey": True}, {"name": "n", "type": "text"}]}, "mysql", "CREATE TABLE t (id INT AUTO_INCREMENT PRIMARY KEY, n TEXT)", []),
        ("ddl identity", {"op": "create_table", "name": "t", "columns": [{"name": "id", "type": "serial", "primaryKey": True}, {"name": "n", "type": "text"}]}, "tsql", "CREATE TABLE t (id INTEGER IDENTITY(1, 1) PRIMARY KEY, n VARCHAR(MAX))", []),
        ("ddl identity", {"op": "create_table", "name": "t", "columns": [{"name": "id", "type": "serial", "primaryKey": True}, {"name": "n", "type": "text"}]}, "postgres", "CREATE TABLE t (id INT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, n TEXT)", []),
        ("ddl identity", {"op": "create_table", "name": "t", "columns": [{"name": "id", "type": "serial", "primaryKey": True}, {"name": "n", "type": "text"}]}, "oracle", "CREATE TABLE t (id INT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, n CLOB)", []),
        ("ddl identity", {"op": "create_table", "name": "t", "columns": [{"name": "id", "type": "serial", "primaryKey": True}, {"name": "n", "type": "text"}]}, "snowflake", "CREATE TABLE t (id INT AUTOINCREMENT PRIMARY KEY, n VARCHAR)", []),
        ("ddl types", {"op": "create_table", "name": "t", "columns": [{"name": "a", "type": "boolean"}, {"name": "b", "type": "timestamp"}, {"name": "c", "type": "varchar(20)"}, {"name": "d", "type": "numeric(10,2)"}]}, "tsql", "CREATE TABLE t (a BIT, b DATETIME2, c VARCHAR(20), d NUMERIC(10, 2))", []),
        ("ddl types", {"op": "create_table", "name": "t", "columns": [{"name": "a", "type": "boolean"}, {"name": "b", "type": "timestamp"}, {"name": "c", "type": "varchar(20)"}, {"name": "d", "type": "numeric(10,2)"}]}, "oracle", "CREATE TABLE t (a NUMBER(1), b TIMESTAMP, c VARCHAR2(20), d NUMBER(10, 2))", []),
        ("ddl types", {"op": "create_table", "name": "t", "columns": [{"name": "a", "type": "boolean"}, {"name": "b", "type": "timestamp"}, {"name": "c", "type": "varchar(20)"}, {"name": "d", "type": "numeric(10,2)"}]}, "bigquery", "CREATE TABLE t (a BOOL, b DATETIME, c STRING(20), d NUMERIC(10, 2))", []),
        ("ddl types", {"op": "create_table", "name": "t", "columns": [{"name": "a", "type": "boolean"}, {"name": "b", "type": "timestamp"}, {"name": "c", "type": "varchar(20)"}, {"name": "d", "type": "numeric(10,2)"}]}, "mysql", "CREATE TABLE t (a BOOLEAN, b DATETIME, c VARCHAR(20), d DECIMAL(10, 2))", []),
    ]
    COMPILE_KAT.extend(rows)


_kat()


def suite_compile_kat(via: str, call) -> None:
    section(f"b3. compile known-answer [{via}]")
    resp_all = pmap(lambda row: call("compile", compile_req(row[1], row[2])), COMPILE_KAT)
    for (name, _, dialect, sql, params), resp in zip(COMPILE_KAT, resp_all):
        ok = resp["ok"] and resp["data"]["sql"] == sql and resp["data"]["params"] == params
        check(f"{name} / {dialect}", ok, resp if not resp["ok"] else (resp["data"]["sql"], resp["data"]["params"]))
    pretty = call("compile", compile_req(COMPILE_KAT[0][1], "postgres", pretty=True))
    check("pretty compile is multi-line and still parameterised", pretty["ok"] and "\n" in pretty["data"]["sql"] and "$1" in pretty["data"]["sql"], pretty)

    # --- placeholder styles and parameter ordering
    spec = sel(**{"from": "t", "columns": ["x"], "where": {"and": [eq("a", {"param": "alpha"}), eq("b", {"param": "beta"}), eq("c", {"param": "alpha"})]}})
    expectations = {
        "?": (["sqlite", "mysql", "mariadb", "duckdb", "snowflake", "clickhouse", "trino", "spark", "hive"], ["alpha", "beta", "alpha"], r"a = \? AND b = \? AND c = \?"),
        "$n": (["postgres", "redshift"], ["alpha", "beta"], r"a = \$1 AND b = \$2 AND c = \$1"),
        "@name": (["tsql", "bigquery"], ["alpha", "beta"], r"a = @alpha AND b = @beta AND c = @alpha"),
        ":name": (["oracle"], ["alpha", "beta"], r"a = :alpha AND b = :beta AND c = :alpha"),
    }
    for style, (dialects, params, pattern) in expectations.items():
        for resp, dialect in zip(pmap(lambda d: call("compile", compile_req(spec, d)), dialects), dialects):
            check(f"placeholder style {style} / {dialect}", resp["ok"] and resp["data"]["params"] == params and re.search(pattern, resp["data"]["sql"]) is not None, resp)
    cte_spec = sel(**{"from": "c", "where": eq("m", {"param": "main_p"}), "ctes": [{"name": "c", "query": sel(**{"from": "u", "where": eq("k", {"param": "cte_p"})})}]})
    resp = call("compile", compile_req(cte_spec, "sqlite"))
    check("params follow SQL text order (CTE first even though listed last in the spec)", resp["ok"] and resp["data"]["params"] == ["cte_p", "main_p"] and resp["data"]["sql"].startswith("WITH c AS"), resp)
    resp = call("compile", compile_req(sel(**{"from": "t", "where": eq("a", "__KNIFEP_x_0__")}), "sqlite"))
    check("a literal that looks like an internal placeholder is left alone", resp["ok"] and "'__KNIFEP_x_0__'" in resp["data"]["sql"] and resp["data"]["params"] == [], resp)
    resp = call("compile", compile_req(sel(**{"from": "t", "where": eq("a", "x'; DROP TABLE t; --")}), "postgres"))
    check("string literals are escaped (no injection)", resp["ok"] and "'x''; DROP TABLE t; --'" in resp["data"]["sql"], resp)
    resp = call("compile", compile_req(sel(**{"from": "t", "where": eq("a", None)}), "sqlite"))
    check("= null warns", resp["ok"] and any("is null" in m for _, m in issues_of(resp)), resp)
    resp = call("compile", compile_req(sel(**{"from": "t", "where": {"col": "a", "op": "ilike", "value": "x"}}), "mariadb"))
    check("mariadb compile notes the MySQL dialect and the ILIKE emulation", resp["ok"] and any("MariaDB" in m for _, m in issues_of(resp)) and any("ILIKE" in m for _, m in issues_of(resp)), resp)


ROUND_TRIP_SPECS: dict[str, dict[str, Any]] = {
    "select complex": sel(**{"from": {"name": "users", "as": "u"}, "distinct": True, "columns": ["u.id", {"expr": {"fn": "count", "args": [col("*")]}, "as": "n"}, {"expr": {"fn": "coalesce", "args": [col("o.name"), "none"]}, "as": "org"}],
        "joins": [{"type": "left", "table": {"name": "orgs", "as": "o"}, "on": {"and": [{"col": "u.org_id", "op": "=", "value": col("o.id")}, {"col": "o.name", "op": "!=", "value": {"param": "skip"}}]}}],
        "where": {"or": [{"col": "u.name", "op": "ilike", "value": "%a%"}, {"not": {"col": "u.age", "op": "between", "value": [1, {"param": "hi"}]}}, {"col": "u.id", "op": "in", "value": [1, 2, 3]}]},
        "groupBy": [col("u.id"), col("o.name")], "having": {"col": "n", "op": ">=", "value": 1}, "orderBy": [{"expr": col("n"), "dir": "desc", "nulls": "last"}, {"expr": col("u.id")}], "limit": 5, "offset": 2}),
    "select cte + subquery-free": sel(**{"from": "t2", "ctes": [{"name": "t1", "query": sel(**{"from": "orders", "columns": ["user_id"], "where": {"col": "total", "op": ">", "value": {"param": "p"}}})},
                                                             {"name": "t2", "query": sel(**{"from": "t1", "columns": ["user_id"], "distinct": True})}]}),
    "select functions": sel(**{"from": "t", "columns": [{"expr": {"fn": "upper", "args": [col("a")]}, "as": "u"}, {"expr": {"fn": "length", "args": [col("a")]}, "as": "l"}, {"expr": {"fn": "now"}, "as": "n"},
                                                    {"expr": {"fn": "cast", "args": [col("a"), "integer"]}, "as": "i"}, {"expr": {"fn": "+", "args": [{"fn": "*", "args": [col("a"), 2]}, 1]}, "as": "m"}]}),
    "select aggregates": sel(**{"from": "t", "columns": [{"expr": col("a"), "agg": "sum"}, {"expr": col("a"), "agg": "avg"}, {"expr": col("a"), "agg": "min"}, {"expr": col("a"), "agg": "max"}, {"expr": col("a"), "agg": "count", "distinct": True}]}),
    "insert": {"op": "insert", "table": "users", "columns": ["id", "name"], "rows": [[1, "a"], [2, {"param": "n"}]]},
    "update": {"op": "update", "table": "users", "set": {"name": {"param": "n"}, "age": {"fn": "+", "args": [col("age"), 1]}}, "where": {"col": "id", "op": "=", "value": {"param": "id"}}},
    "delete": {"op": "delete", "table": "users", "where": {"and": [{"col": "id", "op": "in", "value": [1, 2]}, {"col": "name", "op": "is not null"}]}},
    "create_table": {"op": "create_table", "name": "t", "ifNotExists": True, "columns": [{"name": "id", "type": "integer", "primaryKey": True}, {"name": "email", "type": "varchar(80)", "nullable": False, "unique": True},
                     {"name": "bio", "type": "text"}, {"name": "ok", "type": "boolean", "default": True}, {"name": "at", "type": "timestamp", "default": {"fn": "now"}}, {"name": "org", "type": "integer", "references": {"table": "orgs", "column": "id"}}, {"name": "n", "type": "numeric(10,2)"}]},
    "create_table composite": {"op": "create_table", "name": "pairs", "columns": [{"name": "a", "type": "integer"}, {"name": "b", "type": "integer"}], "primaryKey": ["a", "b"]},
    "upsert": {"op": "insert", "table": "users", "columns": ["id", "name"], "rows": [[1, "a"]], "onConflict": {"target": ["id"], "action": "update"}},
    "upsert nothing": {"op": "insert", "table": "users", "columns": ["id", "name"], "rows": [[1, "a"]], "onConflict": {"target": ["id"], "action": "nothing"}},
    "returning": {"op": "update", "table": "users", "set": {"name": "z"}, "where": eq("id", 1), "returning": ["id"]},
    "identity": {"op": "create_table", "name": "t", "columns": [{"name": "id", "type": "serial", "primaryKey": True}, {"name": "n", "type": "text"}]},
}
# documented, intentional refusals: (spec name, dialect) -> message fragment
EXPECTED_REFUSALS: dict[tuple[str, str], str] = {}
for _d in ("clickhouse", "hive"):
    EXPECTED_REFUSALS[("upsert", _d)] = "onConflict is not supported"
    EXPECTED_REFUSALS[("upsert nothing", _d)] = "onConflict is not supported"
for _d in ("mysql", "oracle", "bigquery", "snowflake", "redshift", "clickhouse", "trino", "spark", "hive"):
    EXPECTED_REFUSALS[("returning", _d)] = "returning is not supported"
EXPECTED_REFUSALS[("returning", "mariadb")] = "returning is not supported for MariaDB UPDATE"
for _d in ("bigquery", "clickhouse", "trino", "spark", "hive"):
    EXPECTED_REFUSALS[("identity", _d)] = "not supported for"


def suite_roundtrip(via: str, call) -> None:
    section(f"c. compile -> re-parse in the same dialect, 14 dialects [{via}]")
    combos = [(name, dialect) for name in ROUND_TRIP_SPECS for dialect in DIALECTS]
    compiled = pmap(lambda c: call("compile", compile_req(ROUND_TRIP_SPECS[c[0]], c[1])), combos)
    to_validate = []
    for (name, dialect), resp in zip(combos, compiled):
        refusal = EXPECTED_REFUSALS.get((name, dialect))
        if not resp["ok"]:
            check(f"{name} / {dialect}: refusal is the documented one", refusal is not None and refusal in resp["error"], resp)
            continue
        check(f"{name} / {dialect}: compiles (not a documented refusal)", refusal is None, resp)
        to_validate.append((name, dialect, resp["data"]["sql"]))
    validated = pmap(lambda t: call("validate", {"sql": t[2], "dialect": t[1]}), to_validate)
    for (name, dialect, sql), resp in zip(to_validate, validated):
        check(f"{name} / {dialect}: re-parses with zero errors", resp["ok"] and resp["data"]["ok"] and not errors_of({"data": resp["data"]}), (sql, resp))
    check("round-trip covered every dialect", {d for _, d, _ in to_validate} == set(DIALECTS))


# ------------------------------------------------------------------ (b4) MERGE for engines without ON CONFLICT

MERGE_DIALECTS = ["tsql", "oracle", "snowflake", "bigquery", "redshift", "trino", "spark"]
_DUCK_PY = os.environ.get("KNIFE_DUCKDB_PY") or str(ROOT.parent / "samurai-knife-py" / "venv-duckdb" / "bin" / "python")
_DUCK = Path(_DUCK_PY).exists()


def merge_spec(rows: list[list[Any]], action: str = "update", **oc: Any) -> dict[str, Any]:
    return {"op": "insert", "table": "users", "columns": ["id", "name", "n"], "rows": rows, "onConflict": {"target": ["id"], "action": action, **oc}}


def inline_params(sql: str, params: list[str], values: dict[str, Any], dialect: str) -> str:
    """Substitute the dialect's placeholders with SQL literals so a plain engine can run the statement."""
    lit = lambda name: repr(values[name]) if not isinstance(values[name], str) else "'" + values[name].replace("'", "''") + "'"  # noqa: E731
    style = {"postgres": "$", "redshift": "$", "tsql": "@", "bigquery": "@", "oracle": ":"}.get(dialect, "?")
    if style == "?":
        it = iter(params)
        return re.sub(r"\?", lambda _m: lit(next(it)), sql)
    if style == "$":
        return re.sub(r"\$(\d+)", lambda m: lit(params[int(m.group(1)) - 1]), sql)
    return re.sub(rf"{re.escape(style)}([A-Za-z_]\w*)", lambda m: lit(m.group(1)), sql)


def duck_run(jobs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    proc = subprocess.run([_DUCK_PY, str(ROOT / "tests" / "duck_exec.py")], input=json.dumps(jobs), capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        return [{"error": proc.stderr[-300:]}] * len(jobs)
    return json.loads(proc.stdout)


USERS_SETUP = ["CREATE TABLE users (id INTEGER PRIMARY KEY, name VARCHAR, n INTEGER)", "INSERT INTO users VALUES (1,'x',10),(3,'z',30)"]
USERS_QUERY = "SELECT id, name, n FROM users ORDER BY id"
# scenario: (name, spec, param values, setup, query, hand-computed final table)
MERGE_EXEC: list[tuple[str, dict[str, Any], dict[str, Any], list[str], str, list[list[Any]]]] = [
    ("update existing + insert new", merge_spec([[1, "a", 5], [2, "b", 6]]), {}, USERS_SETUP, USERS_QUERY, [[1, "a", 5], [2, "b", 6], [3, "z", 30]]),
    ("action nothing keeps the existing row", merge_spec([[1, "a", 5], [2, "b", 6]], "nothing"), {}, USERS_SETUP, USERS_QUERY, [[1, "x", 10], [2, "b", 6], [3, "z", 30]]),
    ("set with the existing and the new row", merge_spec([[1, "a", 5], [2, "b", 6]], set={"n": {"fn": "+", "args": [{"col": "n"}, {"col": "excluded.n"}]}}), {}, USERS_SETUP, USERS_QUERY, [[1, "x", 15], [2, "b", 6], [3, "z", 30]]),
    ("a param used twice", merge_spec([[1, "a", {"param": "x"}], [2, "b", {"param": "x"}]]), {"x": 7}, USERS_SETUP, USERS_QUERY, [[1, "a", 7], [2, "b", 7], [3, "z", 30]]),
    ("only new rows", merge_spec([[4, "d", 1], [5, "e", 2], [6, "f", 3]]), {}, USERS_SETUP, USERS_QUERY, [[1, "x", 10], [3, "z", 30], [4, "d", 1], [5, "e", 2], [6, "f", 3]]),
    ("single row", merge_spec([[3, "q", 0]]), {}, USERS_SETUP, USERS_QUERY, [[1, "x", 10], [3, "q", 0]]),
    ("composite key", {"op": "insert", "table": "users", "columns": ["a", "b", "v"], "rows": [[1, 1, "new"], [2, 1, "ins"]], "onConflict": {"target": ["a", "b"], "action": "update"}}, {},
     ["CREATE TABLE users (a INTEGER, b INTEGER, v VARCHAR, PRIMARY KEY (a, b))", "INSERT INTO users VALUES (1,1,'old'),(1,2,'keep')"], "SELECT a, b, v FROM users ORDER BY a, b",
     [[1, 1, "new"], [1, 2, "keep"], [2, 1, "ins"]]),
    ("string with a quote", merge_spec([[1, "O'Neil", 1]]), {}, USERS_SETUP, USERS_QUERY, [[1, "O'Neil", 1], [3, "z", 30]]),
]
# sqlglot writes the quote as \' for these (their engines accept backslash escapes); DuckDB, the oracle, does not.
BACKSLASH_ESCAPE_DIALECTS = {"snowflake", "bigquery", "redshift", "spark"}


def sqlite_upsert_state(spec: dict[str, Any], values: dict[str, Any], setup: list[str], query: str) -> list[list[Any]]:
    """The same spec through the engine's own sqlite ON CONFLICT output, executed by stdlib sqlite3 (a second, independent path to the answer)."""
    resp = direct("compile", compile_req(spec, "sqlite"))
    conn = sqlite3.connect(":memory:")
    for stmt in setup:
        conn.execute(stmt)
    conn.execute(resp["data"]["sql"], bind(resp["data"]["params"], values))
    return [list(r) for r in conn.execute(query).fetchall()]


MERGE_KAT_ROWS = [[1, "a", {"param": "x"}], [2, "b", 3]]
MERGE_KAT: list[tuple[str, dict[str, Any], str, str, list[str]]] = [
    ("update", merge_spec(MERGE_KAT_ROWS), "tsql",
     "MERGE INTO users USING (VALUES (1, 'a', @x), (2, 'b', 3)) AS s(id, name, n) ON users.id = s.id WHEN MATCHED THEN UPDATE SET name = s.name, n = s.n WHEN NOT MATCHED THEN INSERT (id, name, n) VALUES (s.id, s.name, s.n);", ["x"]),
    ("update", merge_spec(MERGE_KAT_ROWS), "oracle",
     "MERGE INTO users USING (SELECT 1 AS id, 'a' AS name, :x AS n FROM DUAL UNION ALL SELECT 2, 'b', 3 FROM DUAL) s ON (users.id = s.id) WHEN MATCHED THEN UPDATE SET name = s.name, n = s.n WHEN NOT MATCHED THEN INSERT (id, name, n) VALUES (s.id, s.name, s.n)", ["x"]),
    ("update", merge_spec(MERGE_KAT_ROWS), "snowflake",
     "MERGE INTO users USING (VALUES (1, 'a', ?), (2, 'b', 3)) AS s(id, name, n) ON users.id = s.id WHEN MATCHED THEN UPDATE SET name = s.name, n = s.n WHEN NOT MATCHED THEN INSERT (id, name, n) VALUES (s.id, s.name, s.n)", ["x"]),
    ("update", merge_spec(MERGE_KAT_ROWS), "bigquery",
     "MERGE INTO users USING (SELECT 1 AS id, 'a' AS name, @x AS n UNION ALL SELECT 2, 'b', 3) AS s ON users.id = s.id WHEN MATCHED THEN UPDATE SET name = s.name, n = s.n WHEN NOT MATCHED THEN INSERT (id, name, n) VALUES (s.id, s.name, s.n)", ["x"]),
    ("update", merge_spec(MERGE_KAT_ROWS), "redshift",
     "MERGE INTO users USING (SELECT 1 AS id, 'a' AS name, $1 AS n UNION ALL SELECT 2, 'b', 3) AS s ON users.id = s.id WHEN MATCHED THEN UPDATE SET name = s.name, n = s.n WHEN NOT MATCHED THEN INSERT (id, name, n) VALUES (s.id, s.name, s.n)", ["x"]),
    ("update", merge_spec(MERGE_KAT_ROWS), "trino",
     "MERGE INTO users USING (VALUES (1, 'a', ?), (2, 'b', 3)) AS s(id, name, n) ON users.id = s.id WHEN MATCHED THEN UPDATE SET name = s.name, n = s.n WHEN NOT MATCHED THEN INSERT (id, name, n) VALUES (s.id, s.name, s.n)", ["x"]),
    ("update", merge_spec(MERGE_KAT_ROWS), "spark",
     "MERGE INTO users USING (SELECT 1 AS id, 'a' AS name, ? AS n UNION ALL SELECT 2, 'b', 3) AS s ON users.id = s.id WHEN MATCHED THEN UPDATE SET name = s.name, n = s.n WHEN NOT MATCHED THEN INSERT (id, name, n) VALUES (s.id, s.name, s.n)", ["x"]),
    ("nothing", merge_spec(MERGE_KAT_ROWS, "nothing"), "tsql",
     "MERGE INTO users USING (VALUES (1, 'a', @x), (2, 'b', 3)) AS s(id, name, n) ON users.id = s.id WHEN NOT MATCHED THEN INSERT (id, name, n) VALUES (s.id, s.name, s.n);", ["x"]),
    ("nothing", merge_spec(MERGE_KAT_ROWS, "nothing"), "oracle",
     "MERGE INTO users USING (SELECT 1 AS id, 'a' AS name, :x AS n FROM DUAL UNION ALL SELECT 2, 'b', 3 FROM DUAL) s ON (users.id = s.id) WHEN NOT MATCHED THEN INSERT (id, name, n) VALUES (s.id, s.name, s.n)", ["x"]),
    ("set", merge_spec(MERGE_KAT_ROWS, set={"n": {"fn": "+", "args": [{"col": "n"}, {"col": "excluded.n"}]}}), "tsql",
     "MERGE INTO users USING (VALUES (1, 'a', @x), (2, 'b', 3)) AS s(id, name, n) ON users.id = s.id WHEN MATCHED THEN UPDATE SET n = users.n + s.n WHEN NOT MATCHED THEN INSERT (id, name, n) VALUES (s.id, s.name, s.n);", ["x"]),
    ("single row oracle", merge_spec([[1, "a", 2]]), "oracle",
     "MERGE INTO users USING (SELECT 1 AS id, 'a' AS name, 2 AS n FROM DUAL) s ON (users.id = s.id) WHEN MATCHED THEN UPDATE SET name = s.name, n = s.n WHEN NOT MATCHED THEN INSERT (id, name, n) VALUES (s.id, s.name, s.n)", []),
]


def suite_merge(via: str, call) -> None:
    section(f"b4. insert.onConflict as MERGE [{via}]")
    for (name, spec, dialect, sql, params), resp in zip(MERGE_KAT, pmap(lambda row: call("compile", compile_req(row[1], row[2])), MERGE_KAT)):
        check(f"known answer {name} / {dialect}", resp["ok"] and resp["data"]["sql"] == sql and resp["data"]["params"] == params, resp if not resp["ok"] else (resp["data"]["sql"], resp["data"]["params"]))

    # structure per engine rule (regex over the generated text, not over sqlglot internals)
    for dialect, resp in zip(MERGE_DIALECTS, pmap(lambda d: call("compile", compile_req(merge_spec(MERGE_KAT_ROWS), d)), MERGE_DIALECTS)):
        sql = resp["data"]["sql"] if resp["ok"] else ""
        check(f"{dialect}: is a MERGE with USING / ON / both WHEN branches", sql.startswith("MERGE INTO users USING (") and " WHEN MATCHED THEN UPDATE SET " in sql and " WHEN NOT MATCHED THEN INSERT (id, name, n) VALUES (s.id, s.name, s.n)" in sql, sql)
        check(f"{dialect}: never an ON CONFLICT / ON DUPLICATE KEY", "ON CONFLICT" not in sql and "DUPLICATE" not in sql, sql)
        check(f"{dialect}: carries a note that this is MERGE", resp["ok"] and any("MERGE" in m for _, m in issues_of(resp)), resp)
        has_values = "(VALUES " in sql
        check(f"{dialect}: VALUES source only where documented (tsql/snowflake/trino)", has_values == (dialect in ("tsql", "snowflake", "trino")), sql)
        if has_values:
            check(f"{dialect}: VALUES source names its columns", ") AS s(id, name, n) ON " in sql, sql)
        else:
            check(f"{dialect}: SELECT ... UNION ALL source, no column-list alias", " UNION ALL SELECT 2, 'b', 3" in sql and "s(id" not in sql, sql)
        check(f"{dialect}: ON parenthesised exactly for Oracle", ("ON (users.id = s.id)" in sql) == (dialect == "oracle"), sql)
        check(f"{dialect}: Oracle selects FROM DUAL, nobody else does", sql.count("FROM DUAL") == (2 if dialect == "oracle" else 0), sql)
        check(f"{dialect}: trailing semicolon exactly for T-SQL", sql.endswith(";") == (dialect == "tsql"), sql)
    re_parsed = pmap(lambda d: call("validate", {"sql": call("compile", compile_req(merge_spec(MERGE_KAT_ROWS), d))["data"]["sql"], "dialect": d}), MERGE_DIALECTS)
    for dialect, resp in zip(MERGE_DIALECTS, re_parsed):
        check(f"{dialect}: re-parses as one merge statement on users", resp["ok"] and resp["data"]["ok"] and [(x["kind"], x["tables"]) for x in resp["data"]["statements"]] == [("merge", ["users", "DUAL"] if dialect == "oracle" else ["users"])], resp)

    # native dialects keep their native clause
    for dialect, needle in (("sqlite", "ON CONFLICT(id) DO UPDATE"), ("postgres", "ON CONFLICT(id) DO UPDATE"), ("duckdb", "ON CONFLICT(id) DO UPDATE"), ("mysql", "ON DUPLICATE KEY UPDATE"), ("mariadb", "ON DUPLICATE KEY UPDATE")):
        resp = call("compile", compile_req(merge_spec([[1, "a", 2]]), dialect))
        check(f"{dialect} keeps its native upsert", resp["ok"] and needle in resp["data"]["sql"] and "MERGE" not in resp["data"]["sql"], resp)

    # negative cases
    neg: list[tuple[str, dict[str, Any], str, str]] = [
        ("oracle: updating a key column is ORA-38104", merge_spec([[1, "a", 2]], set={"id": 9}), "oracle", "ORA-38104"),
        ("target column missing from the inserted columns", {**merge_spec([[1, "a", 2]]), "onConflict": {"target": ["email"], "action": "update"}}, "tsql", "must be among the inserted columns"),
        ("nothing left to update", {"op": "insert", "table": "users", "columns": ["id"], "rows": [[1]], "onConflict": {"target": ["id"], "action": "update"}}, "snowflake", "nothing to update"),
        ("clickhouse still refuses and says what to do", merge_spec([[1, "a", 2]]), "clickhouse", "update (where the key matches) and an insert separately"),
        ("hive still refuses", merge_spec([[1, "a", 2]]), "hive", "onConflict is not supported for hive"),
    ]
    for (name, spec, dialect, fragment), resp in zip(neg, pmap(lambda row: call("compile", compile_req(row[1], row[2])), neg)):
        check(f"rejects: {name}", not resp["ok"] and fragment in resp.get("error", ""), resp)

    # transpile: ON CONFLICT -> MERGE, and MERGE shapes per engine
    upserts = [
        ("do update", "INSERT INTO users (id, name, n) VALUES (1, 'a', 5), (2, 'b', 6) ON CONFLICT (id) DO UPDATE SET name = excluded.name, n = excluded.n", [[1, "a", 5], [2, "b", 6], [3, "z", 30]]),
        ("do nothing", "INSERT INTO users (id, name, n) VALUES (1, 'a', 5), (2, 'b', 6) ON CONFLICT (id) DO NOTHING", [[1, "x", 10], [2, "b", 6], [3, "z", 30]]),
        ("update from existing + new", "INSERT INTO users (id, name, n) VALUES (1, 'a', 5), (2, 'b', 6) ON CONFLICT (id) DO UPDATE SET n = users.n + excluded.n", [[1, "x", 15], [2, "b", 6], [3, "z", 30]]),
    ]
    tp = {(name, d): call("transpile", {"sql": sql, "from": "sqlite", "to": d}) for name, sql, _ in upserts for d in MERGE_DIALECTS}
    for (name, d), resp in tp.items():
        sql = resp["data"]["sql"] if resp["ok"] else ""
        check(f"transpile upsert ({name}) sqlite->{d}: a MERGE, no ON CONFLICT, no error issue", sql.startswith("MERGE INTO users USING (") and "ON CONFLICT" not in sql and not errors_of(resp), resp)
    resp = tp[("do update", "oracle")]
    check("transpile upsert -> oracle: ON (...) parenthesised, SELECT FROM DUAL source", resp["ok"] and "ON (users.id = s.id)" in resp["data"]["sql"] and resp["data"]["sql"].count("FROM DUAL") == 2, resp)
    check("transpile upsert -> tsql ends with a semicolon", tp[("do update", "tsql")]["data"]["sql"].endswith(");"), tp[("do update", "tsql")])
    for sql, why in (("INSERT INTO t (a, b) SELECT a, b FROM u ON CONFLICT (a) DO NOTHING", "INSERT ... SELECT"), ("INSERT INTO t VALUES (1, 2) ON CONFLICT (a) DO NOTHING", "no column list"),
                     ("INSERT INTO t (a, b) VALUES (1, 2) ON CONFLICT (a) DO UPDATE SET b = 1 WHERE t.b < 1", "conflict WHERE")):
        resp = call("transpile", {"sql": sql, "from": "postgres", "to": "tsql"})
        check(f"transpile upsert -> tsql errors for {why} instead of guessing", resp["ok"] and bool(errors_of(resp)) and "ON CONFLICT" in resp["data"]["sql"].upper(), resp)
    resp = call("transpile", {"sql": "INSERT INTO t (id, v) VALUES (1, 2) ON DUPLICATE KEY UPDATE v = VALUES(v)", "from": "mysql", "to": "oracle"})
    check("transpile ON DUPLICATE KEY -> oracle errors (no key to match on)", resp["ok"] and any("conflict target" in m or "key columns" in m for m in errors_of(resp)), resp)
    pg_merge = "MERGE INTO users AS t USING (VALUES (1, 'a'), (2, 'b')) AS s(id, name) ON t.id = s.id WHEN MATCHED THEN UPDATE SET name = s.name WHEN NOT MATCHED THEN INSERT (id, name) VALUES (s.id, s.name)"
    merge_expect = {
        "oracle": "MERGE INTO users t USING (SELECT 1 AS id, 'a' AS name FROM DUAL UNION ALL SELECT 2, 'b' FROM DUAL) s ON (t.id = s.id) WHEN MATCHED THEN UPDATE SET name = s.name WHEN NOT MATCHED THEN INSERT (id, name) VALUES (s.id, s.name)",
        "bigquery": "MERGE INTO users AS t USING (SELECT 1 AS id, 'a' AS name UNION ALL SELECT 2, 'b') AS s ON t.id = s.id WHEN MATCHED THEN UPDATE SET name = s.name WHEN NOT MATCHED THEN INSERT (id, name) VALUES (s.id, s.name)",
        "redshift": "MERGE INTO users AS t USING (SELECT 1 AS id, 'a' AS name UNION ALL SELECT 2, 'b') AS s ON t.id = s.id WHEN MATCHED THEN UPDATE SET name = s.name WHEN NOT MATCHED THEN INSERT (id, name) VALUES (s.id, s.name)",
        "spark": "MERGE INTO users AS t USING (SELECT 1 AS id, 'a' AS name UNION ALL SELECT 2, 'b') AS s ON t.id = s.id WHEN MATCHED THEN UPDATE SET name = s.name WHEN NOT MATCHED THEN INSERT (id, name) VALUES (s.id, s.name)",
        "tsql": "MERGE INTO users AS t USING (VALUES (1, 'a'), (2, 'b')) AS s(id, name) ON t.id = s.id WHEN MATCHED THEN UPDATE SET name = s.name WHEN NOT MATCHED THEN INSERT (id, name) VALUES (s.id, s.name);",
        "snowflake": "MERGE INTO users AS t USING (VALUES (1, 'a'), (2, 'b')) AS s(id, name) ON t.id = s.id WHEN MATCHED THEN UPDATE SET name = s.name WHEN NOT MATCHED THEN INSERT (id, name) VALUES (s.id, s.name)",
        "trino": "MERGE INTO users AS t USING (VALUES (1, 'a'), (2, 'b')) AS s(id, name) ON t.id = s.id WHEN MATCHED THEN UPDATE SET name = s.name WHEN NOT MATCHED THEN INSERT (id, name) VALUES (s.id, s.name)",
    }
    for d, sql in zip(MERGE_DIALECTS, pmap(lambda d: call("transpile", {"sql": pg_merge, "from": "postgres", "to": d}), MERGE_DIALECTS)):
        check(f"transpile postgres MERGE -> {d}", sql["ok"] and sql["data"]["sql"] == merge_expect[d] and not sql["data"]["issues"], sql)
    for d in ("mysql", "sqlite"):
        resp = call("transpile", {"sql": pg_merge, "from": "postgres", "to": d})
        check(f"transpile MERGE -> {d} says there is no MERGE", resp["ok"] and any("no MERGE" in m for m in errors_of(resp)), resp)
    resp = call("transpile", {"sql": "MERGE INTO t USING (VALUES (1)) AS s ON t.a = s.a WHEN NOT MATCHED THEN INSERT (a) VALUES (s.a)", "from": "postgres", "to": "oracle"})
    check("a VALUES source without column names cannot become a SELECT source: error, not guessed SQL", resp["ok"] and bool(errors_of(resp)), resp)

    # execution oracle: DuckDB runs the generated MERGE, sqlite3 runs the same spec as ON CONFLICT, both must equal the hand-computed table
    if via != "direct":
        return
    if not _DUCK:
        print(f"SKIP DuckDB MERGE execution (no duckdb python at {_DUCK_PY}; set KNIFE_DUCKDB_PY)")
        return
    jobs: list[dict[str, Any]] = []
    labels: list[tuple[str, str, list[list[Any]]]] = []
    for name, spec, values, setup, query, expected in MERGE_EXEC:
        for dialect in MERGE_DIALECTS:
            if "quote" in name and dialect in BACKSLASH_ESCAPE_DIALECTS:
                continue
            resp = call("compile", compile_req(spec, dialect))
            if not resp["ok"]:
                check(f"exec {name} / {dialect}: compiles", False, resp)
                continue
            sql = inline_params(resp["data"]["sql"], resp["data"]["params"], values, dialect).rstrip(";").replace(" FROM DUAL", "")
            jobs.append({"setup": setup, "run": [sql], "query": query})
            labels.append((name, dialect, expected))
    for (name, dialect, expected), got in zip(labels, duck_run(jobs)):
        check(f"duckdb executes {name} / {dialect}", got.get("rows") == expected, got)
    for name, spec, values, setup, query, expected in MERGE_EXEC:
        check(f"sqlite ON CONFLICT agrees with the hand table: {name}", sqlite_upsert_state(spec, values, setup, query) == expected)

    jobs, labels = [], []
    for name, sql, expected in upserts:
        for d in MERGE_DIALECTS:
            out = tp[(name, d)]["data"]["sql"].rstrip(";").replace(" FROM DUAL", "")
            jobs.append({"setup": USERS_SETUP, "run": [out], "query": USERS_QUERY})
            labels.append((name, d, expected))
        conn = sqlite3.connect(":memory:")
        for stmt in USERS_SETUP:
            conn.execute(stmt)
        conn.execute(sql)
        check(f"sqlite runs the original upsert ({name}) to the hand table", [list(r) for r in conn.execute(USERS_QUERY).fetchall()] == expected)
    for (name, d, expected), got in zip(labels, duck_run(jobs)):
        check(f"duckdb executes the transpiled upsert ({name}) -> {d}", got.get("rows") == expected, got)
    jobs = [{"setup": USERS_SETUP, "run": [call("transpile", {"sql": pg_merge, "from": "postgres", "to": d})["data"]["sql"].rstrip(";").replace(" FROM DUAL", "")], "query": USERS_QUERY} for d in MERGE_DIALECTS]
    for d, got in zip(MERGE_DIALECTS, duck_run(jobs)):
        check(f"duckdb executes the transpiled postgres MERGE -> {d}", got.get("rows") == [[1, "a", 10], [2, "b", None], [3, "z", 30]], got)


# ------------------------------------------------------------------ (b5) RETURNING / OUTPUT

RET_INS = {"op": "insert", "table": "orgs", "columns": ["id", "name"], "rows": [[20, "N"]], "returning": ["id", "name"]}
RET_UPD = {"op": "update", "table": "orders", "set": {"total": {"fn": "+", "args": [col("total"), {"param": "d"}]}}, "where": {"col": "status", "op": "=", "value": {"param": "s"}}, "returning": ["id", "total"]}
RET_DEL = {"op": "delete", "table": "orders", "where": {"col": "id", "op": "in", "value": [1, 2]}, "returning": ["id", "total"]}
RET_MERGE = {"op": "insert", "table": "users", "columns": ["id", "name"], "rows": [[1, "Zed"], [9, "New"]], "onConflict": {"target": ["id"], "action": "update"}, "returning": ["id"]}
RET_VALUES = {"d": 1, "s": "open"}
# (spec, expected rows from the fixture, hand computed; order-insensitive)
RET_CASES = {"insert": (RET_INS, [(20, "N")]), "update": (RET_UPD, [(3, 8.25), (6, 61.0)]), "delete": (RET_DEL, [(1, 10.0), (2, 25.5)])}
TSQL_OUTPUT = {
    "insert": "INSERT INTO orgs (id, name) OUTPUT inserted.id, inserted.name VALUES (20, 'N')",
    "update": "UPDATE orders SET total = total + @d OUTPUT inserted.id, inserted.total WHERE status = @s",
    "delete": "DELETE FROM orders OUTPUT deleted.id, deleted.total WHERE id IN (1, 2)",
}
TSQL_MERGE_OUTPUT = ("MERGE INTO users USING (VALUES (1, 'Zed'), (9, 'New')) AS s(id, name) ON users.id = s.id WHEN MATCHED THEN UPDATE SET name = s.name "
                     "WHEN NOT MATCHED THEN INSERT (id, name) VALUES (s.id, s.name) OUTPUT inserted.id;")


def suite_returning(via: str, call) -> None:
    section(f"b5. RETURNING / OUTPUT [{via}]")
    trigger = "T-SQL OUTPUT without INTO is rejected for tables with enabled triggers (error 334): use OUTPUT ... INTO @table_variable there."
    for kind, (spec, _) in RET_CASES.items():
        resp = call("compile", compile_req(spec, "tsql"))
        check(f"tsql {kind}: OUTPUT with the right prefix and position", resp["ok"] and resp["data"]["sql"] == TSQL_OUTPUT[kind], resp)
        check(f"tsql {kind}: warns about the trigger limitation, nothing else", resp["ok"] and issues_of(resp) == [("warning", trigger)], resp)
        valid = call("validate", {"sql": resp["data"]["sql"], "dialect": "tsql"})
        check(f"tsql {kind}: the generated OUTPUT statement parses back as {kind}", valid["ok"] and valid["data"]["ok"] and valid["data"]["statements"][0]["kind"] == kind, valid)
    resp = call("compile", compile_req(RET_MERGE, "tsql"))
    check("tsql MERGE ... OUTPUT inserted.id; (upsert + returning)", resp["ok"] and resp["data"]["sql"] == TSQL_MERGE_OUTPUT, resp)
    resp = call("compile", compile_req({**RET_INS, "returning": ["*"]}, "tsql"))
    check("tsql returning * -> inserted.*", resp["ok"] and "OUTPUT inserted.* VALUES" in resp["data"]["sql"], resp)
    resp = call("compile", compile_req(RET_DEL, "tsql", pretty=True))
    check("tsql pretty delete keeps OUTPUT before WHERE", resp["ok"] and resp["data"]["sql"] == "DELETE FROM orders OUTPUT deleted.id, deleted.total\nWHERE\n  id IN (1, 2)", resp)

    # sqlite oracle: the OUTPUT statement, converted back to sqlite by the engine, must do exactly what the sqlite compile of the same spec does
    for kind, (spec, expected) in RET_CASES.items():
        direct_sql = call("compile", compile_req(spec, "sqlite"))["data"]
        direct_rows = fresh_db().execute(direct_sql["sql"], bind(direct_sql["params"], RET_VALUES)).fetchall()
        check(f"sqlite {kind} returning = hand-computed rows", sorted(direct_rows) == sorted(expected), direct_rows)
        back = call("transpile", {"sql": TSQL_OUTPUT[kind], "from": "tsql", "to": "sqlite"})
        conn = fresh_db()
        rows = conn.execute(back["data"]["sql"], RET_VALUES).fetchall() if back["ok"] else []
        check(f"tsql OUTPUT {kind} -> sqlite returns the same rows as the direct compile", sorted(rows) == sorted(expected), back)
        pg = call("transpile", {"sql": TSQL_OUTPUT[kind], "from": "tsql", "to": "postgres"})
        check(f"tsql OUTPUT {kind} -> postgres has no inserted./deleted. prefixes left", pg["ok"] and "inserted." not in pg["data"]["sql"] and "deleted." not in pg["data"]["sql"] and " RETURNING " in pg["data"]["sql"], pg)
        fwd = call("transpile", {"sql": direct_sql["sql"], "from": "sqlite", "to": "tsql"})
        check(f"sqlite {kind} RETURNING -> tsql OUTPUT (generated, prefixed)", fwd["ok"] and ("OUTPUT deleted." if kind == "delete" else "OUTPUT inserted.") in fwd["data"]["sql"] and not errors_of(fwd), fwd)
    upd = call("transpile", {"sql": "UPDATE t SET b = 1 OUTPUT inserted.a, deleted.b WHERE a = 1", "from": "tsql", "to": "postgres"})
    check("tsql OUTPUT deleted.b on UPDATE -> postgres warns that the old value is unavailable", upd["ok"] and any("before the UPDATE" in m for _, m in issues_of(upd)) and upd["data"]["sql"].endswith("RETURNING a, b"), upd)
    star = call("transpile", {"sql": "DELETE FROM t OUTPUT deleted.* WHERE a = 1", "from": "tsql", "to": "tsql"})
    check("tsql DELETE ... OUTPUT before WHERE round-trips through the tsql parser", star["ok"] and star["data"]["sql"] == "DELETE FROM t OUTPUT deleted.* WHERE a = 1", star)
    fmt = call("format", {"sql": "delete from t output deleted.a where a=1", "dialect": "tsql"})
    check("format keeps OUTPUT right after the delete target", fmt["ok"] and fmt["data"]["sql"] == "DELETE FROM t OUTPUT deleted.a\nWHERE\n  a = 1", fmt)

    # MariaDB: INSERT/DELETE ... RETURNING yes, UPDATE refused with the alternative
    resp = call("compile", compile_req(RET_INS, "mariadb"))
    check("mariadb INSERT ... RETURNING", resp["ok"] and resp["data"]["sql"] == "INSERT INTO orgs (id, name) VALUES (20, 'N') RETURNING id, name", resp)
    resp = call("compile", compile_req(RET_DEL, "mariadb"))
    check("mariadb DELETE ... RETURNING", resp["ok"] and resp["data"]["sql"] == "DELETE FROM orders WHERE id IN (1, 2) RETURNING id, total" and any("10.0" in m for _, m in issues_of(resp)), resp)
    resp = call("compile", compile_req(RET_UPD, "mariadb"))
    check("mariadb UPDATE ... RETURNING refused with the plain UPDATE as the alternative", not resp["ok"] and "returning is not supported for MariaDB UPDATE" in resp["error"] and resp["error"].endswith("UPDATE orders SET total = total + ? WHERE status = ?"), resp)
    resp = call("transpile", {"sql": "UPDATE t SET b = 1 RETURNING a", "from": "postgres", "to": "mariadb"})
    check("transpile UPDATE RETURNING -> mariadb errors with the alternative", resp["ok"] and any("no UPDATE ... RETURNING" in m and m.endswith("UPDATE t SET b = 1") for m in errors_of(resp)), resp)
    resp = call("compile", compile_req(RET_INS, "mysql"))
    check("mysql refuses returning and gives the statement without it", not resp["ok"] and resp["error"].endswith("INSERT INTO orgs (id, name) VALUES (20, 'N')"), resp)

    # Oracle: clear error + the RETURNING-less statement, identical to compiling the spec without returning
    for kind, (spec, _) in RET_CASES.items():
        resp = call("compile", compile_req(spec, "oracle"))
        plain = call("compile", compile_req({k: v for k, v in spec.items() if k != "returning"}, "oracle"))
        check(f"oracle {kind}: refused, says INTO / PL/SQL, alternative equals the plain compile", not resp["ok"] and "PL/SQL" in resp["error"] and "INTO :out" in resp["error"] and resp["error"].endswith(plain["data"]["sql"]), resp)
    resp = call("transpile", {"sql": "INSERT INTO t (a) VALUES (1) RETURNING a", "from": "postgres", "to": "oracle"})
    check("transpile RETURNING -> oracle: error naming INTO and the plain statement", resp["ok"] and any("INTO variables" in m and m.endswith("INSERT INTO t (a) VALUES (1)") for m in errors_of(resp)), resp)
    resp = call("transpile", {"sql": "INSERT INTO t (a) VALUES (1) RETURNING a", "from": "postgres", "to": "snowflake"})
    check("transpile RETURNING -> snowflake: error + alternative", resp["ok"] and any("no RETURNING" in m and "Without it: INSERT INTO t (a) VALUES (1)" in m for m in errors_of(resp)), resp)


# ------------------------------------------------------------------ (b6) conditions on expressions

def fn(name: str, *args: Any, **extra: Any) -> dict[str, Any]:
    return {"fn": name, "args": list(args), **extra}


# (name, spec, params, hand-computed rows) against the sqlite fixture (users, orgs, orders)
EXPR_EXEC: list[tuple[str, dict[str, Any], dict[str, Any], list[tuple]]] = [
    ("where lower(name) = param", sel(**{"from": "users", "columns": ["id"], "where": {"expr": fn("lower", col("name")), "op": "=", "value": {"param": "p"}}}), {"p": "alice"}, [(1,)]),
    ("where length(name) > 3 (excludes bob)", sel(**{"from": "users", "columns": ["id"], "where": {"expr": fn("length", col("name")), "op": ">", "value": 3}, "orderBy": [{"expr": col("id")}]}), {}, [(1,), (3,), (4,), (5,)]),
    ("where arithmetic with grouping parentheses", sel(**{"from": "users", "columns": ["id"], "where": {"expr": fn("*", fn("+", col("age"), 5), 2), "op": ">", "value": 70}}), {}, [(3,)]),
    ("where expr like", sel(**{"from": "users", "columns": ["id"], "where": {"expr": fn("upper", col("name")), "op": "like", "value": "A%"}, "orderBy": [{"expr": col("id")}]}), {}, [(1,), (4,)]),
    ("where expr ilike (no double LOWER on engines without ILIKE)", sel(**{"from": "users", "columns": ["id"], "where": {"expr": fn("lower", col("name")), "op": "ilike", "value": "AL%"}, "orderBy": [{"expr": col("id")}]}), {}, [(1,), (4,)]),
    ("where expr in / between / is null", sel(**{"from": "users", "columns": ["id"], "where": {"and": [
        {"expr": fn("coalesce", col("org_id"), 0), "op": "in", "value": [0, 2]}, {"expr": fn("coalesce", col("age"), 0), "op": "between", "value": [20, {"param": "hi"}]}, {"expr": fn("nullif", col("email"), "x"), "op": "is not null"}]},
        "orderBy": [{"expr": col("id")}]}), {"hi": 45}, [(3,), (5,)]),
    ("where mixes col and expr leaves", sel(**{"from": "users", "columns": ["id"], "where": {"or": [{"col": "id", "op": "=", "value": 1}, {"expr": fn("lower", col("name")), "op": "=", "value": "carol"}]}, "orderBy": [{"expr": col("id")}]}), {}, [(1,), (3,)]),
    ("having sum(total) > 100", sel(**{"from": "orders", "columns": ["user_id"], "groupBy": [col("user_id")], "having": {"expr": fn("sum", col("total")), "op": ">", "value": 100}}), {}, [(3,)]),
    ("having count(distinct) via fn.distinct", sel(**{"from": "orders", "columns": ["status"], "groupBy": [col("status")], "having": {"expr": fn("count", col("user_id"), distinct=True), "op": ">=", "value": 2}, "orderBy": [{"expr": col("status")}]}), {}, [("open",), ("paid",)]),
    ("having aggregate against another aggregate and a param", sel(**{"from": "orders", "columns": ["status"], "groupBy": [col("status")], "having": {"and": [{"expr": fn("max", col("total")), "op": ">", "value": fn("avg", col("total"))}, {"expr": fn("sum", col("total")), "op": ">", "value": {"param": "lo"}}]}, "orderBy": [{"expr": col("status")}]}), {"lo": 60}, [("open",), ("paid",)]),
    ("having expression over an aggregate alias", sel(**{"from": "orders", "columns": ["status", {"expr": "*", "agg": "count", "as": "n"}], "groupBy": [col("status")], "having": {"expr": fn("+", col("n"), 1), "op": ">", "value": 3}}), {}, [("paid", 3)]),
    ("having without groupBy: whole-table aggregate (true)", sel(**{"from": "orders", "columns": [{"expr": "*", "agg": "count", "as": "n"}], "having": {"expr": fn("count", col("*")), "op": ">", "value": 5}}), {}, [(6,)]),
    ("having without groupBy: whole-table aggregate (false)", sel(**{"from": "orders", "columns": [{"expr": "*", "agg": "count", "as": "n"}], "having": {"expr": fn("count", col("*")), "op": ">", "value": 6}}), {}, []),
    ("join on an expression", sel(**{"from": {"name": "users", "as": "u"}, "columns": ["u.id"], "joins": [{"table": {"name": "orgs", "as": "o"}, "on": {"expr": fn("+", col("u.org_id"), 0), "op": "=", "value": col("o.id")}}], "orderBy": [{"expr": col("u.id")}]}), {}, [(1,), (2,), (3,), (5,)]),
]


def suite_expr_conditions(via: str, call) -> None:
    section(f"b6. conditions on expressions [{via}]")
    for (name, spec, values, expected), resp in zip(EXPR_EXEC, pmap(lambda row: call("compile", compile_req(row[1], "sqlite")), EXPR_EXEC)):
        if not resp["ok"]:
            check(f"sqlite exec: {name}", False, resp)
            continue
        try:
            rows = exec_rows(fresh_db(), resp["data"]["sql"], bind(resp["data"]["params"], values))
        except sqlite3.Error as error:
            check(f"sqlite exec: {name}", False, f"{error} | {resp['data']['sql']}")
            continue
        check(f"sqlite exec: {name}", sorted(rows) == sorted(expected), (rows, resp["data"]["sql"]))
    conn = fresh_db()
    r = call("compile", compile_req({"op": "delete", "table": "orders", "where": {"expr": fn("lower", col("status")), "op": "=", "value": "open"}}, "sqlite"))
    conn.execute(r["data"]["sql"])
    check("delete where lower(status) = 'open'", [x[0] for x in conn.execute("SELECT id FROM orders ORDER BY id")] == [1, 2, 4, 5], r)
    conn = fresh_db()
    r = call("compile", compile_req({"op": "update", "table": "users", "set": {"active": 0}, "where": {"expr": fn("%", col("age"), 2), "op": "=", "value": 1}}, "sqlite"))
    conn.execute(r["data"]["sql"])
    check("update where age % 2 = 1", [x[0] for x in conn.execute("SELECT id FROM users WHERE active = 0 ORDER BY id")] == [2, 3, 4, 5], r)

    # known answers
    lower_eq = sel(**{"from": "users", "where": {"expr": fn("lower", col("name")), "op": "=", "value": {"param": "p"}}})
    having = sel(**{"from": "orders", "columns": ["status"], "groupBy": [col("status")], "having": {"expr": fn("sum", col("total")), "op": ">", "value": 100}})
    kats = [
        (lower_eq, "sqlite", "SELECT * FROM users WHERE LOWER(name) = ?", ["p"]), (lower_eq, "postgres", "SELECT * FROM users WHERE LOWER(name) = $1", ["p"]),
        (lower_eq, "tsql", "SELECT * FROM users WHERE LOWER(name) = @p", ["p"]), (lower_eq, "oracle", "SELECT * FROM users WHERE LOWER(name) = :p", ["p"]),
        (having, "postgres", "SELECT status FROM orders GROUP BY status HAVING SUM(total) > 100", []), (having, "mysql", "SELECT status FROM orders GROUP BY status HAVING SUM(total) > 100", []),
        (sel(**{"from": "t", "where": {"expr": fn("lower", col("n")), "op": "ilike", "value": "a%"}}), "tsql", "SELECT * FROM t WHERE LOWER(n) LIKE LOWER('a%')", []),
        (sel(**{"from": "t", "where": {"expr": fn("*", fn("+", col("a"), col("b")), 2), "op": ">", "value": 10}}), "bigquery", "SELECT * FROM t WHERE (a + b) * 2 > 10", []),
        (sel(**{"from": "t", "columns": ["g"], "groupBy": [col("g")], "having": {"expr": fn("count", col("x"), distinct=True), "op": ">=", "value": {"param": "k"}}}), "snowflake", "SELECT g FROM t GROUP BY g HAVING COUNT(DISTINCT x) >= ?", ["k"]),
    ]
    for (spec, dialect, sql, params), resp in zip(kats, pmap(lambda k: call("compile", compile_req(k[0], k[1])), kats)):
        check(f"known answer expr condition / {dialect}: {sql[:60]}", resp["ok"] and resp["data"]["sql"] == sql and resp["data"]["params"] == params, resp if not resp["ok"] else (resp["data"]["sql"], resp["data"]["params"]))
    both = sel(**{"from": "t", "where": {"expr": fn("lower", col("a")), "op": "=", "value": {"param": "w"}}, "groupBy": [col("a")], "having": {"expr": fn("sum", col("b")), "op": ">", "value": {"param": "h"}}})
    resp = call("compile", compile_req(both, "postgres"))
    check("params of where + having keep text order", resp["ok"] and resp["data"]["params"] == ["w", "h"] and resp["data"]["sql"].endswith("WHERE LOWER(a) = $1 GROUP BY a HAVING SUM(b) > $2"), resp)

    # every dialect parses its own output
    specs = {"where expr": lower_eq, "having aggregate": having}
    combos = [(n, d) for n in specs for d in DIALECTS]
    compiled = pmap(lambda c: call("compile", compile_req(specs[c[0]], c[1])), combos)
    validated = pmap(lambda t: call("validate", {"sql": t[1]["data"]["sql"], "dialect": t[0][1]}) if t[1]["ok"] else t[1], list(zip(combos, compiled)))
    for (name, d), comp, val in zip(combos, compiled, validated):
        check(f"{name} / {d}: compiles and re-parses", comp["ok"] and val["ok"] and val["data"]["ok"], (comp, val))

    # old shapes keep working side by side; invalid shapes name the field
    bad: list[tuple[str, dict[str, Any], str]] = [
        ("aggregate in where", sel(**{"from": "t", "where": {"expr": fn("sum", col("a")), "op": ">", "value": 1}}), "spec.where.expr: aggregate 'sum' is not allowed in where"),
        ("aggregate nested in a function in where", sel(**{"from": "t", "where": {"expr": fn("lower", fn("max", col("a"))), "op": "=", "value": "x"}}), "aggregate 'max' is not allowed in where"),
        ("aggregate on the value side in where", sel(**{"from": "t", "where": {"col": "a", "op": ">", "value": fn("avg", col("b"))}}), "spec.where.value: aggregate 'avg'"),
        ("aggregate in a join condition", sel(**{"from": "t", "joins": [{"table": "u", "on": {"expr": fn("count", col("*")), "op": ">", "value": 1}}]}), "not allowed in a join condition"),
        ("aggregate in update where", {"op": "update", "table": "t", "set": {"a": 1}, "where": {"expr": fn("sum", col("a")), "op": ">", "value": 1}}, "not allowed in where"),
        ("col and expr together", sel(**{"from": "t", "where": {"col": "a", "expr": 1, "op": "="}}), "either 'col'"),
        ("neither col nor expr", sel(**{"from": "t", "where": {"op": "=", "value": 1}}), "missing required field 'col'"),
        ("expr that is not a value", sel(**{"from": "t", "where": {"expr": {"x": 1}, "op": "=", "value": 1}}), "spec.where.expr: expected a literal or one of"),
        ("expr with a bad function name", sel(**{"from": "t", "where": {"expr": {"fn": "x); DROP TABLE t; --"}, "op": "=", "value": 1}}), "not a function name"),
        ("distinct on a non-aggregate", sel(**{"from": "t", "where": {"expr": fn("lower", col("a"), distinct=True), "op": "=", "value": 1}}), "spec.where.expr.distinct"),
        ("distinct with two args", sel(**{"from": "t", "columns": ["g"], "groupBy": [col("g")], "having": {"expr": fn("count", col("a"), col("b"), distinct=True), "op": ">", "value": 1}}), "exactly one arg"),
        ("distinct not a boolean", sel(**{"from": "t", "columns": ["g"], "groupBy": [col("g")], "having": {"expr": fn("count", col("a"), distinct="yes"), "op": ">", "value": 1}}), "distinct: expected a boolean"),
        ("having without groupBy and without an aggregate", sel(**{"from": "t", "having": {"expr": fn("lower", col("a")), "op": "=", "value": "x"}}), "aggregate expression"),
        ("expr op needing a value", sel(**{"from": "t", "where": {"expr": fn("lower", col("a")), "op": "="}}), "needs a value"),
        ("unknown key beside expr", sel(**{"from": "t", "where": {"expr": 1, "op": "=", "value": 1, "x": 2}}), "spec.where.x: unknown field"),
    ]
    for (name, spec, fragment), resp in zip(bad, pmap(lambda b: call("compile", compile_req(b[1], "postgres")), bad)):
        check(f"rejects {name}", not resp["ok"] and fragment in resp["error"], resp)
    resp = call("compile", compile_req(sel(**{"from": "t", "where": {"expr": None, "op": "=", "value": None}}), "sqlite"))
    check("expr = null warns like col = null", resp["ok"] and any("is never true" in m for _, m in issues_of(resp)), resp)


# ------------------------------------------------------------------ (b7) identity columns: DuckDB sequences, helpful refusals

ID_SPEC = {"op": "create_table", "name": "users", "ifNotExists": True, "columns": [{"name": "id", "type": "serial", "primaryKey": True}, {"name": "name", "type": "text", "nullable": False}]}
ID_INSERT = {"op": "insert", "table": "users", "columns": ["name"], "rows": [["a"], ["b"], ["c"]]}


def suite_identity(via: str, call) -> None:
    section(f"b7. identity / auto-increment [{via}]")
    resp = call("compile", compile_req(ID_SPEC, "duckdb"))
    expected = "CREATE SEQUENCE IF NOT EXISTS users_id_seq START WITH 1 INCREMENT BY 1;\nCREATE TABLE IF NOT EXISTS users (id INT DEFAULT NEXTVAL('users_id_seq') PRIMARY KEY, name TEXT NOT NULL);"
    check("duckdb: sequence + nextval default (two statements)", resp["ok"] and resp["data"]["sql"] == expected and any("CREATE SEQUENCE" in m for _, m in issues_of(resp)), resp)
    resp = call("compile", compile_req(ID_SPEC, "duckdb", pretty=True))
    check("duckdb pretty keeps two statements", resp["ok"] and resp["data"]["sql"].count(";") == 2 and "CREATE SEQUENCE IF NOT EXISTS users_id_seq" in resp["data"]["sql"], resp)
    resp = call("compile", compile_req({**ID_SPEC, "ifNotExists": False, "name": "main.items", "columns": [{"name": "id", "type": "bigserial", "primaryKey": True}]}, "duckdb"))
    check("duckdb schema-qualified table: sequence in the same schema, plain CREATE SEQUENCE without ifNotExists", resp["ok"] and resp["data"]["sql"].startswith("CREATE SEQUENCE main.items_id_seq START WITH 1 INCREMENT BY 1;\nCREATE TABLE main.items (id BIGINT DEFAULT NEXTVAL('main.items_id_seq') PRIMARY KEY") , resp)
    resp = call("compile", compile_req({**ID_SPEC, "columns": [{"name": "id", "type": "integer", "autoIncrement": True, "primaryKey": True, "default": 5}]}, "duckdb"))
    check("duckdb: identity + own default refused", not resp["ok"] and "cannot also have its own default" in resp["error"], resp)

    # execution oracle (DuckDB): the generated script creates the table, and rows inserted without an id get 1, 2, 3 (run twice: IF NOT EXISTS keeps both objects)
    if via == "direct" and _DUCK:
        ddl = call("compile", compile_req(ID_SPEC, "duckdb"))["data"]["sql"]
        ins = call("compile", compile_req(ID_INSERT, "duckdb"))["data"]["sql"]
        qualified = call("compile", compile_req({**ID_SPEC, "ifNotExists": False, "name": "main.items", "columns": [{"name": "id", "type": "bigserial", "primaryKey": True}, {"name": "v", "type": "text"}]}, "duckdb"))["data"]["sql"]
        qins = call("compile", compile_req({"op": "insert", "table": "main.items", "columns": ["v"], "rows": [["x"], ["y"]]}, "duckdb"))["data"]["sql"]
        mysql_in = "CREATE TABLE a (id INT AUTO_INCREMENT PRIMARY KEY, n TEXT)"
        mysql_out = call("transpile", {"sql": mysql_in, "from": "mysql", "to": "duckdb"})
        pg_out = call("transpile", {"sql": "CREATE TABLE b (id BIGSERIAL PRIMARY KEY, n TEXT)", "from": "postgres", "to": "duckdb"})
        jobs = [
            {"setup": [], "run": [ddl, ins, ddl, ins], "query": "SELECT id, name FROM users ORDER BY id"},
            {"setup": [], "run": [qualified, qins], "query": "SELECT id, v FROM main.items ORDER BY id"},
            {"setup": [], "run": [mysql_out["data"]["sql"], "INSERT INTO a (n) VALUES ('p'), ('q')"], "query": "SELECT id, n FROM a ORDER BY id"},
            {"setup": [], "run": [pg_out["data"]["sql"], "INSERT INTO b (n) VALUES ('p'), ('q')"], "query": "SELECT id, n FROM b ORDER BY id"},
            {"setup": [], "run": [ddl], "query": "SELECT sequence_name FROM duckdb_sequences() ORDER BY 1"},
        ]
        got = duck_run(jobs)
        check("duckdb executes the identity table: ids continue 1..6 over two runs", got[0].get("rows") == [[1, "a"], [2, "b"], [3, "c"], [4, "a"], [5, "b"], [6, "c"]], got[0])
        check("duckdb executes the schema-qualified bigserial table", got[1].get("rows") == [[1, "x"], [2, "y"]], got[1])
        check("duckdb executes the transpiled MySQL AUTO_INCREMENT table", got[2].get("rows") == [[1, "p"], [2, "q"]], (got[2], mysql_out))
        check("duckdb executes the transpiled PostgreSQL BIGSERIAL table", got[3].get("rows") == [[1, "p"], [2, "q"]], (got[3], pg_out))
        check("duckdb sees exactly the one sequence", got[4].get("rows") == [["users_id_seq"]], got[4])

    resp = call("transpile", {"sql": "CREATE TABLE a.t (id INT AUTO_INCREMENT PRIMARY KEY, n TEXT)", "from": "mysql", "to": "duckdb"})
    check("transpile AUTO_INCREMENT -> duckdb: sequence first, qualified name kept", resp["ok"] and resp["data"]["sql"] == "CREATE SEQUENCE a.t_id_seq START WITH 1 INCREMENT BY 1;\nCREATE TABLE a.t (id INT DEFAULT NEXTVAL('a.t_id_seq') PRIMARY KEY, n TEXT);" and not errors_of(resp), resp)

    # refusals tell what to do instead; BigQuery/ClickHouse carry a compiled alternative that itself parses in that dialect
    alt_expected = {
        "bigquery": "CREATE TABLE IF NOT EXISTS users (id STRING DEFAULT GENERATE_UUID() PRIMARY KEY, name STRING NOT NULL)",
        "clickhouse": "CREATE TABLE IF NOT EXISTS users (id UUID DEFAULT generateUUIDv4(), name String) ENGINE=MergeTree ORDER BY id",
        "trino": "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name VARCHAR NOT NULL)",
        "spark": "CREATE TABLE IF NOT EXISTS users (id INT PRIMARY KEY, name STRING NOT NULL)",
        "hive": "CREATE TABLE IF NOT EXISTS users (id INT PRIMARY KEY, name STRING NOT NULL)",
    }
    for dialect, alt in alt_expected.items():
        resp = call("compile", compile_req(ID_SPEC, dialect))
        check(f"{dialect}: identity refused, says what to do, ends with the compiled alternative", not resp["ok"] and f"not supported for {dialect}" in resp["error"] and "Closest valid alternative: " + alt in resp["error"], resp)
        valid = call("validate", {"sql": alt, "dialect": dialect})
        check(f"{dialect}: the alternative parses in {dialect} and has no identity syntax left", valid["ok"] and valid["data"]["ok"] and not re.search(r"IDENTITY|AUTO_?INCREMENT", alt, re.I), valid)
        tr = call("transpile", {"sql": "CREATE TABLE t (id SERIAL PRIMARY KEY, n TEXT)", "from": "postgres", "to": dialect})
        check(f"{dialect}: transpile of SERIAL errors with the same advice", tr["ok"] and any("not supported for" in m for m in errors_of(tr)), tr)
    resp = call("compile", compile_req({**ID_SPEC, "columns": [{"name": "id", "type": "integer", "autoIncrement": True, "primaryKey": True}]}, "bigquery"))
    check("autoIncrement flag (not only serial types) takes the same refusal", not resp["ok"] and "GENERATE_UUID" in resp["error"], resp)

    # ClickHouse: key and NOT NULL columns must be plain types (no Nullable(...), no NOT NULL suffix)
    spec = {"op": "create_table", "name": "t", "columns": [{"name": "id", "type": "integer", "primaryKey": True}, {"name": "u", "type": "uuid", "nullable": False}, {"name": "n", "type": "text"}]}
    resp = call("compile", compile_req(spec, "clickhouse"))
    check("clickhouse: key + NOT NULL columns are not Nullable, nullable ones are", resp["ok"] and resp["data"]["sql"] == "CREATE TABLE t (id Int32, u UUID, n Nullable(String)) ENGINE=MergeTree ORDER BY id", resp)
    resp = call("compile", compile_req({**spec, "columns": [{"name": "a", "type": "integer"}, {"name": "b", "type": "integer"}], "primaryKey": ["a", "b"]}, "clickhouse"))
    check("clickhouse composite key: both key columns plain", resp["ok"] and resp["data"]["sql"] == "CREATE TABLE t (a Int32, b Int32) ENGINE=MergeTree ORDER BY (a, b)", resp)


# ------------------------------------------------------------------ (b8) semantic conversions executed in SQLite and DuckDB

T_SETUP = ["CREATE TABLE t (id INTEGER, d {ts}, s VARCHAR, n INTEGER)",
           "INSERT INTO t VALUES (1, '2024-01-05 10:30:00', 'Hello,World,Foo', 3), (2, '2024-03-31 23:59:59', 'a,b', 2), (3, '2023-12-31 00:00:00', 'x', 0)"]
DAY10 = lambda rows: [str(v)[:10] for v in rows]  # noqa: E731
# (name, source dialect, SQL, {target: expected rows}, post-processing of the fetched rows). Expected values are hand-computed from the calendar (2024-01-05 is a Friday,
# 2024 is a leap year: 2024-03-31 is day 91) and string lengths; they were never taken from either engine.
SEM_EXEC: list[tuple[str, str, str, dict[str, list], str]] = [
    ("tsql DATEADD(day)", "tsql", "SELECT DATEADD(day, 5, d) FROM t ORDER BY id", {"sqlite": ["2024-01-10", "2024-04-05", "2024-01-05"], "duckdb": ["2024-01-10", "2024-04-05", "2024-01-05"]}, "day10"),
    ("tsql DATEADD(hour) keeps the time", "tsql", "SELECT DATEADD(hour, 2, d) FROM t WHERE id = 1", {"sqlite": ["2024-01-05 12:30:00"], "duckdb": ["2024-01-05 12:30:00"]}, "str"),
    ("tsql DATEADD(month)", "tsql", "SELECT DATEADD(month, 1, d) FROM t WHERE id IN (1, 3) ORDER BY id", {"sqlite": ["2024-02-05", "2024-01-31"], "duckdb": ["2024-02-05", "2024-01-31"]}, "day10"),
    ("tsql DATEADD(week) / negative", "tsql", "SELECT DATEADD(week, 2, d), DATEADD(year, -1, d) FROM t WHERE id = 1", {"sqlite": [("2024-01-19", "2023-01-05")], "duckdb": [("2024-01-19", "2023-01-05")]}, "day10row"),
    ("tsql DATEDIFF(day)", "tsql", "SELECT DATEDIFF(day, '2023-12-31', d) FROM t ORDER BY id", {"sqlite": [5, 91, 0], "duckdb": [5, 91, 0]}, "int"),
    ("tsql DATEDIFF(month) counts boundaries", "tsql", "SELECT DATEDIFF(month, '2023-12-31', d) FROM t ORDER BY id", {"duckdb": [1, 3, 0]}, "int"),
    ("pg DATE_TRUNC(month)", "postgres", "SELECT DATE_TRUNC('month', d) FROM t ORDER BY id", {"sqlite": ["2024-01-01", "2024-03-01", "2023-12-01"], "duckdb": ["2024-01-01", "2024-03-01", "2023-12-01"]}, "day10"),
    ("pg DATE_TRUNC(year)", "postgres", "SELECT DATE_TRUNC('year', d) FROM t ORDER BY id", {"sqlite": ["2024-01-01", "2024-01-01", "2023-01-01"], "duckdb": ["2024-01-01", "2024-01-01", "2023-01-01"]}, "day10"),
    ("pg DATE_TRUNC(hour)", "postgres", "SELECT DATE_TRUNC('hour', d) FROM t WHERE id = 1", {"sqlite": ["2024-01-05 10:00:00"], "duckdb": ["2024-01-05 10:00:00"]}, "str"),
    ("pg EXTRACT year/dow/doy/quarter", "postgres", "SELECT EXTRACT(YEAR FROM d), EXTRACT(DOW FROM d), EXTRACT(DOY FROM d), EXTRACT(QUARTER FROM d) FROM t ORDER BY id",
     {"sqlite": [(2024, 5, 5, 1), (2024, 0, 91, 1), (2023, 0, 365, 4)], "duckdb": [(2024, 5, 5, 1), (2024, 0, 91, 1), (2023, 0, 365, 4)]}, "introw"),
    ("pg EXTRACT(EPOCH)", "postgres", "SELECT EXTRACT(EPOCH FROM d) FROM t WHERE id = 1", {"sqlite": [1704450600], "duckdb": [1704450600]}, "int"),
    ("pg STRING_AGG", "postgres", "SELECT STRING_AGG(s, '|') FROM t", {"sqlite": ["Hello,World,Foo", "a,b", "x"], "duckdb": ["Hello,World,Foo", "a,b", "x"]}, "agg"),
    ("pg STRING_AGG ORDER BY (DuckDB; SQLite 3.44+)", "postgres", "SELECT STRING_AGG(s, ',' ORDER BY id DESC) FROM t", {"duckdb": ["x,a,b,Hello,World,Foo"]}, "str"),
    ("pg LEFT/RIGHT", "postgres", "SELECT LEFT(s, 3), RIGHT(s, 3), RIGHT(s, n) FROM t ORDER BY id", {"sqlite": [("Hel", "Foo", "Foo"), ("a,b", "a,b", ",b"), ("x", "x", "")], "duckdb": [("Hel", "Foo", "Foo"), ("a,b", "a,b", ",b"), ("x", "x", "")]}, "row"),
    ("pg d + INTERVAL", "postgres", "SELECT d + INTERVAL '5 days' FROM t ORDER BY id", {"sqlite": ["2024-01-10", "2024-04-05", "2024-01-05"], "duckdb": ["2024-01-10", "2024-04-05", "2024-01-05"]}, "day10"),
    ("mysql DATE_SUB", "mysql", "SELECT DATE_SUB(d, INTERVAL 2 MONTH) FROM t WHERE id IN (1, 3) ORDER BY id", {"sqlite": ["2023-11-05", "2023-10-31"], "duckdb": ["2023-11-05", "2023-10-31"]}, "day10"),
    ("pg GREATEST/LEAST", "postgres", "SELECT GREATEST(n, 2), LEAST(n, 2) FROM t ORDER BY id", {"sqlite": [(3, 2), (2, 2), (2, 0)], "duckdb": [(3, 2), (2, 2), (2, 0)]}, "introw"),
    ("oracle NVL / NVL2", "oracle", "SELECT NVL(n, 0), NVL2(s, 'y', 'n') FROM t ORDER BY id", {"sqlite": [(3, "y"), (2, "y"), (0, "y")], "duckdb": [(3, "y"), (2, "y"), (0, "y")]}, "row"),
    ("tsql ISNULL / IIF / LEN", "tsql", "SELECT ISNULL(n, 0), IIF(n > 0, 'p', 'n'), LEN(s) FROM t ORDER BY id", {"sqlite": [(3, "p", 15), (2, "p", 3), (0, "n", 1)], "duckdb": [(3, "p", 15), (2, "p", 3), (0, "n", 1)]}, "row"),
    ("mysql IFNULL / IF / CHAR_LENGTH", "mysql", "SELECT IFNULL(n, 0), IF(n > 0, 'p', 'n'), CHAR_LENGTH(s) FROM t ORDER BY id", {"sqlite": [(3, "p", 15), (2, "p", 3), (0, "n", 1)], "duckdb": [(3, "p", 15), (2, "p", 3), (0, "n", 1)]}, "row"),
    ("pg SPLIT_PART (DuckDB)", "postgres", "SELECT SPLIT_PART(s, ',', 2) FROM t ORDER BY id", {"duckdb": ["World", "b", ""]}, "str"),
    ("pg LIMIT/OFFSET", "postgres", "SELECT s FROM t ORDER BY id LIMIT 2 OFFSET 1", {"sqlite": ["a,b", "x"], "duckdb": ["a,b", "x"]}, "str"),
    ("tsql TOP", "tsql", "SELECT TOP 2 id FROM t ORDER BY id DESC", {"sqlite": [3, 2], "duckdb": [3, 2]}, "int"),
    ("pg ILIKE", "postgres", "SELECT id FROM t WHERE s ILIKE 'A%'", {"sqlite": [2], "duckdb": [2]}, "int"),
    ("pg CAST", "postgres", "SELECT CAST(n AS VARCHAR(10)), n::int FROM t ORDER BY id", {"sqlite": [("3", 3), ("2", 2), ("0", 0)], "duckdb": [("3", 3), ("2", 2), ("0", 0)]}, "row"),
    ("pg || concat", "postgres", "SELECT s || '-' || n FROM t ORDER BY id", {"sqlite": ["Hello,World,Foo-3", "a,b-2", "x-0"], "duckdb": ["Hello,World,Foo-3", "a,b-2", "x-0"]}, "str"),
    ("mysql CONCAT(3 args)", "mysql", "SELECT CONCAT(s, '-', n) FROM t ORDER BY id", {"sqlite": ["Hello,World,Foo-3", "a,b-2", "x-0"], "duckdb": ["Hello,World,Foo-3", "a,b-2", "x-0"]}, "str"),
    ("pg SUBSTRING / POSITION", "postgres", "SELECT SUBSTRING(s FROM 2 FOR 3), POSITION('x' IN s) FROM t ORDER BY id", {"sqlite": [("ell", 0), (",b", 0), ("", 1)], "duckdb": [("ell", 0), (",b", 0), ("", 1)]}, "row"),
    ("mysql DATE_FORMAT", "mysql", "SELECT DATE_FORMAT(d, '%Y-%m') FROM t ORDER BY id", {"sqlite": ["2024-01", "2024-03", "2023-12"], "duckdb": ["2024-01", "2024-03", "2023-12"]}, "str"),
    ("mysql LAST_DAY (DuckDB)", "mysql", "SELECT LAST_DAY(d) FROM t WHERE id = 1", {"duckdb": ["2024-01-31"]}, "day10"),
]


def _norm(kind: str, rows: list[tuple]) -> list:
    flat = [r[0] for r in rows] if rows and len(rows[0]) == 1 else rows
    if kind == "day10":
        return [str(v)[:10] for v in flat]
    if kind == "day10row":
        return [tuple(str(v)[:10] for v in r) for r in rows]
    if kind == "int":
        return [int(v) for v in flat]
    if kind == "introw":
        return [tuple(int(v) for v in r) for r in rows]
    if kind == "agg":
        return sorted(str(flat[0]).split("|"))
    if kind == "row":
        return [tuple(r) for r in rows]
    return [str(v) if v is not None else None for v in flat]


def suite_semantic_exec(via: str, call) -> None:
    section(f"b8. semantic conversions executed in SQLite and DuckDB [{via}]")
    spec = {"op": "create_table", "name": "t", "columns": [{"name": "n", "type": "integer", "nullable": False, "default": 5}, {"name": "ok", "type": "boolean", "nullable": False, "default": False}]}
    resp = call("compile", compile_req(spec, "oracle"))
    check("oracle compile: DEFAULT precedes NOT NULL (ORA-00907 otherwise)", resp["ok"] and resp["data"]["sql"] == "CREATE TABLE t (n INT DEFAULT 5 NOT NULL, ok NUMBER(1) DEFAULT 0 NOT NULL)", resp)
    resp = call("compile", compile_req(spec, "tsql"))
    check("tsql compile keeps NOT NULL DEFAULT and writes BIT defaults as 0/1", resp["ok"] and resp["data"]["sql"] == "CREATE TABLE t (n INTEGER NOT NULL DEFAULT 5, ok BIT NOT NULL DEFAULT 0)", resp)
    if via != "direct":
        return
    jobs: list[tuple[str, str, list, str, str]] = []
    for name, src, sql, expected, kind in SEM_EXEC:
        for target, want in expected.items():
            resp = call("transpile", {"sql": sql, "from": src, "to": target})
            if not resp["ok"] or errors_of(resp):
                check(f"{name} -> {target}: converts without error issues", False, resp)
                continue
            jobs.append((name, target, want, kind, resp["data"]["sql"]))
    for name, target, want, kind, sql in [j for j in jobs if j[1] == "sqlite"]:
        conn = sqlite3.connect(":memory:")
        for stmt in T_SETUP:
            conn.execute(stmt.format(ts="TEXT"))
        try:
            rows = conn.execute(sql).fetchall()
        except sqlite3.Error as error:
            check(f"{name} -> sqlite", False, f"{error} | {sql}")
            continue
        got = _norm(kind, rows)
        check(f"{name} -> sqlite runs and returns the hand-computed rows", got == (sorted(want) if kind == "agg" else want), (got, want, sql))
    duck = [j for j in jobs if j[1] == "duckdb"]
    if not _DUCK:
        print(f"SKIP DuckDB semantic execution ({len(duck)} checks; no duckdb python at {_DUCK_PY})")
        return
    setup = [stmt.format(ts="TIMESTAMP") for stmt in T_SETUP]
    results = duck_run([{"setup": setup, "run": [], "query": sql} for *_, sql in duck])
    for (name, target, want, kind, sql), got in zip(duck, results):
        if "rows" not in got:
            check(f"{name} -> duckdb", False, (got, sql))
            continue
        check(f"{name} -> duckdb runs and returns the hand-computed rows", _norm(kind, [tuple(r) for r in got["rows"]]) == (sorted(want) if kind == "agg" else want), (got, want, sql))

    # DDL / statements that do not return rows: run, then look at the state
    for target, setup_sql, ts in (("sqlite", None, "TEXT"), ("duckdb", None, "TIMESTAMP")):
        stmts = [("postgres", "TRUNCATE TABLE t"), ("postgres", "CREATE INDEX IF NOT EXISTS ix ON t (n, s DESC)")]
        converted = [call("transpile", {"sql": sql, "from": src, "to": target})["data"]["sql"] for src, sql in stmts]
        if target == "sqlite":
            conn = sqlite3.connect(":memory:")
            for stmt in T_SETUP:
                conn.execute(stmt.format(ts=ts))
            for stmt in reversed(converted):  # index first (idempotent twice), then the truncate
                conn.execute(stmt)
                conn.execute(stmt)
            check("sqlite: TRUNCATE became DELETE FROM and emptied the table; CREATE INDEX IF NOT EXISTS ran twice", conn.execute("SELECT COUNT(*) FROM t").fetchone() == (0,) and conn.execute("SELECT name FROM sqlite_master WHERE type='index' AND name='ix'").fetchone() == ("ix",), converted)
        else:
            got = duck_run([{"setup": [x.format(ts=ts) for x in T_SETUP], "run": [converted[1], converted[1], converted[0]], "query": "SELECT COUNT(*) FROM t"}])[0]
            check("duckdb: CREATE INDEX IF NOT EXISTS twice, TRUNCATE empties the table", got.get("rows") == [[0]], (got, converted))

    # the function lists: sqlite's PRAGMA function_list and DuckDB's generated list flag exactly the functions that engine lacks
    resp = call("transpile", {"sql": "SELECT LAST_DAY(d), MAKEDATE(y, 1), DAYNAME(d) FROM t", "from": "mysql", "to": "duckdb"})
    names = [m.split("()")[0] for m in errors_of(resp)]
    check("duckdb: MAKEDATE is flagged (DuckDB has no such function), LAST_DAY and DAYNAME are not", resp["ok"] and names == ["MAKEDATE"], resp)
    check("duckdb function list names its DuckDB version", resp["ok"] and any("DuckDB (DuckDB 1." in m for m in errors_of(resp)), resp)
    got = duck_run([{"setup": [], "run": [], "query": "SELECT LAST_DAY(DATE '2024-02-10'), DAYNAME(DATE '2024-02-10')"}, {"setup": [], "run": [], "query": "SELECT MAKEDATE(2024, 1)"}])
    check("duckdb really accepts LAST_DAY/DAYNAME and rejects MAKEDATE", "rows" in got[0] and "error" in got[1] and "makedate" in got[1]["error"].lower(), got)


# ------------------------------------------------------------------ (d) check

def suite_check(via: str, call) -> None:
    section(f"d. check against a schema [{via}]")
    sch = call("schema", {"ddl": FIXTURE_DDL, "dialect": "sqlite"})
    check("fixture DDL -> schema", sch["ok"] and [t["name"] for t in sch["data"]["schema"]["tables"]] == ["users", "orgs", "orders"], sch)
    schema = sch["data"]["schema"]

    def run(sql: str, dialect: str = "sqlite", sc: dict[str, Any] | None = None):
        return call("check", {"sql": sql, "dialect": dialect, "schema": sc or schema})

    # (sql, dialect, expected error fragments (all must appear), expect ok)
    cases: list[tuple[str, str, list[str]]] = [
        ("SELECT id, name FROM users", "sqlite", []),
        ("SELECT emial FROM users", "sqlite", ["Unknown column 'emial'", "Did you mean 'email'"]),
        ("SELECT nme FROM users", "sqlite", ["Did you mean 'name'"]),
        ("SELECT totally_invented FROM users", "sqlite", ["Unknown column 'totally_invented'"]),
        ("SELECT * FROM usres", "sqlite", ["Unknown table 'usres'", "Did you mean 'users'"]),
        ("SELECT * FROM invoices", "sqlite", ["Unknown table 'invoices'"]),
        ("SELECT id FROM users u JOIN orders o ON o.user_id = u.id", "sqlite", ["Column 'id' is ambiguous"]),
        ("SELECT u.id, o.id FROM users u JOIN orders o ON o.user_id = u.id", "sqlite", []),
        ("SELECT x.id FROM users u", "sqlite", ["Unknown table or alias 'x'", "Did you mean 'u'"]),
        ("SELECT u.nope FROM users u", "sqlite", ["Unknown column 'u.nope'"]),
        ("SELECT u.name FROM users AS u JOIN orgs AS o ON u.org_id = o.id WHERE o.name = 'Acme'", "sqlite", []),
        ("SELECT u.name FROM users u JOIN orgs o ON u.org_id = o.id WHERE o.nmae = 'Acme'", "sqlite", ["Unknown column 'o.nmae'", "Did you mean 'name'"]),
        ("WITH c AS (SELECT id, email FROM users) SELECT c.email FROM c", "sqlite", []),
        ("WITH c AS (SELECT id, email FROM users) SELECT c.nope FROM c", "sqlite", ["Unknown column 'c.nope'"]),
        ("WITH c AS (SELECT id AS k FROM users) SELECT id FROM c", "sqlite", ["Unknown column 'id'"]),
        ("WITH c AS (SELECT * FROM users) SELECT c.age FROM c", "sqlite", []),
        ("WITH c AS (SELECT * FROM users) SELECT c.agee FROM c", "sqlite", ["Unknown column 'c.agee'"]),
        ("WITH a AS (SELECT id FROM users), b AS (SELECT id FROM a) SELECT b.id FROM b", "sqlite", []),
        ("SELECT * FROM (SELECT id AS k FROM users) t WHERE t.k = 1", "sqlite", []),
        ("SELECT * FROM (SELECT id AS k FROM users) t WHERE t.id = 1", "sqlite", ["Unknown column 't.id'"]),
        ("SELECT (SELECT max(total) FROM orders o WHERE o.user_id = u.id) m FROM users u", "sqlite", []),
        ("SELECT (SELECT max(totl) FROM orders o WHERE o.user_id = u.id) m FROM users u", "sqlite", ["Unknown column 'totl'", "Did you mean 'total'"]),
        ("SELECT id FROM users WHERE id IN (SELECT user_id FROM orders WHERE status = 'paid')", "sqlite", []),
        ("SELECT id FROM users WHERE id IN (SELECT user_id FROM orders WHERE statuss = 'paid')", "sqlite", ["Unknown column 'statuss'"]),
        ("SELECT id FROM users WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = users.id AND o.total > 5)", "sqlite", []),
        ("SELECT u.id FROM users u UNION SELECT o.id FROM orgs o", "sqlite", []),
        ("SELECT u.id FROM users u UNION SELECT o.idd FROM orgs o", "sqlite", ["Unknown column 'o.idd'"]),
        ("SELECT name AS n FROM users ORDER BY n", "sqlite", []),
        ("SELECT status, count(*) AS c FROM orders GROUP BY status HAVING c > 1", "sqlite", []),
        ("SELECT a.id FROM users a JOIN users b USING (id)", "sqlite", []),
        ("SELECT id FROM users JOIN orgs USING (id)", "sqlite", []),
        ("SELECT NAME FROM USERS", "sqlite", []),
        ("SELECT main.users.id FROM main.users", "sqlite", []),
        ("SELECT [id] FROM [users]", "tsql", []),
        ("SELECT TOP 3 u.idd FROM [users] u", "tsql", ["Unknown column 'u.idd'"]),
        ("SELECT `name` FROM `users`", "mysql", []),
        ("SELECT `nam` FROM `users`", "mysql", ["Did you mean 'name'"]),
        ("SELECT \"nosuch\" FROM users", "sqlite", ["Unknown column 'nosuch'", "single quotes"]),
        ("INSERT INTO users (id, name) VALUES (9, 'x')", "sqlite", []),
        ("INSERT INTO users (id, nmae) VALUES (9, 'x')", "sqlite", ["Unknown column 'nmae'", "Did you mean 'name'"]),
        ("INSERT INTO users (id, name) VALUES (9)", "sqlite", ["INSERT row 1 has 1 value but the column list has 2 columns"]),
        ("INSERT INTO users (id, name) VALUES (9, 'a'), (10, 'b', 'c')", "sqlite", ["INSERT row 2 has 3 values but the column list has 2 columns"]),
        ("INSERT INTO users VALUES (1, 'a')", "sqlite", ["INSERT row 1 has 2 values but table 'users' has 7 columns"]),
        ("INSERT INTO users VALUES (1, 'a', 'e', 3, 4, 5, 'c')", "sqlite", []),
        ("INSERT INTO users (id, name) SELECT id FROM orgs", "sqlite", ["INSERT ... SELECT provides 1 column but 2 are expected"]),
        ("INSERT INTO users (id, name) SELECT id, name FROM orgs", "sqlite", []),
        ("INSERT INTO users (id, id) VALUES (1, 2)", "sqlite", ["listed twice"]),
        ("INSERT INTO nowhere (a) VALUES (1)", "sqlite", ["Unknown table 'nowhere'"]),
        ("INSERT INTO orgs (id, name) VALUES (1, 'a') ON CONFLICT (idd) DO NOTHING", "sqlite", ["ON CONFLICT target"]),
        ("INSERT INTO orgs (id, name) VALUES (1, 'a') RETURNING idd", "sqlite", ["Unknown column 'idd' in RETURNING"]),
        ("UPDATE users SET name = 'x' WHERE id = 1", "sqlite", []),
        ("UPDATE users SET nam = 'x' WHERE idd = 1", "sqlite", ["'nam'", "'idd'"]),
        ("UPDATE users SET age = (SELECT max(total) FROM orders WHERE user_id = users.id)", "sqlite", []),
        ("DELETE FROM users WHERE id IN (SELECT user_id FROM orders WHERE totl > 1)", "sqlite", ["Unknown column 'totl'"]),
        ("DELETE FROM userz WHERE id = 1", "sqlite", ["Unknown table 'userz'"]),
        ("CREATE TABLE extra (id INT, v TEXT); INSERT INTO extra (id, v) VALUES (1, 'a'); SELECT v FROM extra", "sqlite", []),
        ("CREATE TABLE extra (id INT, v TEXT); SELECT w FROM extra", "sqlite", ["Unknown column 'w'"]),
        ("SELECT 1; SELECT emial FROM users", "sqlite", ["Unknown column 'emial'"]),
    ]
    for (sql, dialect, expected), resp in zip(cases, pmap(lambda c: run(c[0], c[1]), cases)):
        if not resp["ok"]:
            check(sql, False, resp)
            continue
        errors = errors_of(resp)
        ok = (bool(errors) == bool(expected)) and all(any(frag in m for m in errors) for frag in expected) and resp["data"]["ok"] == (not expected)
        check(f"{dialect}: {sql}", ok, errors)

    resp = run("SELECT emial FROM users")
    first = resp["data"]["issues"][0]
    check("error carries line/column of the identifier", first.get("line") == 1 and first.get("column") == 8, first)
    resp = run("SELECT id\nFROM users\nWHERE nope = 1")
    first = resp["data"]["issues"][0]
    check("line/column across lines", first.get("line") == 3 and first.get("column") == 7, first)
    resp = run("SELEC id FROM users")
    check("syntax error -> ok false with positioned issue", resp["ok"] and resp["data"]["ok"] is False and resp["data"]["issues"][0]["level"] == "error", resp)
    resp = run("INSERT INTO users (id, name) VALUES (1, 'a')")
    check("NOT NULL columns missing from the INSERT warn", resp["ok"] and resp["data"]["ok"] and not resp["data"]["issues"], resp)
    resp = run("INSERT INTO orgs (id) VALUES (1)", sc={"tables": [{"name": "orgs", "columns": [{"name": "id", "primaryKey": True, "nullable": False}, {"name": "name", "nullable": False}]}]})
    check("NOT NULL without default is a warning, not an error", resp["ok"] and resp["data"]["ok"] and any(lv == "warning" and "NOT NULL" in m for lv, m in issues_of(resp)), resp)
    resp = call("check", {"sql": "SELECT 1", "dialect": "sqlite", "schema": {"tables": "no"}})
    check("malformed schema param rejected", not resp["ok"] and "params.schema" in resp["error"], resp)
    check("empty schema: every table is unknown", not run("SELECT a FROM t", sc={"tables": []})["data"]["ok"])


# ------------------------------------------------------------------ (e) spec rejection, validate, schema

def suite_reject(via: str, call) -> None:
    section(f"e. spec rejection [{via}]")
    base_sel = sel(**{"from": "t"})
    bad: list[tuple[str, dict[str, Any], str]] = [
        ("unknown op", {"op": "merge", "table": "t"}, "spec.op: unknown op 'merge'"),
        ("missing op", {"from": "t"}, "spec.op"),
        ("spec not an object", [], "spec: expected an object"),
        ("select without from", {"op": "select"}, "missing required field 'from'"),
        ("unknown key on select", {**base_sel, "wher": eq("a", 1)}, "spec.wher: unknown field"),
        ("empty and", {**base_sel, "where": {"and": []}}, "spec.where.and: needs a non-empty array"),
        ("empty or nested", {**base_sel, "where": {"and": [eq("a", 1), {"or": []}]}}, "spec.where.and[1].or: needs a non-empty array"),
        ("and with extra key", {**base_sel, "where": {"and": [eq("a", 1)], "col": "a"}}, "spec.where.col: unknown field"),
        ("and holding a non-condition", {**base_sel, "where": {"and": [5]}}, "spec.where.and[0]: expected a condition object"),
        ("condition without op", {**base_sel, "where": {"col": "a", "value": 1}}, "missing required field 'op'"),
        ("unknown comparison op", {**base_sel, "where": {"col": "a", "op": "~~", "value": 1}}, "unknown operator '~~'"),
        ("= without value", {**base_sel, "where": {"col": "a", "op": "="}}, "needs a value"),
        ("in with scalar", {**base_sel, "where": {"col": "a", "op": "in", "value": 1}}, "needs a non-empty array"),
        ("in with empty list", {**base_sel, "where": {"col": "a", "op": "in", "value": []}}, "needs a non-empty array"),
        ("between with 3 values", {**base_sel, "where": {"col": "a", "op": "between", "value": [1, 2, 3]}}, "exactly two values"),
        ("is null with value", {**base_sel, "where": {"col": "a", "op": "is null", "value": 1}}, "takes no value"),
        ("= with array", {**base_sel, "where": {"col": "a", "op": "=", "value": [1]}}, "single value"),
        ("value of unknown shape", {**base_sel, "where": {"col": "a", "op": "=", "value": {"x": 1}}}, "expected a literal or one of"),
        ("param with bad name", {**base_sel, "where": {"col": "a", "op": "=", "value": {"param": "1 or 1=1"}}}, "parameter names must match"),
        ("fn with bad name", {**base_sel, "columns": [{"expr": {"fn": "x); DROP TABLE t; --"}}]}, "not a function name"),
        ("fn args not an array", {**base_sel, "columns": [{"expr": {"fn": "upper", "args": "a"}}]}, "expected an array"),
        ("column name with parenthesis", {**base_sel, "columns": ["count(*)"]}, "is not an identifier"),
        ("column name with semicolon", {**base_sel, "columns": ["a;b"]}, "is not an identifier"),
        ("table name with quote", {**base_sel, "from": 'a"b'}, "is not an identifier"),
        ("join without on", {**base_sel, "joins": [{"type": "left", "table": "u"}]}, "needs 'on'"),
        ("cross join with on", {**base_sel, "joins": [{"type": "cross", "table": "u", "on": eq("a", 1)}]}, "no ON condition"),
        ("bad join type", {**base_sel, "joins": [{"type": "sideways", "table": "u", "on": eq("a", 1)}]}, "unknown join type"),
        ("negative limit", {**base_sel, "limit": -1}, "non-negative integer"),
        ("float limit", {**base_sel, "limit": 1.5}, "non-negative integer"),
        ("offset without limit", {**base_sel, "offset": 3}, "needs 'limit'"),
        ("having without group", {**base_sel, "having": eq("a", 1)}, "HAVING needs groupBy"),
        ("aggregate of an aggregate", {**base_sel, "columns": [{"expr": {"fn": "count", "args": [col("*")]}, "agg": "count"}]}, "already an aggregate"),
        ("bad aggregate", {**base_sel, "columns": [{"expr": col("a"), "agg": "median"}]}, "unknown aggregate"),
        ("distinct without agg", {**base_sel, "columns": [{"expr": col("a"), "distinct": True}]}, "only applies together with 'agg'"),
        ("bad order dir", {**base_sel, "orderBy": [{"expr": col("a"), "dir": "up"}]}, "expected 'asc' or 'desc'"),
        ("bad nulls", {**base_sel, "orderBy": [{"expr": col("a"), "nulls": "middle"}]}, "expected 'first' or 'last'"),
        ("duplicate cte", {**base_sel, "ctes": [{"name": "c", "query": base_sel}, {"name": "c", "query": base_sel}]}, "duplicate CTE name"),
        ("cte query not a select", {**base_sel, "ctes": [{"name": "c", "query": {"op": "delete", "table": "t"}}]}, "ctes[0].query"),
        ("deep nesting", {**base_sel, "where": __import__("functools").reduce(lambda acc, _: {"not": acc}, range(60), eq("a", 1))}, "nested too deeply"),
        ("insert row arity", {"op": "insert", "table": "t", "columns": ["a", "b"], "rows": [[1, 2], [3]]}, "spec.rows[1]: has 1 values but there are 2 columns"),
        ("insert without rows", {"op": "insert", "table": "t", "columns": ["a"], "rows": []}, "non-empty array of rows"),
        ("insert duplicate columns", {"op": "insert", "table": "t", "columns": ["a", "A"], "rows": [[1, 2]]}, "duplicate column names"),
        ("onConflict bad action", {"op": "insert", "table": "t", "columns": ["a"], "rows": [[1]], "onConflict": {"target": ["a"], "action": "ignore"}}, "expected 'nothing' or 'update'"),
        ("onConflict empty target", {"op": "insert", "table": "t", "columns": ["a"], "rows": [[1]], "onConflict": {"target": [], "action": "nothing"}}, "non-empty array of column names"),
        ("onConflict set with nothing", {"op": "insert", "table": "t", "columns": ["a"], "rows": [[1]], "onConflict": {"target": ["a"], "action": "nothing", "set": {"a": 1}}}, "only applies to action 'update'"),
        ("update without set", {"op": "update", "table": "t", "set": {}}, "needs at least one column"),
        ("update set not object", {"op": "update", "table": "t", "set": [1]}, "expected an object of column -> value"),
        ("delete extra key", {"op": "delete", "table": "t", "set": {}}, "spec.set: unknown field"),
        ("create_table without columns", {"op": "create_table", "name": "t", "columns": []}, "non-empty array of column definitions"),
        ("create_table bad type", {"op": "create_table", "name": "t", "columns": [{"name": "a", "type": "int); DROP TABLE x; --"}]}, "not a portable type name"),
        ("create_table duplicate column", {"op": "create_table", "name": "t", "columns": [{"name": "a", "type": "int"}, {"name": "A", "type": "int"}]}, "duplicate column 'A'"),
        ("create_table pk not a column", {"op": "create_table", "name": "t", "columns": [{"name": "a", "type": "int"}], "primaryKey": ["b"]}, "'b' is not a column"),
        ("create_table bad fk action", {"op": "create_table", "name": "t", "columns": [{"name": "a", "type": "int", "references": {"table": "u", "column": "id", "onDelete": "explode"}}]}, "references.onDelete"),
        ("create_table nullable not bool", {"op": "create_table", "name": "t", "columns": [{"name": "a", "type": "int", "nullable": "no"}]}, "nullable: expected a boolean"),
    ]
    for (name, spec, fragment), resp in zip(bad, pmap(lambda b: call("compile", compile_req(b[1], "postgres")), bad)):
        check(f"rejects {name}", (not resp["ok"]) and fragment in resp["error"], resp)

    unsupported = [
        ("onConflict on clickhouse", {"op": "insert", "table": "t", "columns": ["a"], "rows": [[1]], "onConflict": {"target": ["a"], "action": "nothing"}}, "clickhouse", "not supported for clickhouse"),
        ("returning on mysql", {"op": "delete", "table": "t", "where": eq("a", 1), "returning": ["a"]}, "mysql", "returning is not supported for mysql"),
        ("serial on bigquery", {"op": "create_table", "name": "t", "columns": [{"name": "id", "type": "serial", "primaryKey": True}]}, "bigquery", "not supported for bigquery"),
        ("sqlite autoincrement without pk", {"op": "create_table", "name": "t", "columns": [{"name": "id", "type": "integer", "autoIncrement": True}]}, "sqlite", "single primary key"),
        ("param as default", {"op": "create_table", "name": "t", "columns": [{"name": "id", "type": "integer", "default": {"param": "x"}}]}, "sqlite", "cannot be a {param}"),
        ("cast with param type", sel(**{"from": "t", "columns": [{"expr": {"fn": "cast", "args": [col("a"), {"param": "t"}]}}]}), "sqlite", "plain string"),
        ("fn arity", sel(**{"from": "t", "columns": [{"expr": {"fn": "upper", "args": []}}]}), "sqlite", "fn 'upper'"),
        ("upsert update with nothing left", {"op": "insert", "table": "t", "columns": ["id"], "rows": [[1]], "onConflict": {"target": ["id"], "action": "update"}}, "postgres", "nothing to update"),
    ]
    for (name, spec, dialect, fragment), resp in zip(unsupported, pmap(lambda b: call("compile", compile_req(b[1], b[2])), unsupported)):
        check(f"refuses {name}", (not resp["ok"]) and fragment in resp["error"], resp)
    check("unknown dialect on compile", "params.dialect" in call("compile", compile_req(base_sel, "db2")).get("error", ""))
    check("missing spec", "params.spec" in call("compile", {"dialect": "sqlite"}).get("error", ""))
    check("unknown action", not call("explode", {}).get("ok", True) if via == "direct" else True)
    check("missing sql", "params.sql" in call("format", {"dialect": "sqlite"}).get("error", ""))
    check("empty sql", "must not be empty" in call("validate", {"sql": "  ", "dialect": "sqlite"}).get("error", ""))


def suite_validate_schema(via: str, call) -> None:
    section(f"f. validate + schema actions [{via}]")
    resp = call("validate", {"sql": "select a, t.b from t join u on t.id = u.id; update x set a = 1; create table z (q int); delete from y where id = 1", "dialect": "postgres"})
    kinds = [s["kind"] for s in resp["data"]["statements"]] if resp["ok"] else []
    check("validate: per-statement kinds", kinds == ["select", "update", "create_table", "delete"], resp)
    st = resp["data"]["statements"]
    check("validate: tables and columns referenced", st[0]["tables"] == ["t", "u"] and "t.b" in st[0]["columns"] and "t.id" in st[0]["columns"] and st[1]["tables"] == ["x"] and st[2]["columns"] == ["q"], st)
    check("validate: UPDATE without WHERE is a warning only", resp["data"]["ok"] and any(lv == "warning" and "UPDATE without WHERE" in m for lv, m in issues_of(resp)), resp)
    resp = call("validate", {"sql": "WITH c AS (SELECT 1) SELECT * FROM c JOIN real_t ON TRUE", "dialect": "sqlite"})
    check("validate: CTE names are not tables", resp["data"]["statements"][0]["tables"] == ["real_t"], resp)
    resp = call("validate", {"sql": "SELECT 1;\nSELECT FROM WHERE;\nSELECT (1", "dialect": "mysql"})
    errs = [i for i in resp["data"]["issues"] if i["level"] == "error"]
    check("validate: syntax errors with line/column across statements", resp["ok"] and resp["data"]["ok"] is False and len(errs) >= 2 and errs[0].get("line") == 2 and errs[0].get("column") == 13 and any(e.get("line") == 3 for e in errs), errs)
    for bad_stmt in ("SELEC x", "foo(1)", "42"):
        resp = call("validate", {"sql": bad_stmt, "dialect": "postgres"})
        check(f"validate: lone expression {bad_stmt!r} is not a statement", resp["ok"] and resp["data"]["ok"] is False and "Not a SQL statement" in resp["data"]["issues"][0]["message"] and resp["data"]["issues"][0].get("column") == 1, resp)
    resp = call("validate", {"sql": "SELECT 'abc", "dialect": "sqlite"})
    check("validate: unterminated string -> error issue", resp["ok"] and resp["data"]["ok"] is False and resp["data"]["issues"], resp)
    resp = call("validate", {"sql": "SELECT 1", "dialect": "mariadb"})
    check("validate: mariadb noted", resp["ok"] and any("MariaDB" in m for _, m in issues_of(resp)), resp)
    resp = call("validate", {"sql": "SELECT TOP 3 a FROM t", "dialect": "tsql"})
    check("validate: dialect-specific syntax is accepted in its dialect", resp["data"]["ok"], resp)
    resp = call("validate", {"sql": "SELECT TOP 3 a FROM t", "dialect": "postgres"})
    check("validate: ... and rejected elsewhere", not resp["data"]["ok"], resp)

    ddl = """
    CREATE TABLE orgs (id SERIAL PRIMARY KEY, name VARCHAR(80) NOT NULL UNIQUE);
    CREATE TABLE users (
      id INT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      email TEXT NOT NULL DEFAULT 'x@y',
      org_id INT REFERENCES orgs (id) ON DELETE CASCADE,
      manager INT,
      CONSTRAINT fk_mgr FOREIGN KEY (manager) REFERENCES users (id)
    );
    CREATE TABLE memberships (user_id INT NOT NULL, team TEXT NOT NULL, since DATE, PRIMARY KEY (user_id, team),
      FOREIGN KEY (user_id) REFERENCES users (id));
    CREATE UNIQUE INDEX ix_email ON users (email);
    ALTER TABLE users ADD COLUMN nick TEXT;
    ALTER TABLE users ADD CONSTRAINT fk_org2 FOREIGN KEY (org_id) REFERENCES orgs (id);
    ALTER TABLE memberships DROP COLUMN since;
    """
    resp = call("schema", {"ddl": ddl, "dialect": "postgres"})
    check("schema: ok", resp["ok"] and resp["data"]["issues"] == [], resp)
    tables = {t["name"]: t for t in resp["data"]["schema"]["tables"]} if resp["ok"] else {}
    users, orgs, memb = tables.get("users", {}), tables.get("orgs", {}), tables.get("memberships", {})
    colmap = lambda t: {c["name"]: c for c in t.get("columns", [])}  # noqa: E731
    check("schema: primary keys (single, composite, serial)", orgs.get("primaryKey") == ["id"] and users.get("primaryKey") == ["id"] and memb.get("primaryKey") == ["user_id", "team"], tables)
    check("schema: nullability and PK implies NOT NULL", colmap(users)["email"]["nullable"] is False and colmap(users)["org_id"]["nullable"] is True and colmap(users)["id"]["nullable"] is False and colmap(memb)["team"]["nullable"] is False and colmap(memb)["user_id"]["primaryKey"] is True, users)
    check("schema: defaults and types", colmap(users)["email"]["default"] == "'x@y'" and colmap(users)["email"]["type"] == "TEXT" and colmap(orgs)["name"]["type"] == "VARCHAR(80)", users)
    check("schema: unique flag", colmap(orgs)["name"].get("unique") is True, orgs)
    fks = {tuple(fk["columns"]): (fk["refTable"], tuple(fk["refColumns"])) for fk in users.get("foreignKeys", [])}
    check("schema: foreign keys (column-level, table-level, ALTER ADD CONSTRAINT)", fks.get(("org_id",)) == ("orgs", ("id",)) and fks.get(("manager",)) == ("users", ("id",)), users.get("foreignKeys"))
    check("schema: ALTER ADD COLUMN / DROP COLUMN applied", "nick" in colmap(users) and "since" not in colmap(memb), (users, memb))
    check("schema: CREATE INDEX recorded", users.get("indexes") == [{"name": "ix_email", "columns": ["email"], "unique": True}], users.get("indexes"))
    check("schema: composite FK on a table-level constraint", memb.get("foreignKeys") == [{"columns": ["user_id"], "refTable": "users", "refColumns": ["id"]}], memb)
    mermaid = resp["data"]["mermaid"] if resp["ok"] else ""
    check("schema: mermaid entities, keys and relationships", mermaid.startswith("erDiagram\n") and "    INT id PK" in mermaid and "TEXT email UK" not in mermaid
          and "INT user_id PK,FK" in mermaid and "users }o--o| orgs : org_id" in mermaid and "memberships }o--|| users : user_id" in mermaid and "users }o--o| users : manager" in mermaid, mermaid)
    check("schema: mermaid entity blocks are balanced", mermaid.count(" {\n") == mermaid.count("\n  }\n") == 3, mermaid)
    resp = call("schema", {"ddl": "CREATE TABLE a (x INT REFERENCES missing (id)); CREATE INDEX i ON nope (q)", "dialect": "sqlite"})
    check("schema: dangling FK / index reported as warnings", resp["ok"] and sum(1 for lv, _ in issues_of(resp) if lv == "warning") == 2, resp)
    resp = call("schema", {"ddl": "CREATE TABLE (", "dialect": "sqlite"})
    check("schema: syntax error reported as an issue", resp["ok"] and issues_of(resp) and issues_of(resp)[0][0] == "error", resp)
    resp = call("schema", {"ddl": "SELECT 1", "dialect": "sqlite"})
    check("schema: no CREATE TABLE -> warning", resp["ok"] and any("No CREATE TABLE" in m for _, m in issues_of(resp)), resp)
    resp = call("schema", {"ddl": "CREATE TABLE `my table` (`a b` INT PRIMARY KEY, c TEXT)", "dialect": "mysql"})
    check("schema: mermaid quotes odd identifiers", '"my table" {' in resp["data"]["mermaid"] and 'INT "a b" PK' in resp["data"]["mermaid"], resp["data"]["mermaid"] if resp["ok"] else resp)
    # the schema output feeds check directly
    chk = call("check", {"sql": "SELECT u.nick, o.name FROM users u JOIN orgs o ON o.id = u.org_id", "dialect": "postgres", "schema": tables and {"tables": list(tables.values())}})
    check("schema output is a valid check input", chk["ok"] and chk["data"]["ok"], chk)
    chk = call("check", {"sql": "SELECT u.nik FROM users u", "dialect": "postgres", "schema": {"tables": list(tables.values())}})
    check("... and catches typos in it", chk["ok"] and not chk["data"]["ok"] and "Did you mean 'nick'" in chk["data"]["issues"][0]["message"], chk)


def suite_http_only() -> None:
    if not BASE:
        return
    section("g. HTTP contract of POST /api/sql")

    def raw(body: bytes, origin: str | None = BASE, ctype: str = "application/json"):
        headers = {"Content-Type": ctype}
        if origin:
            headers["Origin"] = origin
        req = urllib.request.Request(f"{BASE}/api/sql", body, headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read() or b"{}")

    status, body = raw(json.dumps({"action": "format", "params": {"sql": "select 1", "dialect": "sqlite"}}).encode())
    check("200 {ok:true,data}", status == 200 and body == {"ok": True, "data": {"sql": "SELECT\n  1"}}, (status, body))
    status, body = raw(json.dumps({"action": "format", "params": {"sql": "select from where", "dialect": "sqlite"}}).encode())
    check("engine refusal -> 422 {ok:false,error}", status == 422 and body["ok"] is False and body["error"], (status, body))
    status, body = raw(json.dumps({"action": "explode", "params": {}}).encode())
    check("unknown action -> 400", status == 400, (status, body))
    status, body = raw(json.dumps({"action": "format"}).encode())
    check("missing params -> 400", status == 400, (status, body))
    status, body = raw(b"{nope")
    check("invalid JSON -> 400", status == 400, (status, body))
    status, body = raw(json.dumps({"action": "format", "params": {}, "extra": 1}).encode())
    check("extra top-level key -> 400 (strict)", status == 400, (status, body))
    status, body = raw(json.dumps({"action": "format", "params": {"sql": "select 1", "dialect": "sqlite"}}).encode(), origin="http://evil.example")
    check("foreign Origin blocked", status == 403, (status, body))
    status, body = raw(json.dumps({"action": "format", "params": {"sql": "x" * (1024 * 1024 + 10), "dialect": "sqlite"}}).encode())
    check("oversized body -> 413", status == 413, status)
    status, body = raw(json.dumps({"action": "compile", "params": {"dialect": "postgres", "spec": {"op": "select", "from": "t", "where": {"and": []}}}}).encode())
    check("spec error surfaces through HTTP with the field path", status == 422 and "spec.where.and" in body["error"], (status, body))


def main() -> None:
    only = os.environ.get("SQL_E2E_ONLY")  # e.g. SQL_E2E_ONLY=semantic_exec,merge: run just those suite_* functions while iterating
    suites = [suite_corpus, suite_compile_sqlite, suite_transpile_sqlite, suite_compile_kat, suite_roundtrip, suite_merge, suite_returning, suite_expr_conditions,
              suite_identity, suite_semantic_exec, suite_check, suite_reject, suite_validate_schema]
    for via, call in TRANSPORTS.items():
        for suite in suites:
            if only is None or any(name in suite.__name__ for name in only.split(",")):
                suite(via, call)
    if only is None:
        suite_http_only()
    print("\n==== summary")
    total_pass = total = 0
    for name, (ok, n) in results.items():
        print(f"{ok:4d}/{n:<4d} {name}")
        total_pass += ok
        total += n
    print(f"{total_pass}/{total} passed, {len(failures)} failed")
    if failures:
        print("FAILED:\n  " + "\n  ".join(failures))
        sys.exit(1)


if __name__ == "__main__":
    main()
