"use client";

/** Items of a node's input or output: a table (top-level fields) or JSON; clicking a column inserts it as an expression. */
import { useState } from "react";
import { Badge, SegmentedControl } from "@/components/ui";
import { formatBytes } from "@/lib/format";
import type { Item } from "@/lib/workflows/types";

const MAX_ROWS = 100;

function cell(value: unknown): string {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "object") {
    const text = JSON.stringify(value);
    return text.length > 120 ? `${text.slice(0, 120)}…` : text;
  }
  const text = String(value);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

const fieldPath = (key: string) => (/^[A-Za-z_$][\w$]*$/.test(key) ? `$json.${key}` : `$json[${JSON.stringify(key)}]`);

export function DataView({
  items,
  total,
  empty,
  onPick,
  label,
}: {
  items: Item[];
  /** Real item count when `items` holds only the first ones (stored runs). */
  total?: number;
  empty: string;
  /** Insert `{{ path }}` into the focused parameter. */
  onPick?: (path: string) => void;
  label: string;
}) {
  const [mode, setMode] = useState<"table" | "json">("table");
  const count = total ?? items.length;
  if (!items.length) return <p className="px-1 py-6 text-center text-[13px] text-faint">{count ? `${count} items (data not kept for this run)` : empty}</p>;
  const shown = items.slice(0, MAX_ROWS);
  const columns: string[] = [];
  for (const item of shown) for (const key of Object.keys(item.json)) if (!columns.includes(key) && columns.length < 40) columns.push(key);
  const files = shown.flatMap((item) => Object.entries(item.binary ?? {}));
  return (
    <div className="space-y-2" aria-label={label}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted">
          {count} item{count === 1 ? "" : "s"}
          {count > shown.length ? ` (first ${shown.length} shown)` : ""}
        </span>
        <SegmentedControl label={`${label} view`} value={mode} onChange={setMode} options={[{ value: "table", label: "Table" }, { value: "json", label: "JSON" }]} />
      </div>
      {files.length ? (
        <div className="flex flex-wrap gap-1.5">
          {files.slice(0, 12).map(([key, ref], index) => (
            <Badge key={`${key}-${index}`} tone="accent" title={ref.mimeType}>
              {key}: {ref.fileName ?? "file"} · {formatBytes(ref.fileSize)}
            </Badge>
          ))}
        </div>
      ) : null}
      {mode === "json" ? (
        <pre className="max-h-[52vh] overflow-auto rounded-lg border border-line bg-field p-3 font-mono text-[12px] leading-relaxed text-ink">{JSON.stringify(shown.map((item) => item.json), null, 2)}</pre>
      ) : (
        <div className="max-h-[52vh] overflow-auto rounded-lg border border-line">
          <table className="w-full border-collapse text-left text-[12px]">
            <thead className="sticky top-0 bg-raised">
              <tr>
                <th className="w-8 border-b border-line px-2 py-1.5 font-mono text-faint">#</th>
                {columns.map((column) => (
                  <th key={column} className="border-b border-line px-2 py-1.5 font-semibold text-ink">
                    {onPick ? (
                      <button type="button" className="cursor-pointer rounded px-1 font-mono hover:bg-accent/15" title={`Insert {{ ${fieldPath(column)} }} into the field you last edited`} onClick={() => onPick(fieldPath(column))}>
                        {column}
                      </button>
                    ) : (
                      <span className="font-mono">{column}</span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((item, index) => (
                <tr key={index} className="odd:bg-surface even:bg-raised/40">
                  <td className="border-b border-line px-2 py-1 font-mono text-faint">{index + 1}</td>
                  {columns.map((column) => (
                    <td key={column} className="max-w-[16rem] border-b border-line px-2 py-1 align-top font-mono break-words text-muted">
                      {cell(item.json[column])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {!columns.length ? <p className="px-3 py-3 text-[12px] text-faint">Items without fields.</p> : null}
        </div>
      )}
    </div>
  );
}
