"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { CategoryIcon, categoryTint } from "@/components/category-icons";
import { cx } from "@/lib/format";
import { categoryLabel, searchTools, TOOLS, type ToolMeta } from "@/lib/registry";
import { useToolPreferences } from "@/lib/tool-preferences";
import { openAssistant } from "@/lib/agent-client/bridge";
import { SHELL_EVENTS } from "./shell-store";
import { useT } from "@/lib/i18n/react";

interface Entry {
  tool: ToolMeta;
  tag?: "recent" | "favorite";
}

/** ⌘K / Ctrl+K / `/` palette: fuzzy-jump to any tool from anywhere. */
export function CommandPalette() {
  const { t: tr, tn } = useT();
  const router = useRouter();
  const pathname = usePathname();
  // The shell is never remounted, so plain `open` state would survive every client navigation (assistant open_tool,
  // `]`, Back/Forward). Remember where it was opened: it is shown only while we are still on that page.
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === pathname;
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const { favorites, recent, ready } = useToolPreferences();

  useEffect(() => {
    const show = () => {
      setQuery("");
      setCursor(0);
      setOpenAt(pathname);
    };
    window.addEventListener(SHELL_EVENTS.palette, show);
    return () => window.removeEventListener(SHELL_EVENTS.palette, show);
  }, [pathname]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Esc must work even after focus left the input (click on the dialog, Tab).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenAt(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const entries = useMemo<Entry[]>(() => {
    if (query.trim()) return searchTools(query).map((tool) => ({ tool }));
    const bySlug = new Map(TOOLS.map((t) => [t.slug, t]));
    const seen = new Set<string>();
    const out: Entry[] = [];
    const add = (slugs: string[], tag: Entry["tag"]) => {
      for (const slug of slugs) {
        const tool = bySlug.get(slug);
        if (tool && !seen.has(slug)) {
          seen.add(slug);
          out.push({ tool, tag });
        }
      }
    };
    if (ready) {
      add(recent.slice(0, 5), "recent");
      add(favorites, "favorite");
    }
    add(
      TOOLS.map((t) => t.slug),
      undefined,
    );
    return out;
  }, [query, favorites, recent, ready]);

  // A trailing "Ask the assistant" row turns any query into a prompt.
  const q = query.trim();
  const askIndex = q ? entries.length : -1;
  const rows = entries.length + (q ? 1 : 0);
  const active = Math.min(cursor, Math.max(rows - 1, 0));

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  if (!open) return null;

  const close = () => setOpenAt(null);
  const go = (tool: ToolMeta) => {
    close();
    router.push(`/tools/${tool.slug}`);
  };
  const ask = () => {
    close();
    openAssistant(q);
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center sk-scrim px-3 pt-[12vh] backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={tr("Jump to a tool")}
        className="sk-pop sk-glass w-full max-w-2xl overflow-hidden rounded-2xl border border-line-strong shadow-pop"
        style={{ transformOrigin: "top center" }}
      >
        <div className="flex items-center gap-3 border-b border-line px-4 focus-within:ring-2 focus-within:ring-inset focus-within:ring-accent">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden className="shrink-0 text-faint">
            <circle cx="11" cy="11" r="6.5" />
            <path d="M16 16l4.5 4.5" />
          </svg>
          <input
            ref={inputRef}
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="sk-palette-list"
            aria-activedescendant={active === askIndex ? "sk-pal-ask" : entries[active] ? `sk-pal-${entries[active].tool.slug}` : undefined}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor(Math.min(active + 1, rows - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor(Math.max(active - 1, 0));
              } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && q) {
                e.preventDefault();
                ask();
              } else if (e.key === "Enter" && active === askIndex) {
                e.preventDefault();
                ask();
              } else if (e.key === "Enter" && entries[active]) {
                e.preventDefault();
                go(entries[active].tool);
              } else if (e.key === "Escape") {
                e.preventDefault();
                close();
              }
            }}
            spellCheck={false}
            autoComplete="off"
            placeholder={tr("Jump to a tool — resize, pdf, json, regex…")}
            aria-label={tr("Search tools")}
            className="h-14 min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-faint"
          />
          <kbd className="sk-kbd">esc</kbd>
        </div>
        <ul
          ref={listRef}
          id="sk-palette-list"
          role="listbox"
          aria-label={tr("Tools")}
          className="max-h-[min(26rem,60vh)] overflow-y-auto p-2"
        >
          {entries.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-muted">
              {tr("No tool matches “{query}”.", { query })}
            </li>
          ) : (
            entries.map(({ tool, tag }, i) => (
              <li
                key={tool.slug}
                id={`sk-pal-${tool.slug}`}
                role="option"
                aria-selected={i === active}
                data-index={i}
                onMouseMove={() => setCursor(i)}
                onClick={() => go(tool)}
                className={cx(
                  "flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2",
                  i === active ? "bg-accent/12 ring-1 ring-accent/30" : "",
                )}
              >
                <span style={categoryTint(tool.category)} className="inline-flex shrink-0">
                  <CategoryIcon category={tool.category} size={18} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{tr(tool.name)}</span>
                  <span className="block truncate text-xs text-muted">{tr(tool.tagline)}</span>
                </span>
                {tag ? (
                  <span className="shrink-0 font-mono text-[10px] tracking-wider text-faint uppercase">
                    {tag === "recent" ? tr("recent") : "★"}
                  </span>
                ) : (
                  <span className="hidden shrink-0 font-mono text-[10px] tracking-wider text-faint uppercase sm:block">
                    {tr(categoryLabel(tool.category))}
                  </span>
                )}
              </li>
            ))
          )}
          {q ? (
            <li
              id="sk-pal-ask"
              role="option"
              aria-selected={active === askIndex}
              data-index={askIndex}
              onMouseMove={() => setCursor(askIndex)}
              onClick={ask}
              className={cx(
                "mt-1 flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-ai/40 px-3 py-2",
                active === askIndex ? "bg-ai/12 ring-1 ring-ai/40" : "",
              )}
            >
              <span aria-hidden className="size-2 shrink-0 rounded-full bg-ai" />
              <span className="min-w-0 flex-1 truncate text-sm text-ink">
                {tr("Ask the assistant:")}{" "} <span className="text-muted">“{q}”</span>
              </span>
              <kbd className="sk-kbd shrink-0">Ctrl ↵</kbd>
            </li>
          ) : null}
        </ul>
        <div className="flex items-center gap-4 border-t border-line px-4 py-2 text-[11px] text-faint">
          <span><kbd className="sk-kbd">↑</kbd> <kbd className="sk-kbd">↓</kbd> {" "}{tr("move")}</span>
          <span><kbd className="sk-kbd">↵</kbd> {" "}{tr("open")}</span>
          <span className="ml-auto">{tn("{n} tool", "{n} tools", entries.length)}</span>
        </div>
      </div>
    </div>
  );
}
