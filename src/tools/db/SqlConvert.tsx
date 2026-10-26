"use client";

import { useEffect, useRef, useState } from "react";
import { Button, CopyButton, Field, Notice, Panel, TextArea } from "@/components/ui";
import { downloadText } from "@/lib/format";
import { callSql } from "@/lib/sql/client";
import { useStoredDialect } from "@/lib/sql/schema-store";
import type { SqlDialect, SqlIssue } from "@/lib/sql/types";
import { DialectSelect, IssueList } from "./sql-shared";
import { useT } from "@/lib/i18n/react";
import { msg } from "@/lib/i18n/msg";

interface Example {
  label: string;
  from: SqlDialect;
  to: SqlDialect;
  sql: string;
}

const EXAMPLES: Example[] = [
  {
    label: msg("SQLite → Postgres: upsert"),
    from: "sqlite",
    to: "postgres",
    sql: "INSERT INTO page_hits (path, hits, last_seen) VALUES ('/home', 1, datetime('now'))\nON CONFLICT(path) DO UPDATE SET hits = hits + 1, last_seen = datetime('now');",
  },
  {
    label: msg("MySQL → T-SQL: LIMIT and AUTO_INCREMENT"),
    from: "mysql",
    to: "tsql",
    sql: "CREATE TABLE users (\n  id INT AUTO_INCREMENT PRIMARY KEY,\n  name VARCHAR(80) NOT NULL,\n  created_at DATETIME DEFAULT CURRENT_TIMESTAMP\n);\n\nSELECT id, name FROM users ORDER BY created_at DESC LIMIT 10 OFFSET 20;",
  },
  {
    label: msg("Postgres → MySQL: ILIKE, casts, now()"),
    from: "postgres",
    to: "mysql",
    sql: "SELECT id::text AS id, created_at::date AS day\nFROM events\nWHERE name ILIKE '%launch%' AND created_at > now() - interval '7 days';",
  },
  {
    label: msg("Oracle → Postgres: NVL, SYSDATE, FETCH FIRST"),
    from: "oracle",
    to: "postgres",
    sql: "SELECT NVL(nickname, name) AS shown_name, SYSDATE AS today\nFROM employees\nFETCH FIRST 5 ROWS ONLY;",
  },
  {
    label: msg("T-SQL → SQLite: TOP, ISNULL, GETDATE"),
    from: "tsql",
    to: "sqlite",
    sql: "SELECT TOP 10 name, ISNULL(email, 'n/a') AS email, GETDATE() AS fetched_at\nFROM dbo.users\nORDER BY name;",
  },
  {
    label: msg("BigQuery → Snowflake: backticks and DATE_TRUNC"),
    from: "bigquery",
    to: "snowflake",
    sql: "SELECT DATE_TRUNC(order_date, MONTH) AS month, COUNT(*) AS orders\nFROM `shop.sales.orders`\nGROUP BY month\nORDER BY month;",
  },
];

export default function SqlConvert() {
  const { t, tn } = useT();
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
      <Panel title={t("Dialects")}>
        <div className="grid items-end gap-3 sm:grid-cols-[1fr_auto_1fr]">
          <Field label={t("Convert from")}>
            <DialectSelect label={t("Convert from")} value={from} onChange={setFrom} />
          </Field>
          <Button onClick={() => { setFrom(to); setTo(from); }} aria-label={t("Swap the from and to dialects")}>{t("Swap dialects")}</Button>
          <Field label={t("Convert to")}>
            <DialectSelect label={t("Convert to")} value={to} onChange={setTo} />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-1.5" role="group" aria-label={t("Examples")}>
          <span className="text-xs text-faint">{t("Examples:")}</span>
          {EXAMPLES.map((example) => (
            <Button key={example.label} size="sm" className="h-auto! min-h-7 max-w-full py-1 text-left whitespace-normal!" onClick={() => { setFrom(example.from); setTo(example.to); setSql(example.sql); }}>
              {t(example.label)}
            </Button>
          ))}
        </div>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title={t("Input SQL")}
          right={
            <div className="flex gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => { setSql(output.replace(/;\s*$/, ";")); setFrom(to); setTo(from); }} disabled={!output}>{t("Use output as input")}</Button>
              <Button size="sm" variant="ghost" onClick={() => setSql("")} disabled={!sql}>{t("Clear SQL")}</Button>
            </div>
          }
        >
          <Field label={t("SQL to convert")} hint={t("Parsed in the source dialect and re-written for the target. Never executed.")}>
            <TextArea rows={14} spellCheck={false} value={sql} onChange={(e) => setSql(e.target.value)} placeholder={t("Paste SQL written for the source dialect…")} />
          </Field>
        </Panel>

        <Panel
          title={t("Converted SQL")}
          right={
            <div className="flex gap-1.5">
              <CopyButton text={output} label={t("Copy converted SQL")} />
              <Button size="sm" disabled={!output} onClick={() => downloadText(output.endsWith("\n") ? output : `${output}\n`, filename, "application/sql")}>{t("Download .sql")}</Button>
            </div>
          }
        >
          <div className="space-y-3">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-muted">
              <input type="checkbox" checked={pretty} onChange={(e) => setPretty(e.target.checked)} className="size-4 accent-[var(--c-accent)]" />
              {t("Pretty-print the output")}
            </label>
            <pre
              aria-label={t("Converted SQL")}
              data-agent-region="converted-sql"
              className="sk-input max-h-[60vh] min-h-56 overflow-auto px-3 py-2.5 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words"
            >
              {output || <span className="text-faint">{busy ? t("Converting…") : t("The converted SQL appears here.")}</span>}
            </pre>
            {error ? <div role="alert"><Notice tone="error">{error}</Notice></div> : null}
            {from === to ? <Notice tone="info">{t("Source and target are the same dialect: this just re-formats the SQL.")}</Notice> : null}
          </div>
        </Panel>
      </div>

      <Panel title={issues.length ? `Issues (${errors ? tn("{n} error", "{n} errors", errors) : ""}${errors && warnings ? ", " : ""}${warnings ? tn("{n} warning", "{n} warnings", warnings) : ""})` : t("Issues")}>
        <div role="status" data-agent-region="convert-issues">
          {converted && issues.length === 0 ? <p className="text-sm text-good">{t("No issues: every construct converted exactly.")}</p> : null}
          {!converted && !error ? <p className="text-sm text-faint">{t("Conversion notes appear here: errors block the conversion, warnings mean the target dialect has no exact equivalent.")}</p> : null}
          <IssueList issues={issues} />
        </div>
      </Panel>
    </div>
  );
}
