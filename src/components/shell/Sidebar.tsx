"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import { CategoryIcon, categoryTint } from "@/components/category-icons";
import { BetaBadge } from "@/components/ToolShell";
import { cx } from "@/lib/format";
import { NAV, NAV_FOOTER, type NavItem } from "@/lib/nav";
import { searchTools, TOOLS, type ToolMeta, type ToolTab } from "@/lib/registry";
import { useToolPreferences } from "@/lib/tool-preferences";
import { useT } from "@/lib/i18n/react";

/** One sidebar line: a whole tool, or (Craft apps, filter results) one tab of a suite. */
interface Entry {
  tool: ToolMeta;
  tab?: ToolTab;
  label: string;
  hint?: string;
}

function hrefOf(entry: { tool: ToolMeta; tab?: ToolTab }): string {
  return entry.tab ? `/tools/${entry.tool.slug}?tab=${encodeURIComponent(entry.tab.id)}` : `/tools/${entry.tool.slug}`;
}

const ROW = "flex min-h-8 items-center gap-2 rounded-md px-2.5 py-1 text-[13px] transition-colors";
const ROW_IDLE = "text-muted hover:bg-raised hover:text-ink";
const ROW_ACTIVE = "bg-accent/12 font-medium text-ink shadow-[inset_2px_0_0_var(--c-accent)]";

function EntryLink({ entry, active, onNavigate }: { entry: Entry; active: boolean; onNavigate?: () => void }) {
  const { t } = useT();
  return (
    <Link
      href={hrefOf(entry)}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      title={entry.tab && !entry.hint ? `${t(entry.label)}: ${t(entry.tool.name)}` : t(entry.tool.tagline)}
      className={cx(ROW, active ? ROW_ACTIVE : ROW_IDLE)}
    >
      <span className="min-w-0 truncate">{t(entry.label)}</span>
      {entry.hint ? <span className="ml-auto min-w-0 shrink truncate text-[11px] font-normal text-faint">{t(entry.hint)}</span> : null}
      {entry.tool.beta && !entry.tab ? <BetaBadge compact /> : null}
    </Link>
  );
}

/** The tabs of the tool you are in, nested under it (local navigation; never listed on their own). */
function LocalTabs({ tool, activeTab, onNavigate }: { tool: ToolMeta; activeTab: string | null; onNavigate?: () => void }) {
  const { t } = useT();
  if (!tool.tabs || tool.tabs.length < 2) return null;
  return (
    <ul aria-label={t("{name} sections", { name: t(tool.name) })} className="mt-0.5 mb-1 ml-3.5 space-y-px border-l border-line pl-2">
      {tool.tabs.map((tab) => {
        const active = tab.id === activeTab;
        return (
          <li key={tab.id}>
            <Link
              href={hrefOf({ tool, tab })}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cx("flex min-h-7 items-center rounded-md px-2 text-[12.5px] transition-colors", active ? "bg-accent/10 text-ink" : "text-muted hover:bg-raised hover:text-ink")}
            >
              <span className="truncate">{t(tab.label)}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

const COLLAPSED_KEY = "knife:nav-collapsed";
const collapsedListeners = new Set<() => void>();

function subscribeCollapsed(listener: () => void): () => void {
  collapsedListeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    collapsedListeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function readCollapsed(): string {
  try {
    return localStorage.getItem(COLLAPSED_KEY) ?? "[]";
  } catch {
    return "[]";
  }
}

/** Which sections the person folded away, kept per browser; the server renders every section open. */
function useCollapsed(): [Set<string>, (id: string, open: boolean) => void] {
  const raw = useSyncExternalStore(subscribeCollapsed, readCollapsed, () => "[]");
  const collapsed = useMemo(() => {
    try {
      const stored = JSON.parse(raw) as unknown;
      return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : []);
    } catch {
      return new Set<string>();
    }
  }, [raw]);
  const toggle = (id: string, open: boolean) => {
    const next = new Set(collapsed);
    if (open) next.delete(id);
    else next.add(id);
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
    } catch {
      // storage blocked: the section still toggles natively for this page
    }
    for (const listener of collapsedListeners) listener();
  };
  return [collapsed, toggle];
}

const bySlug = new Map(TOOLS.map((tool) => [tool.slug, tool]));

function entryOf(item: NavItem): Entry | null {
  const tool = bySlug.get(item.slug);
  if (!tool) return null;
  const tab = item.tab ? tool.tabs?.find((candidate) => candidate.id === item.tab) : undefined;
  if (item.tab && !tab) return null;
  return { tool, ...(tab ? { tab } : {}), label: item.label ?? tab?.label ?? tool.name, ...(item.hint ? { hint: item.hint } : {}) };
}

/** Filter: matching tools (name, tagline, keywords), then tabs whose name matches, as "Tool · Tab". */
function filterEntries(query: string, t: (text: string) => string): Entry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const tools = searchTools(q).map((tool): Entry => ({ tool, label: tool.name }));
  const tabs = TOOLS.flatMap((tool) =>
    (tool.tabs ?? []).filter((tab) => tool.tabs!.length > 1 && (tab.label.toLowerCase().includes(q) || t(tab.label).toLowerCase().includes(q))).map((tab): Entry => ({ tool, tab, label: tab.label, hint: tool.name })),
  );
  return [...tools, ...tabs].slice(0, 40);
}

function SidebarContent({ activeSlug, onNavigate }: { activeSlug: string | null; onNavigate?: () => void }) {
  const { t } = useT();
  const searchParams = useSearchParams();
  const { favorites, ready } = useToolPreferences();
  const [collapsed, toggle] = useCollapsed();
  const [query, setQuery] = useState("");
  const navRef = useRef<HTMLElement>(null);

  const activeTool = activeSlug ? bySlug.get(activeSlug) : undefined;
  const activeTab = searchParams.get("tab") ?? activeTool?.tabs?.[0]?.id ?? null;
  const sections = useMemo(() => NAV.map((section) => ({ ...section, entries: section.items.map(entryOf).filter((entry): entry is Entry => entry !== null) })), []);
  const footer = useMemo(() => NAV_FOOTER.map(entryOf).filter((entry): entry is Entry => entry !== null), []);
  const pinned = ready ? favorites.map((slug) => bySlug.get(slug)).filter((tool): tool is ToolMeta => Boolean(tool)) : [];
  const results = useMemo(() => filterEntries(query, t), [query, t]);
  // A whole tool is active on any of its tabs; a tab entry (Craft apps, results) only on its own tab.
  const isActive = (entry: Entry) => entry.tool.slug === activeSlug && (entry.tab ? entry.tab.id === activeTab : true);

  // Bring the current page's line into view when it is below the fold (e.g. a Craft app or a tool far down the list).
  useEffect(() => {
    navRef.current?.querySelector<HTMLElement>("a[aria-current=page]")?.scrollIntoView({ block: "nearest" });
  }, [activeSlug, activeTab]);

  const line = (entry: Entry, key: string) => (
    <li key={key}>
      <EntryLink entry={entry} active={isActive(entry)} onNavigate={onNavigate} />
      {!entry.tab && entry.tool.slug === activeSlug ? <LocalTabs tool={entry.tool} activeTab={activeTab} onNavigate={onNavigate} /> : null}
    </li>
  );

  return (
    <nav ref={navRef} aria-label={t("Tools")} className="flex min-h-full flex-col gap-3 px-3 py-3">
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && query) {
            event.stopPropagation();
            setQuery("");
          }
        }}
        aria-label={t("Filter tools")}
        placeholder={t("Filter tools…")}
        autoComplete="off"
        spellCheck={false}
        className="sk-input h-8 w-full px-2.5 text-[13px]"
      />

      <Link
        href="/"
        onClick={onNavigate}
        aria-current={activeSlug === null ? "page" : undefined}
        className={cx(ROW, "font-medium", activeSlug === null ? ROW_ACTIVE : ROW_IDLE)}
      >
        {t("All tools")}
      </Link>

      {query.trim() ? (
        <section aria-label={t("Filtered tools")}>
          {results.length ? (
            <ul className="space-y-px">{results.map((entry) => line(entry, `${entry.tool.slug}:${entry.tab?.id ?? ""}`))}</ul>
          ) : (
            <p className="px-2.5 py-2 text-[13px] text-faint">{t("No tool matches. Ctrl K searches everything.")}</p>
          )}
        </section>
      ) : (
        <>
          {pinned.length > 0 ? (
            <section aria-labelledby="sk-nav-pinned">
              <h2 id="sk-nav-pinned" className="mb-1 px-2.5 text-[11px] font-semibold tracking-wide text-muted uppercase">
                {t("Favorites")}
              </h2>
              <ul className="space-y-px">{pinned.map((tool) => line({ tool, label: tool.name }, `fav:${tool.slug}`))}</ul>
            </section>
          ) : null}

          {sections.map((section) => {
            if (!section.entries.length) return null;
            const here = section.entries.some((entry) => entry.tool.slug === activeSlug);
            // The section you are in always stays open, so the current page is never hidden.
            const open = here || !collapsed.has(section.id);
            return (
              <details
                key={section.id}
                open={open}
                onToggle={(event) => {
                  const now = event.currentTarget.open;
                  if (!here && now === collapsed.has(section.id)) toggle(section.id, now);
                }}
                className="group/section"
                data-nav-section={section.id}
              >
                <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 rounded-md px-2.5 text-[11px] font-semibold tracking-wide text-muted uppercase select-none hover:bg-raised hover:text-ink [&::-webkit-details-marker]:hidden">
                  <span style={categoryTint(section.icon)} className="inline-flex">
                    <CategoryIcon category={section.icon} size={15} />
                  </span>
                  <span className="truncate">{t(section.label)}</span>
                  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden className="ml-auto shrink-0 transition-transform group-open/section:rotate-90" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                    <path d="M6 4l4 4-4 4" />
                  </svg>
                </summary>
                <ul className="mt-0.5 space-y-px">{section.entries.map((entry) => line(entry, `${entry.tool.slug}:${entry.tab?.id ?? ""}`))}</ul>
              </details>
            );
          })}
        </>
      )}

      <ul aria-label={t("Setup")} className="mt-auto space-y-px border-t border-line pt-3">
        {footer.map((entry) => line(entry, `setup:${entry.tool.slug}`))}
      </ul>
    </nav>
  );
}

/**
 * Persistent navigator (src/lib/nav.ts): a filter, Favorites, sections by what people work on with every tool once, the
 * current tool's tabs nested under it, and the setup pages in the footer.
 */
export function Sidebar({ activeSlug, onNavigate }: { activeSlug: string | null; onNavigate?: () => void }) {
  const { t } = useT();
  return (
    <Suspense
      fallback={
        <nav aria-label={t("Tools")} className="space-y-2 px-3 py-3">
          <Link href="/" className="flex min-h-8 items-center px-2.5 text-[13px] text-muted">
            {t("All tools")}
          </Link>
        </nav>
      }
    >
      <SidebarContent activeSlug={activeSlug} onNavigate={onNavigate} />
    </Suspense>
  );
}
