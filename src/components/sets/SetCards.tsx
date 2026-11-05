"use client";

import Link from "next/link";
import { CategoryIcon, categoryTint } from "@/components/category-icons";
import { useT } from "@/lib/i18n/react";
import { TOOL_SETS, TOP_TASKS, type ToolSet } from "@/lib/toolsets";

function Arrow() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-accent-soft">
      <path d="M3 8h9M8.5 4.5L12 8l-3.5 3.5" />
    </svg>
  );
}

/** The first thing on the home page: the jobs most people come for, as big buttons in their own words. */
export function TopTasks() {
  const { t } = useT();
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-top-tasks>
      {TOP_TASKS.map((task) => (
        <li key={task.label}>
          <Link href={task.href} className="group flex h-full items-center gap-3 rounded-tool border border-line bg-surface p-4 shadow-card transition-colors hover:border-accent/50 hover:bg-raised/50 focus-visible:outline-2 focus-visible:outline-accent">
            <span className="min-w-0 flex-1">
              <span className="block text-base font-semibold text-ink">{t(task.label)}</span>
              <span className="mt-0.5 block text-[13px] leading-relaxed text-muted">{t(task.hint)}</span>
            </span>
            <Arrow />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** One card per tool set, leading with what it replaces. */
export function SetCard({ set }: { set: ToolSet }) {
  const { t } = useT();
  return (
    <Link href={`/sets/${set.id}`} data-set-card={set.id} className="group flex h-full flex-col gap-3 rounded-tool border border-line bg-surface p-5 shadow-card transition-colors hover:border-accent/50 hover:bg-raised/40 focus-visible:outline-2 focus-visible:outline-accent">
      <span className="flex items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-line bg-raised/70" style={categoryTint(set.icon)}>
          <CategoryIcon category={set.icon} />
        </span>
        <span className="min-w-0 text-[13px] font-medium text-muted">{t(set.name)}</span>
      </span>
      <span className="text-lg font-semibold leading-snug tracking-tight text-ink">{t(set.headline)}</span>
      <span className="line-clamp-3 flex-1 text-sm leading-relaxed text-muted">{t(set.pitch)}</span>
      <span className="flex items-center gap-1.5 text-sm font-medium text-accent-soft">
        {t("See what's inside")}
        <Arrow />
      </span>
    </Link>
  );
}

export function SetCards({ only }: { only?: readonly string[] }) {
  const sets = only ? TOOL_SETS.filter((set) => only.includes(set.id)) : TOOL_SETS;
  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-set-cards>
      {sets.map((set) => (
        <li key={set.id}>
          <SetCard set={set} />
        </li>
      ))}
    </ul>
  );
}
