"""transpile + validate helpers: dialect conversion with loss reporting, per-statement table/column info."""
from __future__ import annotations

import re
from typing import Any

from sqlglot import exp

from .common import Issue, generate, issue, join_statements, mariadb_note
from .semantic import missing_functions, prepare

def statement_kind(statement: exp.Expression) -> str:
    if isinstance(statement, exp.Create):
        return "create_" + str(statement.args.get("kind") or "object").lower()
    if isinstance(statement, exp.Drop):
        return "drop_" + str(statement.args.get("kind") or "object").lower()
    if isinstance(statement, exp.Alter):
        return "alter_" + str(statement.args.get("kind") or "table").lower()
    if isinstance(statement, exp.Query) and not isinstance(statement, exp.Select):
        return "select"
    return statement.key


def statement_info(statement: exp.Expression) -> tuple[dict[str, Any], list[Issue]]:
    cte_names = {c.alias.lower() for c in statement.find_all(exp.CTE)}
    tables: list[str] = []
    for table in statement.find_all(exp.Table):
        if not table.name or (not table.db and table.name.lower() in cte_names):
            continue
        qualified = ".".join(p for p in (table.catalog, table.db, table.name) if p)
        if qualified not in tables:
            tables.append(qualified)
    columns: list[str] = []
    for column in statement.find_all(exp.Column):
        if isinstance(column.this, exp.Star):
            continue
        text = ".".join(p for p in (column.table, column.name) if p)
        if text not in columns:
            columns.append(text)
    for definition in statement.find_all(exp.ColumnDef):
        if definition.name not in columns:
            columns.append(definition.name)
    warnings: list[Issue] = []
    if isinstance(statement, (exp.Update, exp.Delete)) and statement.args.get("where") is None:
        verb = "UPDATE" if isinstance(statement, exp.Update) else "DELETE"
        warnings.append(issue(f"{verb} without WHERE affects every row.", "warning"))
    return {"kind": statement_kind(statement), "tables": tables, "columns": columns}, warnings


def _unsupported_issue(message: str) -> Issue:
    """sqlglot's "not supported" notes: a dropped argument ("Argument 'format' is not supported for expression 'ToChar'") silently changes the result, everything else is an approximation."""
    if re.match(r"Argument '[^']+' is not supported for expression", message):
        return issue(f"{message} (the argument was dropped, so the converted SQL returns something different)", "error")
    return issue(message, "warning")


def transpile_statements(statements: list[exp.Expression], source: str, target: str, pretty: bool) -> dict[str, Any]:
    issues: list[Issue] = []
    rendered: list[str] = []
    for statement in statements:
        before: list[exp.Expression] = []
        statement, semantic = prepare(statement, source, target, before)
        issues.extend(semantic)
        rendered.extend(generate(extra, target, pretty)[0] for extra in before)
        sql, unsupported = generate(statement, target, pretty)
        if target == "tsql" and isinstance(statement, exp.Merge) and len(statements) == 1:
            sql += ";"  # T-SQL rejects an unterminated MERGE (error 10713); several statements get their `;` from join_statements
        rendered.append(sql)
        issues.extend(_unsupported_issue(message.rstrip(".")) for message in unsupported)
        issues.extend(missing_functions(sql, target))
    for dialect, role in ((source, "source"), (target, "target")):
        note = mariadb_note(dialect, f"the {role} is handled as MySQL, so MariaDB-only syntax is not recognised or generated.")
        if note:
            issues.append(note)
    seen: set[str] = set()
    unique = [i for i in issues if not (i["message"] in seen or seen.add(i["message"]))]
    return {"sql": join_statements(rendered, pretty), "issues": unique}
