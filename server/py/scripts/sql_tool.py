#!/usr/bin/env python3
"""SQL engine (sqlglot). Usage: sql_tool.py request.json response.json

Request  {"action": "format|transpile|validate|schema|compile|check", "params": {...}}
Response {"ok": true, "data": ...} | {"ok": false, "error": "..."}   (shapes: src/lib/sql/types.ts SqlActionMap)

Deterministic and offline: no database connection is ever opened. Statement separator convention: one
statement is returned without a trailing semicolon, several are each terminated with `;`.
"""
from __future__ import annotations

import json
import sys
from typing import Any

from sqlkit.check import check_sql
from sqlkit.common import (
    ParseFailure, SqlToolError, generate, issue, join_statements, mariadb_note, need_dialect, need_str, parse_statements,
)
from sqlkit.compile import compile_spec
from sqlkit.schema import build_schema, to_mermaid
from sqlkit.transpile import statement_info, transpile_statements


def do_format(params: dict[str, Any]) -> dict[str, Any]:
    sql, dialect = need_str(params, "sql"), need_dialect(params)
    try:
        statements = parse_statements(sql, dialect)
    except ParseFailure as failure:
        first = failure.issues[0]
        where = f" (line {first['line']}, column {first['column']})" if "line" in first and "column" in first else ""
        raise SqlToolError(f"Cannot format: {first['message']}{where}") from failure
    if not statements:
        raise SqlToolError("Cannot format: no SQL statements found.")
    return {"sql": join_statements([generate(s, dialect, True)[0] for s in statements], True)}


def do_transpile(params: dict[str, Any]) -> dict[str, Any]:
    sql = need_str(params, "sql")
    source, target = need_dialect(params, "from"), need_dialect(params, "to")
    pretty = bool(params.get("pretty"))
    try:
        statements = parse_statements(sql, source)
    except ParseFailure as failure:
        return {"sql": "", "issues": failure.issues}
    if not statements:
        return {"sql": "", "issues": [issue("No SQL statements found.")]}
    return transpile_statements(statements, source, target, pretty)


def do_validate(params: dict[str, Any]) -> dict[str, Any]:
    sql, dialect = need_str(params, "sql"), need_dialect(params)
    try:
        statements = parse_statements(sql, dialect)
    except ParseFailure as failure:
        return {"ok": False, "issues": failure.issues, "statements": []}
    issues = []
    if not statements:
        issues.append(issue("No SQL statements found."))
    infos = []
    for statement in statements:
        info, warnings = statement_info(statement)
        infos.append(info)
        issues.extend(warnings)
    note = mariadb_note(dialect, "parsed with the MySQL dialect.")
    if note:
        issues.append(note)
    return {"ok": not any(i["level"] == "error" for i in issues), "issues": issues, "statements": infos}


def do_schema(params: dict[str, Any]) -> dict[str, Any]:
    ddl, dialect = need_str(params, "ddl"), need_dialect(params)
    schema, issues = build_schema(ddl, dialect)
    return {"schema": schema, "mermaid": to_mermaid(schema), "issues": issues}


def do_compile(params: dict[str, Any]) -> dict[str, Any]:
    dialect = need_dialect(params)
    if "spec" not in params:
        raise SqlToolError("params.spec: missing.")
    return compile_spec(params["spec"], dialect, bool(params.get("pretty")))


def do_check(params: dict[str, Any]) -> dict[str, Any]:
    sql, dialect = need_str(params, "sql"), need_dialect(params)
    schema = params.get("schema")
    if not isinstance(schema, dict) or not isinstance(schema.get("tables"), list):
        raise SqlToolError("params.schema: expected { tables: [{ name, columns: [{ name }] }] }.")
    for index, table in enumerate(schema["tables"]):
        if not isinstance(table, dict) or not isinstance(table.get("name"), str) or not isinstance(table.get("columns"), list):
            raise SqlToolError(f"params.schema.tables[{index}]: expected { '{ name, columns }' }.")
        for cindex, col in enumerate(table["columns"]):
            if not isinstance(col, dict) or not isinstance(col.get("name"), str):
                raise SqlToolError(f"params.schema.tables[{index}].columns[{cindex}]: expected {{ name }}.")
    return check_sql(sql, dialect, schema)


ACTIONS = {
    "format": do_format, "transpile": do_transpile, "validate": do_validate,
    "schema": do_schema, "compile": do_compile, "check": do_check,
}


def run(request: Any) -> dict[str, Any]:
    if not isinstance(request, dict):
        return {"ok": False, "error": "Request must be an object { action, params }."}
    action, params = request.get("action"), request.get("params", {})
    handler = ACTIONS.get(action) if isinstance(action, str) else None
    if handler is None:
        return {"ok": False, "error": f"Unknown action {action!r}. Allowed: {', '.join(ACTIONS)}."}
    if not isinstance(params, dict):
        return {"ok": False, "error": "params must be an object."}
    try:
        return {"ok": True, "data": handler(params)}
    except SqlToolError as error:
        return {"ok": False, "error": str(error)}
    except RecursionError:
        return {"ok": False, "error": "The SQL or spec is nested too deeply to process."}
    except Exception as error:  # a sqlglot edge case must reach the caller as JSON, not a stack trace on stderr
        return {"ok": False, "error": f"SQL engine internal error ({type(error).__name__}): {error}"}


def main() -> None:
    req_path, resp_path = sys.argv[1], sys.argv[2]
    with open(req_path, encoding="utf-8") as fh:
        request = json.load(fh)
    result = run(request)
    with open(resp_path, "w", encoding="utf-8") as fh:
        json.dump(result, fh)


if __name__ == "__main__":
    main()
