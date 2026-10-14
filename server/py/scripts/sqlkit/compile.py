"""QuerySpec -> sqlglot expressions -> dialect SQL (+ the dialect's placeholder style for {param} values)."""
from __future__ import annotations

import re
import uuid
from typing import Any

import sqlglot
from sqlglot import exp

from .common import Issue, SqlToolError, generate, issue, join_statements, mariadb_note, sg_name
from .spec import SpecError, check_spec

# Placeholder style per dialect (documented in docs/TESTING.md and the knife_sql_compile tool description).
#   ?      sqlite, mysql, mariadb, duckdb, snowflake, clickhouse, trino, spark, hive  (one `params` entry per placeholder)
#   $1     postgres, redshift                                                         (numbered; a name reused keeps its number)
#   @name  tsql, bigquery                                                             (named; `params` lists each name once)
#   :name  oracle                                                                     (named; `params` lists each name once)
PLACEHOLDER_STYLE = {
    "sqlite": "?", "mysql": "?", "mariadb": "?", "duckdb": "?", "snowflake": "?", "clickhouse": "?", "trino": "?", "spark": "?", "hive": "?",
    "postgres": "$n", "redshift": "$n",
    "tsql": "@name", "bigquery": "@name",
    "oracle": ":name",
}

# Reserved words that are unsafe unquoted in at least one common engine (sqlglot's own tables are incomplete,
# e.g. sqlite output leaves `order` bare). Names outside this set and matching [A-Za-z_][A-Za-z0-9_]* stay unquoted.
RESERVED = frozenset("""
add all alter and any as asc between by case check column constraint create cross current_date current_time current_timestamp
default delete desc distinct drop else end exists false for foreign from full group having in index inner insert intersect into is
join key left like limit natural not null offset on or order outer primary references right select set table then to true union
unique update user using values view when where with grant revoke rank row rows over partition range
""".split())

NATIVE_ILIKE = frozenset({"postgres", "redshift", "snowflake", "duckdb", "clickhouse", "spark"})

_SAFE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

_FUNC_AGG = {"count": exp.Count, "sum": exp.Sum, "avg": exp.Avg, "min": exp.Min, "max": exp.Max}
_COMPARE = {"=": exp.EQ, "!=": exp.NEQ, "<": exp.LT, "<=": exp.LTE, ">": exp.GT, ">=": exp.GTE, "like": exp.Like, "ilike": exp.ILike}
_ARITH = {"+": exp.Add, "-": exp.Sub, "*": exp.Mul, "/": exp.Div, "%": exp.Mod}
_TYPE_ALIASES = {
    "string": "text", "int": "integer", "bool": "boolean", "datetime": "timestamp", "bytes": "blob", "double": "double precision",
}
_UPSERT_FAMILY = {
    "sqlite": "conflict", "postgres": "conflict", "duckdb": "conflict", "mysql": "duplicate", "mariadb": "duplicate",
    "tsql": "merge", "oracle": "merge", "snowflake": "merge", "bigquery": "merge", "redshift": "merge", "trino": "merge", "spark": "merge",
}
# MERGE source row set: a VALUES table where the engine documents `(VALUES ...) AS s(cols)` inside MERGE ... USING, otherwise
# SELECT ... UNION ALL SELECT ... (BigQuery, Redshift and Spark have no usable VALUES table there; Oracle has none before 23ai).
_MERGE_VALUES = frozenset({"tsql", "snowflake", "trino"})
_RETURNING_OK = {"sqlite", "postgres", "duckdb", "mariadb", "tsql"}


class Ctx:
    def __init__(self, dialect: str) -> None:
        self.dialect = dialect
        self.sg = sg_name(dialect)
        self.token = uuid.uuid4().hex[:10]
        self.placeholders: list[str] = []
        self.issues: list[Issue] = []
        self.prelude: list[exp.Expression] = []  # statements that must run before the main one (DuckDB sequences)

    def warn(self, message: str) -> None:
        self.issues.append(issue(message, "warning"))

    def sentinel(self, name: str) -> str:
        self.placeholders.append(name)
        return f"__KNIFEP_{self.token}_{len(self.placeholders) - 1}__"


# ---------------------------------------------------------------- names

def ident(ctx: Ctx, name: str) -> exp.Identifier:
    quoted = not _SAFE.match(name) or name.lower() in RESERVED
    return exp.Identifier(this=name, quoted=quoted)


def table_ref(ctx: Ctx, ref: str | dict[str, Any]) -> exp.Table:
    name, alias = (ref, None) if isinstance(ref, str) else (ref["name"], ref.get("as"))
    parts = name.split(".")
    table = exp.Table(this=ident(ctx, parts[-1]))
    if len(parts) >= 2:
        table.set("db", ident(ctx, parts[-2]))
    if len(parts) == 3:
        table.set("catalog", ident(ctx, parts[0]))
    if alias:
        table.set("alias", exp.TableAlias(this=ident(ctx, alias)))
    return table


def column(ctx: Ctx, name: str) -> exp.Expression:
    parts = name.split(".")
    leaf: exp.Expression = exp.Star() if parts[-1] == "*" else ident(ctx, parts[-1])
    col = exp.Column(this=leaf)
    if len(parts) >= 2:
        col.set("table", ident(ctx, parts[-2]))
    if len(parts) == 3:
        col.set("db", ident(ctx, parts[0]))
    return col


# ---------------------------------------------------------------- values

def _wrap(node: exp.Expression) -> exp.Expression:
    return exp.Paren(this=node) if isinstance(node, (exp.Binary, exp.Connector)) and not isinstance(node, exp.Paren) else node


def value(ctx: Ctx, v: Any) -> exp.Expression:
    if v is None:
        return exp.Null()
    if isinstance(v, bool):
        # tsql BIT and pre-23ai Oracle have no boolean literal; sqlglot prints (1 = 1) in some positions.
        return exp.Literal.number(int(v)) if ctx.dialect in ("tsql", "oracle") else exp.Boolean(this=v)
    if isinstance(v, (int, float)):
        return exp.Literal.number(repr(v) if isinstance(v, float) else v)
    if isinstance(v, str):
        return exp.Literal.string(v)
    if "param" in v:
        return exp.Var(this=ctx.sentinel(v["param"]))
    if "col" in v:
        return column(ctx, v["col"])
    args = [value(ctx, a) for a in v.get("args", [])]
    if v.get("distinct"):
        args = [exp.Distinct(expressions=args)]
    return function(ctx, v["fn"], args, v.get("args", []))


def function(ctx: Ctx, name: str, args: list[exp.Expression], raw_args: list[Any]) -> exp.Expression:
    lowered = name.lower()
    if name in _ARITH or name == "||":
        if len(args) < 2:
            raise SpecError(f"fn '{name}' needs at least two args.")
        node = _wrap(args[0])
        for nxt in args[1:]:
            node = (exp.DPipe if name == "||" else _ARITH[name])(this=node, expression=_wrap(nxt))
        return node
    if lowered == "cast":
        if len(args) != 2 or not isinstance(raw_args[1], str):
            raise SpecError("fn 'cast' takes [value, 'type name'] (the type is a plain string such as 'integer').")
        return exp.Cast(this=args[0], to=exp.DataType.build(_TYPE_ALIASES.get(raw_args[1].lower(), raw_args[1]), dialect=ctx.sg))
    if "." in name:
        return exp.Anonymous(this=name, expressions=args)
    try:
        # Portable names resolve through sqlglot's base dialect (NOW -> CURRENT_TIMESTAMP, ...) so each target
        # renders its own spelling (postgres knows the common aliases such as NOW); names only the target dialect
        # knows fall back to its parser; unknown names pass through verbatim as native functions.
        node: exp.Expression = exp.Anonymous(this=name, expressions=args)
        for lookup in (None, "postgres", ctx.sg):
            node = exp.func(name, *args, dialect=lookup)
            if not isinstance(node, exp.Anonymous):
                break
        return node
    except (ValueError, TypeError) as error:
        raise SpecError(f"fn '{name}': {error}") from error


def ilike(ctx: Ctx, left: exp.Expression, right: exp.Expression) -> exp.Expression:
    """Native ILIKE where the engine has it; otherwise LOWER(x) LIKE LOWER(y) (sqlglot leaves ILIKE bare for tsql/trino/bigquery)."""
    if ctx.dialect in NATIVE_ILIKE:
        return exp.ILike(this=left, expression=right)
    ctx.warn(f"{ctx.dialect} has no ILIKE: compiled as LOWER(col) LIKE LOWER(pattern) (case folding is ASCII-only in some engines).")
    fold = lambda node: node if isinstance(node, exp.Lower) else exp.Lower(this=node)  # noqa: E731
    return exp.Like(this=fold(left), expression=fold(right))


def condition(ctx: Ctx, c: dict[str, Any], aliases: dict[str, exp.Expression] | None = None) -> exp.Expression:
    if "and" in c or "or" in c:
        key = "and" if "and" in c else "or"
        parts = [condition(ctx, item, aliases) for item in c[key]]
        if len(parts) == 1:
            return parts[0]
        return (exp.and_ if key == "and" else exp.or_)(*parts, copy=False)
    if "not" in c:
        return exp.not_(condition(ctx, c["not"], aliases), copy=False)
    if "expr" in c:
        left = value(ctx, c["expr"])
        what = "expression"
        if aliases:
            left = left.transform(lambda n: aliases[n.name].copy() if isinstance(n, exp.Column) and not n.table and n.name in aliases else n)
    else:
        what = c["col"]
        left = aliases[c["col"]].copy() if aliases and c["col"] in aliases else column(ctx, c["col"])
    op = c["op"].lower()
    val = c.get("value")
    if op in _COMPARE:
        if val is None and op in ("=", "!="):
            ctx.warn(f"'{what} {op} null' is never true in SQL; use op 'is null' / 'is not null'.")
        if op == "ilike":
            return ilike(ctx, left, value(ctx, val))
        return _COMPARE[op](this=left, expression=value(ctx, val))
    if op in ("in", "not in"):
        node: exp.Expression = exp.In(this=left, expressions=[value(ctx, item) for item in val])
        return exp.Not(this=node) if op == "not in" else node
    if op == "between":
        return exp.Between(this=left, low=value(ctx, val[0]), high=value(ctx, val[1]))
    node = exp.Is(this=left, expression=exp.Null())
    return exp.Not(this=node) if op == "is not null" else node


# ---------------------------------------------------------------- select

def select_column(ctx: Ctx, col: str | dict[str, Any]) -> exp.Expression:
    if isinstance(col, str):
        return column(ctx, col)
    expr_spec = col["expr"]
    agg = col.get("agg")
    if agg:
        inner: exp.Expression = exp.Star() if expr_spec == "*" and agg == "count" else value(ctx, expr_spec)
        if col.get("distinct"):
            inner = exp.Distinct(expressions=[inner])
        node: exp.Expression = _FUNC_AGG[agg](this=inner)
    else:
        node = value(ctx, expr_spec)
    if col.get("as"):
        node = exp.Alias(this=node, alias=ident(ctx, col["as"]))
    return node


def _default_nulls_first(ctx: Ctx, desc: bool) -> bool:
    ordering = sqlglot.Dialect.get_or_raise(ctx.sg).NULL_ORDERING
    if ordering == "nulls_are_last":
        return False
    return (ordering == "nulls_are_small") != desc


def build_select(ctx: Ctx, spec: dict[str, Any]) -> exp.Select:
    columns = [select_column(ctx, c) for c in spec.get("columns", [])] or [exp.Star()]
    query = exp.select(*columns, copy=False).from_(table_ref(ctx, spec["from"]), copy=False)
    if spec.get("distinct"):
        query = query.distinct(copy=False)
    for join in spec.get("joins", []):
        jtype = join.get("type", "inner")
        node = exp.Join(this=table_ref(ctx, join["table"]))
        if jtype == "inner":
            node.set("kind", "INNER")
        elif jtype == "cross":
            node.set("kind", "CROSS")
        else:
            node.set("side", jtype.upper())
        if "on" in join:
            node.set("on", condition(ctx, join["on"]))
        query = query.join(node, copy=False)
    if "where" in spec:
        query = query.where(condition(ctx, spec["where"]), copy=False)
    if spec.get("groupBy"):
        query = query.group_by(*[value(ctx, g) for g in spec["groupBy"]], copy=False)
    if "having" in spec:
        # HAVING cannot use select aliases in most engines: a `col` naming an aggregate alias becomes the aggregate itself.
        aggregates = {c["as"]: select_column(ctx, {**c, "as": None}) for c in spec.get("columns", []) if isinstance(c, dict) and c.get("agg") and c.get("as")}
        query = query.having(condition(ctx, spec["having"], aggregates), copy=False)
    if spec.get("orderBy"):
        ordered = []
        for item in spec["orderBy"]:
            desc = item.get("dir") == "desc"
            node = exp.Ordered(this=value(ctx, item["expr"]))
            if desc:
                node.set("desc", True)
            # sqlglot prints NULLS FIRST/LAST only when it differs from the dialect default, so an unstated
            # preference must be set to that default (an absent flag reads as "nulls last").
            node.set("nulls_first", item["nulls"] == "first" if "nulls" in item else _default_nulls_first(ctx, desc))
            ordered.append(node)
        query = query.order_by(*ordered, copy=False)
    if "limit" in spec:
        query = query.limit(spec["limit"], copy=False)
    if "offset" in spec:
        query = query.offset(spec["offset"], copy=False)
    for cte in spec.get("ctes", []):
        query = query.with_(ident(ctx, cte["name"]), as_=build_select(ctx, cte["query"]), copy=False)
    return query


# ---------------------------------------------------------------- DML

def _without_returning(ctx: Ctx, spec: dict[str, Any]) -> str:
    """The same statement minus `returning`: what the caller can run when the engine cannot hand the rows back itself."""
    plain = {k: v for k, v in spec.items() if k != "returning"}
    return compile_spec(plain, ctx.dialect)["sql"]


def _returning_error(ctx: Ctx, spec: dict[str, Any], reason: str) -> SpecError:
    try:
        alternative = f" Without it the statement is: {_without_returning(ctx, spec)}"
    except SqlToolError:
        alternative = ""
    return SpecError(f"returning is not supported for {reason}.{alternative}")


def _returning(ctx: Ctx, spec: dict[str, Any], kind: str) -> exp.Returning | None:
    if not spec.get("returning"):
        return None
    d = ctx.dialect
    if d == "oracle":
        raise _returning_error(ctx, spec, (
            "oracle: RETURNING col INTO :out only exists inside PL/SQL or with an OUT bind variable in your driver, so it is not a standalone statement. "
            "Run the statement without it and read the rows back with a SELECT on the key"))
    if d not in _RETURNING_OK:
        raise _returning_error(ctx, spec, f"{d}: only {', '.join(sorted(_RETURNING_OK))} have a RETURNING/OUTPUT clause the compiler can emit. Run the statement, then SELECT the rows")
    if d == "mariadb" and kind == "update":
        raise _returning_error(ctx, spec, "MariaDB UPDATE (only INSERT ... RETURNING from 10.5 and DELETE ... RETURNING from 10.0 exist). Run the update, then SELECT the rows")
    # T-SQL OUTPUT columns must be prefixed: inserted. = the row after INSERT/UPDATE/MERGE, deleted. = the row removed by DELETE.
    prefix = "deleted" if kind == "delete" else "inserted"
    cols: list[exp.Expression] = []
    for name in spec["returning"]:
        col = column(ctx, name)
        if d == "tsql":
            col.set("table", exp.Identifier(this=prefix, quoted=False))
        cols.append(col)
    if d == "tsql":
        ctx.warn("T-SQL OUTPUT without INTO is rejected for tables with enabled triggers (error 334): use OUTPUT ... INTO @table_variable there.")
    elif d == "mariadb":
        ctx.warn("MariaDB supports INSERT ... RETURNING from 10.5 and DELETE ... RETURNING from 10.0; UPDATE ... RETURNING does not exist.")
    return exp.Returning(expressions=cols)


def build_insert(ctx: Ctx, spec: dict[str, Any]) -> exp.Expression:
    if "onConflict" in spec and _UPSERT_FAMILY.get(ctx.dialect) == "merge":
        return build_merge(ctx, spec)
    table = table_ref(ctx, spec["table"])
    target = exp.Schema(this=table, expressions=[ident(ctx, c) for c in spec["columns"]])
    rows = [exp.Tuple(expressions=[value(ctx, v) for v in row]) for row in spec["rows"]]
    insert = exp.Insert(this=target, expression=exp.Values(expressions=rows))
    if "onConflict" in spec:
        insert.set("conflict", _conflict(ctx, spec))
    returning = _returning(ctx, spec, "insert")
    if returning is not None:
        insert.set("returning", returning)
    return insert


def _merge_source(ctx: Ctx, columns: list[str], rows: list[list[exp.Expression]], alias: str) -> exp.Expression:
    if ctx.dialect in _MERGE_VALUES:
        return exp.Values(
            expressions=[exp.Tuple(expressions=row) for row in rows],
            alias=exp.TableAlias(this=ident(ctx, alias), columns=[ident(ctx, c) for c in columns]),
        )
    selects: list[exp.Select] = []
    for i, row in enumerate(rows):
        # Only the first SELECT names the columns; later ones are positional.
        items = [exp.alias_(v, ident(ctx, c), copy=False) for v, c in zip(row, columns)] if i == 0 else row
        select = exp.select(*items, copy=False)
        if ctx.dialect == "oracle":
            select = select.from_(exp.to_table("DUAL"), copy=False)
        selects.append(select)
    body: exp.Expression = selects[0]
    for nxt in selects[1:]:
        body = exp.Union(this=body, expression=nxt, distinct=False)
    return exp.Subquery(this=body, alias=exp.TableAlias(this=ident(ctx, alias)))


def merge_node(
    ctx: Ctx,
    table: exp.Table,
    columns: list[str],
    rows: list[list[exp.Expression]],
    keys: list[str],
    assignments: list[tuple[str, exp.Expression]] | None,
) -> exp.Merge:
    """MERGE INTO t USING <rows> AS s ON <key match> [WHEN MATCHED THEN UPDATE SET ...] WHEN NOT MATCHED THEN INSERT ... .

    `assignments` None = do nothing for existing rows. Right-hand sides may use `excluded.x` (the new row), a bare `x` or
    `<table>.x` (the existing row); they are re-qualified because MERGE has two row sources and bare names are ambiguous."""
    d = ctx.dialect
    target_name = table.name
    alias = "src" if target_name.lower() == "s" else "s"
    lowered = {c.lower() for c in columns}
    missing = [k for k in keys if k.lower() not in lowered]
    if missing:
        raise SpecError(f"insert.onConflict.target: column(s) {', '.join(missing)} must be among the inserted columns (the MERGE matches the new rows to existing ones on them).")

    def own(node: exp.Expression) -> exp.Expression:
        if isinstance(node, exp.Column) and isinstance(node.this, exp.Identifier):
            owner = node.table.lower()
            if owner == "excluded":
                node.set("table", ident(ctx, alias))
            elif not owner or owner == target_name.lower():
                node.set("table", ident(ctx, target_name))
        return node

    match: exp.Expression = exp.and_(*[exp.EQ(this=column(ctx, f"{target_name}.{k}"), expression=column(ctx, f"{alias}.{k}")) for k in keys], copy=False)
    if d == "oracle":
        match = exp.Paren(this=match)  # Oracle requires parentheses around the ON condition (ORA-00906 otherwise)
    whens: list[exp.Expression] = []
    if assignments is not None:
        if d == "oracle":
            bad = [k for k, _ in assignments if k.lower() in {x.lower() for x in keys}]
            if bad:
                raise SpecError(f"insert.onConflict.set: Oracle cannot update a column used in the ON condition (ORA-38104): {', '.join(bad)}.")
        sets = [exp.EQ(this=exp.Column(this=ident(ctx, k)), expression=v.copy().transform(own)) for k, v in assignments]
        whens.append(exp.When(matched=True, then=exp.Update(expressions=sets)))
    whens.append(exp.When(
        matched=False,
        then=exp.Insert(
            this=exp.Tuple(expressions=[exp.Column(this=ident(ctx, c)) for c in columns]),
            expression=exp.Tuple(expressions=[column(ctx, f"{alias}.{c}") for c in columns]),
        ),
    ))
    merge = exp.Merge(this=table, using=_merge_source(ctx, columns, rows, alias), on=match, whens=exp.Whens(expressions=whens))
    ctx.warn(f"{d} has no ON CONFLICT: written as MERGE (rows are matched by {', '.join(keys)} with no unique index required, so duplicates are not prevented).")
    if d == "tsql":
        ctx.warn("T-SQL MERGE needs a terminating semicolon (added) and is not atomic under concurrency without WITH (HOLDLOCK) on the target; two new rows with the same key in one statement raise an error.")
    elif d == "snowflake":
        ctx.warn("Snowflake MERGE with several source rows matching one target row is nondeterministic (or an error with ERROR_ON_NONDETERMINISTIC_MERGE).")
    elif d in ("trino", "spark"):
        ctx.warn(f"{d} MERGE only works on tables whose connector/format supports row-level changes (e.g. Iceberg/Delta{', transactional Hive' if d == 'trino' else ''}).")
    return merge


def build_merge(ctx: Ctx, spec: dict[str, Any]) -> exp.Merge:
    oc = spec["onConflict"]
    rows = [[value(ctx, v) for v in row] for row in spec["rows"]]
    assignments: list[tuple[str, exp.Expression]] | None = None
    if oc["action"] == "update":
        assignments = [(k, value(ctx, v)) for k, v in _conflict_assignments(spec)]
    merge = merge_node(ctx, table_ref(ctx, spec["table"]), spec["columns"], rows, oc["target"], assignments)
    returning = _returning(ctx, spec, "insert")
    if returning is not None:
        merge.set("returning", returning)
    return merge


def _conflict_assignments(spec: dict[str, Any]) -> list[tuple[str, Any]]:
    oc = spec["onConflict"]
    if oc["action"] != "update":
        return []
    target = [c.lower() for c in oc["target"]]
    if "set" in oc:
        assignments = list(oc["set"].items())
    else:
        assignments = [(c, {"col": f"excluded.{c}"}) for c in spec["columns"] if c.lower() not in target]
        if not assignments:
            raise SpecError("insert.onConflict: every inserted column is part of the conflict target, so there is nothing to update; give 'set' or use action 'nothing'.")
    if not assignments:
        raise SpecError("insert.onConflict.set: needs at least one column.")
    return assignments


def _conflict(ctx: Ctx, spec: dict[str, Any]) -> exp.OnConflict:
    family = _UPSERT_FAMILY.get(ctx.dialect)
    if family is None:
        raise SpecError(
            f"insert.onConflict is not supported for {ctx.dialect}: it has neither ON CONFLICT, ON DUPLICATE KEY nor a MERGE "
            "the compiler can emit. Compile an update (where the key matches) and an insert separately."
        )
    oc = spec["onConflict"]
    assignments = _conflict_assignments(spec)

    def rhs(v: Any) -> exp.Expression:
        if family == "duplicate" and isinstance(v, dict) and isinstance(v.get("col"), str) and v["col"].lower().startswith("excluded."):
            return exp.Anonymous(this="VALUES", expressions=[ident(ctx, v["col"].split(".", 1)[1])])
        return value(ctx, v)

    if family == "conflict":
        node = exp.OnConflict(conflict_keys=[column(ctx, c) for c in oc["target"]])
        if oc["action"] == "nothing":
            node.set("action", exp.var("DO NOTHING"))
        else:
            node.set("action", exp.var("DO UPDATE"))
            node.set("expressions", [exp.EQ(this=exp.Column(this=ident(ctx, k)), expression=rhs(v)) for k, v in assignments])
        return node
    node = exp.OnConflict(duplicate=True, action=exp.var("UPDATE"))
    if oc["action"] == "nothing":
        first = ident(ctx, oc["target"][0])
        node.set("expressions", [exp.EQ(this=exp.Column(this=first), expression=exp.Column(this=first.copy()))])
        ctx.warn("MySQL has no DO NOTHING for ON DUPLICATE KEY: compiled as a no-op update (col = col) on the first target column.")
    else:
        node.set("expressions", [exp.EQ(this=exp.Column(this=ident(ctx, k)), expression=rhs(v)) for k, v in assignments])
    if ctx.dialect == "mariadb":
        ctx.warn("MariaDB is compiled with the MySQL dialect: ON DUPLICATE KEY UPDATE with VALUES(col) is valid on MariaDB too.")
    return node


def build_update(ctx: Ctx, spec: dict[str, Any]) -> exp.Update:
    sets = [exp.EQ(this=exp.Column(this=ident(ctx, k)), expression=value(ctx, v)) for k, v in spec["set"].items()]
    update = exp.Update(this=table_ref(ctx, spec["table"]), expressions=sets)
    if "where" in spec:
        update.set("where", exp.Where(this=condition(ctx, spec["where"])))
    else:
        ctx.warn("UPDATE without where changes every row.")
    returning = _returning(ctx, spec, "update")
    if returning is not None:
        update.set("returning", returning)
    return update


def build_delete(ctx: Ctx, spec: dict[str, Any]) -> exp.Delete:
    delete = exp.Delete(this=table_ref(ctx, spec["table"]))
    if "where" in spec:
        delete.set("where", exp.Where(this=condition(ctx, spec["where"])))
    else:
        ctx.warn("DELETE without where removes every row.")
    returning = _returning(ctx, spec, "delete")
    if returning is not None:
        delete.set("returning", returning)
    return delete


# ---------------------------------------------------------------- DDL

def _data_type(ctx: Ctx, type_name: str) -> exp.DataType:
    name = _TYPE_ALIASES.get(type_name.strip().lower(), type_name.strip())
    try:
        return exp.DataType.build(name, dialect=None)
    except Exception as error:  # sqlglot raises ParseError/ValueError for names it cannot read
        raise SpecError(f"type {type_name!r} is not a recognised portable type: {error}") from error


_IDENTITY_UNSUPPORTED = ("bigquery", "clickhouse", "trino", "spark", "hive")
# What to do instead where the engine has no identity/auto-increment column; the two UUID engines also get a compiled example.
_IDENTITY_ADVICE = {
    "bigquery": "BigQuery has no auto-increment/identity columns; use a UUID key (type 'uuid', default {fn: 'generate_uuid'} = STRING DEFAULT GENERATE_UUID()) or number rows when loading (ROW_NUMBER() OVER ())",
    "clickhouse": "ClickHouse has no auto-increment/identity columns; use a UUID key (type 'uuid', default {fn: 'generateUUIDv4'}) or a snowflake id (type 'bigint', default {fn: 'generateSnowflakeID'}, 24.6+)",
    "trino": "Trino has no identity columns and most connectors reject column defaults; supply the id in the INSERT (e.g. {fn: 'uuid'} into a 'uuid' column)",
    "spark": "Spark SQL has no identity columns (only Databricks Delta has GENERATED ... AS IDENTITY); supply the id in the INSERT (e.g. {fn: 'uuid'} or monotonically_increasing_id())",
    "hive": "Hive has no identity columns; supply the id in the INSERT or load (e.g. reflect('java.util.UUID', 'randomUUID') or ROW_NUMBER() OVER ())",
}
_IDENTITY_DEFAULT_FN = {"bigquery": "generate_uuid", "clickhouse": "generateUUIDv4"}


def sequence_name(table: str, column: str) -> str:
    """`users`.`id` -> users_id_seq, schema qualifier kept (DuckDB resolves sequences like tables)."""
    parts = table.split(".")
    base = re.sub(r"[^A-Za-z0-9_]", "_", f"{parts[-1]}_{column}_seq")
    return ".".join([*[re.sub(r"[^A-Za-z0-9_]", "_", p) for p in parts[:-1]], base])


def _auto_increment(ctx: Ctx, table: str | None = None, column: str | None = None, if_not_exists: bool = False) -> exp.Expression:
    d = ctx.dialect
    if d in _IDENTITY_UNSUPPORTED:
        raise SpecError(f"autoIncrement/serial columns are not supported for {d}: {_IDENTITY_ADVICE[d]}.")
    if d == "duckdb":
        # DuckDB has no identity column: the faithful equivalent is a sequence plus DEFAULT nextval('<sequence>').
        if table is None or column is None:
            raise SpecError("DuckDB identity needs the table and column name to name its sequence.")
        name = sequence_name(table, column)
        ctx.prelude.append(exp.Create(
            this=exp.to_table(name), kind="SEQUENCE", exists=if_not_exists,
            properties=exp.Properties(expressions=[exp.SequenceProperties(start=exp.Literal.number(1), increment=exp.Literal.number(1))]),
        ))
        ctx.warn(f"DuckDB has no identity columns: '{column}' uses DEFAULT nextval('{name}') and a CREATE SEQUENCE statement was added before the table (run both).")
        return exp.DefaultColumnConstraint(this=exp.Anonymous(this="nextval", expressions=[exp.Literal.string(name)]))
    if d in ("mysql", "mariadb"):
        return exp.AutoIncrementColumnConstraint()
    if d == "snowflake":
        return exp.AutoIncrementColumnConstraint()
    if d in ("tsql", "redshift"):
        return exp.GeneratedAsIdentityColumnConstraint(this=False, start=exp.Literal.number(1), increment=exp.Literal.number(1))
    return exp.GeneratedAsIdentityColumnConstraint(this=False)  # postgres, oracle: GENERATED BY DEFAULT AS IDENTITY


def _identity_alternative(ctx: Ctx, spec: dict[str, Any], column_name: str) -> str:
    """The same table with that column made a UUID key (bigquery/clickhouse) or a plain column (others): compiled, so the advice is verified SQL."""
    fn = _IDENTITY_DEFAULT_FN.get(ctx.dialect)
    columns = []
    for col in spec["columns"]:
        if col["name"] != column_name:
            columns.append(col)
            continue
        plain = {k: v for k, v in col.items() if k not in ("autoIncrement", "default")}
        plain["type"] = "uuid" if fn else ("integer" if col["type"].strip().lower() in ("serial", "smallserial") else "bigint" if col["type"].strip().lower() == "bigserial" else col["type"])
        if fn:
            plain["default"] = {"fn": fn}
        columns.append(plain)
    try:
        return compile_spec({**spec, "columns": columns}, ctx.dialect)["sql"]
    except SqlToolError:
        return ""


def build_create_table(ctx: Ctx, spec: dict[str, Any]) -> exp.Create:
    d = ctx.dialect
    column_pks = [c["name"] for c in spec["columns"] if c.get("primaryKey")]
    table_pk = spec.get("primaryKey") or (column_pks if len(column_pks) > 1 else [])
    inline_pk = column_pks[0] if len(column_pks) == 1 and not spec.get("primaryKey") else None
    if spec.get("primaryKey") and column_pks and {c.lower() for c in column_pks} != {c.lower() for c in spec["primaryKey"]}:
        raise SpecError("spec.primaryKey disagrees with the columns flagged primaryKey: use one or the other.")
    defs: list[exp.Expression] = []
    clickhouse = d == "clickhouse"
    for col in spec["columns"]:
        raw_type = col["type"].strip().lower()
        auto = bool(col.get("autoIncrement")) or raw_type in ("serial", "bigserial", "smallserial")
        base = {"serial": "integer", "bigserial": "bigint", "smallserial": "smallint"}.get(raw_type, col["type"])
        dtype = _data_type(ctx, base)
        if d == "oracle" and dtype.is_type(exp.DType.BOOLEAN):
            dtype = exp.DataType.build("number(1)")
            ctx.warn(f"Oracle before 23ai has no BOOLEAN: column '{col['name']}' is NUMBER(1) holding 0/1.")
        is_pk = col["name"].lower() in {c.lower() for c in (table_pk or ([inline_pk] if inline_pk else []))}
        constraints: list[exp.Expression] = []
        if auto and d == "duckdb" and "default" in col:
            raise SpecError(f"column '{col['name']}': a DuckDB identity column is a DEFAULT nextval(...), so it cannot also have its own default.")
        if auto:
            if d == "sqlite":
                if inline_pk is None or col["name"] != inline_pk:
                    raise SpecError(f"column '{col['name']}': SQLite AUTOINCREMENT needs this column to be the table's single primary key.")
                dtype = exp.DataType.build("integer")
            else:
                if not is_pk and not col.get("unique") and d in ("mysql", "mariadb"):
                    raise SpecError(f"column '{col['name']}': MySQL AUTO_INCREMENT columns must be a key (set primaryKey or unique).")
                try:
                    constraints.append(exp.ColumnConstraint(kind=_auto_increment(ctx, spec["name"], col["name"], bool(spec.get("ifNotExists")))))
                except SpecError as error:
                    alternative = _identity_alternative(ctx, spec, col["name"]) if d in _IDENTITY_UNSUPPORTED else ""
                    raise SpecError(f"column '{col['name']}': {error}" + (f" Closest valid alternative: {alternative}" if alternative else "")) from error
        if clickhouse:
            # ClickHouse types are non-nullable unless wrapped in Nullable(...) (sqlglot wraps unless told otherwise), and key columns must not be nullable.
            dtype.set("nullable", not (col.get("nullable") is False or is_pk))
        elif col.get("nullable") is False and not is_pk:
            constraints.append(exp.ColumnConstraint(kind=exp.NotNullColumnConstraint()))
        if "default" in col:
            default = value(ctx, col["default"])
            if isinstance(col["default"], dict) and "param" in col["default"]:
                raise SpecError(f"column '{col['name']}': a default cannot be a {{param}}.")
            if d == "sqlite" and isinstance(default, exp.Func) and not isinstance(default, (exp.CurrentTimestamp, exp.CurrentDate, exp.CurrentTime)):
                default = exp.Paren(this=default)
            constraints.append(exp.ColumnConstraint(kind=exp.DefaultColumnConstraint(this=default)))
        if inline_pk and col["name"] == inline_pk and not clickhouse:
            constraints.append(exp.ColumnConstraint(kind=exp.PrimaryKeyColumnConstraint()))
            if auto and d == "sqlite":
                constraints.append(exp.ColumnConstraint(kind=exp.AutoIncrementColumnConstraint()))
        if col.get("unique"):
            constraints.append(exp.ColumnConstraint(kind=exp.UniqueColumnConstraint()))
        if "references" in col:
            if clickhouse:
                ctx.warn(f"ClickHouse has no foreign keys: references on '{col['name']}' were dropped.")
            else:
                ref = col["references"]
                reference = exp.Reference(
                    this=exp.Schema(this=table_ref(ctx, ref["table"]), expressions=[ident(ctx, ref["column"])]),
                    options=[f"ON DELETE {ref['onDelete'].upper()}"] if ref.get("onDelete") else [],
                )
                constraints.append(exp.ColumnConstraint(kind=reference))
        if d == "oracle":  # DEFAULT / identity clause first, inline constraints after it (ORA-00907 otherwise)
            constraints.sort(key=lambda c: 0 if isinstance(c.args.get("kind"), (exp.DefaultColumnConstraint, exp.GeneratedAsIdentityColumnConstraint)) else 1)
        defs.append(exp.ColumnDef(this=ident(ctx, col["name"]), kind=dtype, constraints=constraints or None))
    if table_pk and not clickhouse:
        defs.append(exp.PrimaryKey(expressions=[ident(ctx, c) for c in table_pk]))
    create = exp.Create(this=exp.Schema(this=table_ref(ctx, spec["name"]), expressions=defs), kind="TABLE", exists=bool(spec.get("ifNotExists")))
    if clickhouse:
        ctx.warn("ClickHouse requires an ENGINE: MergeTree was added" + (" and primary key columns became the sorting key." if (table_pk or inline_pk) else " (ORDER BY tuple())."))
        keys = table_pk or ([inline_pk] if inline_pk else [])
        create.set("properties", exp.Properties(expressions=[
            exp.EngineProperty(this=exp.var("MergeTree")),
            # a composite sorting key must be one tuple expression: `ORDER BY (a, b)` (`ORDER BY a, b` is a syntax error in ClickHouse)
            exp.Order(expressions=[exp.Ordered(this=exp.column(keys[0]) if len(keys) == 1 else exp.Tuple(expressions=[exp.column(k) for k in keys]))]) if keys else exp.var("ORDER BY tuple()"),
        ]))
    if d == "oracle" and spec.get("ifNotExists"):
        ctx.warn("Oracle added IF NOT EXISTS only in 23ai; older versions reject it.")
    if d in ("bigquery", "trino", "spark", "hive") and (table_pk or inline_pk or any(c.get("references") or c.get("unique") for c in spec["columns"])):
        ctx.warn(f"{d}: PRIMARY KEY / UNIQUE / REFERENCES are not enforced (or need NOT ENFORCED / DISABLE) and may be rejected by the engine.")
    return create


# ---------------------------------------------------------------- entry

_BUILDERS = {"select": build_select, "insert": build_insert, "update": build_update, "delete": build_delete, "create_table": build_create_table}


def _oracle_insert_all(ctx: Ctx, insert: exp.Insert, pretty: bool) -> str:
    """Oracle has no multi-row VALUES: INSERT ALL INTO t (..) VALUES (..) INTO t (..) VALUES (..) SELECT 1 FROM DUAL."""
    parts: list[str] = []
    for row in insert.expression.expressions:
        single = exp.Insert(this=insert.this.copy(), expression=exp.Values(expressions=[row.copy()]))
        sql, _ = generate(single, ctx.dialect, False)
        parts.append(sql[len("INSERT "):])
    sep = "\n" if pretty else " "
    return "INSERT ALL" + sep + sep.join(parts) + sep + "SELECT 1 FROM DUAL"


def finalize(ctx: Ctx, sql: str) -> tuple[str, list[str]]:
    style = PLACEHOLDER_STYLE[ctx.dialect]
    params: list[str] = []
    numbered: dict[str, int] = {}

    def swap(match: re.Match[str]) -> str:
        name = ctx.placeholders[int(match.group(1))]
        if style == "?":
            params.append(name)
            return "?"
        if style == "$n":
            if name not in numbered:
                numbered[name] = len(numbered) + 1
                params.append(name)
            return f"${numbered[name]}"
        if name not in params:
            params.append(name)
        return f"{style[0]}{name}"

    return re.sub(rf"__KNIFEP_{ctx.token}_(\d+)__", swap, sql), params


def compile_spec(spec: Any, dialect: str, pretty: bool = False) -> dict[str, Any]:
    check_spec(spec)
    ctx = Ctx(dialect)
    builder = _BUILDERS[spec["op"]]
    expression = builder(ctx, spec)
    if dialect == "oracle" and isinstance(expression, exp.Insert) and len(spec["rows"]) > 1:
        sql = _oracle_insert_all(ctx, expression, pretty)
        unsupported: list[str] = []
    else:
        sql, unsupported = generate(expression, dialect, pretty)
    for message in unsupported:
        ctx.warn(f"{dialect}: {message}")
    if ctx.prelude:
        sql = join_statements([generate(p, dialect, pretty)[0] for p in ctx.prelude] + [sql], pretty)
    sql, params = finalize(ctx, sql)
    if dialect == "tsql" and isinstance(expression, exp.Merge):
        sql += ";"  # T-SQL rejects an unterminated MERGE (error 10713)
    note = mariadb_note(dialect, "identifiers use backticks and syntax follows MySQL; features only MariaDB has are not generated.")
    if note:
        ctx.issues.append(note)
    seen: set[str] = set()
    return {"sql": sql, "params": params, "issues": [i for i in ctx.issues if not (i["message"] in seen or seen.add(i["message"]))]}
