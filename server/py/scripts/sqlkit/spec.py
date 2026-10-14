"""QuerySpec validation (mirrors the zod schema in src/lib/sql/types.ts, with messages that name the bad field)."""
from __future__ import annotations

import math
import re
from typing import Any

from .common import SqlToolError

COMPARISON_OPS = ("=", "!=", "<", "<=", ">", ">=", "like", "ilike", "in", "not in", "between", "is null", "is not null")
AGGREGATES = ("count", "sum", "avg", "min", "max")
JOIN_TYPES = ("inner", "left", "right", "full", "cross")
FK_ACTIONS = ("cascade", "restrict", "set null", "no action")
OPS = ("select", "insert", "update", "delete", "create_table")
MAX_DEPTH = 40

PARAM_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
FN_RE = re.compile(r"^(?:[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?|\+|-|\*|/|%|\|\|)$")
# Identifier text for names: anything printable except characters that could only be an attempt at an expression.
_BAD_NAME_CHARS = set("();,'`\\\x00\n\r\t")


class SpecError(SqlToolError):
    pass


def fail(path: str, message: str) -> None:
    raise SpecError(f"{path}: {message}")


def _keys(obj: Any, path: str, allowed: set[str], required: tuple[str, ...] = ()) -> dict[str, Any]:
    if not isinstance(obj, dict):
        fail(path, f"expected an object, got {type(obj).__name__}.")
    for key in obj:
        if key not in allowed:
            fail(f"{path}.{key}", f"unknown field. Allowed here: {', '.join(sorted(allowed))}.")
    for key in required:
        if key not in obj:
            fail(path, f"missing required field '{key}'.")
    return obj


def check_name(value: Any, path: str, *, star: bool = False, dotted: bool = False) -> None:
    if not isinstance(value, str) or not value.strip():
        fail(path, "expected a non-empty string.")
    parts = value.split(".") if dotted else [value]
    if len(parts) > 3:
        fail(path, f"'{value}' has too many dot-separated parts (max schema.table.column).")
    for part in parts:
        if not part.strip():
            fail(path, f"'{value}' has an empty name part.")
        if star and part == "*":
            continue
        if _BAD_NAME_CHARS & set(part) or "--" in part or '"' in part:
            fail(path, f"'{value}' is not an identifier. Use {{fn}}/{{expr}} for expressions; names cannot contain quotes, parentheses, semicolons or commas.")


def check_value(value: Any, path: str, depth: int = 0) -> None:
    if depth > MAX_DEPTH:
        fail(path, "nested too deeply.")
    if value is None or isinstance(value, (str, bool)):
        return
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            fail(path, "numbers must be finite.")
        return
    if not isinstance(value, dict):
        fail(path, f"expected a string, number, boolean, null, {{param}}, {{col}} or {{fn}}; got {type(value).__name__}.")
    if "param" in value:
        _keys(value, path, {"param"})
        if not isinstance(value["param"], str) or not PARAM_RE.match(value["param"]):
            fail(f"{path}.param", "parameter names must match [A-Za-z_][A-Za-z0-9_]*.")
    elif "col" in value:
        _keys(value, path, {"col"})
        check_name(value["col"], f"{path}.col", star=True, dotted=True)
    elif "fn" in value:
        _keys(value, path, {"fn", "args", "distinct"})
        if not isinstance(value["fn"], str) or not FN_RE.match(value["fn"]):
            fail(f"{path}.fn", f"'{value['fn']}' is not a function name (letters/digits/underscore, or one of + - * / % ||).")
        if "distinct" in value:
            if not isinstance(value["distinct"], bool):
                fail(f"{path}.distinct", "expected a boolean.")
            if value["distinct"] and (value["fn"].lower() not in AGGREGATES or len(value.get("args", [])) != 1):
                fail(f"{path}.distinct", f"'distinct' needs an aggregate fn ({', '.join(AGGREGATES)}) with exactly one arg, e.g. {{fn: 'count', args: [{{col: 'x'}}], distinct: true}}.")
        args = value.get("args", [])
        if not isinstance(args, list):
            fail(f"{path}.args", "expected an array.")
        for i, arg in enumerate(args):
            check_value(arg, f"{path}.args[{i}]", depth + 1)
    else:
        fail(path, "expected a literal or one of {param}, {col}, {fn, args}.")


def aggregate_in(value: Any) -> str | None:
    """Name of the first aggregate function used anywhere inside a (valid) value, else None."""
    if isinstance(value, dict) and "fn" in value:
        if str(value["fn"]).lower() in AGGREGATES:
            return str(value["fn"])
        for arg in value.get("args", []):
            found = aggregate_in(arg)
            if found:
                return found
    return None


def condition_has_aggregate(cond: Any) -> bool:
    if not isinstance(cond, dict):
        return False
    for combo in ("and", "or"):
        if combo in cond:
            return any(condition_has_aggregate(item) for item in cond[combo])
    if "not" in cond:
        return condition_has_aggregate(cond["not"])
    items = [cond.get("expr")] + (cond["value"] if isinstance(cond.get("value"), list) else [cond.get("value")])
    return any(aggregate_in(item) for item in items)


def check_condition(cond: Any, path: str, depth: int = 0, clause: str = "where") -> None:
    """`clause` names where the condition sits ('having' allows aggregates; where/on/update/delete conditions do not)."""
    if depth > MAX_DEPTH:
        fail(path, "conditions are nested too deeply.")
    if not isinstance(cond, dict):
        fail(path, f"expected a condition object, got {type(cond).__name__}.")
    for combo in ("and", "or"):
        if combo in cond:
            _keys(cond, path, {combo})
            items = cond[combo]
            if not isinstance(items, list) or not items:
                fail(f"{path}.{combo}", "needs a non-empty array of conditions.")
            for i, item in enumerate(items):
                check_condition(item, f"{path}.{combo}[{i}]", depth + 1, clause)
            return
    if "not" in cond:
        _keys(cond, path, {"not"})
        check_condition(cond["not"], f"{path}.not", depth + 1, clause)
        return
    if "col" not in cond and "expr" not in cond and "op" not in cond:
        fail(path, "expected {and: [...]}, {or: [...]}, {not: cond}, {col, op, value} or {expr, op, value}.")
    _keys(cond, path, {"col", "expr", "op", "value"}, ("op",))
    if "col" in cond and "expr" in cond:
        fail(path, "give either 'col' (a column name) or 'expr' (a value/function such as {fn: 'lower', args: [{col: 'name'}]}), not both.")
    if "col" in cond:
        check_name(cond["col"], f"{path}.col", dotted=True)
    elif "expr" in cond:
        check_value(cond["expr"], f"{path}.expr")
    else:
        fail(path, "missing required field 'col' (a column name) or 'expr' (an expression).")
    op = cond["op"]
    if not isinstance(op, str) or op.lower() not in COMPARISON_OPS:
        fail(f"{path}.op", f"unknown operator {op!r}. Allowed: {', '.join(COMPARISON_OPS)}.")
    op = op.lower()
    has_value = "value" in cond
    value = cond.get("value")
    if op in ("is null", "is not null"):
        if has_value:
            fail(f"{path}.value", f"operator '{op}' takes no value.")
    elif op in ("in", "not in"):
        if not isinstance(value, list) or not value:
            fail(f"{path}.value", f"operator '{op}' needs a non-empty array of values.")
        for i, item in enumerate(value):
            check_value(item, f"{path}.value[{i}]")
    elif op == "between":
        if not isinstance(value, list) or len(value) != 2:
            fail(f"{path}.value", "operator 'between' needs exactly two values [low, high].")
        for i, item in enumerate(value):
            check_value(item, f"{path}.value[{i}]")
    else:
        if not has_value:
            fail(f"{path}.value", f"operator '{op}' needs a value.")
        if isinstance(value, list):
            fail(f"{path}.value", f"operator '{op}' takes a single value, not an array (use 'in').")
        check_value(value, f"{path}.value")
    if clause != "having":
        for key, item in (("expr", cond.get("expr")), ("value", value)):
            for one in (item if isinstance(item, list) else [item]):
                found = aggregate_in(one)
                if found:
                    fail(f"{path}.{key}", f"aggregate '{found}' is not allowed in {clause} (SQL evaluates it before grouping): put the condition in 'having'.")


def check_table_ref(ref: Any, path: str) -> None:
    if isinstance(ref, str):
        check_name(ref, path, dotted=True)
        return
    _keys(ref, path, {"name", "as"}, ("name",))
    check_name(ref["name"], f"{path}.name", dotted=True)
    if "as" in ref:
        check_name(ref["as"], f"{path}.as")


def _check_returning(spec: dict[str, Any], path: str) -> None:
    if "returning" in spec:
        items = spec["returning"]
        if not isinstance(items, list) or not items:
            fail(f"{path}.returning", "expected a non-empty array of column names.")
        for i, name in enumerate(items):
            check_name(name, f"{path}.returning[{i}]", star=True)


def check_select(spec: Any, path: str, depth: int = 0) -> None:
    if depth > 8:
        fail(path, "CTEs are nested too deeply.")
    _keys(spec, path, {"op", "from", "columns", "distinct", "joins", "where", "groupBy", "having", "orderBy", "limit", "offset", "ctes"}, ("op", "from"))
    check_table_ref(spec["from"], f"{path}.from")
    for i, col in enumerate(spec.get("columns", [])):
        cpath = f"{path}.columns[{i}]"
        if isinstance(col, str):
            check_name(col, cpath, star=True, dotted=True)
            continue
        _keys(col, cpath, {"expr", "as", "agg", "distinct"}, ("expr",))
        check_value(col["expr"], f"{cpath}.expr")
        if "agg" in col and isinstance(col["expr"], dict) and str(col["expr"].get("fn", "")).lower() in AGGREGATES:
            fail(f"{cpath}.expr", f"'{col['expr']['fn']}' is already an aggregate: drop 'agg' or use a plain {{col}} here.")
        if "as" in col:
            check_name(col["as"], f"{cpath}.as")
        if "agg" in col and col["agg"] not in AGGREGATES:
            fail(f"{cpath}.agg", f"unknown aggregate {col['agg']!r}. Allowed: {', '.join(AGGREGATES)}.")
        if col.get("distinct") is not None and not isinstance(col["distinct"], bool):
            fail(f"{cpath}.distinct", "expected a boolean.")
        if col.get("distinct") and "agg" not in col:
            fail(f"{cpath}.distinct", "'distinct' only applies together with 'agg' (use select.distinct for SELECT DISTINCT).")
    if "columns" in spec and not isinstance(spec["columns"], list):
        fail(f"{path}.columns", "expected an array.")
    for i, join in enumerate(spec.get("joins", [])):
        jpath = f"{path}.joins[{i}]"
        _keys(join, jpath, {"type", "table", "on"}, ("table",))
        jtype = join.get("type", "inner")
        if jtype not in JOIN_TYPES:
            fail(f"{jpath}.type", f"unknown join type {jtype!r}. Allowed: {', '.join(JOIN_TYPES)}.")
        check_table_ref(join["table"], f"{jpath}.table")
        if "on" in join:
            check_condition(join["on"], f"{jpath}.on", clause="a join condition")
        if jtype == "cross" and "on" in join:
            fail(f"{jpath}.on", "a cross join has no ON condition.")
        if jtype != "cross" and "on" not in join:
            fail(jpath, f"a {jtype} join needs 'on' (use type 'cross' for a cartesian product).")
    for key in ("where", "having"):
        if key in spec:
            check_condition(spec[key], f"{path}.{key}", clause=key)
    for i, item in enumerate(spec.get("groupBy", [])):
        check_value(item, f"{path}.groupBy[{i}]")
    for i, order in enumerate(spec.get("orderBy", [])):
        opath = f"{path}.orderBy[{i}]"
        _keys(order, opath, {"expr", "dir", "nulls"}, ("expr",))
        check_value(order["expr"], f"{opath}.expr")
        if "dir" in order and order["dir"] not in ("asc", "desc"):
            fail(f"{opath}.dir", "expected 'asc' or 'desc'.")
        if "nulls" in order and order["nulls"] not in ("first", "last"):
            fail(f"{opath}.nulls", "expected 'first' or 'last'.")
    for key in ("limit", "offset"):
        if key in spec and (not isinstance(spec[key], int) or isinstance(spec[key], bool) or spec[key] < 0):
            fail(f"{path}.{key}", "expected a non-negative integer.")
    if "offset" in spec and "limit" not in spec:
        fail(f"{path}.offset", "'offset' needs 'limit' (OFFSET without LIMIT is not portable).")
    if "having" in spec and "groupBy" not in spec and not any(isinstance(c, dict) and "agg" in c for c in spec.get("columns", [])) and not condition_has_aggregate(spec["having"]):
        fail(f"{path}.having", "HAVING needs groupBy, an aggregate column or an aggregate expression ({expr: {fn: 'sum', args: [...]}, op, value}).")
    names: set[str] = set()
    for i, cte in enumerate(spec.get("ctes", [])):
        cpath = f"{path}.ctes[{i}]"
        _keys(cte, cpath, {"name", "query"}, ("name", "query"))
        check_name(cte["name"], f"{cpath}.name")
        if cte["name"].lower() in names:
            fail(f"{cpath}.name", f"duplicate CTE name '{cte['name']}'.")
        names.add(cte["name"].lower())
        check_select(cte["query"], f"{cpath}.query", depth + 1)
        if cte["query"].get("op") != "select":
            fail(f"{cpath}.query.op", "a CTE query must be a select.")


def check_spec(spec: Any) -> None:
    if not isinstance(spec, dict):
        fail("spec", "expected an object.")
    op = spec.get("op")
    if op not in OPS:
        fail("spec.op", f"unknown op {op!r}. Allowed: {', '.join(OPS)}.")
    if op == "select":
        check_select(spec, "spec")
    elif op == "insert":
        _keys(spec, "spec", {"op", "table", "columns", "rows", "onConflict", "returning"}, ("op", "table", "columns", "rows"))
        check_name(spec["table"], "spec.table", dotted=True)
        columns = spec["columns"]
        if not isinstance(columns, list) or not columns:
            fail("spec.columns", "expected a non-empty array of column names.")
        for i, name in enumerate(columns):
            check_name(name, f"spec.columns[{i}]")
        if len({str(c).lower() for c in columns}) != len(columns):
            fail("spec.columns", "duplicate column names.")
        rows = spec["rows"]
        if not isinstance(rows, list) or not rows:
            fail("spec.rows", "expected a non-empty array of rows.")
        for r, row in enumerate(rows):
            if not isinstance(row, list):
                fail(f"spec.rows[{r}]", "each row must be an array of values.")
            if len(row) != len(columns):
                fail(f"spec.rows[{r}]", f"has {len(row)} values but there are {len(columns)} columns.")
            for c, value in enumerate(row):
                check_value(value, f"spec.rows[{r}][{c}]")
        if "onConflict" in spec:
            conflict = _keys(spec["onConflict"], "spec.onConflict", {"target", "action", "set"}, ("target", "action"))
            target = conflict["target"]
            if not isinstance(target, list) or not target:
                fail("spec.onConflict.target", "expected a non-empty array of column names.")
            for i, name in enumerate(target):
                check_name(name, f"spec.onConflict.target[{i}]")
            if conflict["action"] not in ("nothing", "update"):
                fail("spec.onConflict.action", "expected 'nothing' or 'update'.")
            if "set" in conflict:
                if conflict["action"] != "update":
                    fail("spec.onConflict.set", "'set' only applies to action 'update'.")
                _check_set(conflict["set"], "spec.onConflict.set")
        _check_returning(spec, "spec")
    elif op == "update":
        _keys(spec, "spec", {"op", "table", "set", "where", "returning"}, ("op", "table", "set"))
        check_name(spec["table"], "spec.table", dotted=True)
        _check_set(spec["set"], "spec.set")
        if not spec["set"]:
            fail("spec.set", "needs at least one column.")
        if "where" in spec:
            check_condition(spec["where"], "spec.where", clause="where")
        _check_returning(spec, "spec")
    elif op == "delete":
        _keys(spec, "spec", {"op", "table", "where", "returning"}, ("op", "table"))
        check_name(spec["table"], "spec.table", dotted=True)
        if "where" in spec:
            check_condition(spec["where"], "spec.where", clause="where")
        _check_returning(spec, "spec")
    else:
        _check_create(spec)


def _check_set(value: Any, path: str) -> None:
    if not isinstance(value, dict):
        fail(path, "expected an object of column -> value.")
    for key, item in value.items():
        check_name(key, f"{path}.{key}")
        check_value(item, f"{path}.{key}")


def _check_create(spec: dict[str, Any]) -> None:
    _keys(spec, "spec", {"op", "name", "ifNotExists", "columns", "primaryKey"}, ("op", "name", "columns"))
    check_name(spec["name"], "spec.name", dotted=True)
    columns = spec["columns"]
    if not isinstance(columns, list) or not columns:
        fail("spec.columns", "expected a non-empty array of column definitions.")
    seen: set[str] = set()
    for i, col in enumerate(columns):
        path = f"spec.columns[{i}]"
        _keys(col, path, {"name", "type", "nullable", "default", "primaryKey", "unique", "references", "autoIncrement"}, ("name", "type"))
        check_name(col["name"], f"{path}.name")
        if col["name"].lower() in seen:
            fail(f"{path}.name", f"duplicate column '{col['name']}'.")
        seen.add(col["name"].lower())
        if not isinstance(col["type"], str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_ ]*(\(\s*\d+\s*(,\s*\d+\s*)?\))?", col["type"].strip()):
            fail(f"{path}.type", f"{col['type']!r} is not a portable type name like integer, text, varchar(80), numeric(10,2).")
        for flag in ("nullable", "primaryKey", "unique", "autoIncrement"):
            if flag in col and not isinstance(col[flag], bool):
                fail(f"{path}.{flag}", "expected a boolean.")
        if "default" in col:
            check_value(col["default"], f"{path}.default")
        if "references" in col:
            ref = _keys(col["references"], f"{path}.references", {"table", "column", "onDelete"}, ("table", "column"))
            check_name(ref["table"], f"{path}.references.table", dotted=True)
            check_name(ref["column"], f"{path}.references.column")
            if "onDelete" in ref and ref["onDelete"] not in FK_ACTIONS:
                fail(f"{path}.references.onDelete", f"expected one of {', '.join(FK_ACTIONS)}.")
    if "primaryKey" in spec:
        pk = spec["primaryKey"]
        if not isinstance(pk, list) or not pk:
            fail("spec.primaryKey", "expected a non-empty array of column names.")
        for i, name in enumerate(pk):
            check_name(name, f"spec.primaryKey[{i}]")
            if str(name).lower() not in seen:
                fail(f"spec.primaryKey[{i}]", f"'{name}' is not a column of this table.")
