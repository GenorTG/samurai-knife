"use client";

import { Notice } from "@/components/ui";
import { formatInt } from "@/lib/format";
import type { Cell } from "@/lib/learn/sql/compare";
import type { RunOutput, SqlErrorInfo, StatementResult } from "@/lib/learn/sql/db";

/** Results of one run: an error with its position, notices, and each statement's rows (plans as text). */

function CellView({ value }: { value: Cell }) {
  if (value === null) return <span className="text-faint italic">NULL</span>;
  if (typeof value === "boolean") return <>{value ? "true" : "false"}</>;
  return <>{String(value)}</>;
}

function ErrorView({ error, sql }: { error: SqlErrorInfo; sql: string }) {
  const position = error.position;
  const line = position ? (sql.split("\n")[position.line - 1] ?? "") : "";
  return (
    <div className="space-y-2" data-agent-region="learn-sql-error">
      <Notice tone="error">
        {error.code === "knife_refused" ? "Not run: " : "Error: "}
        {error.message}
        {position ? ` (line ${position.line}, column ${position.column})` : ""}
        {error.code && error.code !== "knife_refused" ? ` [${error.code}]` : ""}
      </Notice>
      {position ? (
        <pre aria-label="Error position" className="overflow-x-auto rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 font-mono text-xs text-ink">
          {line}
          {"\n"}
          <span className="text-danger">{" ".repeat(Math.max(0, position.column - 1))}^</span>
        </pre>
      ) : null}
      {error.detail ? <p className="text-xs text-muted">Detail: {error.detail}</p> : null}
      {error.hint ? <p className="text-xs text-muted">Hint: {error.hint}</p> : null}
    </div>
  );
}

function isPlan(result: StatementResult): boolean {
  return result.columns.length === 1 && result.columns[0] === "QUERY PLAN";
}

function ResultBlock({ result, index, total }: { result: StatementResult; index: number; total: number }) {
  const label = total > 1 ? `Statement ${index + 1}: ${result.command}` : result.command;
  if (result.columns.length === 0) {
    return (
      <p className="text-sm text-muted">
        {label} — {formatInt(result.rowCount)} row{result.rowCount === 1 ? "" : "s"} affected.
      </p>
    );
  }
  if (isPlan(result)) {
    return (
      <div className="space-y-1">
        <p className="text-xs text-faint">{label}</p>
        <pre aria-label="Query plan" className="max-h-96 overflow-auto rounded-lg border border-line bg-raised/40 p-3 font-mono text-xs leading-relaxed text-ink">
          {result.rows.map((row) => String(row[0] ?? "")).join("\n")}
        </pre>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <p className="text-xs text-faint">
        {label} — {formatInt(result.rows.length)} row{result.rows.length === 1 ? "" : "s"}
        {result.truncated ? ` (only the first ${formatInt(result.rows.length)} are shown)` : ""}
      </p>
      <div className="max-h-[28rem] overflow-auto rounded-lg border border-line">
        <table className="w-full border-collapse text-left font-mono text-xs" aria-label={`Result of ${label}`}>
          <thead className="sticky top-0 bg-raised">
            <tr>
              {result.columns.map((column, i) => (
                <th key={`${column}-${i}`} scope="col" className="border-b border-line px-2.5 py-1.5 font-semibold text-ink">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, r) => (
              <tr key={r} className="odd:bg-surface even:bg-raised/30">
                {row.map((cell, c) => (
                  <td key={c} className="border-b border-line/60 px-2.5 py-1 whitespace-nowrap text-ink">
                    <CellView value={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function SqlResults({ run, sql }: { run: RunOutput; sql: string }) {
  const shown = run.results.filter((result, index) => result.columns.length > 0 || index === run.results.length - 1);
  return (
    <div className="space-y-3" data-agent-region="learn-sql-results">
      {run.error ? <ErrorView error={run.error} sql={sql} /> : null}
      {run.notices.length ? (
        <ul className="space-y-0.5 text-xs text-muted" aria-label="Notices">
          {run.notices.map((notice, i) => (
            <li key={i}>{notice}</li>
          ))}
        </ul>
      ) : null}
      {shown.map((result) => {
        const index = run.results.indexOf(result);
        return <ResultBlock key={index} result={result} index={index} total={run.results.length} />;
      })}
    </div>
  );
}
