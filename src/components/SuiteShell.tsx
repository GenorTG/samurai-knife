"use client";

import { usePathname, useSearchParams } from "next/navigation";
import {
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cx } from "@/lib/format";
import { useT } from "@/lib/i18n/react";

export interface SuiteTab {
  id: string;
  label: string;
  /** Panel wants the full viewport width; see `.sk-tool-main` in globals.css. */
  wide?: boolean;
}

const TAB_PARAM = "tab";

function tabClass(selected: boolean) {
  return cx(
    "relative -mb-px min-h-10 shrink-0 cursor-pointer whitespace-nowrap rounded-t-lg border-b-2 px-3.5 py-2 text-sm font-medium transition-colors",
    "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
    selected
      ? "border-accent text-ink"
      : "border-transparent text-muted hover:bg-raised/60 hover:text-ink",
  );
}

/**
 * Tabs for a suite of related tools. The selected tab lives in `?tab=<id>` so
 * every tab is deep-linkable and Back/Forward walk through them. Updates use
 * the History API directly (Next.js syncs `useSearchParams` with it), so
 * switching tabs never reloads the page or refetches the route.
 */
function SuiteTabs({
  tabs,
  label,
  renderTab,
}: {
  tabs: SuiteTab[];
  label: string;
  renderTab: (id: string) => ReactNode;
}) {
  const { t } = useT();
  const baseId = useId();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const listRef = useRef<HTMLDivElement>(null);
  // Which edges of the tab strip have more tabs hidden behind them (drives the fade mask).
  const [overflow, setOverflow] = useState({ start: false, end: false });

  const requested = searchParams.get(TAB_PARAM);
  const active = tabs.find((tab) => tab.id === requested) ?? tabs[0];
  const activeId = active?.id;

  const select = useCallback(
    (id: string, mode: "push" | "replace") => {
      if (id === activeId) return;
      const params = new URLSearchParams(window.location.search);
      params.set(TAB_PARAM, id);
      const url = `${pathname}?${params.toString()}${window.location.hash}`;
      if (mode === "push") window.history.pushState(null, "", url);
      else window.history.replaceState(null, "", url);
    },
    [activeId, pathname],
  );

  // Keep the selected tab visible inside the tab strip. Scrolling the strip
  // itself (not scrollIntoView) means the page never jumps vertically.
  useEffect(() => {
    const list = listRef.current;
    const selected = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !selected) return;
    const target = selected.offsetLeft - (list.clientWidth - selected.offsetWidth) / 2;
    list.scrollTo({ left: Math.max(0, target) });
  }, [activeId]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const start = list.scrollLeft > 1;
      const end = list.scrollLeft + list.clientWidth < list.scrollWidth - 1;
      setOverflow((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    };
    measure();
    list.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => {
      list.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [tabs, activeId]);

  // Alt+1…9 jumps straight to the nth tab, from anywhere on the page.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const n = Number(e.code.replace("Digit", ""));
      if (!Number.isInteger(n) || n < 1 || n > tabs.length) return;
      e.preventDefault();
      select(tabs[n - 1].id, "push");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [select, tabs]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex((tab) => tab.id === activeId);
    let next = -1;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    event.preventDefault();
    // Arrow keys replace instead of push so holding a key does not flood history.
    select(tabs[next].id, "replace");
    listRef.current
      ?.querySelector<HTMLElement>(`[data-tab-id="${tabs[next].id}"]`)
      ?.focus({ preventScroll: true });
  }

  return (
    <div>
      <div
        ref={listRef}
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        data-fade={overflow.start && overflow.end ? "both" : overflow.start ? "start" : overflow.end ? "end" : undefined}
        className="sk-tablist relative mb-5 flex min-w-0 max-w-full gap-0.5 overflow-x-auto overscroll-x-contain border-b border-line"
      >
        {tabs.map((tab) => {
          const selected = tab.id === activeId;
          return (
            <button
              autoComplete="off"
              key={tab.id}
              type="button"
              role="tab"
              id={`${baseId}-tab-${tab.id}`}
              data-tab-id={tab.id}
              aria-selected={selected}
              aria-controls={selected ? `${baseId}-panel-${tab.id}` : undefined}
              tabIndex={selected ? 0 : -1}
              onClick={() => select(tab.id, "push")}
              className={tabClass(selected)}
            >
              {t(tab.label)}
            </button>
          );
        })}
      </div>
      {active ? (
        <div
          key={active.id}
          role="tabpanel"
          id={`${baseId}-panel-${active.id}`}
          aria-labelledby={`${baseId}-tab-${active.id}`}
          className="sk-tabpanel min-w-0"
          data-tab-panel={active.id}
          data-wide={active.wide ? "true" : undefined}
        >
          {renderTab(active.id)}
        </div>
      ) : null}
    </div>
  );
}

/** Static stand-in while `useSearchParams` resolves on a prerendered page. */
function SuiteFallback({ tabs, label }: { tabs: SuiteTab[]; label: string }) {
  const { t } = useT();
  return (
    <div aria-busy="true">
      <div
        role="tablist"
        aria-label={label}
        className="sk-tablist mb-5 flex min-w-0 max-w-full gap-0.5 overflow-x-auto border-b border-line"
      >
        {tabs.map((tab, index) => (
          <span
            key={tab.id}
            role="tab"
            aria-selected={index === 0}
            aria-disabled="true"
            className={tabClass(index === 0)}
          >
            {t(tab.label)}
          </span>
        ))}
      </div>
    </div>
  );
}

export function SuiteShell(props: {
  tabs: SuiteTab[];
  label: string;
  renderTab: (id: string) => ReactNode;
}) {
  const { t } = useT();
  return (
    <Suspense fallback={<SuiteFallback tabs={props.tabs} label={t(props.label)} />}>
      <SuiteTabs {...props} />
    </Suspense>
  );
}
