"use client";

import Link from "next/link";
import { Suspense, useMemo, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import { CategoryIcon, categoryTint } from "@/components/category-icons";
import { BetaBadge } from "@/components/ToolShell";
import { cx } from "@/lib/format";
import { NAV } from "@/lib/nav";
import { TOOLS, type ToolMeta, type ToolTab } from "@/lib/registry";
import { useToolPreferences } from "@/lib/tool-preferences";

interface NavEntry {
  tool: ToolMeta;
  tab?: ToolTab;
  label?: string;
}

function NavLink({
  entry,
  active,
  onNavigate,
  nested = false,
}: {
  entry: NavEntry;
  active: boolean;
  onNavigate?: () => void;
  nested?: boolean;
}) {
  const { tool, tab } = entry;
  return (
    <Link
      href={tab ? `/tools/${tool.slug}?tab=${encodeURIComponent(tab.id)}` : `/tools/${tool.slug}`}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      title={tab ? `${entry.label ?? tab.label} — ${tool.name}` : tool.tagline}
      className={cx(
        "group flex min-h-8 items-center gap-2 rounded-lg py-1 text-[13px] transition-colors",
        nested ? "pl-5 pr-2.5" : "px-2.5",
        active
          ? "bg-accent/12 font-medium text-ink shadow-[inset_2px_0_0_var(--c-accent)]"
          : "text-muted hover:bg-raised hover:text-ink",
      )}
    >
      <span className="truncate">{entry.label ?? tab?.label ?? tool.name}</span>
      {tool.beta ? <BetaBadge compact /> : null}
      {!tab && tool.tabs && tool.tabs.length > 1 ? (
        <span className="ml-auto shrink-0 font-mono text-[10px] text-faint tabular-nums">
          {tool.tabs.length}
        </span>
      ) : null}
    </Link>
  );
}

function SectionTitle({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <h2 className="mb-1 flex items-center gap-2 px-2.5 font-mono text-[10px] font-semibold tracking-[0.14em] text-faint uppercase">
      {children}
      {count !== undefined ? <span className="font-normal tabular-nums">{count}</span> : null}
    </h2>
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

function SidebarContent({
  activeSlug,
  onNavigate,
}: {
  activeSlug: string | null;
  onNavigate?: () => void;
}) {
  const searchParams = useSearchParams();
  const { favorites, recent, ready } = useToolPreferences();
  const [collapsed, toggle] = useCollapsed();

  const bySlug = useMemo(() => new Map(TOOLS.map((tool) => [tool.slug, tool])), []);
  const activeTab = searchParams.get("tab") ?? bySlug.get(activeSlug ?? "")?.tabs?.[0]?.id ?? null;
  const pick = (slugs: string[]) =>
    slugs.map((slug) => bySlug.get(slug)).filter((tool): tool is ToolMeta => Boolean(tool));
  const favTools = ready ? pick(favorites) : [];
  const recentTools = ready ? pick(recent).slice(0, 5) : [];

  const sections = useMemo(
    () =>
      NAV.map((section) => ({
        ...section,
        groups: section.groups.map((group) => ({
          ...group,
          entries: group.items
            .map((item): NavEntry | null => {
              const tool = bySlug.get(item.slug);
              if (!tool) return null;
              const tab = item.tab ? tool.tabs?.find((candidate) => candidate.id === item.tab) : undefined;
              if (item.tab && !tab) return null;
              return { tool, ...(tab ? { tab } : {}), ...(item.label ? { label: item.label } : {}) };
            })
            .filter((entry): entry is NavEntry => entry !== null),
        })),
      })),
    [bySlug],
  );
  // A suite listed as a whole is active on any of its tabs; a tab entry only on its own tab.
  const isActive = (entry: NavEntry) => entry.tool.slug === activeSlug && (entry.tab ? entry.tab.id === activeTab : true);

  return (
    <nav aria-label="Tools" className="space-y-4 px-3 py-4">
      <Link
        href="/"
        onClick={onNavigate}
        aria-current={activeSlug === null ? "page" : undefined}
        className={cx(
          "flex min-h-8 items-center gap-2 rounded-lg px-2.5 py-1 text-[13px] font-medium transition-colors",
          activeSlug === null
            ? "bg-accent/12 text-ink shadow-[inset_2px_0_0_var(--c-accent)]"
            : "text-muted hover:bg-raised hover:text-ink",
        )}
      >
        All tools
        <span className="ml-auto font-mono text-[10px] text-faint tabular-nums">{TOOLS.length}</span>
      </Link>

      {favTools.length > 0 ? (
        <section>
          <SectionTitle count={favTools.length}>★ Favorites</SectionTitle>
          {favTools.map((tool) => (
            <NavLink key={tool.slug} entry={{ tool }} active={false} onNavigate={onNavigate} />
          ))}
        </section>
      ) : null}

      {recentTools.length > 0 ? (
        <section>
          <SectionTitle>Recent</SectionTitle>
          {recentTools.map((tool) => (
            <NavLink key={tool.slug} entry={{ tool }} active={false} onNavigate={onNavigate} />
          ))}
        </section>
      ) : null}

      {sections.map((section) => {
        const count = section.groups.reduce((sum, group) => sum + group.entries.length, 0);
        if (!count) return null;
        return (
          <details
            key={section.id}
            open={!collapsed.has(section.id)}
            onToggle={(event) => {
              const open = event.currentTarget.open;
              if (open === collapsed.has(section.id)) toggle(section.id, open);
            }}
            className="group"
            data-nav-section={section.id}
          >
            <summary className="mb-1 flex cursor-pointer list-none items-center gap-2 rounded-md px-2.5 py-1.5 font-mono text-[10px] font-semibold tracking-[0.14em] text-faint uppercase hover:bg-raised [&::-webkit-details-marker]:hidden">
              <span style={categoryTint(section.icon)} className="inline-flex">
                <CategoryIcon category={section.icon} size={14} />
              </span>
              {section.label}
              <span className="font-normal tabular-nums">{count}</span>
              <span aria-hidden className="ml-auto text-[11px] transition-transform group-open:rotate-90">›</span>
            </summary>
            {section.groups.map((group, index) =>
              group.entries.length ? (
                <div key={group.title ?? index} className={group.title ? "mt-2" : undefined}>
                  {group.title ? <SectionTitle count={group.entries.length}>{group.title}</SectionTitle> : null}
                  {group.entries.map((entry) => (
                    <NavLink
                      key={`${entry.tool.slug}:${entry.tab?.id ?? "tool"}`}
                      entry={entry}
                      nested={Boolean(group.title)}
                      active={isActive(entry)}
                      onNavigate={onNavigate}
                    />
                  ))}
                </div>
              ) : null,
            )}
          </details>
        );
      })}
    </nav>
  );
}

/** Persistent navigator: sections by task (src/lib/nav.ts), Simple / Advanced sub-groups, each Craft app on its own line. */
export function Sidebar({
  activeSlug,
  onNavigate,
}: {
  activeSlug: string | null;
  onNavigate?: () => void;
}) {
  return (
    <Suspense
      fallback={
        <nav aria-label="Tools" className="space-y-2 px-3 py-4">
          <Link href="/" className="flex min-h-8 items-center px-2.5 text-[13px] text-muted">
            All tools
          </Link>
        </nav>
      }
    >
      <SidebarContent activeSlug={activeSlug} onNavigate={onNavigate} />
    </Suspense>
  );
}
