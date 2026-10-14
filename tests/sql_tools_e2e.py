#!/usr/bin/env python3
"""knife_sql_* tools end-to-end: listing/schema validity, POST /api/agent/tool and POST /api/mcp for every tool.

Usage: python3 tests/sql_tools_e2e.py <base_url>      (system python3 with `jsonschema`; no provider, no mock needed)
Start the server: KNIFE_DATA_DIR=$(mktemp -d) KNIFE_PORT=3271 npm run dev   (default passwordless account, no login)
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from typing import Any

from jsonschema import Draft7Validator

if len(sys.argv) < 2:
    sys.exit("usage: python3 tests/sql_tools_e2e.py <base_url>")
BASE = sys.argv[1].rstrip("/")
SQL_TOOLS = ["knife_sql_format", "knife_sql_transpile", "knife_sql_validate", "knife_sql_schema", "knife_sql_compile", "knife_sql_check"]
passed = 0
failures: list[str] = []


def check(name: str, ok: bool, detail: Any = "") -> None:
    global passed
    if ok:
        passed += 1
    else:
        failures.append(name)
        print(f"FAIL {name} | {str(detail)[:700]}")


def post(path: str, body: dict[str, Any], accept: str = "application/json") -> tuple[int, str]:
    req = urllib.request.Request(f"{BASE}{path}", json.dumps(body).encode(), {"Content-Type": "application/json", "Accept": accept, "Origin": BASE}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode()


def tool(name: str, args: dict[str, Any]) -> dict[str, Any]:
    status, text = post("/api/agent/tool", {"name": name, "args": args})
    body = json.loads(text)
    body["_status"] = status
    if body.get("ok"):
        try:
            body["data"] = json.loads(body["content"])
        except ValueError:
            body["data"] = body["content"]
    return body


_rpc_id = 0


def mcp(method: str, params: dict[str, Any]) -> dict[str, Any]:
    global _rpc_id
    _rpc_id += 1
    status, text = post("/api/mcp", {"jsonrpc": "2.0", "id": _rpc_id, "method": method, "params": params}, accept="application/json, text/event-stream")
    payload = next((line[5:].strip() for line in text.splitlines() if line.startswith("data:")), text)
    return {"_status": status, **json.loads(payload)}


def mcp_call(name: str, args: dict[str, Any]) -> tuple[bool, Any]:
    reply = mcp("tools/call", {"name": name, "arguments": args})
    result = reply.get("result", {})
    text = result["content"][0]["text"] if result.get("content") else ""
    is_error = bool(result.get("isError")) or "error" in reply
    if not is_error:
        try:
            return True, json.loads(text)
        except ValueError:
            return True, text
    return False, text or json.dumps(reply.get("error"))


SCHEMA = {"tables": [
    {"name": "users", "columns": [{"name": "id", "primaryKey": True}, {"name": "name"}, {"name": "email"}, {"name": "org_id"}]},
    {"name": "orgs", "columns": [{"name": "id", "primaryKey": True}, {"name": "name"}]},
]}
DDL = "CREATE TABLE users (id INT PRIMARY KEY, name TEXT, email TEXT, org_id INT REFERENCES orgs(id)); CREATE TABLE orgs (id INT PRIMARY KEY, name TEXT);"

# ---------------------------------------------------------------- listing and JSON schema validity
status, text = urllib.request.urlopen(f"{BASE}/api/agent/tools", timeout=30).status, urllib.request.urlopen(f"{BASE}/api/agent/tools", timeout=30).read().decode()
defs = {t["function"]["name"]: t["function"] for t in json.loads(text)["tools"]}
check("all six knife_sql_* tools are listed for the assistant", all(n in defs for n in SQL_TOOLS), sorted(defs))
for name, fn in defs.items():
    try:
        Draft7Validator.check_schema(fn["parameters"])
        valid = True
        err = ""
    except Exception as exc:  # noqa: BLE001
        valid, err = False, exc
    check(f"{name}: parameters are a valid draft-7 schema", valid, err)
    check(f"{name}: root is an object with properties", fn["parameters"].get("type") == "object" and isinstance(fn["parameters"].get("properties"), dict), fn["parameters"])
for name in SQL_TOOLS:
    params = defs[name]["parameters"]
    blob = json.dumps(params)
    check(f"{name}: schema is flat and small (no $ref/anyOf/oneOf/allOf, < 5 KB)", not any(k in blob for k in ('"$ref"', '"anyOf"', '"oneOf"', '"allOf"', '"definitions"', '"$defs"')) and len(blob) < 5000, (len(blob), blob[:300]))
check("knife_sql_compile: spec is a loose object requiring op", defs["knife_sql_compile"]["parameters"]["properties"]["spec"]["required"] == ["op"], defs["knife_sql_compile"]["parameters"]["properties"]["spec"])
check("knife_sql_schema: dialect is optional", defs["knife_sql_schema"]["parameters"]["required"] == ["ddl"], defs["knife_sql_schema"]["parameters"])
manual = {
    "knife_sql_compile": ["PREFER THIS over hand-writing SQL", "knife_sql_check", "{param: name}", "Placeholders:", "onConflict", "create_table"],
    "knife_sql_check": ["ALWAYS call this after writing or editing SQL", "Never invent column names", "did-you-mean"],
    "knife_sql_transpile": ["ALWAYS read `issues`", "instead of rewriting by hand"],
    "knife_sql_schema": ["Mermaid", "knife_sql_check"],
}
for name, phrases in manual.items():
    check(f"{name}: description carries the agent manual", all(p in defs[name]["description"] for p in phrases), [p for p in phrases if p not in defs[name]["description"]])
validator = Draft7Validator(defs["knife_sql_compile"]["parameters"])
check("compile schema accepts a real call", validator.is_valid({"spec": {"op": "select", "from": "t", "where": {"and": [{"col": "a", "op": "=", "value": 1}]}}, "dialect": "tsql"}))
check("compile schema rejects an unknown dialect, a missing op and extra top-level keys",
      not validator.is_valid({"spec": {"op": "select"}, "dialect": "db2"}) and not validator.is_valid({"spec": {"from": "t"}, "dialect": "sqlite"}) and not validator.is_valid({"spec": {"op": "select"}, "dialect": "sqlite", "x": 1}))

# ---------------------------------------------------------------- POST /api/agent/tool
r = tool("knife_sql_format", {"sql": "select a,b from t where a=1", "dialect": "postgres"})
check("agent/tool format", r["ok"] and r["data"] == {"sql": "SELECT\n  a,\n  b\nFROM t\nWHERE\n  a = 1"}, r)
r = tool("knife_sql_format", {"sql": "select from where", "dialect": "postgres"})
check("agent/tool format: syntax error -> ok:false with position", r["_status"] == 200 and r["ok"] is False and "line 1, column 13" in r["error"], r)

r = tool("knife_sql_transpile", {"sql": "SELECT * FROM t WHERE a ILIKE 'x%' LIMIT 5", "from": "postgres", "to": "tsql"})
check("agent/tool transpile: TOP + emulated ILIKE + warning", r["ok"] and r["data"]["sql"] == "SELECT TOP 5 * FROM t WHERE LOWER(a) LIKE LOWER('x%')" and r["data"]["issues"][0]["level"] == "warning", r)
r = tool("knife_sql_transpile", {"sql": "INSERT INTO t (a) VALUES (1) RETURNING a", "from": "postgres", "to": "mysql"})
check("agent/tool transpile: unsupported feature comes back as an error-level issue", r["ok"] and any(i["level"] == "error" and "RETURNING" in i["message"] for i in r["data"]["issues"]), r)
r = tool("knife_sql_transpile", {"sql": "SELECT 1", "from": "postgres", "to": "klingon"})
check("agent/tool transpile: bad dialect -> ok:false", r["ok"] is False and r["error"], r)
r = tool("knife_sql_transpile", {"sql": "SELECT 1", "from": "postgres", "to": "mysql", "extra": True})
check("agent/tool transpile: unknown argument rejected", r["ok"] is False, r)

r = tool("knife_sql_validate", {"sql": "SELECT a FROM t JOIN u ON t.id = u.id; DELETE FROM x", "dialect": "mysql"})
check("agent/tool validate: statements + warnings", r["ok"] and r["data"]["ok"] and [s["kind"] for s in r["data"]["statements"]] == ["select", "delete"] and r["data"]["statements"][0]["tables"] == ["t", "u"]
      and any("DELETE without WHERE" in i["message"] for i in r["data"]["issues"]), r)
r = tool("knife_sql_validate", {"sql": "SELEC 1", "dialect": "mysql"})
check("agent/tool validate: syntax error as data, not a failure", r["ok"] and r["data"]["ok"] is False and r["data"]["issues"][0]["level"] == "error", r)

r = tool("knife_sql_schema", {"ddl": DDL})
check("agent/tool schema: default dialect, structure + mermaid", r["ok"] and [t["name"] for t in r["data"]["schema"]["tables"]] == ["users", "orgs"] and r["data"]["mermaid"].startswith("erDiagram") and "users }o--o| orgs : org_id" in r["data"]["mermaid"], r)
r = tool("knife_sql_schema", {"ddl": "CREATE TABLE `a b` (id INT)", "dialect": "mysql"})
check("agent/tool schema: explicit dialect", r["ok"] and r["data"]["schema"]["tables"][0]["name"] == "a b", r)

spec = {"op": "select", "from": {"name": "users", "as": "u"}, "columns": ["u.id", "u.name"], "where": {"and": [{"col": "u.name", "op": "ilike", "value": {"param": "q"}}, {"col": "u.org_id", "op": "in", "value": [1, 2]}]}, "orderBy": [{"expr": {"col": "u.id"}}], "limit": 5}
expected = {
    "postgres": ("SELECT u.id, u.name FROM users AS u WHERE u.name ILIKE $1 AND u.org_id IN (1, 2) ORDER BY u.id LIMIT 5", ["q"]),
    "mysql": ("SELECT u.id, u.name FROM users AS u WHERE LOWER(u.name) LIKE LOWER(?) AND u.org_id IN (1, 2) ORDER BY u.id LIMIT 5", ["q"]),
    "tsql": ("SELECT TOP 5 u.id, u.name FROM users AS u WHERE LOWER(u.name) LIKE LOWER(@q) AND u.org_id IN (1, 2) ORDER BY u.id", ["q"]),
    "oracle": ("SELECT u.id, u.name FROM users u WHERE LOWER(u.name) LIKE LOWER(:q) AND u.org_id IN (1, 2) ORDER BY u.id FETCH FIRST 5 ROWS ONLY", ["q"]),
}
for dialect, (sql, params) in expected.items():
    r = tool("knife_sql_compile", {"spec": spec, "dialect": dialect})
    check(f"agent/tool compile {dialect}", r["ok"] and r["data"]["sql"] == sql and r["data"]["params"] == params, r)
r = tool("knife_sql_compile", {"spec": {"op": "insert", "table": "users", "columns": ["id", "name"], "rows": [[1, {"param": "n"}]], "onConflict": {"target": ["id"], "action": "update"}}, "dialect": "mysql", "pretty": True})
check("agent/tool compile: upsert for mysql, pretty", r["ok"] and "ON DUPLICATE KEY UPDATE" in r["data"]["sql"] and "\n" in r["data"]["sql"] and r["data"]["params"] == ["n"], r)
r = tool("knife_sql_compile", {"spec": {"op": "select", "from": "t", "where": {"and": []}}, "dialect": "postgres"})
check("agent/tool compile: bad spec -> ok:false naming the field path", r["ok"] is False and "spec.where.and: needs a non-empty array" in r["error"], r)
r = tool("knife_sql_compile", {"spec": {"op": "merge"}, "dialect": "postgres"})
check("agent/tool compile: op outside the enum is rejected at the schema layer", r["ok"] is False, r)
r = tool("knife_sql_compile", {"spec": {"op": "insert", "table": "t", "columns": ["a"], "rows": [[1]], "onConflict": {"target": ["a"], "action": "nothing"}}, "dialect": "clickhouse"})
check("agent/tool compile: dialect limitation explained", r["ok"] is False and "not supported for clickhouse" in r["error"], r)
r = tool("knife_sql_compile", {"spec": {"op": "insert", "table": "t", "columns": ["a", "b"], "rows": [[1, {"param": "p"}]], "onConflict": {"target": ["a"], "action": "update"}, "returning": ["a"]}, "dialect": "tsql"})
check("agent/tool compile: upsert for tsql is a MERGE with OUTPUT inserted.", r["ok"] and r["data"]["sql"].startswith("MERGE INTO t USING (VALUES (1, @p)) AS s(a, b) ON t.a = s.a") and r["data"]["sql"].endswith("OUTPUT inserted.a;") and r["data"]["params"] == ["p"], r)
lower_where = {"op": "select", "from": "users", "where": {"expr": {"fn": "lower", "args": [{"col": "name"}]}, "op": "=", "value": {"param": "p"}}}
r = tool("knife_sql_compile", {"spec": lower_where, "dialect": "postgres"})
check("agent/tool compile: WHERE lower(name) = $1 via {expr, op, value}", r["ok"] and r["data"]["sql"] == "SELECT * FROM users WHERE LOWER(name) = $1" and r["data"]["params"] == ["p"], r)
having_sum = {"op": "select", "from": "orders", "columns": ["status"], "groupBy": [{"col": "status"}], "having": {"expr": {"fn": "sum", "args": [{"col": "total"}]}, "op": ">", "value": 100}}
r = tool("knife_sql_compile", {"spec": having_sum, "dialect": "oracle"})
check("agent/tool compile: HAVING SUM(total) > 100 without an alias", r["ok"] and r["data"]["sql"] == "SELECT status FROM orders GROUP BY status HAVING SUM(total) > 100", r)
r = tool("knife_sql_compile", {"spec": {"op": "select", "from": "t", "where": {"expr": {"fn": "sum", "args": [{"col": "a"}]}, "op": ">", "value": 1}}, "dialect": "postgres"})
check("agent/tool compile: aggregate in where rejected with the field path", r["ok"] is False and "spec.where.expr: aggregate 'sum' is not allowed in where" in r["error"], r)

r = tool("knife_sql_check", {"sql": "SELECT u.emial FROM users u JOIN orgs o ON o.id = u.org_id", "dialect": "postgres", "schema": SCHEMA})
check("agent/tool check with schema: did-you-mean", r["ok"] and r["data"]["ok"] is False and "Did you mean 'email'" in r["data"]["issues"][0]["message"], r)
r = tool("knife_sql_check", {"sql": "SELECT u.email FROM users u JOIN orgs o ON o.id = u.org_id", "dialect": "postgres", "ddl": DDL})
check("agent/tool check with ddl: clean query passes", r["ok"] and r["data"]["ok"] is True and r["data"]["issues"] == [], r)
r = tool("knife_sql_check", {"sql": "SELECT id FROM users u JOIN orgs o ON o.id = u.org_id", "dialect": "postgres", "ddl": DDL})
check("agent/tool check with ddl: ambiguous column", r["ok"] and not r["data"]["ok"] and "ambiguous" in r["data"]["issues"][0]["message"], r)
r = tool("knife_sql_check", {"sql": "SELECT 1", "dialect": "postgres", "ddl": DDL, "schema": SCHEMA})
check("agent/tool check: both schema and ddl -> error", r["ok"] is False and "not both" in r["error"], r)
r = tool("knife_sql_check", {"sql": "SELECT 1", "dialect": "postgres"})
check("agent/tool check: neither schema nor ddl -> error explains", r["ok"] is False and "schema" in r["error"], r)
r = tool("knife_sql_check", {"sql": "SELECT 1", "dialect": "postgres", "ddl": "CREATE TABLE ("})
check("agent/tool check: broken ddl -> error with message", r["ok"] is False and "DDL does not parse" in r["error"], r)
r = tool("knife_sql_check", {"sql": "SELECT 1", "dialect": "postgres", "schema": {"tables": [{"name": "t", "columns": [{"name": "a", "bogus": 1}]}]}})
check("agent/tool check: malformed schema rejected", r["ok"] is False, r)
r = tool("knife_sql_check", {"sql": "SELEC x", "dialect": "postgres", "schema": SCHEMA})
check("agent/tool check: syntax error is reported as an issue", r["ok"] and r["data"]["ok"] is False and r["data"]["issues"][0]["level"] == "error", r)

# ---------------------------------------------------------------- the intended assistant loop: compile -> check -> fix -> check
bad = {"op": "select", "from": "users", "columns": ["id", "full_name"], "where": {"col": "org_id", "op": "=", "value": {"param": "org"}}}
compiled = tool("knife_sql_compile", {"spec": bad, "dialect": "postgres"})
verdict = tool("knife_sql_check", {"sql": compiled["data"]["sql"], "dialect": "postgres", "schema": SCHEMA})
check("loop: compiled SQL with an invented column is caught by check", compiled["ok"] and verdict["ok"] and not verdict["data"]["ok"] and "Unknown column 'full_name'" in verdict["data"]["issues"][0]["message"], verdict)
fixed = {**bad, "columns": ["id", "name"]}
compiled = tool("knife_sql_compile", {"spec": fixed, "dialect": "postgres"})
verdict = tool("knife_sql_check", {"sql": compiled["data"]["sql"], "dialect": "postgres", "schema": SCHEMA})
check("loop: corrected spec passes check", verdict["ok"] and verdict["data"]["ok"] and compiled["data"]["sql"] == "SELECT id, name FROM users WHERE org_id = $1", (compiled, verdict))

# ---------------------------------------------------------------- POST /api/mcp
reply = mcp("tools/list", {})
listed = {t["name"]: t for t in reply["result"]["tools"]}
check("mcp tools/list includes the six SQL tools with inputSchema", all(n in listed and listed[n]["inputSchema"]["type"] == "object" and listed[n]["description"] for n in SQL_TOOLS), sorted(listed))
check("mcp descriptions match the agent manual", "PREFER THIS" in listed["knife_sql_compile"]["description"] and "ALWAYS call this" in listed["knife_sql_check"]["description"])
for name in SQL_TOOLS:
    try:
        Draft7Validator.check_schema({k: v for k, v in listed[name]["inputSchema"].items() if k != "$schema"})
        valid = True
    except Exception:  # noqa: BLE001
        valid = False
    check(f"mcp {name}: inputSchema is a valid JSON schema", valid, listed[name]["inputSchema"])

ok, data = mcp_call("knife_sql_format", {"sql": "select 1", "dialect": "sqlite"})
check("mcp call format", ok and data == {"sql": "SELECT\n  1"}, (ok, data))
ok, data = mcp_call("knife_sql_transpile", {"sql": "SELECT * FROM t LIMIT 5", "from": "postgres", "to": "oracle"})
check("mcp call transpile", ok and data["sql"] == "SELECT * FROM t FETCH FIRST 5 ROWS ONLY", (ok, data))
ok, data = mcp_call("knife_sql_validate", {"sql": "SELECT a FROM t", "dialect": "sqlite"})
check("mcp call validate", ok and data["ok"] and data["statements"][0]["tables"] == ["t"], (ok, data))
ok, data = mcp_call("knife_sql_schema", {"ddl": DDL, "dialect": "postgres"})
check("mcp call schema", ok and data["mermaid"].startswith("erDiagram") and len(data["schema"]["tables"]) == 2, (ok, data))
ok, data = mcp_call("knife_sql_compile", {"spec": spec, "dialect": "bigquery"})
check("mcp call compile (@name placeholders)", ok and data["sql"].startswith("SELECT u.id, u.name FROM users AS u WHERE LOWER(u.name) LIKE LOWER(@q)") and data["params"] == ["q"], (ok, data))
ok, data = mcp_call("knife_sql_check", {"sql": "SELECT nme FROM users", "dialect": "postgres", "schema": SCHEMA})
check("mcp call check", ok and data["ok"] is False and "Did you mean 'name'" in data["issues"][0]["message"], (ok, data))
ok, data = mcp_call("knife_sql_compile", {"spec": having_sum, "dialect": "tsql"})
check("mcp tools/call knife_sql_compile: aggregate expression in having", ok and data["sql"] == "SELECT status FROM orders GROUP BY status HAVING SUM(total) > 100", data)
ok, data = mcp_call("knife_sql_compile", {"spec": lower_where, "dialect": "tsql"})
check("mcp tools/call knife_sql_compile: expr condition", ok and data["sql"] == "SELECT * FROM users WHERE LOWER(name) = @p", data)
ok, data = mcp_call("knife_sql_compile", {"spec": {"op": "select", "from": "t", "limit": -1}, "dialect": "sqlite"})
check("mcp call compile failure -> isError with the field path", not ok and "spec.limit: expected a non-negative integer" in data, (ok, data))
ok, data = mcp_call("knife_sql_format", {"sql": "select 1", "dialect": "klingon"})
check("mcp call with an invalid dialect -> isError", not ok, (ok, data))
ok, data = mcp_call("knife_sql_format", {"sql": "select 1", "dialect": "sqlite", "extra": 1})
check("mcp call with an extra key -> isError", not ok, (ok, data))

print(f"\n{passed}/{passed + len(failures)} passed, {len(failures)} failed")
if failures:
    print("FAILED:\n  " + "\n  ".join(failures))
    sys.exit(1)
