"use client";

import Link from "next/link";
import { useMemo } from "react";
import { CategoryIcon, categoryTint } from "@/components/category-icons";
import { cx } from "@/lib/format";
import { CATEGORIES, TOOLS, type ToolMeta } from "@/lib/registry";
import { useToolPreferences } from "@/lib/tool-preferences";

function NavLink({
  tool,
  active,
  onNavigate,
}: {
  tool: ToolMeta;
  active: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={`/tools/${tool.slug}`}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      title={tool.tagline}
      className={cx(
        "group flex min-h-8 items-center gap-2 rounded-lg px-2.5 py-1 text-[13px] transition-colors",
        active
          ? "bg-accent/12 font-medium text-ink shadow-[inset_2px_0_0_var(--c-accent)]"
          : "text-muted hover:bg-raised hover:text-ink",
      )}
    >
      <span className="truncate">{tool.name}</span>
      {tool.tabs ? (
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

/** Persistent tool navigator: favorites, recent, then every category. */
export function Sidebar({
  activeSlug,
  onNavigate,
}: {
  activeSlug: string | null;
  onNavigate?: () => void;
}) {
  const { favorites, recent, ready } = useToolPreferences();

  const bySlug = useMemo(() => new Map(TOOLS.map((t) => [t.slug, t])), []);
  const pick = (slugs: string[]) =>
    slugs.map((s) => bySlug.get(s)).filter((t): t is ToolMeta => Boolean(t));
  const favTools = ready ? pick(favorites) : [];
  const recentTools = ready ? pick(recent).slice(0, 5) : [];

  const groups = useMemo(
    () =>
      CATEGORIES.map((cat) => ({
        ...cat,
        items: TOOLS.filter((t) => t.category === cat.id),
      })).filter((g) => g.items.length > 0),
    [],
  );

  return (
    <nav aria-label="Tools" className="space-y-5 px-3 py-4">
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
          {favTools.map((t) => (
            <NavLink key={t.slug} tool={t} active={false} onNavigate={onNavigate} />
          ))}
        </section>
      ) : null}

      {recentTools.length > 0 ? (
        <section>
          <SectionTitle>Recent</SectionTitle>
          {recentTools.map((t) => (
            <NavLink key={t.slug} tool={t} active={false} onNavigate={onNavigate} />
          ))}
        </section>
      ) : null}

      {groups.map((g) => (
        <section key={g.id}>
          <h2 className="mb-1 flex items-center gap-2 px-2.5 font-mono text-[10px] font-semibold tracking-[0.14em] text-faint uppercase">
            <span style={categoryTint(g.id)} className="inline-flex">
              <CategoryIcon category={g.id} size={14} />
            </span>
            {g.label}
            <span className="font-normal tabular-nums">{g.items.length}</span>
          </h2>
          {g.items.map((t) => (
            <NavLink key={t.slug} tool={t} active={t.slug === activeSlug} onNavigate={onNavigate} />
          ))}
        </section>
      ))}
    </nav>
  );
}
