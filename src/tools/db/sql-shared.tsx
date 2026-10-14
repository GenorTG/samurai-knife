"use client";

import { Button, Select } from "@/components/ui";
import { clearSchema, describeSchema, useStoredSchema } from "@/lib/sql/schema-store";
import { SQL_DIALECTS, type SqlDialect, type SqlIssue } from "@/lib/sql/types";
import { cx } from "@/lib/format";

export function DialectSelect({
  value,
  onChange,
  className,
  label,
}: {
  value: SqlDialect;
  onChange: (dialect: SqlDialect) => void;
  className?: string;
  label: string;
}) {
  return (
    <Select aria-label={label} className={className} value={value} onChange={(e) => onChange(e.target.value as SqlDialect)}>
      {SQL_DIALECTS.map((d) => (
        <option key={d.id} value={d.id}>{d.label}</option>
      ))}
    </Select>
  );
}

/** The stored schema as plain text in a labelled region, so people and the assistant can both see what the tabs will check against. */
export function CurrentSchemaRegion({ hint }: { hint?: string }) {
  const stored = useStoredSchema();
  return (
    <section aria-label="Current schema" data-agent-region="current-schema" className="rounded-lg border border-line bg-raised/40 px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-muted">
          Current schema{stored ? ` — ${stored.schema.tables.length} table${stored.schema.tables.length === 1 ? "" : "s"} (${stored.source})` : ""}
        </h3>
        {stored ? <Button size="sm" variant="ghost" onClick={clearSchema}>Forget schema</Button> : null}
      </div>
      {stored ? (
        <pre className="mt-1.5 max-h-40 overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink">{describeSchema(stored.schema)}</pre>
      ) : (
        <p className="mt-1 text-xs text-faint">{hint ?? "No schema stored. Paste DDL in the Schema tab and choose “Use as current schema” to enable schema-aware checks and completion."}</p>
      )}
    </section>
  );
}

/** Plain-words explanation for the common engine messages; falls back to the engine text. */
export function explainIssue(issue: SqlIssue): string {
  const m = issue.message.toLowerCase();
  if (m.includes("unsupported") || m.includes("not supported") || m.includes("no equivalent")) {
    return "The target dialect has no exact equivalent for this construct, so the converted SQL may behave differently or need a manual rewrite.";
  }
  if (m.includes("unknown table")) return "This table does not exist in the stored schema (check spelling and schema qualifiers).";
  if (m.includes("unknown column")) return "This column does not exist on the table it is used with.";
  if (m.includes("expecting") || m.includes("unexpected") || m.includes("invalid expression") || m.includes("syntax")) {
    return "The parser could not read this part as SQL in the chosen dialect: look for a missing comma, parenthesis, keyword or quote just before the marked position.";
  }
  return issue.level === "error" ? "This blocks the statement from being read or converted." : "A heads-up: the result is usable but double-check this part.";
}

export function IssueList({ issues, emptyText }: { issues: SqlIssue[]; emptyText?: string }) {
  if (issues.length === 0) return emptyText ? <p className="text-sm text-good">{emptyText}</p> : null;
  return (
    <ul aria-label="Issues" className="space-y-2">
      {issues.map((issue, i) => (
        <li
          key={`${issue.level}-${issue.line ?? 0}-${issue.column ?? 0}-${i}`}
          className={cx(
            "rounded-lg border px-3 py-2 text-[13px] leading-relaxed",
            issue.level === "error" ? "border-danger/40 bg-danger/10" : "border-warn/40 bg-warn/10",
          )}
        >
          <p className={cx("font-semibold", issue.level === "error" ? "text-danger" : "text-warn")}>
            {issue.level === "error" ? "Error" : "Warning"}
            {issue.line ? ` at line ${issue.line}${issue.column ? `, column ${issue.column}` : ""}` : ""}: {issue.message}
          </p>
          <p className="mt-0.5 text-muted">{explainIssue(issue)}</p>
        </li>
      ))}
    </ul>
  );
}
