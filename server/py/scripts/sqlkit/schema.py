"""DDL -> SqlSchema (+ Mermaid erDiagram)."""
from __future__ import annotations

import re
from typing import Any

from sqlglot import exp

from .common import Issue, issue, parse_statements, sg_name, ParseFailure


def _name(node: exp.Expression | None) -> str:
    return node.name if node is not None else ""


def _table_key(table: exp.Table) -> str:
    return table.name  # schema-qualified names are matched by their last part


def _type_text(dtype: exp.DataType | None, dialect: str) -> str | None:
    return dtype.sql(dialect=sg_name(dialect)) if isinstance(dtype, exp.DataType) else None


class SchemaBuilder:
    def __init__(self, dialect: str) -> None:
        self.dialect = dialect
        self.tables: dict[str, dict[str, Any]] = {}
        self.issues: list[Issue] = []

    def result(self) -> dict[str, Any]:
        return {"tables": list(self.tables.values())}

    def table(self, name: str) -> dict[str, Any] | None:
        for key, value in self.tables.items():
            if key.lower() == name.lower():
                return value
        return None

    # --- one statement
    def apply(self, statement: exp.Expression) -> None:
        if isinstance(statement, exp.Create) and str(statement.args.get("kind", "")).upper() == "TABLE" and isinstance(statement.this, exp.Schema):
            self._create_table(statement)
        elif isinstance(statement, exp.Create) and str(statement.args.get("kind", "")).upper() == "INDEX":
            self._create_index(statement)
        elif isinstance(statement, exp.Alter):
            self._alter(statement)
        elif isinstance(statement, exp.Drop) and str(statement.args.get("kind", "")).upper() == "TABLE":
            for target in [statement.this] if isinstance(statement.this, exp.Table) else []:
                self.tables.pop(next((k for k in self.tables if k.lower() == target.name.lower()), ""), None)
        elif isinstance(statement, (exp.Select, exp.Insert, exp.Update, exp.Delete)):
            self.issues.append(issue("Ignored a data statement (only CREATE/ALTER/DROP TABLE and CREATE INDEX shape the schema).", "warning"))

    def _column(self, definition: exp.ColumnDef) -> tuple[dict[str, Any], dict[str, Any] | None, bool]:
        col: dict[str, Any] = {"name": _name(definition.this)}
        type_text = _type_text(definition.args.get("kind"), self.dialect)
        if type_text:
            col["type"] = type_text
        nullable = True
        pk = unique = False
        fk: dict[str, Any] | None = None
        for constraint in definition.args.get("constraints") or []:
            kind = constraint.args.get("kind") if isinstance(constraint, exp.ColumnConstraint) else None
            if isinstance(kind, exp.NotNullColumnConstraint):
                nullable = bool(kind.args.get("allow_null"))
            elif isinstance(kind, exp.PrimaryKeyColumnConstraint):
                pk = True
            elif isinstance(kind, exp.UniqueColumnConstraint):
                unique = True
            elif isinstance(kind, exp.DefaultColumnConstraint):
                col["default"] = kind.this.sql(dialect=sg_name(self.dialect))
            elif isinstance(kind, exp.Reference):
                target = kind.this
                if isinstance(target, exp.Schema) and isinstance(target.this, exp.Table):
                    fk = {"columns": [col["name"]], "refTable": _table_key(target.this), "refColumns": [_name(c) for c in target.expressions] or []}
        col["nullable"] = False if pk else nullable
        if pk:
            col["primaryKey"] = True
        if unique:
            col["unique"] = True
        return col, fk, pk

    def _create_table(self, statement: exp.Create) -> None:
        schema = statement.this
        name = _table_key(schema.this)
        table: dict[str, Any] = {"name": name, "columns": []}
        pk_cols: list[str] = []
        fks: list[dict[str, Any]] = []
        for item in schema.expressions:
            if isinstance(item, exp.ColumnDef):
                col, fk, pk = self._column(item)
                table["columns"].append(col)
                if pk:
                    pk_cols.append(col["name"])
                if fk:
                    fks.append(fk)
            elif isinstance(item, exp.PrimaryKey):
                pk_cols = [_name(c) for c in item.expressions]
            elif isinstance(item, exp.Constraint):
                for inner in item.expressions:
                    self._table_constraint(inner, pk_cols, fks, table)
            elif isinstance(item, exp.ForeignKey):
                self._table_constraint(item, pk_cols, fks, table)
            elif isinstance(item, exp.UniqueColumnConstraint):
                self._mark_unique(table, [_name(c) for c in (item.this.expressions if isinstance(item.this, exp.Schema) else [])])
        self._finish_pk(table, pk_cols, fks)
        if self.table(name) is not None and not statement.args.get("exists"):
            self.issues.append(issue(f"Table '{name}' is created more than once; the later definition wins.", "warning"))
        self.tables[name] = table

    def _table_constraint(self, node: exp.Expression, pk_cols: list[str], fks: list[dict[str, Any]], table: dict[str, Any]) -> None:
        if isinstance(node, exp.PrimaryKey):
            pk_cols[:] = [_name(c) for c in node.expressions]
        elif isinstance(node, exp.ForeignKey):
            reference = node.args.get("reference")
            if isinstance(reference, exp.Reference) and isinstance(reference.this, exp.Schema) and isinstance(reference.this.this, exp.Table):
                fks.append({
                    "columns": [_name(c) for c in node.expressions],
                    "refTable": _table_key(reference.this.this),
                    "refColumns": [_name(c) for c in reference.this.expressions],
                })
        elif isinstance(node, exp.UniqueColumnConstraint):
            inner = node.this
            self._mark_unique(table, [_name(c) for c in (inner.expressions if isinstance(inner, exp.Schema) else [])])

    @staticmethod
    def _mark_unique(table: dict[str, Any], cols: list[str]) -> None:
        if len(cols) == 1:
            for col in table["columns"]:
                if col["name"].lower() == cols[0].lower():
                    col["unique"] = True

    @staticmethod
    def _finish_pk(table: dict[str, Any], pk_cols: list[str], fks: list[dict[str, Any]]) -> None:
        lowered = {c.lower() for c in pk_cols}
        for col in table["columns"]:
            if col["name"].lower() in lowered:
                col["primaryKey"] = True
                col["nullable"] = False
        if pk_cols:
            table["primaryKey"] = pk_cols
        unique_fks = [fk for i, fk in enumerate(fks) if fk not in fks[:i]]
        if unique_fks:
            table["foreignKeys"] = unique_fks

    def _create_index(self, statement: exp.Create) -> None:
        index = statement.this
        if not isinstance(index, exp.Index) or not isinstance(index.args.get("table"), exp.Table):
            return
        table = self.table(_table_key(index.args["table"]))
        params = index.args.get("params")
        cols = [_name(o.this) if isinstance(o, exp.Ordered) else _name(o) for o in (params.args.get("columns") or [] if params else [])]
        if table is None:
            self.issues.append(issue(f"CREATE INDEX {_name(index.this)} refers to unknown table '{_table_key(index.args['table'])}'.", "warning"))
            return
        table.setdefault("indexes", []).append({"name": _name(index.this), "columns": cols, "unique": bool(statement.args.get("unique"))})

    def _alter(self, statement: exp.Alter) -> None:
        target = statement.this
        if not isinstance(target, exp.Table):
            return
        table = self.table(_table_key(target))
        if table is None:
            self.issues.append(issue(f"ALTER TABLE refers to unknown table '{_table_key(target)}'.", "warning"))
            return
        for action in statement.args.get("actions") or []:
            if isinstance(action, exp.ColumnDef):
                col, fk, pk = self._column(action)
                table["columns"].append(col)
                if pk:
                    table["primaryKey"] = [col["name"]]
                if fk:
                    table.setdefault("foreignKeys", []).append(fk)
            elif isinstance(action, exp.AddConstraint):
                pk_cols = list(table.get("primaryKey", []))
                fks = list(table.get("foreignKeys", []))
                for constraint in action.expressions:
                    for inner in constraint.expressions if isinstance(constraint, exp.Constraint) else [constraint]:
                        self._table_constraint(inner, pk_cols, fks, table)
                self._finish_pk(table, pk_cols, fks)
            elif isinstance(action, exp.Drop) and str(action.args.get("kind", "")).upper() == "COLUMN":
                dropped = {_name(c).lower() for c in action.args.get("tables") or []}
                table["columns"] = [c for c in table["columns"] if c["name"].lower() not in dropped]
            elif isinstance(action, exp.RenameColumn):
                for col in table["columns"]:
                    if col["name"].lower() == _name(action.this).lower():
                        col["name"] = _name(action.args.get("to"))
            elif isinstance(action, exp.AlterRename):
                new_name = _name(action.this)
                self.tables.pop(table["name"], None)
                table["name"] = new_name
                self.tables[new_name] = table
            else:
                self.issues.append(issue(f"Ignored ALTER TABLE action {action.key.upper()} on '{table['name']}'.", "warning"))


def build_schema(ddl: str, dialect: str) -> tuple[dict[str, Any], list[Issue]]:
    builder = SchemaBuilder(dialect)
    try:
        statements = parse_statements(ddl, dialect)
    except ParseFailure as failure:
        return {"tables": []}, failure.issues
    if not statements:
        return {"tables": []}, [issue("No SQL statements found.")]
    for statement in statements:
        builder.apply(statement)
    if not builder.tables:
        builder.issues.append(issue("No CREATE TABLE statement found.", "warning"))
    for table in builder.tables.values():
        for fk in table.get("foreignKeys", []):
            ref = builder.table(fk["refTable"])
            if ref is None:
                builder.issues.append(issue(f"Foreign key on '{table['name']}' references unknown table '{fk['refTable']}'.", "warning"))
                continue
            known = {c["name"].lower() for c in ref["columns"]}
            if not fk["refColumns"] and ref.get("primaryKey"):
                fk["refColumns"] = list(ref["primaryKey"])
            for col in fk["refColumns"]:
                if col.lower() not in known:
                    builder.issues.append(issue(f"Foreign key on '{table['name']}' references unknown column '{fk['refTable']}.{col}'.", "warning"))
    return builder.result(), builder.issues


# ---------------------------------------------------------------- Mermaid

def _m_ident(name: str) -> str:
    return name if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]*", name) else '"' + name.replace('"', "'") + '"'


def _m_type(type_text: str | None) -> str:
    if not type_text:
        return "unknown"
    cleaned = re.sub(r"[^A-Za-z0-9_()\[\]-]+", "_", type_text.strip()).strip("_")
    return cleaned if cleaned and cleaned[0].isalpha() else "t_" + cleaned


def to_mermaid(schema: dict[str, Any]) -> str:
    lines = ["erDiagram"]
    for table in schema["tables"]:
        fk_cols = {c.lower() for fk in table.get("foreignKeys", []) for c in fk["columns"]}
        lines.append(f"  {_m_ident(table['name'])} {{")
        for col in table["columns"]:
            keys = [k for k, on in (("PK", col.get("primaryKey")), ("FK", col["name"].lower() in fk_cols), ("UK", col.get("unique"))) if on]
            suffix = (" " + ",".join(keys)) if keys else ""
            comment = ' "not null"' if col.get("nullable") is False and not col.get("primaryKey") else ""
            lines.append(f"    {_m_type(col.get('type'))} {_m_ident(col['name'])}{suffix}{comment}")
        lines.append("  }")
    known = {t["name"].lower() for t in schema["tables"]}
    for table in schema["tables"]:
        for fk in table.get("foreignKeys", []):
            if fk["refTable"].lower() not in known:
                continue
            nullable = any(c.get("nullable", True) for c in table["columns"] if c["name"].lower() in {x.lower() for x in fk["columns"]})
            unique = len(fk["columns"]) == 1 and any(c.get("unique") or table.get("primaryKey") == fk["columns"] for c in table["columns"] if c["name"].lower() == fk["columns"][0].lower())
            left = "||" if unique else "}o"
            right = "o|" if nullable else "||"
            lines.append(f"  {_m_ident(table['name'])} {left}--{right} {_m_ident(fk['refTable'])} : {_m_ident('_'.join(fk['columns']))}")
    return "\n".join(lines)
