"""check: every table/column a statement references must exist in the schema (catches invented identifiers)."""
from __future__ import annotations

from typing import Any

from sqlglot import exp
from sqlglot.optimizer.scope import Scope, build_scope, traverse_scope, walk_in_scope

from .common import Issue, ParseFailure, did_you_mean, issue, parse_statements
from .schema import SchemaBuilder

# Bare words that parse as columns but are really niladic functions / pseudo-columns in some dialect.
_PSEUDO = frozenset({"sysdate", "systimestamp", "current_user", "session_user", "user", "rownum", "rowid", "level", "sysdatetime", "getdate", "localtimestamp", "localtime", "oid", "ctid", "_rowid_"})


def _position(node: exp.Expression | None) -> tuple[int | None, int | None]:
    """1-based (line, column) of the first character of an identifier, from the parser's token meta."""
    ident = node.this if isinstance(node, (exp.Column, exp.Table)) else node
    meta = getattr(ident, "meta", None) or {}
    line, col = meta.get("line"), meta.get("col")
    if not isinstance(line, int) or not isinstance(col, int):
        return None, None
    width = (meta.get("end", 0) - meta.get("start", 0)) if "start" in meta and "end" in meta else 0
    return line, max(1, col - width)


class Checker:
    def __init__(self, schema: dict[str, Any], dialect: str) -> None:
        self.dialect = dialect
        self.builder = SchemaBuilder(dialect)
        for table in schema.get("tables", []):
            self.builder.tables[table["name"]] = table
        self.issues: list[Issue] = []
        self._seen: set[tuple[str, int | None, int | None]] = set()
        self._out_cache: dict[int, list[str] | None] = {}

    # --- reporting
    def report(self, message: str, node: exp.Expression | None = None, level: str = "error") -> None:
        line, col = _position(node)
        key = (message, line, col)
        if key in self._seen:
            return
        self._seen.add(key)
        self.issues.append(issue(message, level, line, col))

    # --- schema access
    def table_columns(self, name: str) -> list[str] | None:
        table = self.builder.table(name)
        return [c["name"] for c in table["columns"]] if table else None

    def table_names(self) -> list[str]:
        return [t["name"] for t in self.builder.tables.values()]

    # --- statements
    def statement(self, statement: exp.Expression) -> None:
        if isinstance(statement, exp.Insert):
            self.insert(statement)
        elif isinstance(statement, (exp.Update, exp.Delete)):
            self.update_delete(statement)
        elif isinstance(statement, exp.Query):
            self.query(statement)
        elif isinstance(statement, (exp.Create, exp.Alter, exp.Drop)):
            inner = statement.expression if isinstance(statement, exp.Create) else None
            if isinstance(inner, exp.Query):
                self.query(inner)
            self.builder.apply(statement)
        else:
            self.report(f"Statement type {statement.key.upper()} is not checked against the schema.", None, "warning")

    def query(self, query: exp.Expression) -> list[str] | None:
        root = build_scope(query)
        if root is None:
            return None
        scopes = list(traverse_scope(query))
        seen_tables: set[int] = set()
        for scope in scopes:
            for source in scope.sources.values():
                if isinstance(source, exp.Table) and id(source) not in seen_tables:
                    seen_tables.add(id(source))
                    self.check_table(source, [s for s in scope.cte_sources] if hasattr(scope, "cte_sources") else [])
        for scope in scopes:
            self.check_scope(scope)
        return self.out_cols(root)

    def check_table(self, table: exp.Table, ctes: list[str]) -> bool:
        if self.table_columns(table.name) is not None:
            return True
        self.report(f"Unknown table '{table.name}'." + did_you_mean(table.name, self.table_names() + ctes), table)
        return False

    # --- scopes
    def source_columns(self, scope: Scope, alias: str) -> list[str] | None:
        source = scope.sources.get(alias)
        if isinstance(source, exp.Table):
            return self.table_columns(source.name)
        if isinstance(source, Scope):
            return self.out_cols(source)
        return None

    def out_cols(self, scope: Scope) -> list[str] | None:
        if id(scope) in self._out_cache:
            return self._out_cache[id(scope)]
        self._out_cache[id(scope)] = None  # recursion guard
        names: list[str] | None = []
        expression = scope.expression
        if isinstance(expression, exp.SetOperation):
            result = self.out_cols(scope.set_operation_scopes[0]) if scope.set_operation_scopes else None
            self._out_cache[id(scope)] = result
            return result
        for projection in getattr(expression, "selects", []):
            if isinstance(projection, exp.Star):
                for alias in scope.sources:
                    cols = self.source_columns(scope, alias)
                    if cols is None or names is None:
                        names = None
                        break
                    names.extend(cols)
            elif isinstance(projection, exp.Column) and isinstance(projection.this, exp.Star):
                cols = self.source_columns(scope, projection.table) if projection.table in scope.sources else None
                names = None if cols is None or names is None else names + cols
            elif names is not None:
                names.append(projection.alias_or_name)
            if names is None:
                break
        self._out_cache[id(scope)] = names
        return names

    def check_scope(self, scope: Scope) -> None:
        if not isinstance(scope.expression, exp.Select):
            return
        sources = {alias.lower(): alias for alias in scope.sources}
        chain = [scope]
        while chain[-1].parent is not None:
            chain.append(chain[-1].parent)
        using: set[str] = set()
        natural = False
        for join in scope.expression.args.get("joins") or []:
            using.update(c.name.lower() for c in join.args.get("using") or [])
            natural = natural or bool(join.args.get("method"))
        aliases = {e.alias.lower() for e in scope.expression.selects if e.alias}
        scope_unknown = bool(scope.udtfs) or any(self.source_columns(scope, a) is None for a in scope.sources)
        for node in walk_in_scope(scope.expression):
            if isinstance(node, exp.Column):
                self.check_column(node, scope, chain, sources, using, natural, aliases, scope_unknown)

    def check_column(self, col: exp.Column, scope: Scope, chain: list[Scope], sources: dict[str, str], using: set[str], natural: bool, aliases: set[str], scope_unknown: bool) -> None:
        name = col.name
        qualifier = col.table
        is_star = isinstance(col.this, exp.Star)
        if qualifier:
            for sc in chain:
                lowered = {a.lower(): a for a in sc.sources}
                if qualifier.lower() not in lowered:
                    continue
                if is_star:
                    return
                cols = self.source_columns(sc, lowered[qualifier.lower()])
                if cols is None or name.lower() in {c.lower() for c in cols}:
                    return
                label = sc.sources[lowered[qualifier.lower()]]
                where = f"table '{label.name}'" if isinstance(label, exp.Table) else f"'{qualifier}'"
                self.report(f"Unknown column '{qualifier}.{name}': {where} has no column '{name}'." + did_you_mean(name, cols) + self._quote_hint(col), col)
                return
            scope_aliases = list(scope.sources)
            if scope.udtfs:
                return
            self.report(f"Unknown table or alias '{qualifier}'." + did_you_mean(qualifier, scope_aliases), col)
            return
        if is_star or name.lower() in _PSEUDO and not col.this.args.get("quoted"):
            return
        for depth, sc in enumerate(chain):
            hits: list[str] = []
            unknown = bool(sc.udtfs)
            for alias in sc.sources:
                cols = self.source_columns(sc, alias)
                if cols is None:
                    unknown = True
                elif name.lower() in {c.lower() for c in cols}:
                    hits.append(alias)
            if hits:
                if len(hits) > 1 and name.lower() not in using and not natural and depth == 0:
                    shown = ", ".join(hits)
                    self.report(f"Column '{name}' is ambiguous: it exists in {shown}. Qualify it, e.g. {hits[0]}.{name}.", col)
                return
            if unknown:
                return
        if name.lower() in aliases:
            return
        candidates = [c for a in scope.sources for c in (self.source_columns(scope, a) or [])]
        self.report(f"Unknown column '{name}'." + did_you_mean(name, candidates) + self._quote_hint(col), col)

    @staticmethod
    def _quote_hint(col: exp.Column) -> str:
        return " Note: double-quoted text is an identifier here; use single quotes for a string literal." if col.this.args.get("quoted") else ""

    # --- DML
    def insert(self, insert: exp.Insert) -> None:
        target = insert.this
        table = target.this if isinstance(target, exp.Schema) else target
        listed = [c for c in target.expressions] if isinstance(target, exp.Schema) else None
        known = False
        columns: list[str] = []
        if isinstance(table, exp.Table):
            known = self.check_table(table, [])
            columns = self.table_columns(table.name) or []
        lowered = {c.lower() for c in columns}
        if known and listed is not None:
            seen: set[str] = set()
            for ident in listed:
                if ident.name.lower() not in lowered:
                    self.report(f"Unknown column '{ident.name}' in table '{table.name}'." + did_you_mean(ident.name, columns), ident)
                if ident.name.lower() in seen:
                    self.report(f"Column '{ident.name}' is listed twice in the INSERT column list.", ident)
                seen.add(ident.name.lower())
        expected = len(listed) if listed is not None else (len(columns) if known else None)
        source = insert.expression
        if isinstance(source, exp.Values):
            for index, row in enumerate(source.expressions, 1):
                items = row.expressions if isinstance(row, exp.Tuple) else [row]
                if expected is not None and len(items) != expected:
                    where = "the column list" if listed is not None else f"table '{table.name}'"
                    self.report(f"INSERT row {index} has {len(items)} value{'s' if len(items) != 1 else ''} but {where} has {expected} column{'s' if expected != 1 else ''}.", row)
        elif isinstance(source, exp.Query):
            out = self.query(source)
            if out is not None and expected is not None and len(out) != expected:
                self.report(f"INSERT ... SELECT provides {len(out)} column{'s' if len(out) != 1 else ''} but {expected} {'are' if expected != 1 else 'is'} expected.", source)
        if known and listed is not None and not insert.args.get("conflict"):
            table_def = self.builder.table(table.name) or {"columns": []}
            given = {i.name.lower() for i in listed}
            for col in table_def["columns"]:
                if col["name"].lower() not in given and col.get("nullable") is False and "default" not in col and not col.get("primaryKey"):
                    self.report(f"Column '{col['name']}' of '{table.name}' is NOT NULL without a default but is not in the INSERT column list.", insert, "warning")
        conflict = insert.args.get("conflict")
        if known and conflict is not None:
            for key in conflict.args.get("conflict_keys") or []:
                inner = key.this if isinstance(key, exp.Ordered) else key
                if inner.name and inner.name.lower() not in lowered:
                    self.report(f"Unknown column '{inner.name}' in the ON CONFLICT target." + did_you_mean(inner.name, columns), inner)
        returning = insert.args.get("returning")
        if known and returning is not None:
            for item in returning.expressions:
                if isinstance(item, exp.Column) and not isinstance(item.this, exp.Star) and item.name.lower() not in lowered:
                    self.report(f"Unknown column '{item.name}' in RETURNING." + did_you_mean(item.name, columns), item)

    def update_delete(self, statement: exp.Update | exp.Delete) -> None:
        """Re-express UPDATE/DELETE as `SELECT <set values> FROM <target> [joins] WHERE <cond>` and check that."""
        target = statement.this
        if not isinstance(target, exp.Table):
            return
        known = self.check_table(target, [])
        columns = self.table_columns(target.name) or []
        lowered = {c.lower() for c in columns}
        probe = exp.Select(expressions=[exp.Literal.number(1)])
        probe.set("from_", exp.From(this=target.copy()))
        joins = [j.copy() for j in statement.args.get("joins") or []]
        extra = statement.args.get("from_") or statement.args.get("from")
        if isinstance(extra, exp.From):
            joins.append(exp.Join(this=extra.this.copy()))
            joins.extend(j.copy() for j in extra.args.get("joins") or [])
        for source in statement.args.get("using") or []:
            if isinstance(source, exp.Expression):
                joins.append(exp.Join(this=source.copy()))
        probe.set("joins", joins)
        if statement.args.get("where") is not None:
            probe.set("where", statement.args["where"].copy())
        if isinstance(statement, exp.Update):
            values = []
            for assignment in statement.expressions:
                if not isinstance(assignment, exp.EQ):
                    continue
                lhs = assignment.this
                if known and isinstance(lhs, exp.Column) and lhs.name.lower() not in lowered:
                    self.report(f"Unknown column '{lhs.name}' in table '{target.name}' (UPDATE ... SET)." + did_you_mean(lhs.name, columns), lhs)
                values.append(assignment.expression.copy())
            probe.set("expressions", values or [exp.Literal.number(1)])
        self._check_probe(probe)
        returning = statement.args.get("returning")
        if known and returning is not None:
            for item in returning.expressions:
                if isinstance(item, exp.Column) and not isinstance(item.this, exp.Star) and item.name.lower() not in lowered:
                    self.report(f"Unknown column '{item.name}' in RETURNING." + did_you_mean(item.name, columns), item)

    def _check_probe(self, probe: exp.Select) -> None:
        root = build_scope(probe)
        if root is None:
            return
        scopes = list(traverse_scope(probe))
        for scope in scopes:
            for source in scope.sources.values():
                if isinstance(source, exp.Table) and source is not probe.args["from_"].this:
                    self.check_table(source, [])
        for scope in scopes:
            self.check_scope(scope)


def check_sql(sql: str, dialect: str, schema: dict[str, Any]) -> dict[str, Any]:
    checker = Checker(schema, dialect)
    try:
        statements = parse_statements(sql, dialect)
    except ParseFailure as failure:
        return {"ok": False, "issues": failure.issues}
    if not statements:
        return {"ok": False, "issues": [issue("No SQL statements found.")]}
    for statement in statements:
        checker.statement(statement)
    return {"ok": not any(i["level"] == "error" for i in checker.issues), "issues": checker.issues}
