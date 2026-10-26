"use client";

import { useState } from "react";
import { Button, CopyButton, Field, Notice, Panel, TextArea } from "@/components/ui";
import { cx, downloadText } from "@/lib/format";
import { callSql } from "@/lib/sql/client";
import { SAMPLE_SCHEMAS } from "@/lib/sql/samples";
import { saveSchema, useStoredDialect } from "@/lib/sql/schema-store";
import type { SqlActionMap, SqlDialect, SqlSchema, SqlSchemaTable } from "@/lib/sql/types";
import { CurrentSchemaRegion, DialectSelect, IssueList } from "./sql-shared";
import { useT } from "@/lib/i18n/react";

type Parsed = SqlActionMap["schema"]["out"] & { dialect: SqlDialect };

function Badge({ children, tone }: { children: string; tone: "pk" | "fk" | "plain" }) {
  return (
    <span
      className={cx(
        "rounded border px-1.5 py-px font-mono text-[10.5px] font-semibold tracking-wide",
        tone === "pk" && "border-accent/50 bg-accent/10 text-accent-soft",
        tone === "fk" && "border-warn/50 bg-warn/10 text-warn",
        tone === "plain" && "border-line-strong text-muted",
      )}
    >
      {children}
    </span>
  );
}

function TableCard({ table }: { table: SqlSchemaTable }) {
  const { t } = useT();
  const fkByColumn = new Map<string, string>();
  for (const fk of table.foreignKeys ?? []) {
    fk.columns.forEach((column, i) => fkByColumn.set(column, `${fk.refTable}.${fk.refColumns[i] ?? ""}`));
  }
  return (
    <article aria-label={t("Table {name}", { name: table.name })} className="min-w-0 rounded-lg border border-line bg-surface">
      <h3 className="border-b border-line bg-raised/50 px-3 py-2 font-mono text-[13px] font-semibold text-ink">{table.name}</h3>
      <ul className="divide-y divide-line">
        {table.columns.map((column) => {
          const isPk = column.primaryKey || table.primaryKey?.includes(column.name);
          const fk = fkByColumn.get(column.name);
          return (
            <li key={column.name} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5 text-[13px]">
              <span className="font-mono font-medium text-ink">{column.name}</span>
              <span className="font-mono text-xs text-muted">{column.type || "?"}</span>
              <span className="ml-auto flex flex-wrap items-center gap-1">
                {isPk ? <Badge tone="pk">PK</Badge> : null}
                {fk ? <Badge tone="fk">{`FK → ${fk}`}</Badge> : null}
                {column.unique ? <Badge tone="plain">UNIQUE</Badge> : null}
                {column.nullable === false && !isPk ? <Badge tone="plain">NOT NULL</Badge> : null}
                {column.default ? <Badge tone="plain">{`DEFAULT ${column.default}`}</Badge> : null}
              </span>
            </li>
          );
        })}
      </ul>
      {table.indexes?.length ? (
        <p className="border-t border-line px-3 py-1.5 font-mono text-[11.5px] text-muted">
          {table.indexes.map((index) => `${index.unique ? "unique " : ""}index ${index.name} (${index.columns.join(", ")})`).join("; ")}
        </p>
      ) : null}
    </article>
  );
}

export default function SqlSchemaTab() {
  const { t, tn } = useT();
  const [dialect, setDialect] = useStoredDialect("postgres");
  const [ddl, setDdl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const parse = async (text = ddl, forDialect: SqlDialect = dialect) => {
    if (!text.trim()) {
      setError(t("Paste CREATE TABLE statements first."));
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(null);
    const response = await callSql("schema", { ddl: text, dialect: forDialect });
    setBusy(false);
    if (!response.ok) {
      setError(response.error);
      setParsed(null);
      return;
    }
    setParsed({ ...response.data, dialect: forDialect });
  };

  const loadSample = (id: string) => {
    const sample = SAMPLE_SCHEMAS.find((s) => s.id === id);
    if (!sample) return;
    setDdl(sample.ddl);
    setDialect(sample.dialect as SqlDialect);
    void parse(sample.ddl, sample.dialect as SqlDialect);
  };

  const saveAsCurrent = (schema: SqlSchema, source: string) => {
    saveSchema(schema, source);
    setSaved(t("Saved {tables} as the current schema. Validate, Build and Run now use it.", { tables: tn("{n} table", "{n} tables", schema.tables.length) }));
  };

  const schemaJson = parsed ? JSON.stringify(parsed.schema, null, 2) : "";
  const tableCount = parsed?.schema.tables.length ?? 0;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <div className="min-w-0 space-y-4">
        <Panel title="DDL">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("Sample schemas")}>
              <span className="text-xs text-faint">{t("Samples:")}</span>
              {SAMPLE_SCHEMAS.map((sample) => (
                <Button key={sample.id} size="sm" onClick={() => loadSample(sample.id)} title={t(sample.label)}>{`Sample: ${sample.id}`}</Button>
              ))}
            </div>
            <Field label={t("Dialect of the DDL")}>
              <DialectSelect label={t("Dialect of the DDL")} value={dialect} onChange={setDialect} className="max-w-64" />
            </Field>
            <Field label={t("CREATE TABLE statements")} hint={t("Paste DDL from a dump, migration or pg_dump -s. Nothing is executed; it is only parsed.")}>
              <TextArea rows={16} spellCheck={false} value={ddl} onChange={(e) => setDdl(e.target.value)} placeholder={t("CREATE TABLE users (id integer primary key, ...);")} />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => void parse()} disabled={busy}>{busy ? t("Parsing…") : t("Parse DDL")}</Button>
              <Button variant="ghost" onClick={() => { setDdl(""); setParsed(null); setError(null); setSaved(null); }} disabled={!ddl && !parsed}>{t("Clear DDL")}</Button>
            </div>
            {error ? <div role="alert"><Notice tone="error">{error}</Notice></div> : null}
          </div>
        </Panel>
        <CurrentSchemaRegion />
      </div>

      <div className="min-w-0 space-y-4">
        <Panel
          title={parsed ? `Tables (${tableCount})` : t("Tables")}
          right={
            parsed ? (
              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" variant="primary" onClick={() => saveAsCurrent(parsed.schema, `pasted DDL, ${parsed.dialect}`)} disabled={tableCount === 0}>{t("Use as current schema")}</Button>
                <CopyButton text={schemaJson} label={t("Copy schema JSON")} />
              </div>
            ) : null
          }
        >
          <div className="space-y-3" data-agent-region="schema-tables">
            {saved ? <div role="status"><Notice tone="good">{saved}</Notice></div> : null}
            {parsed ? <IssueList issues={parsed.issues} /> : null}
            {!parsed ? <p className="text-sm text-faint">{t("Parse some DDL to see tables, columns, keys and an ER diagram.")}</p> : null}
            {parsed && tableCount === 0 ? <Notice tone="warn">{t("No CREATE TABLE statements were found in that DDL.")}</Notice> : null}
            <div className="grid gap-3 xl:grid-cols-2">
              {parsed?.schema.tables.map((table) => <TableCard key={table.name} table={table} />)}
            </div>
          </div>
        </Panel>

        <Panel
          title={t("ER diagram (Mermaid source)")}
          right={
            <div className="flex gap-1.5">
              <CopyButton text={parsed?.mermaid ?? ""} label={t("Copy Mermaid")} />
              <Button size="sm" disabled={!parsed?.mermaid} onClick={() => downloadText(parsed?.mermaid ?? "", "schema.mmd")}>{t("Download .mmd")}</Button>
            </div>
          }
        >
          <pre aria-label={t("Mermaid erDiagram source")} data-agent-region="mermaid" className="sk-input max-h-[50vh] min-h-24 overflow-auto px-3 py-2.5 font-mono text-[12.5px] leading-relaxed whitespace-pre">
            {parsed?.mermaid || <span className="text-faint">{t("The diagram source appears here. Paste it into any Mermaid renderer.")}</span>}
          </pre>
        </Panel>
      </div>
    </div>
  );
}
