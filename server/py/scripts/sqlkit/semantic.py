"""Pre-generation fixes for constructs sqlglot prints verbatim although the target engine rejects or changes them.

`prepare` returns a rewritten copy of the statement plus issues: "error" = the converted SQL will not run on the
target, "warning" = it runs but is an approximation (the caller should read it)."""
from __future__ import annotations

import re
import sqlite3
from pathlib import Path

import sqlglot
from sqlglot import exp

from .common import Issue, SqlToolError, generate, issue
from . import rewrites
from .compile import NATIVE_ILIKE, _MERGE_VALUES, _UPSERT_FAMILY, Ctx, _auto_increment, _merge_source, merge_node

_NATIVE_CONFLICT = {"sqlite", "postgres", "duckdb"}
_NATIVE_DUPLICATE = {"mysql", "mariadb"}
_SERIAL = {exp.DType.SERIAL: exp.DType.INT, exp.DType.BIGSERIAL: exp.DType.BIGINT, exp.DType.SMALLSERIAL: exp.DType.SMALLINT}
_INT_TYPES = {exp.DType.TINYINT, exp.DType.SMALLINT, exp.DType.MEDIUMINT, exp.DType.INT, exp.DType.BIGINT}
_NO_ARRAYS = {"sqlite", "mysql", "mariadb", "tsql", "oracle"}


def prepare(statement: exp.Expression, source: str, target: str, before: list[exp.Expression] | None = None) -> tuple[exp.Expression, list[Issue]]:
    """`before` collects statements that must run ahead of the converted one (DuckDB sequences for identity columns)."""
    statement = statement.copy()
    issues: list[Issue] = []
    statement = _upsert(statement, target, issues)
    _merge(statement, target, issues)
    _returning(statement, target, issues)
    _ilike(statement, target, issues)
    _identity(statement, target, issues, before if before is not None else [])
    _types(statement, target, issues)
    _dual(statement, target)
    statement = rewrites.apply(statement, source, target, issues)
    _dialect_only(statement, source, target, issues)
    _sqlite_dates(statement, target, issues)
    return statement, issues


# ---------------------------------------------------------------- upsert / returning

def _upsert(statement: exp.Expression, target: str, issues: list[Issue]) -> exp.Expression:
    conflict = statement.args.get("conflict") if isinstance(statement, exp.Insert) else None
    if conflict is None:
        return statement
    # sqlglot parses a conflict target as ORDER BY items (`ON CONFLICT (id NULLS FIRST)`), which no engine accepts.
    keys = conflict.args.get("conflict_keys") or []
    conflict.set("conflict_keys", [k.this.copy() if isinstance(k, exp.Ordered) else k for k in keys])
    duplicate = bool(conflict.args.get("duplicate"))
    if duplicate and target in _NATIVE_CONFLICT:
        issues.append(issue("ON DUPLICATE KEY UPDATE has no conflict target, but ON CONFLICT (cols) needs one: add the unique/primary key columns by hand.", "error"))
    elif not duplicate and target in _NATIVE_DUPLICATE:
        _to_duplicate_key(statement, conflict, issues)
    elif _UPSERT_FAMILY.get(target) == "merge":
        return _to_merge(statement, conflict, target, issues)
    elif target not in _NATIVE_CONFLICT | _NATIVE_DUPLICATE:
        issues.append(issue(f"{target} has neither ON CONFLICT, ON DUPLICATE KEY nor a MERGE this converter can write: run an UPDATE (where the key matches) and an INSERT separately.", "error"))
    return statement


def _to_merge(statement: exp.Insert, conflict: exp.OnConflict, target: str, issues: list[Issue]) -> exp.Expression:
    """INSERT ... VALUES ... ON CONFLICT (keys) DO UPDATE/NOTHING -> MERGE INTO t USING <rows> AS s ON <keys> WHEN ..."""
    def fail(message: str) -> exp.Expression:
        issues.append(issue(message, "error"))
        return statement

    if conflict.args.get("duplicate"):
        return fail(f"ON DUPLICATE KEY UPDATE has no conflict target, but MERGE needs the key columns: give them by hand ({target} has no ON DUPLICATE KEY).")
    schema, values = statement.this, statement.expression
    if not isinstance(schema, exp.Schema) or not schema.expressions:
        return fail("An upsert needs an explicit column list (INSERT INTO t (a, b) VALUES ...) to be rewritten as MERGE.")
    if not isinstance(values, exp.Values):
        return fail("Only INSERT ... VALUES upserts can be rewritten as MERGE automatically; INSERT ... SELECT ... ON CONFLICT needs a hand-written MERGE.")
    if conflict.args.get("where") is not None or conflict.args.get("constraint") is not None or not conflict.args.get("conflict_keys"):
        return fail("ON CONFLICT without a plain column target (ON CONSTRAINT / WHERE) cannot be rewritten as MERGE automatically.")
    ctx = Ctx(target)
    columns = [c.name for c in schema.expressions]
    rows = [[v.copy() for v in (row.expressions if isinstance(row, exp.Tuple) else [row])] for row in values.expressions]
    keys = [k.name for k in conflict.args["conflict_keys"]]
    assignments: list[tuple[str, exp.Expression]] | None = None
    if "NOTHING" not in str(conflict.args.get("action") or "").upper():
        assignments = []
        for item in conflict.args.get("expressions") or []:
            if not isinstance(item, exp.EQ) or not isinstance(item.this, exp.Column):
                return fail("ON CONFLICT DO UPDATE SET has an assignment this converter cannot rewrite as MERGE.")
            assignments.append((item.this.name, item.expression.copy()))
        if not assignments:
            return fail("ON CONFLICT DO UPDATE has no SET list.")
    try:
        merge = merge_node(ctx, schema.this.copy(), columns, rows, keys, assignments)
    except SqlToolError as error:
        return fail(str(error))
    returning = statement.args.get("returning")
    if returning is not None:
        merge.set("returning", returning.copy())
    issues.extend(ctx.issues)
    return merge


def _merge(statement: exp.Expression, target: str, issues: list[Issue]) -> None:
    """MERGE statements (any source dialect) printed for engines whose MERGE needs a different shape than sqlglot prints."""
    if not isinstance(statement, exp.Merge):
        return
    on = statement.args.get("on")
    if target == "oracle" and on is not None and not isinstance(on, exp.Paren):
        statement.set("on", exp.Paren(this=on.copy()))  # Oracle requires ON (condition)
    using = statement.args.get("using")
    if target not in _MERGE_VALUES | {"postgres", "duckdb"} and isinstance(using, exp.Values):
        alias = using.args.get("alias")
        columns = [c.name for c in alias.columns] if alias is not None and alias.columns else []
        rows = [[v.copy() for v in (row.expressions if isinstance(row, exp.Tuple) else [row])] for row in using.expressions]
        if not columns:
            issues.append(issue(f"{target} has no usable VALUES table in MERGE ... USING and the VALUES list has no column names (AS s(a, b)) to build a SELECT ... UNION ALL source from.", "error"))
        elif target in _UPSERT_FAMILY:
            statement.set("using", _merge_source(Ctx(target), columns, rows, alias.name or "s"))
    if target in ("mysql", "mariadb", "sqlite", "clickhouse"):
        issues.append(issue(f"{target} has no MERGE statement: rewrite as INSERT ... ON DUPLICATE KEY / ON CONFLICT or separate UPDATE and INSERT statements.", "error"))


def _to_duplicate_key(statement: exp.Insert, conflict: exp.OnConflict, issues: list[Issue]) -> None:
    keys = conflict.args.get("conflict_keys") or []
    node = exp.OnConflict(duplicate=True, action=exp.var("UPDATE"))
    if "NOTHING" in str(conflict.args.get("action") or "").upper():
        first = keys[0].copy() if keys else exp.column("id")
        node.set("expressions", [exp.EQ(this=first, expression=first.copy())])
        issues.append(issue("ON CONFLICT DO NOTHING became a no-op ON DUPLICATE KEY UPDATE (col = col): MySQL has no DO NOTHING (INSERT IGNORE also swallows other errors).", "warning"))
    else:
        assignments = []
        for item in conflict.args.get("expressions") or []:
            if isinstance(item, exp.EQ):
                right = item.expression.copy().transform(_excluded_to_values)
                assignments.append(exp.EQ(this=item.this.copy(), expression=right))
        node.set("expressions", assignments)
        issues.append(issue("ON CONFLICT (cols) DO UPDATE became ON DUPLICATE KEY UPDATE: MySQL fires on ANY unique key, not only the conflict target.", "warning"))
    statement.set("conflict", node)


def _excluded_to_values(node: exp.Expression) -> exp.Expression:
    if isinstance(node, exp.Column) and node.table.lower() == "excluded":
        return exp.Anonymous(this="VALUES", expressions=[exp.Identifier(this=node.name, quoted=node.this.args.get("quoted", False))])
    return node


_OUTPUT_PREFIXES = {"inserted", "deleted"}


def _alternative(statement: exp.Expression, target: str) -> str:
    bare = statement.copy()
    bare.set("returning", None)
    return generate(bare, target)[0]


def _returning(statement: exp.Expression, target: str, issues: list[Issue]) -> None:
    if not isinstance(statement, (exp.Insert, exp.Update, exp.Delete, exp.Merge)) or statement.args.get("returning") is None:
        return
    returning = statement.args["returning"]
    deleting = isinstance(statement, exp.Delete)
    if target == "tsql":
        # OUTPUT columns need the inserted. (row after INSERT/UPDATE/MERGE) or deleted. (row removed by DELETE) prefix; sqlglot leaves bare names.
        prefix = "deleted" if deleting else "inserted"
        items: list[exp.Expression] = []
        for item in returning.expressions:
            if isinstance(item, exp.Star):
                item = exp.Column(this=exp.Star(), table=exp.to_identifier(prefix))
            for col in ([item] if isinstance(item, exp.Column) else list(item.find_all(exp.Column))):
                if col.table.lower() not in _OUTPUT_PREFIXES:
                    col.set("table", exp.to_identifier(prefix))
            items.append(item)
        returning.set("expressions", items)
        issues.append(issue("T-SQL OUTPUT without INTO is rejected for tables with enabled triggers (error 334): use OUTPUT ... INTO @table_variable there.", "warning"))
        return
    if target in ("postgres", "sqlite", "duckdb", "mariadb") and not (target == "mariadb" and isinstance(statement, exp.Update)):
        old = False
        for col in list(returning.find_all(exp.Column)):
            if col.table.lower() in _OUTPUT_PREFIXES:
                old = old or (col.table.lower() == "deleted" and not deleting)
                col.set("table", None)
        if old:
            issues.append(issue(f"OUTPUT deleted.x returns the value before the UPDATE; {target} RETURNING only returns the new row, so those columns now show new values.", "warning"))
        if target == "mariadb":
            issues.append(issue("MariaDB supports INSERT ... RETURNING from 10.5 and DELETE ... RETURNING from 10.0; UPDATE ... RETURNING does not exist.", "warning"))
        return
    for col in list(returning.find_all(exp.Column)):
        if col.table.lower() in _OUTPUT_PREFIXES:
            col.set("table", None)
    alternative = _alternative(statement, target)
    if target == "mariadb":
        issues.append(issue(f"MariaDB has no UPDATE ... RETURNING: run the update, then SELECT the rows. Without it: {alternative}", "error"))
    elif target == "oracle":
        issues.append(issue(f"Oracle RETURNING needs INTO variables (RETURNING col INTO :out in PL/SQL or with an OUT bind in your driver): the plain clause is not valid in a standalone statement. Without it: {alternative}", "error"))
    else:
        issues.append(issue(f"{target} has no RETURNING clause; run the statement, then SELECT the rows. Without it: {alternative}", "error"))


# ---------------------------------------------------------------- ILIKE

def _ilike(statement: exp.Expression, target: str, issues: list[Issue]) -> None:
    if target in NATIVE_ILIKE:
        return
    nodes = list(statement.find_all(exp.ILike))
    for node in nodes:
        node.replace(exp.Like(this=exp.Lower(this=node.this.copy()), expression=exp.Lower(this=node.expression.copy())))
    if nodes:
        issues.append(issue("ILIKE is emulated as LOWER(x) LIKE LOWER(y): case folding is ASCII-only in some engines.", "warning"))


# ---------------------------------------------------------------- identity / serial columns

def _identity(statement: exp.Expression, target: str, issues: list[Issue], before: list[exp.Expression]) -> None:
    if target in ("postgres", "redshift"):
        return
    ctx = Ctx(target)
    for definition in list(statement.find_all(exp.ColumnDef)):
        kind = definition.args.get("kind")
        constraints = list(definition.args.get("constraints") or [])
        serial = isinstance(kind, exp.DataType) and kind.this in _SERIAL
        identity = [c for c in constraints if isinstance(c.args.get("kind"), (exp.GeneratedAsIdentityColumnConstraint, exp.AutoIncrementColumnConstraint)) and not c.args["kind"].args.get("expression")]
        if not serial and not identity:
            continue
        if serial:
            definition.set("kind", exp.DataType(this=_SERIAL[kind.this]))
        table = statement.this.this if isinstance(statement, exp.Create) and isinstance(statement.this, exp.Schema) else None
        try:
            native = _auto_increment(ctx, ".".join(p for p in (table.db, table.name) if p) if table is not None else None, definition.name, bool(statement.args.get("exists")))
        except SqlToolError as error:
            issues.append(issue(f"Column '{definition.name}': {error}", "error"))
            continue
        constraints = [c for c in constraints if c not in identity]
        marker = exp.ColumnConstraint(kind=native)
        if target == "sqlite":
            definition.set("kind", exp.DataType.build("integer"))
            if not any(isinstance(c.args.get("kind"), exp.PrimaryKeyColumnConstraint) for c in constraints):
                issues.append(issue(f"Column '{definition.name}': SQLite AUTOINCREMENT needs the column to be the table's PRIMARY KEY.", "error"))
            constraints = constraints + [exp.ColumnConstraint(kind=exp.AutoIncrementColumnConstraint())]
        else:
            constraints = [marker] + constraints
        definition.set("constraints", constraints)
    before.extend(ctx.prelude)
    issues.extend(ctx.issues)


# ---------------------------------------------------------------- column types

def _types(statement: exp.Expression, target: str, issues: list[Issue]) -> None:
    if target not in ("tsql", "redshift"):
        for dtype in statement.find_all(exp.DataType):  # VARCHAR(MAX) / VARBINARY(MAX) exist only on SQL Server (and Redshift)
            if any(isinstance(p, exp.DataTypeParam) and p.this.name.upper() == "MAX" for p in dtype.expressions):
                dtype.set("expressions", None)
    for definition in list(statement.find_all(exp.ColumnDef)):
        dtype = definition.args.get("kind")
        if not isinstance(dtype, exp.DataType):
            continue
        name = definition.name
        if target == "tsql" and dtype.this in (exp.DType.JSON, exp.DType.JSONB):
            definition.set("kind", exp.DataType.build("nvarchar(max)", dialect="tsql"))
            issues.append(issue(f"Column '{name}': T-SQL has no JSON type; stored as NVARCHAR(MAX) (use ISJSON/JSON_VALUE).", "warning"))
        elif dtype.this == exp.DType.JSONB and target not in ("postgres", "redshift", "duckdb"):
            dtype.set("this", exp.DType.JSON)
        elif target == "oracle" and dtype.this == exp.DType.BOOLEAN:
            definition.set("kind", exp.DataType.build("number(1)"))
            issues.append(issue(f"Column '{name}': Oracle before 23ai has no BOOLEAN; converted to NUMBER(1) holding 0/1.", "warning"))
        elif target in ("mysql", "mariadb") and dtype.this == exp.DType.VARBINARY and not dtype.expressions:
            definition.set("kind", exp.DataType(this=exp.DType.BLOB))
            issues.append(issue(f"Column '{name}': MySQL VARBINARY needs a length; converted to BLOB.", "warning"))
        elif target in ("mysql", "mariadb") and dtype.this == exp.DType.VARCHAR and not dtype.expressions:
            definition.set("kind", exp.DataType.build("text"))
            issues.append(issue(f"Column '{name}': MySQL VARCHAR needs a length; converted to TEXT.", "warning"))
        elif target not in ("mysql", "mariadb") and dtype.this in _INT_TYPES and dtype.expressions:
            width = dtype.expressions[0].this.name if isinstance(dtype.expressions[0], exp.DataTypeParam) else ""
            if dtype.this == exp.DType.TINYINT and width == "1":
                definition.set("kind", exp.DataType(this=exp.DType.BOOLEAN))
                issues.append(issue(f"Column '{name}': MySQL TINYINT(1) is the boolean idiom; converted to BOOLEAN.", "warning"))
            else:
                dtype.set("expressions", None)


# ---------------------------------------------------------------- FROM dual

def _dual(statement: exp.Expression, target: str) -> None:
    for select in statement.find_all(exp.Select):
        from_ = select.args.get("from_")
        if target == "oracle" and from_ is None and not select.args.get("with_"):
            select.set("from_", exp.From(this=exp.to_table("DUAL")))
        elif target not in ("oracle", "mysql", "mariadb") and from_ is not None and isinstance(from_.this, exp.Table) and from_.this.name.lower() == "dual" and not from_.this.db:
            select.set("from_", None)


# ---------------------------------------------------------------- constructs the target lacks

def _dialect_only(statement: exp.Expression, source: str, target: str, issues: list[Issue]) -> None:
    if target != "oracle" and any(c.name.upper() == "ROWNUM" and not c.table for c in statement.find_all(exp.Column)):
        issues.append(issue("ROWNUM is Oracle-only: use LIMIT / TOP / FETCH FIRST (or ROW_NUMBER() OVER ()).", "error"))
    if target == "tsql" and any(True for _ in statement.find_all(exp.Interval)):
        issues.append(issue("T-SQL has no INTERVAL literal: use DATEADD(unit, n, date).", "error"))
    if target == "oracle" and any(True for _ in statement.find_all(exp.Boolean)):
        issues.append(issue("Oracle before 23ai has no boolean literals (TRUE/FALSE/IS TRUE): compare with 1/0.", "error"))
    if target in _NO_ARRAYS and any(True for _ in statement.find_all(exp.Array)):
        issues.append(issue(f"{target} has no ARRAY type: rewrite with IN (...) or a join.", "error"))
    if isinstance(statement, exp.Delete) and statement.args.get("using") and target in ("tsql", "sqlite", "oracle"):
        issues.append(issue(f"{target} has no DELETE ... USING: delete with a subquery (WHERE id IN (SELECT ...)) instead.", "error"))
    if isinstance(statement, exp.Update) and (statement.args.get("from_") or statement.args.get("from")) and target == "oracle":
        issues.append(issue("Oracle has no UPDATE ... FROM: use MERGE or a correlated subquery.", "error"))
    if target in ("mysql", "mariadb") and any(j.side == "FULL" for j in statement.find_all(exp.Join)):
        issues.append(issue("MySQL has no FULL OUTER JOIN: emulated with LEFT JOIN UNION ALL anti-joined RIGHT JOIN (duplicates semantics differ if the select has DISTINCT/aggregates).", "warning"))
    if source == "tsql" and any(True for _ in statement.find_all(exp.DateDiff)):
        issues.append(issue("T-SQL DATEDIFF counts crossed unit boundaries, other engines measure elapsed time: results can differ by one.", "warning"))


# ---------------------------------------------------------------- SQLite lacks YEAR()/MONTH()/DAY() and many functions

_STRFTIME = {exp.Year: "%Y", exp.Month: "%m", exp.Day: "%d"}


def _sqlite_dates(statement: exp.Expression, target: str, issues: list[Issue]) -> None:
    """YEAR(x)/MONTH(x)/DAY(x) exist in MySQL, T-SQL and others but not in SQLite: rewrite to CAST(STRFTIME(...) AS INTEGER)."""
    if target != "sqlite":
        return
    done = False
    for node in list(statement.find_all(exp.Year, exp.Month, exp.Day)):
        fmt = _STRFTIME[type(node)]
        node.replace(exp.Cast(
            this=exp.Anonymous(this="STRFTIME", expressions=[exp.Literal.string(fmt), node.this.copy()]),
            to=exp.DataType.build("integer"),
        ))
        done = True
    if done:
        issues.append(issue("YEAR()/MONTH()/DAY() do not exist in SQLite: rewritten with STRFTIME (the date must be ISO text, YYYY-MM-DD[ HH:MM:SS]).", "warning"))


# Printed like calls but not functions (or already reported by a dedicated rule, e.g. ARRAY).
_NOT_FUNCTIONS = {"CAST", "TRY_CAST", "CASE", "EXISTS", "IN", "VALUES", "OVER", "FILTER", "EXTRACT", "ARRAY", "ANY", "ALL", "SOME"}
_known: dict[str, tuple[str, set[str]]] = {}


def _builtins() -> set[str]:
    return _engine_functions("sqlite")[1]


def _engine_functions(dialect: str) -> tuple[str, set[str]]:
    """(label, names) of the functions the engine really has: SQLite via PRAGMA function_list, DuckDB via the list generated from a DuckDB build (sqlkit/data)."""
    if dialect not in _known:
        if dialect == "sqlite":
            db = sqlite3.connect(":memory:")
            names = {str(row[0]).lower() for row in db.execute("PRAGMA function_list")}
            db.close()
            _known[dialect] = ("SQLite", names)
        else:
            lines = (Path(__file__).parent / "data" / "duckdb_functions.txt").read_text().splitlines()
            _known[dialect] = (f"DuckDB ({lines[0].lstrip('# ').split(' function')[0]})", {line.strip() for line in lines[1:] if line.strip()})
    return _known[dialect]


def missing_functions(sql: str, dialect: str) -> list[Issue]:
    """Functions in converted SQL that the target engine does not have (sqlite, duckdb: the only engines whose function list is available offline)."""
    if dialect not in ("sqlite", "duckdb"):
        return []
    try:
        statements = [s for s in sqlglot.parse(sql, read=dialect) if s is not None]
    except sqlglot.errors.SqlglotError:
        return []
    label, known = _engine_functions(dialect)
    seen: list[str] = []
    for statement in statements:
        for node in statement.find_all(exp.Func):
            match = re.match(r"([A-Za-z_][A-Za-z0-9_]*)\s*\(", node.sql(dialect=dialect))
            if not match:
                continue
            name = match.group(1)
            if name.upper() in _NOT_FUNCTIONS or name.lower() in known or name.upper() in seen:
                continue
            seen.append(name.upper())
    hint = "the converted statement fails with 'no such function'" if dialect == "sqlite" else "the converted statement fails with a Catalog Error"
    return [issue(f"{name}() is not a built-in {label} function: {hint}. Rewrite it by hand.", "error") for name in seen]


def sqlite_missing_functions(sql: str) -> list[Issue]:
    return missing_functions(sql, "sqlite")
