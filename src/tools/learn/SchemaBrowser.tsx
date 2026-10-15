"use client";

import { formatInt } from "@/lib/format";
import type { SchemaTable } from "@/lib/learn/sql/db";

/** The course tables, grouped by schema; each table expands to its columns (type, key, reference). */
export function SchemaBrowser({ tables, onInsert }: { tables: SchemaTable[]; onInsert: (text: string) => void }) {
  const schemas = [...new Set(tables.map((table) => table.schema))];
  return (
    <div className="space-y-4 text-sm" data-agent-region="learn-schema">
      {schemas.map((schema) => (
        <section key={schema} aria-label={`Schema ${schema}`} className="space-y-1">
          <h3 className="font-mono text-xs font-semibold tracking-wide text-faint uppercase">{schema}</h3>
          <ul className="space-y-1">
            {tables
              .filter((table) => table.schema === schema)
              .map((table) => (
                <li key={table.name}>
                  <details className="rounded-lg border border-line px-2.5 py-1.5">
                    <summary className="cursor-pointer font-mono text-[13px] text-ink">
                      {table.name} <span className="text-xs text-faint">≈{formatInt(table.approxRows)} rows</span>
                    </summary>
                    {table.comment ? <p className="mt-1 text-xs text-muted">{table.comment}</p> : null}
                    <ul className="mt-1.5 space-y-0.5">
                      {table.columns.map((column) => (
                        <li key={column.name} className="flex flex-wrap items-baseline gap-x-2 font-mono text-xs">
                          <button
                            type="button"
                            autoComplete="off"
                            className="cursor-pointer text-accent-soft hover:underline"
                            title="Insert into the editor"
                            onClick={() => onInsert(column.name)}
                          >
                            {column.name}
                          </button>
                          <span className="text-faint">{column.type}</span>
                          {column.primaryKey ? <span className="text-good">PK</span> : null}
                          {column.references ? <span className="text-muted">→ {column.references.replace(/^(shop|geo)\./, "")}</span> : null}
                          {column.nullable ? null : <span className="text-faint">not null</span>}
                        </li>
                      ))}
                    </ul>
                  </details>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
