"use client";

import { useRouter } from "next/navigation";
import { useCallback, useMemo, useRef, useState } from "react";
import { CategoryTile } from "@/components/category-icons";
import { FavoriteButton } from "@/components/ToolActions";
import { BetaBadge, KindBadge } from "@/components/ToolShell";
import { Select } from "@/components/ui";
import { cx } from "@/lib/format";
import { useToolPreferences } from "@/lib/tool-preferences";
import {
  CATEGORIES,
  categoryLabel,
  familyLabel,
  searchTools,
  TOOL_FAMILIES,
  type ToolCategory,
  type ToolFamily,
  type ToolMeta,
} from "@/lib/registry";

type LauncherFilter = ToolCategory | "all" | "favorites" | "recent";

export function Launcher({ tools }: { tools: ToolMeta[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<LauncherFilter>("all");
  const [family, setFamily] = useState<ToolFamily | "all">("all");
  const inputRef = useRef<HTMLInputElement>(null);
  const { favorites, recent, ready, toggleFavorite, clearRecent } = useToolPreferences();

  const categoryPool = useMemo(() => {
    if (filter === "favorites") {
      const bySlug = new Map(tools.map((tool) => [tool.slug, tool]));
      return favorites.map((slug) => bySlug.get(slug)).filter((tool): tool is ToolMeta => Boolean(tool));
    }
    if (filter === "recent") {
      const bySlug = new Map(tools.map((tool) => [tool.slug, tool]));
      return recent.map((slug) => bySlug.get(slug)).filter((tool): tool is ToolMeta => Boolean(tool));
    }
    return filter === "all" ? tools : tools.filter((tool) => tool.category === filter);
  }, [favorites, filter, recent, tools]);

  const familyOptions = useMemo(() => {
    const available = new Set(categoryPool.map((tool) => tool.family));
    return TOOL_FAMILIES.filter((item) => available.has(item.id));
  }, [categoryPool]);

  const activeFamily = familyOptions.some((item) => item.id === family) ? family : "all";

  const pool = useMemo(
    () =>
      activeFamily === "all"
        ? categoryPool
        : categoryPool.filter((tool) => tool.family === activeFamily),
    [activeFamily, categoryPool],
  );

  const results = useMemo(() => searchTools(query, pool), [query, pool]);

  // Reset the keyboard cursor by render-time derivation, not an effect.
  const signature = `${query}|${filter}|${activeFamily}|${favorites.join(",")}|${recent.join(",")}`;
  const [cursorState, setCursorState] = useState({ signature, index: 0 });
  const cursor = cursorState.signature === signature ? cursorState.index : 0;

  const open = useCallback(
    (slug: string) => router.push(`/tools/${slug}`),
    [router],
  );

  const grouped = useMemo(() => {
    if (query.trim() || filter === "favorites" || filter === "recent") return null;
    return CATEGORIES.map((cat) => ({
      ...cat,
      items: results.filter((tool) => tool.category === cat.id),
    })).filter((group) => group.items.length > 0);
  }, [filter, query, results]);

  const selectFilter = (next: LauncherFilter) => {
    setFilter(next);
    setFamily("all");
  };

  const selectFamily = (value: string) => {
    setFamily(value === "all" ? "all" : (value as ToolFamily));
  };

  const quickOpenEnabled = query.trim().length > 0 || filter !== "all" || activeFamily !== "all";

  const emptyMessage =
    filter === "favorites" && favorites.length === 0
      ? "Pin tools with the star button and they will show up here."
      : filter === "recent" && recent.length === 0
        ? "Open any tool once and it will appear here automatically."
        : "Try a file type, a verb, or clear one of the filters.";

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <div className="relative">
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-faint"
          >
            <circle cx="11" cy="11" r="6.5" />
            <path d="M16 16l4.5 4.5" />
          </svg>
          <input
            ref={inputRef}
            data-launcher-search
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursorState({
                  signature,
                  index: Math.min(cursor + 1, Math.max(results.length - 1, 0)),
                });
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursorState({ signature, index: Math.max(cursor - 1, 0) });
              } else if (e.key === "Enter" && quickOpenEnabled && results[cursor]) {
                e.preventDefault();
                open(results[cursor].slug);
              } else if (e.key === "Escape") {
                setQuery("");
                inputRef.current?.blur();
              }
            }}
            spellCheck={false}
            autoComplete="off"
            placeholder="Search tools — resize, pdf, json, regex…"
            aria-label="Search tools"
            className="sk-input h-12 w-full rounded-xl pr-24 pl-11 text-base shadow-card"
          />
          {query ? (
            <button
              autoComplete="off"
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              className="absolute top-1/2 right-3 inline-flex h-7 -translate-y-1/2 items-center rounded-md px-2 text-xs text-muted hover:bg-raised hover:text-ink"
            >
              Clear
            </button>
          ) : (
            <kbd className="sk-kbd pointer-events-none absolute top-1/2 right-4 hidden -translate-y-1/2 sm:block">
              /
            </kbd>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Chip active={filter === "all"} onClick={() => selectFilter("all")}>
            All <FilterCount value={tools.length} />
          </Chip>
          <Chip active={filter === "favorites"} onClick={() => selectFilter("favorites")}>
            Favorites <FilterCount value={favorites.length} />
          </Chip>
          <Chip active={filter === "recent"} onClick={() => selectFilter("recent")}>
            Recent <FilterCount value={recent.length} />
          </Chip>
          {CATEGORIES.map((cat) => (
            <Chip
              key={cat.id}
              active={filter === cat.id}
              onClick={() => selectFilter(cat.id)}
            >
              {cat.label}
            </Chip>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-faint sm:flex-none">
            <span>Family</span>
            {/* Phones: 16px field text (no iOS zoom) would push the count onto its own line; fill the row instead. */}
            <Select
              value={activeFamily}
              onChange={(event) => selectFamily(event.target.value)}
              disabled={familyOptions.length === 0}
              className="h-8 min-w-0 flex-1 text-xs sm:w-auto sm:min-w-40 sm:flex-none"
            >
              <option value="all">All families</option>
              {familyOptions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label} · {categoryPool.filter((tool) => tool.family === item.id).length}
                </option>
              ))}
            </Select>
          </label>
          <div className="flex items-center gap-3">
            {filter === "recent" && recent.length > 0 ? (
              <button
                autoComplete="off"
                type="button"
                onClick={clearRecent}
                className="rounded-md px-2 py-1 text-xs text-muted hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
              >
                Clear recent
              </button>
            ) : null}
            <span
              role="status"
              aria-live="polite"
              className="font-mono text-xs text-faint tabular-nums"
            >
              {results.length} of {tools.length} tools
            </span>
          </div>
        </div>
      </div>

      {results.length === 0 ? (
        <div className="rounded-tool border border-dashed border-line-strong bg-surface px-4 py-14 text-center">
          <p className="text-base font-medium text-muted">
            {filter === "favorites" && favorites.length === 0 ? (
              "No favorites yet."
            ) : filter === "recent" && recent.length === 0 ? (
              "No recent tools yet."
            ) : (
              <>Nothing matches <span className="text-ink">“{query}”</span>.</>
            )}
          </p>
          <p className="mt-1 text-xs text-faint">{emptyMessage}</p>
          {filter !== "all" || activeFamily !== "all" || query ? (
            <button
              autoComplete="off"
              type="button"
              onClick={() => {
                setQuery("");
                selectFilter("all");
              }}
              className="mt-4 rounded-lg border border-line-strong bg-raised px-3 py-1.5 text-xs font-medium text-ink hover:border-faint focus-visible:outline-2 focus-visible:outline-accent"
            >
              Clear filters
            </button>
          ) : null}
        </div>
      ) : null}

      {grouped
        ? grouped.map((group) => (
            <section key={group.id} className="space-y-3">
              <h2 className="flex items-center gap-2.5 text-sm font-semibold text-ink">
                <CategoryTile category={group.id} size="sm" />
                {group.label}
                <span className="font-mono text-xs font-normal text-faint">
                  {group.items.length}
                </span>
              </h2>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))] gap-3">
                {group.items.map((tool) => (
                  <ToolCard
                    key={tool.slug}
                    tool={tool}
                    active={false}
                    favorite={favorites.includes(tool.slug)}
                    disabled={!ready}
                    onOpen={() => open(tool.slug)}
                    onToggleFavorite={() => toggleFavorite(tool.slug)}
                  />
                ))}
              </div>
            </section>
          ))
        : null}

      {!grouped && results.length > 0 ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))] gap-3">
          {results.map((tool, index) => (
            <ToolCard
              key={tool.slug}
              tool={tool}
              active={index === cursor}
              favorite={favorites.includes(tool.slug)}
              disabled={!ready}
              onOpen={() => open(tool.slug)}
              onToggleFavorite={() => toggleFavorite(tool.slug)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      autoComplete="off"
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        "cursor-pointer rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "border-accent bg-accent text-accent-fg"
          : "border-line bg-surface text-muted hover:border-line-strong hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

function FilterCount({ value }: { value: number }) {
  return (
    <span className="ml-1 font-mono text-[10px] tabular-nums opacity-70">
      {value}
    </span>
  );
}

function ToolCard({
  tool,
  active,
  favorite,
  disabled,
  onOpen,
  onToggleFavorite,
}: {
  tool: ToolMeta;
  active: boolean;
  favorite: boolean;
  disabled: boolean;
  onOpen: () => void;
  onToggleFavorite: () => void;
}) {
  return (
    <article
      className={cx(
        "group relative rounded-tool border bg-surface shadow-card transition-[border-color,background-color,transform,box-shadow] duration-150 hover:-translate-y-px hover:shadow-pop",
        active
          ? "border-accent bg-accent/[0.06] ring-1 ring-accent/40 shadow-[0_0_28px_-8px_var(--ring-glow)]"
          : "border-line hover:border-accent/40 hover:bg-raised/50",
      )}
    >
      <button
        autoComplete="off"
        type="button"
        onClick={onOpen}
        className="flex min-h-32 w-full items-start gap-3.5 rounded-tool p-4 pr-14 text-left focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
      >
        <CategoryTile category={tool.category} />
        <span className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-semibold text-ink">{tool.name}</h3>
          <span className="mt-1 line-clamp-2 block text-[13px] leading-relaxed text-muted">
            {tool.tagline}
          </span>
          <span className="mt-2 flex items-center gap-2">
            <KindBadge kind={tool.kind} />
            {tool.beta ? <BetaBadge compact /> : null}
            <span className="truncate font-mono text-[10px] tracking-wider text-faint uppercase">
              {categoryLabel(tool.category)} · {familyLabel(tool.family)}
            </span>
          </span>
        </span>
      </button>
      <FavoriteButton
        toolName={tool.name}
        favorite={favorite}
        onToggle={onToggleFavorite}
        disabled={disabled}
        className="absolute top-3 right-3"
      />
    </article>
  );
}
