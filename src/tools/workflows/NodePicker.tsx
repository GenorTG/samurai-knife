"use client";

/** "Add a node": search the catalog by name, n8n name or keyword; arrows + Enter pick. */
import { useMemo, useState } from "react";
import { cx } from "@/lib/format";
import { NODE_CATALOG } from "@/lib/workflows/catalog/index";
import type { NodeGroup, NodeMeta } from "@/lib/workflows/types";

const GROUP_LABELS: Record<NodeGroup, string> = {
  trigger: "Triggers",
  flow: "Flow",
  data: "Data",
  transform: "Transform",
  files: "Files",
  network: "Network and APIs",
  utility: "Utility",
  ai: "AI",
  apps: "Apps",
};
const ORDER: NodeGroup[] = ["trigger", "network", "data", "flow", "transform", "files", "utility", "ai", "apps"];

function score(meta: NodeMeta, query: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const label = meta.label.toLowerCase();
  if (label === q) return 100;
  if (label.startsWith(q)) return 80;
  if (label.includes(q)) return 60;
  if (meta.alias?.toLowerCase().includes(q)) return 50;
  if (meta.keywords?.some((k) => k.includes(q))) return 40;
  if (meta.description.toLowerCase().includes(q)) return 20;
  return 0;
}

export function NodePicker({ onPick, onClose, triggersOnly = false, noTriggers = false }: { onPick: (meta: NodeMeta) => void; onClose: () => void; triggersOnly?: boolean; noTriggers?: boolean }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const results = useMemo(() => {
    const list = NODE_CATALOG.filter((meta) => (triggersOnly ? meta.inputs === 0 : noTriggers ? meta.inputs > 0 : true))
      .map((meta) => ({ meta, score: score(meta, query.trim()) }))
      .filter((entry) => entry.score > 0);
    const sorted = query.trim() ? list.sort((a, b) => b.score - a.score).map((entry) => entry.meta) : list.sort((a, b) => ORDER.indexOf(a.meta.group) - ORDER.indexOf(b.meta.group)).map((entry) => entry.meta);
    // A group heading before the first node of each group (browsing only, not while searching).
    return sorted.map((meta, index) => ({ meta, header: !query.trim() && (index === 0 || sorted[index - 1].group !== meta.group) ? GROUP_LABELS[meta.group] : null }));
  }, [query, triggersOnly, noTriggers]);
  const pick = (meta: NodeMeta | undefined) => meta && onPick(meta);
  return (
    <div role="dialog" aria-modal="true" aria-label="Add a node" className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[10vh]" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="sk-pop flex max-h-[75vh] w-full max-w-lg flex-col overflow-hidden rounded-tool border border-line-strong bg-surface shadow-pop">
        <div className="border-b border-line p-3">
          <input
            autoFocus
            aria-label="Search nodes"
            placeholder={triggersOnly ? "Search triggers…" : "Search nodes: http, code, if, merge, schedule…"}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
              else if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((value) => Math.min(results.length - 1, value + 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((value) => Math.max(0, value - 1));
              } else if (event.key === "Enter") {
                event.preventDefault();
                pick(results[active]?.meta);
              }
            }}
            className="sk-input h-10 w-full px-3 text-sm"
          />
        </div>
        <ul role="listbox" aria-label="Nodes" className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {results.map(({ meta, header }, index) => {
            return (
              <li key={meta.type} role="presentation">
                {header ? <p className="px-2.5 pt-3 pb-1 font-mono text-[10px] font-semibold tracking-[0.14em] text-faint uppercase">{header}</p> : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => pick(meta)}
                  className={cx("flex w-full cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2 text-left", index === active ? "bg-accent/12" : "hover:bg-raised")}
                >
                  <span aria-hidden className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-[12px] font-bold" style={{ color: `oklch(from var(--c-accent) l c ${meta.hue ?? 220})`, backgroundColor: `oklch(from var(--c-accent) l c ${meta.hue ?? 220} / 0.14)` }}>
                    {meta.inputs === 0 ? "⚡" : meta.label.slice(0, 1)}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-semibold text-ink">
                      {meta.label}
                      {meta.alias && meta.alias !== meta.label ? <span className="ml-1.5 font-normal text-faint">({meta.alias})</span> : null}
                    </span>
                    <span className="block text-[12px] leading-snug text-muted">{meta.description}</span>
                  </span>
                </button>
              </li>
            );
          })}
          {!results.length ? <li className="px-3 py-6 text-center text-sm text-faint">No node matches. Any HTTP API works with HTTP Request.</li> : null}
        </ul>
      </div>
    </div>
  );
}
