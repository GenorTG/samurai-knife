"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { Button, Field, Notice, Panel, TextArea } from "@/components/ui";
import { cx, plural } from "@/lib/format";
import { callSql } from "@/lib/sql/client";
import { useStoredDialect, useStoredSchema } from "@/lib/sql/schema-store";
import type { SqlActionMap, SqlIssue } from "@/lib/sql/types";
import { CurrentSchemaRegion, DialectSelect, IssueList } from "./sql-shared";

type Validation = SqlActionMap["validate"]["out"];

const VALID_SAMPLE = `SELECT c.name, COUNT(o.id) AS orders
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
WHERE c.country = 'PL'
GROUP BY c.name
ORDER BY orders DESC;

UPDATE products SET stock = stock - 1 WHERE sku = 'KB-01';`;

const BROKEN_SAMPLE = `SELECT name, email
FROM customers
WHERE country = 'PL'
  AND created_at > '2025-01-01'
ORDER BY name
LIMT 10;`;

const UNKNOWN_SAMPLE = `SELECT c.name, c.phone, o.totl
FROM customer c
JOIN orders o ON o.customer_id = c.id;`;

/** Source listing with a caret row under each line that has a positioned issue. Pure text, so assistants read it as-is. */
function SourceListing({ sql, issues }: { sql: string; issues: SqlIssue[] }) {
  const lines = sql.split("\n");
  const width = String(lines.length).length;
  const byLine = new Map<number, SqlIssue[]>();
  for (const issue of issues) {
    if (!issue.line) continue;
    byLine.set(issue.line, [...(byLine.get(issue.line) ?? []), issue]);
  }
  return (
    <pre
      aria-label="SQL with error markers"
      data-agent-region="validation-source"
      className="sk-input max-h-[50vh] overflow-auto px-3 py-2.5 font-mono text-[12.5px] leading-relaxed whitespace-pre"
    >
      {lines.map((line, i) => {
        const number = i + 1;
        const here = byLine.get(number) ?? [];
        return (
          <Fragment key={number}>
            <span className={cx(here.length > 0 && "bg-danger/10")}>
              <span className="text-faint select-none">{String(number).padStart(width, " ")} | </span>
              {line}
              {"\n"}
            </span>
            {here.map((issue, j) => (
              <span key={j} className={issue.level === "error" ? "text-danger" : "text-warn"}>
                <span className="text-faint select-none">{" ".repeat(width)} | </span>
                {" ".repeat(Math.max(0, (issue.column ?? 1) - 1))}^ {issue.message}
                {"\n"}
              </span>
            ))}
          </Fragment>
        );
      })}
    </pre>
  );
}

export default function SqlValidate() {
  const [dialect, setDialect] = useStoredDialect("postgres");
  const [sql, setSql] = useState(VALID_SAMPLE);
  const [result, setResult] = useState<Validation | null>(null);
  const [checked, setChecked] = useState<string>(VALID_SAMPLE);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [schemaIssues, setSchemaIssues] = useState<{ ok: boolean; issues: SqlIssue[]; sql: string; dialect: string } | null>(null);
  const [schemaBusy, setSchemaBusy] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const stored = useStoredSchema();
  const ticket = useRef(0);

  const validate = async (text = sql) => {
    const mine = (ticket.current += 1);
    if (!text.trim()) {
      setResult(null);
      setError(null);
      setBusy(false); // a request still in flight is discarded below: nothing else would clear the flag
      return;
    }
    setBusy(true);
    const response = await callSql("validate", { sql: text, dialect });
    if (mine !== ticket.current) return;
    setBusy(false);
    setChecked(text);
    if (!response.ok) {
      setError(response.error);
      setResult(null);
      return;
    }
    setError(null);
    setResult(response.data);
  };

  // Validate shortly after typing stops (and on first render / dialect change).
  useEffect(() => {
    const timer = setTimeout(() => void validate(sql), 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sql, dialect]);

  const checkSchema = async () => {
    if (!stored) return;
    setSchemaBusy(true);
    setSchemaError(null);
    const response = await callSql("check", { sql, dialect, schema: stored.schema });
    setSchemaBusy(false);
    if (!response.ok) {
      setSchemaError(response.error);
      setSchemaIssues(null);
      return;
    }
    setSchemaIssues({ ...response.data, sql, dialect });
  };

  const errors = result?.issues.filter((i) => i.level === "error").length ?? 0;
  const warnings = (result?.issues.length ?? 0) - errors;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="min-w-0 space-y-4">
        <Panel title="SQL to validate">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Sample queries">
              <span className="text-xs text-faint">Samples:</span>
              <Button size="sm" onClick={() => setSql(VALID_SAMPLE)}>Sample: valid</Button>
              <Button size="sm" onClick={() => setSql(BROKEN_SAMPLE)}>Sample: syntax error</Button>
              <Button size="sm" onClick={() => setSql(UNKNOWN_SAMPLE)}>Sample: unknown names</Button>
            </div>
            <Field label="Dialect">
              <DialectSelect label="Dialect" value={dialect} onChange={setDialect} className="max-w-64" />
            </Field>
            <Field label="SQL" hint="Parsed only, never executed. Validation runs a moment after you stop typing.">
              <TextArea rows={14} spellCheck={false} value={sql} onChange={(e) => setSql(e.target.value)} placeholder="Paste one or more SQL statements…" />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => void validate()} disabled={busy}>{busy ? "Validating…" : "Validate SQL"}</Button>
              <Button variant="ghost" onClick={() => setSql("")} disabled={!sql}>Clear SQL</Button>
            </div>
          </div>
        </Panel>

        <Panel title="Check against schema">
          <div className="space-y-3">
            <CurrentSchemaRegion hint="No schema stored yet. Paste DDL in the Schema tab and choose “Use as current schema”, then check tables and columns here." />
            <Button onClick={() => void checkSchema()} disabled={!stored || schemaBusy || !sql.trim()}>{schemaBusy ? "Checking…" : "Check against schema"}</Button>
            {schemaError ? <div role="alert"><Notice tone="error">{schemaError}</Notice></div> : null}
            <div role="status" data-agent-region="schema-check">
              {schemaIssues && schemaIssues.sql === sql && schemaIssues.dialect === dialect ? (
                schemaIssues.ok && schemaIssues.issues.length === 0 ? (
                  <Notice tone="good">Every table and column exists in the current schema.</Notice>
                ) : (
                  <IssueList issues={schemaIssues.issues} />
                )
              ) : null}
            </div>
          </div>
        </Panel>
      </div>

      <div className="min-w-0 space-y-4">
        <Panel title="Result">
          <div className="space-y-3" data-agent-region="validation-result">
            {error ? <div role="alert"><Notice tone="error">{error}</Notice></div> : null}
            {!error && !result ? <p className="text-sm text-faint">Enter SQL to validate it.</p> : null}
            {result ? (
              <div role="status">
                {result.ok && result.issues.length === 0 ? (
                  <Notice tone="good">Valid {dialect} SQL: {plural(result.statements.length, "statement")}.</Notice>
                ) : (
                  <Notice tone={errors ? "error" : "warn"}>
                    {errors ? `${plural(errors, "error")}` : "No errors"}{warnings ? `, ${plural(warnings, "warning")}` : ""} found.
                  </Notice>
                )}
              </div>
            ) : null}
            {result ? <IssueList issues={result.issues} /> : null}
            {result && result.issues.length ? <SourceListing sql={checked} issues={result.issues} /> : null}
          </div>
        </Panel>

        {result && result.statements.length ? (
          <Panel title="Statements">
            <div className="overflow-auto rounded-lg border border-line" tabIndex={0} role="region" aria-label="Statement summary">
              <table className="w-full border-collapse text-[13px]">
                <thead className="bg-raised">
                  <tr>
                    {["#", "Kind", "Tables", "Columns"].map((h) => (
                      <th key={h} scope="col" className="border-b border-line-strong px-3 py-1.5 text-left font-semibold text-ink">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.statements.map((statement, i) => (
                    <tr key={i} className="odd:bg-raised/30">
                      <td className="border-b border-line px-3 py-1.5 align-top text-muted">{i + 1}</td>
                      <td className="border-b border-line px-3 py-1.5 align-top font-mono uppercase">{statement.kind}</td>
                      <td className="border-b border-line px-3 py-1.5 align-top font-mono break-words">{statement.tables.join(", ") || "—"}</td>
                      <td className="border-b border-line px-3 py-1.5 align-top font-mono break-words">{statement.columns.join(", ") || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        ) : null}
      </div>
    </div>
  );
}
