"use client";

import type { ReactNode } from "react";
import { Button, Field } from "@/components/ui";
import { formatLoose, parseLoose } from "@/lib/sql/spec-values";
import { AGGREGATES, type QuerySpec, type SelectSpec, type SpecColumn, type SpecValue } from "@/lib/sql/types";
import { DenseInput, DenseSelect, OptionalCondition, RemoveButton, SectionLabel, ValueInput, VALUE_HINT } from "./parts";

type InsertSpec = Extract<QuerySpec, { op: "insert" }>;
type UpdateSpec = Extract<QuerySpec, { op: "update" }>;
type DeleteSpec = Extract<QuerySpec, { op: "delete" }>;
type CreateSpec = Extract<QuerySpec, { op: "create_table" }>;

export const TABLES_LIST = "sk-sql-tables";
export const COLUMNS_LIST = "sk-sql-columns";

/** A column name not yet used in `pairs` (object keys collide, so two blank rows would merge into one). */
const freshKey = (pairs: [string, SpecValue][]): string => {
  const used = new Set(pairs.map(([k]) => k));
  let n = pairs.length + 1;
  while (used.has(`column_${n}`)) n += 1;
  return `column_${n}`;
};

const csv = (text: string): string[] => text.split(",").map((s) => s.trim()).filter(Boolean);

function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

/* ------------------------------------------------------------------ select */

type ColumnRow = { text: string; agg: "" | (typeof AGGREGATES)[number]; distinct: boolean; as: string };

function toRow(column: SpecColumn): ColumnRow {
  if (typeof column === "string") return { text: column, agg: "", distinct: false, as: "" };
  const expr = column.expr;
  const text = typeof expr === "object" && expr !== null && "col" in expr ? expr.col : formatLoose(expr);
  return { text, agg: column.agg ?? "", distinct: column.distinct ?? false, as: column.as ?? "" };
}

function toColumn(row: ColumnRow): SpecColumn {
  if (!row.agg && !row.as && !row.distinct) return row.text;
  const expr: SpecValue = /^[=:'@]/.test(row.text.trim()) ? parseLoose(row.text) : { col: row.text };
  return { expr, ...(row.agg ? { agg: row.agg } : {}), ...(row.as ? { as: row.as } : {}), ...(row.distinct ? { distinct: true } : {}) };
}

function tableRefText(ref: SelectSpec["from"]): { name: string; as: string } {
  return typeof ref === "string" ? { name: ref, as: "" } : { name: ref.name, as: ref.as ?? "" };
}
const tableRefValue = (name: string, alias: string): SelectSpec["from"] => (alias ? { name, as: alias } : name);

const exprText = (v: SpecValue): string => (typeof v === "object" && v !== null && "col" in v ? v.col : formatLoose(v));
const exprValue = (text: string): SpecValue => (/^[=:'@]/.test(text.trim()) ? parseLoose(text) : { col: text });

export function SelectForm({ spec, onChange }: { spec: SelectSpec; onChange: (next: SelectSpec) => void }) {
  const from = tableRefText(spec.from);
  const rows = (spec.columns ?? []).map(toRow);
  const setRows = (next: ColumnRow[]) => onChange({ ...spec, columns: next.map(toColumn) });
  const joins = spec.joins ?? [];
  const orderBy = spec.orderBy ?? [];
  const patch = (changes: Partial<SelectSpec>) => onChange({ ...spec, ...changes });

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <SectionLabel>From</SectionLabel>
        <Row>
          <DenseInput aria-label="From table" list={TABLES_LIST} placeholder="table" className="w-48" value={from.name} onChange={(e) => patch({ from: tableRefValue(e.target.value, from.as) })} />
          <DenseInput aria-label="From table alias" placeholder="alias (optional)" className="w-36" value={from.as} onChange={(e) => patch({ from: tableRefValue(from.name, e.target.value) })} />
          <label className="flex cursor-pointer items-center gap-1.5 text-sm text-muted">
            <input type="checkbox" className="size-4 accent-[var(--c-accent)]" checked={spec.distinct ?? false} onChange={(e) => patch({ distinct: e.target.checked || undefined })} />
            Distinct rows
          </label>
        </Row>
      </div>

      <div className="space-y-2">
        <SectionLabel hint="Use * for all columns. Pick an aggregate to count/sum/avg/min/max a column.">Columns</SectionLabel>
        {rows.map((row, i) => (
          <Row key={i}>
            <DenseInput aria-label={`Column ${i + 1} expression`} list={COLUMNS_LIST} placeholder="column or *" className="w-44" value={row.text} onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, text: e.target.value } : r)))} />
            <DenseSelect aria-label={`Column ${i + 1} aggregate`} value={row.agg} onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, agg: e.target.value as ColumnRow["agg"] } : r)))}>
              <option value="">no aggregate</option>
              {AGGREGATES.map((a) => <option key={a} value={a}>{a.toUpperCase()}</option>)}
            </DenseSelect>
            {row.agg ? (
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted">
                <input type="checkbox" className="size-4 accent-[var(--c-accent)]" checked={row.distinct} aria-label={`Column ${i + 1} distinct`} onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, distinct: e.target.checked } : r)))} />
                distinct
              </label>
            ) : null}
            <DenseInput aria-label={`Column ${i + 1} alias`} placeholder="alias (optional)" className="w-36" value={row.as} onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, as: e.target.value } : r)))} />
            <RemoveButton label={`Remove column ${i + 1}`} onClick={() => setRows(rows.filter((_, j) => j !== i))} />
          </Row>
        ))}
        <Button size="sm" onClick={() => setRows([...rows, { text: "", agg: "", distinct: false, as: "" }])}>Add column</Button>
      </div>

      <div className="space-y-2">
        <SectionLabel>Joins</SectionLabel>
        {joins.map((join, i) => {
          const table = tableRefText(join.table);
          const setJoin = (changes: Partial<(typeof joins)[number]>) => patch({ joins: joins.map((j, k) => (k === i ? { ...j, ...changes } : j)) });
          return (
            <div key={i} role="group" aria-label={`Join ${i + 1}`} className="space-y-2 rounded-lg border border-line p-2.5">
              <Row>
                <DenseSelect aria-label={`Join ${i + 1} type`} value={join.type ?? "inner"} onChange={(e) => setJoin({ type: e.target.value as "inner" })}>
                  {["inner", "left", "right", "full", "cross"].map((t) => <option key={t} value={t}>{t.toUpperCase()} JOIN</option>)}
                </DenseSelect>
                <DenseInput aria-label={`Join ${i + 1} table`} list={TABLES_LIST} placeholder="table" className="w-44" value={table.name} onChange={(e) => setJoin({ table: tableRefValue(e.target.value, table.as) })} />
                <DenseInput aria-label={`Join ${i + 1} table alias`} placeholder="alias" className="w-28" value={table.as} onChange={(e) => setJoin({ table: tableRefValue(table.name, e.target.value) })} />
                <RemoveButton label={`Remove join ${i + 1}`} onClick={() => patch({ joins: joins.filter((_, k) => k !== i) })} />
              </Row>
              {join.type === "cross" ? null : (
                <OptionalCondition label={`Join ${i + 1} on`} columnsList={COLUMNS_LIST} addLabel={`Add ON condition for join ${i + 1}`} value={join.on} onChange={(next) => setJoin({ on: next })} />
              )}
            </div>
          );
        })}
        <Button size="sm" onClick={() => patch({ joins: [...joins, { type: "inner", table: "" }] })}>Add join</Button>
        {joins.length ? <p className="text-xs text-faint">{VALUE_HINT} (use @alias.column to compare two columns)</p> : null}
      </div>

      <div className="space-y-2">
        <SectionLabel hint={VALUE_HINT}>Where</SectionLabel>
        <OptionalCondition label="Where" columnsList={COLUMNS_LIST} addLabel="Add where condition" value={spec.where} onChange={(next) => patch({ where: next })} />
      </div>

      <div className="space-y-2">
        <SectionLabel>Group by and having</SectionLabel>
        <DenseInput aria-label="Group by columns (comma separated)" list={COLUMNS_LIST} placeholder="c.name, c.country" className="w-full" value={(spec.groupBy ?? []).map(exprText).join(", ")} onChange={(e) => patch({ groupBy: csv(e.target.value).map(exprValue) })} />
        <OptionalCondition label="Having" columnsList={COLUMNS_LIST} addLabel="Add having condition" value={spec.having} onChange={(next) => patch({ having: next })} />
      </div>

      <div className="space-y-2">
        <SectionLabel>Order by</SectionLabel>
        {orderBy.map((order, i) => {
          const setOrder = (changes: Partial<(typeof orderBy)[number]>) => patch({ orderBy: orderBy.map((o, k) => (k === i ? { ...o, ...changes } : o)) });
          return (
            <Row key={i}>
              <DenseInput aria-label={`Order ${i + 1} column`} list={COLUMNS_LIST} placeholder="column" className="w-44" value={exprText(order.expr)} onChange={(e) => setOrder({ expr: exprValue(e.target.value) })} />
              <DenseSelect aria-label={`Order ${i + 1} direction`} value={order.dir ?? "asc"} onChange={(e) => setOrder({ dir: e.target.value as "asc" | "desc" })}>
                <option value="asc">ascending</option>
                <option value="desc">descending</option>
              </DenseSelect>
              <DenseSelect aria-label={`Order ${i + 1} nulls`} value={order.nulls ?? ""} onChange={(e) => setOrder({ nulls: (e.target.value || undefined) as "first" | "last" | undefined })}>
                <option value="">nulls: default</option>
                <option value="first">nulls first</option>
                <option value="last">nulls last</option>
              </DenseSelect>
              <RemoveButton label={`Remove order ${i + 1}`} onClick={() => patch({ orderBy: orderBy.filter((_, k) => k !== i) })} />
            </Row>
          );
        })}
        <Button size="sm" onClick={() => patch({ orderBy: [...orderBy, { expr: { col: "" }, dir: "asc" }] })}>Add order</Button>
      </div>

      <Row>
        <Field label="Limit" className="w-28">
          <DenseInput aria-label="Limit" inputMode="numeric" className="w-full" value={spec.limit ?? ""} onChange={(e) => patch({ limit: /^\d+$/.test(e.target.value) ? Number(e.target.value) : undefined })} />
        </Field>
        <Field label="Offset" className="w-28">
          <DenseInput aria-label="Offset" inputMode="numeric" className="w-full" value={spec.offset ?? ""} onChange={(e) => patch({ offset: /^\d+$/.test(e.target.value) ? Number(e.target.value) : undefined })} />
        </Field>
      </Row>
    </div>
  );
}

/* ------------------------------------------------------------------ insert */

export function InsertForm({ spec, onChange }: { spec: InsertSpec; onChange: (next: InsertSpec) => void }) {
  const patch = (changes: Partial<InsertSpec>) => onChange({ ...spec, ...changes });
  const setCell = (r: number, c: number, v: SpecValue) => patch({ rows: spec.rows.map((row, i) => (i === r ? row.map((cell, j) => (j === c ? v : cell)) : row)) });
  const setColumns = (columns: string[]) => {
    const width = Math.max(columns.length, 1);
    patch({ columns: columns.length ? columns : [""], rows: spec.rows.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? "")) });
  };
  const conflict = spec.onConflict;
  const setPairs = (pairs: [string, SpecValue][]) => patch({ onConflict: conflict ? { ...conflict, set: Object.fromEntries(pairs) } : undefined });
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <SectionLabel>Table and columns</SectionLabel>
        <Row>
          <DenseInput aria-label="Insert into table" list={TABLES_LIST} placeholder="table" className="w-48" value={spec.table} onChange={(e) => patch({ table: e.target.value })} />
          <DenseInput aria-label="Insert columns (comma separated)" list={COLUMNS_LIST} placeholder="sku, title, price" className="w-72 max-w-full" value={spec.columns.join(", ")} onChange={(e) => setColumns(csv(e.target.value))} />
        </Row>
      </div>
      <div className="space-y-2">
        <SectionLabel hint={VALUE_HINT}>Rows</SectionLabel>
        {spec.rows.map((row, r) => (
          <Row key={r}>
            <span className="w-6 text-xs text-faint">{r + 1}.</span>
            {spec.columns.map((column, c) => (
              <ValueInput key={c} label={`Row ${r + 1} ${column || `column ${c + 1}`}`} className="w-32" value={row[c]} onChange={(v) => setCell(r, c, v)} />
            ))}
            <RemoveButton label={`Remove row ${r + 1}`} onClick={() => spec.rows.length > 1 && patch({ rows: spec.rows.filter((_, i) => i !== r) })} />
          </Row>
        ))}
        <Button size="sm" onClick={() => patch({ rows: [...spec.rows, spec.columns.map(() => "")] })}>Add row</Button>
      </div>
      <div className="space-y-2">
        <SectionLabel>On conflict (upsert)</SectionLabel>
        {conflict ? (
          <div className="space-y-2">
            <Row>
              <DenseInput aria-label="Conflict target columns (comma separated)" placeholder="sku" className="w-48" value={conflict.target.join(", ")} onChange={(e) => patch({ onConflict: { ...conflict, target: csv(e.target.value) } })} />
              <DenseSelect aria-label="Conflict action" value={conflict.action} onChange={(e) => patch({ onConflict: { ...conflict, action: e.target.value as "nothing" | "update" } })}>
                <option value="nothing">do nothing</option>
                <option value="update">update the row</option>
              </DenseSelect>
              <RemoveButton label="Remove on-conflict clause" onClick={() => patch({ onConflict: undefined })} />
            </Row>
            {conflict.action === "update" ? (
              <>
                {Object.entries(conflict.set ?? {}).map(([key, value], i, all) => (
                  <Row key={i}>
                    <DenseInput aria-label={`Conflict set ${i + 1} column`} className="w-40" value={key} onChange={(e) => setPairs(all.map(([k, v], j) => (j === i ? [e.target.value, v] : [k, v])))} />
                    <span className="text-xs text-faint">=</span>
                    <ValueInput label={`Conflict set ${i + 1} value`} className="w-40" value={value} onChange={(v) => setPairs(all.map(([k, old], j) => (j === i ? [k, v] : [k, old])))} />
                    <RemoveButton label={`Remove conflict set ${i + 1}`} onClick={() => setPairs(all.filter((_, j) => j !== i))} />
                  </Row>
                ))}
                <Button size="sm" onClick={() => setPairs([...Object.entries(conflict.set ?? {}), [freshKey(Object.entries(conflict.set ?? {})), ""]])}>Add column to update</Button>
              </>
            ) : null}
          </div>
        ) : (
          <Button size="sm" onClick={() => patch({ onConflict: { target: [spec.columns[0] ?? ""], action: "nothing" } })}>Add on-conflict clause</Button>
        )}
      </div>
      <Field label="Returning columns (comma separated, optional)">
        <DenseInput aria-label="Returning columns (comma separated)" className="w-full" value={(spec.returning ?? []).join(", ")} onChange={(e) => patch({ returning: csv(e.target.value).length ? csv(e.target.value) : undefined })} />
      </Field>
    </div>
  );
}

/* ------------------------------------------------------------------ update */

export function UpdateForm({ spec, onChange }: { spec: UpdateSpec; onChange: (next: UpdateSpec) => void }) {
  const patch = (changes: Partial<UpdateSpec>) => onChange({ ...spec, ...changes });
  const pairs = Object.entries(spec.set);
  const setPairs = (next: [string, SpecValue][]) => patch({ set: Object.fromEntries(next) });
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <SectionLabel>Table</SectionLabel>
        <DenseInput aria-label="Update table" list={TABLES_LIST} placeholder="table" className="w-48" value={spec.table} onChange={(e) => patch({ table: e.target.value })} />
      </div>
      <div className="space-y-2">
        <SectionLabel hint={VALUE_HINT}>Set</SectionLabel>
        {pairs.map(([key, value], i) => (
          <Row key={i}>
            <DenseInput aria-label={`Set ${i + 1} column`} list={COLUMNS_LIST} className="w-40" value={key} onChange={(e) => setPairs(pairs.map(([k, v], j) => (j === i ? [e.target.value, v] : [k, v])))} />
            <span className="text-xs text-faint">=</span>
            <ValueInput label={`Set ${i + 1} value`} className="w-48" value={value} onChange={(v) => setPairs(pairs.map(([k, old], j) => (j === i ? [k, v] : [k, old])))} />
            <RemoveButton label={`Remove set ${i + 1}`} onClick={() => setPairs(pairs.filter((_, j) => j !== i))} />
          </Row>
        ))}
        <Button size="sm" onClick={() => setPairs([...pairs, [freshKey(pairs), ""]])}>Add column to set</Button>
      </div>
      <div className="space-y-2">
        <SectionLabel hint="Without a where condition every row is updated.">Where</SectionLabel>
        <OptionalCondition label="Where" columnsList={COLUMNS_LIST} addLabel="Add where condition" value={spec.where} onChange={(next) => patch({ where: next })} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ delete */

export function DeleteForm({ spec, onChange }: { spec: DeleteSpec; onChange: (next: DeleteSpec) => void }) {
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <SectionLabel>Table</SectionLabel>
        <DenseInput aria-label="Delete from table" list={TABLES_LIST} placeholder="table" className="w-48" value={spec.table} onChange={(e) => onChange({ ...spec, table: e.target.value })} />
      </div>
      <div className="space-y-2">
        <SectionLabel hint="Without a where condition every row is deleted.">Where</SectionLabel>
        <OptionalCondition label="Where" columnsList={COLUMNS_LIST} addLabel="Add where condition" value={spec.where} onChange={(next) => onChange({ ...spec, where: next })} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ create table */

export function CreateTableForm({ spec, onChange }: { spec: CreateSpec; onChange: (next: CreateSpec) => void }) {
  const patch = (changes: Partial<CreateSpec>) => onChange({ ...spec, ...changes });
  const setColumn = (i: number, changes: Partial<CreateSpec["columns"][number]>) => patch({ columns: spec.columns.map((c, j) => (j === i ? { ...c, ...changes } : c)) });
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <SectionLabel>Table</SectionLabel>
        <Row>
          <DenseInput aria-label="New table name" placeholder="table name" className="w-48" value={spec.name} onChange={(e) => patch({ name: e.target.value })} />
          <label className="flex cursor-pointer items-center gap-1.5 text-sm text-muted">
            <input type="checkbox" className="size-4 accent-[var(--c-accent)]" checked={spec.ifNotExists ?? false} onChange={(e) => patch({ ifNotExists: e.target.checked || undefined })} />
            IF NOT EXISTS
          </label>
        </Row>
      </div>
      <div className="space-y-2">
        <SectionLabel hint="Use portable types (integer, text, varchar(80), timestamp); the compiler maps them per dialect.">Columns</SectionLabel>
        {spec.columns.map((column, i) => (
          <div key={i} role="group" aria-label={`Column ${i + 1}`} className="space-y-2 rounded-lg border border-line p-2.5">
            <Row>
              <DenseInput aria-label={`Column ${i + 1} name`} placeholder="name" className="w-36" value={column.name} onChange={(e) => setColumn(i, { name: e.target.value })} />
              <DenseInput aria-label={`Column ${i + 1} type`} placeholder="type" className="w-32" value={column.type} onChange={(e) => setColumn(i, { type: e.target.value })} />
              {([["primaryKey", "primary key"], ["unique", "unique"], ["autoIncrement", "auto-increment"]] as const).map(([key, text]) => (
                <label key={key} className="flex cursor-pointer items-center gap-1.5 text-xs text-muted">
                  <input type="checkbox" className="size-4 accent-[var(--c-accent)]" aria-label={`Column ${i + 1} ${text}`} checked={column[key] ?? false} onChange={(e) => setColumn(i, { [key]: e.target.checked || undefined })} />
                  {text}
                </label>
              ))}
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted">
                <input type="checkbox" className="size-4 accent-[var(--c-accent)]" aria-label={`Column ${i + 1} not null`} checked={column.nullable === false} onChange={(e) => setColumn(i, { nullable: e.target.checked ? false : undefined })} />
                not null
              </label>
              <RemoveButton label={`Remove column ${i + 1}`} onClick={() => patch({ columns: spec.columns.filter((_, j) => j !== i) })} />
            </Row>
            <Row>
              <ValueInput label={`Column ${i + 1} default`} className="w-40" value={column.default} onChange={(v) => setColumn(i, { default: v === "" ? undefined : v })} />
              <span className="text-xs text-faint">default</span>
              <DenseInput aria-label={`Column ${i + 1} references table`} list={TABLES_LIST} placeholder="references table" className="w-40" value={column.references?.table ?? ""} onChange={(e) => setColumn(i, { references: e.target.value ? { table: e.target.value, column: column.references?.column ?? "id", onDelete: column.references?.onDelete } : undefined })} />
              {column.references ? (
                <>
                  <DenseInput aria-label={`Column ${i + 1} references column`} placeholder="column" className="w-28" value={column.references.column} onChange={(e) => setColumn(i, { references: { ...column.references!, column: e.target.value } })} />
                  <DenseSelect aria-label={`Column ${i + 1} on delete`} value={column.references.onDelete ?? ""} onChange={(e) => setColumn(i, { references: { ...column.references!, onDelete: (e.target.value || undefined) as undefined } })}>
                    <option value="">on delete: default</option>
                    {["cascade", "restrict", "set null", "no action"].map((o) => <option key={o} value={o}>{`on delete ${o}`}</option>)}
                  </DenseSelect>
                </>
              ) : null}
            </Row>
          </div>
        ))}
        <Button size="sm" onClick={() => patch({ columns: [...spec.columns, { name: "", type: "text" }] })}>Add column</Button>
      </div>
      <Field label="Composite primary key (comma separated, optional)">
        <DenseInput aria-label="Composite primary key columns" className="w-full" value={(spec.primaryKey ?? []).join(", ")} onChange={(e) => patch({ primaryKey: csv(e.target.value).length ? csv(e.target.value) : undefined })} />
      </Field>
    </div>
  );
}
