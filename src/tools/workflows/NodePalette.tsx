"use client";

/**
 * The editor's node list (left of the canvas): every catalog node by group, searchable. Click adds the node (after the
 * selected node when one is selected), drag drops it where it lands on the canvas.
 */
import { useMemo, useState } from "react";
import type { NodeMeta } from "@/lib/workflows/types";
import { NodeIcon, nodeResults } from "./NodePicker";
import { useT } from "@/lib/i18n/react";

/** dataTransfer type a palette drag carries (the node type). */
export const NODE_DRAG_TYPE = "application/x-knife-workflow-node";

export function NodePalette({ onAdd, onClose }: { onAdd: (meta: NodeMeta) => void; onClose: () => void }) {
  const { t } = useT();
  const [query, setQuery] = useState("");
  const results = useMemo(() => nodeResults(query), [query]);
  return (
    <aside aria-label={t("Nodes")} className="flex h-full min-h-0 w-64 shrink-0 flex-col border-r border-line bg-surface" data-node-palette>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <p className="flex-1 font-mono text-[11px] font-semibold tracking-[0.14em] text-faint uppercase">{t("Nodes")}</p>
        <button autoComplete="off" type="button" onClick={onClose} aria-label={t("Hide the node list")} title={t("Hide the node list")} className="cursor-pointer rounded px-1.5 text-faint hover:bg-raised hover:text-ink">
          «
        </button>
      </div>
      <div className="border-b border-line p-2">
        <input
          type="search"
          aria-label={t("Search the node list")}
          placeholder={t("Search: http, code, if, merge…")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && results[0]) {
              event.preventDefault();
              onAdd(results[0].meta);
            } else if (event.key === "Escape") setQuery("");
          }}
          className="sk-input h-8 w-full px-2.5 text-[13px]"
        />
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto p-1.5" aria-label={t("Node list")}>
        {results.map(({ meta, header }) => (
          <li key={meta.type}>
            {header ? <p className="px-2 pt-3 pb-1 font-mono text-[10px] font-semibold tracking-[0.14em] text-faint uppercase">{header}</p> : null}
            <button
              autoComplete="off"
              type="button"
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(NODE_DRAG_TYPE, meta.type);
                event.dataTransfer.effectAllowed = "copy";
              }}
              onClick={() => onAdd(meta)}
              title={t("{description}\nClick to add, or drag onto the canvas.", { description: meta.description })}
              className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-raised active:cursor-grabbing"
            >
              <NodeIcon meta={meta} size="size-5" />
              <span className="min-w-0 truncate text-[13px] text-ink">{t(meta.label)}</span>
            </button>
          </li>
        ))}
        {!results.length ? <li className="px-2 py-6 text-center text-[13px] text-faint">{t("No node matches. Any HTTP API works with HTTP Request.")}</li> : null}
      </ul>
    </aside>
  );
}
