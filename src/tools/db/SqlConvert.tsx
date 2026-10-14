"use client";

import { useEffect, useRef, useState } from "react";
import { Button, CopyButton, Field, Notice, Panel, TextArea } from "@/components/ui";
import { downloadText, plural } from "@/lib/format";
import { callSql } from "@/lib/sql/client";
import { useStoredDialect } from "@/lib/sql/schema-store";
import type { SqlDialect, SqlIssue } from "@/lib/sql/types";
import { DialectSelect, IssueList } from "./sql-shared";

interface Example {
  label: string;
  from: SqlDialect;
  to: SqlDialect;
  sql: string;
}

const EXAMPLES: Example[] = [
  {
    label: "SQLite → Postgres: upsert",
    from: "sqlite",
    to: "postgres",
    sql: "INSERT INTO page_hits (path, hits, last_seen) VALUES ('/home', 1, datetime('now'))\nON CONFLICT(path) DO UPDATE SET hits = hits + 1, last_seen = datetime('now');",
  },
  {
    label: "MySQL → T-SQL: LIMIT and AUTO_INCREMENT",
    from: "mysql",
    to: "tsql",
    sql: "CREATE TABLE users (\n  id INT AUTO_INCREMENT PRIMARY KEY,\n  name VARCHAR(80) NOT NULL,\n  created_at DATETIME DEFAULT CURRENT_TIMESTAMP\n);\n\nSELECT id, name FROM users ORDER BY created_at DESC LIMIT 10 OFFSET 20;",
  },
  {
    label: "Postgres → MySQL: ILIKE, casts, now()",
    from: "postgres",
    to: "mysql",
    sql: "SELECT id::text AS id, created_at::date AS day\nFROM events\nWHERE name ILIKE '%launch%' AND created_at > now() - interval '7 days';",
  },
  {
    label: "Oracle → Postgres: NVL, SYSDATE, FETCH FIRST",
    from: "oracle",
    to: "postgres",
    sql: "SELECT NVL(nickname, name) AS shown_name, SYSDATE AS today\nFROM employees\nFETCH FIRST 5 ROWS ONLY;",
  },
  {
    label: "T-SQL → SQLite: TOP, ISNULL, GETDATE",
    from: "tsql",
    to: "sqlite",
    sql: "SELECT TOP 10 name, ISNULL(email, 'n/a') AS email, GETDATE() AS fetched_at\nFROM dbo.users\nORDER BY name;",
  },
  {
    label: "BigQuery → Snowflake: backticks and DATE_TRUNC",
    from: "bigquery",
    to: "snowflake",
    sql: "SELECT DATE_TRUNC(order_date, MONTH) AS month, COUNT(*) AS orders\nFROM `shop.sales.orders`\nGROUP BY month\nORDER BY month;",
  },
];

export default function SqlConvert() {
  const [from, setFrom] = useStoredDialect("sqlite");
  const [to, setTo] = useState<SqlDialect>("postgres");
  const [sql, setSql] = useState(EXAMPLES[0].sql);
  const [pretty, setPretty] = useState(true);
  const [output, setOutput] = useState("");
  const [issues, setIssues] = useState<SqlIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [converted, setConverted] = useState(false);
  const ticket = useRef(0);

  const convert = async () => {
    const mine = (ticket.current += 1);
    if (!sql.trim()) {
      setOutput("");
      setIssues([]);
      setError(null);
      setConverted(false);
      setBusy(false); // a request still in flight is discarded below: nothing else would clear the flag
      return;
    }
    setBusy(true);
    const response = await callSql("transpile", { sql, from, to, pretty });
    if (mine !== ticket.current) return;
    setBusy(false);
    if (!response.ok) {
      setError(response.error);
      setOutput("");
      setIssues([]);
      setConverted(false);
      return;
    }
    setError(null);
    setOutput(response.data.sql);
    setIssues(response.data.issues);
    setConverted(true);
  };

  useEffect(() => {
    const timer = setTimeout(() => void convert(), 500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sql, from, to, pretty]);

  const errors = issues.filter((i) => i.level === "error").length;
  const warnings = issues.length - errors;
  const filename = `converted-${to}.sql`;

  return (
    <div className="space-y-4">
      <Panel title="Dialects">
        <div className="grid items-end gap-3 sm:grid-cols-[1fr_auto_1fr]">
          <Field label="Convert from">
            <DialectSelect label="Convert from" value={from} onChange={setFrom} />
          </Field>
          <Button onClick={() => { setFrom(to); setTo(from); }} aria-label="Swap the from and to dialects">Swap dialects</Button>
          <Field label="Convert to">
            <DialectSelect label="Convert to" value={to} onChange={setTo} />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="Examples">
          <span className="text-xs text-faint">Examples:</span>
          {EXAMPLES.map((example) => (
            <Button key={example.label} size="sm" className="h-auto! min-h-7 max-w-full py-1 text-left whitespace-normal!" onClick={() => { setFrom(example.from); setTo(example.to); setSql(example.sql); }}>
              {example.label}
            </Button>
          ))}
        </div>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Input SQL"
          right={
            <div className="flex gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => { setSql(output.replace(/;\s*$/, ";")); setFrom(to); setTo(from); }} disabled={!output}>Use output as input</Button>
              <Button size="sm" variant="ghost" onClick={() => setSql("")} disabled={!sql}>Clear SQL</Button>
            </div>
          }
        >
          <Field label="SQL to convert" hint="Parsed in the source dialect and re-written for the target. Never executed.">
            <TextArea rows={14} spellCheck={false} value={sql} onChange={(e) => setSql(e.target.value)} placeholder="Paste SQL written for the source dialect…" />
          </Field>
        </Panel>

        <Panel
          title="Converted SQL"
          right={
            <div className="flex gap-1.5">
              <CopyButton text={output} label="Copy converted SQL" />
              <Button size="sm" disabled={!output} onClick={() => downloadText(output.endsWith("\n") ? output : `${output}\n`, filename, "application/sql")}>Download .sql</Button>
            </div>
          }
        >
          <div className="space-y-3">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-muted">
              <input type="checkbox" checked={pretty} onChange={(e) => setPretty(e.target.checked)} className="size-4 accent-[var(--c-accent)]" />
              Pretty-print the output
            </label>
            <pre
              aria-label="Converted SQL"
              data-agent-region="converted-sql"
              className="sk-input max-h-[60vh] min-h-56 overflow-auto px-3 py-2.5 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words"
            >
              {output || <span className="text-faint">{busy ? "Converting…" : "The converted SQL appears here."}</span>}
            </pre>
            {error ? <div role="alert"><Notice tone="error">{error}</Notice></div> : null}
            {from === to ? <Notice tone="info">Source and target are the same dialect: this just re-formats the SQL.</Notice> : null}
          </div>
        </Panel>
      </div>

      <Panel title={issues.length ? `Issues (${errors ? plural(errors, "error") : ""}${errors && warnings ? ", " : ""}${warnings ? plural(warnings, "warning") : ""})` : "Issues"}>
        <div role="status" data-agent-region="convert-issues">
          {converted && issues.length === 0 ? <p className="text-sm text-good">No issues: every construct converted exactly.</p> : null}
          {!converted && !error ? <p className="text-sm text-faint">Conversion notes appear here: errors block the conversion, warnings mean the target dialect has no exact equivalent.</p> : null}
          <IssueList issues={issues} />
        </div>
      </Panel>
    </div>
  );
}
