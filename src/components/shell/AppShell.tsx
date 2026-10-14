"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Brand } from "@/components/ToolShell";
import { cx } from "@/lib/format";
import { canonicalSlug, categoryLabel, findTool, TOOLS } from "@/lib/registry";
import { openAssistant } from "@/lib/agent-client/bridge";
import { AgentPill, AgentStrip } from "./AgentPill";
import { CommandPalette } from "./CommandPalette";
import { Sidebar } from "./Sidebar";
import { emitShell, SHELL_EVENTS, setSidebarCollapsed, useSidebarCollapsed } from "./shell-store";
import { ShortcutsHelp } from "./ShortcutsHelp";

function isTyping(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function IconButton({
  label,
  onClick,
  children,
  className,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      autoComplete="off"
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cx(
        "inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-muted shadow-xs transition-colors hover:border-line-strong hover:text-ink",
        className,
      )}
    >
      {children}
    </button>
  );
}

/**
 * Global frame: sticky top bar, persistent tool sidebar (drawer on small
 * screens), content that fills all remaining width, and the app-wide
 * keyboard layer (palette, help, chords, prev/next tool).
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const collapsed = useSidebarCollapsed();
  const [drawerAt, setDrawerAt] = useState<string | null>(null);
  const drawerOpen = drawerAt === pathname;
  const chord = useRef<number>(0);

  const match = /^\/tools\/([^/]+)/.exec(pathname);
  const activeSlug = match ? canonicalSlug(match[1]) : null;
  const tool = activeSlug ? findTool(activeSlug) : undefined;

  useEffect(() => {
    const toggleSidebar = () => {
      if (window.matchMedia("(min-width: 1024px)").matches) {
        setSidebarCollapsed(!collapsed);
      } else {
        setDrawerAt((v) => (v === pathname ? null : pathname));
      }
    };
    const step = (dir: 1 | -1) => {
      if (!activeSlug) return;
      const i = TOOLS.findIndex((t) => t.slug === activeSlug);
      if (i < 0) return;
      router.push(`/tools/${TOOLS[(i + dir + TOOLS.length) % TOOLS.length].slug}`);
    };
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "j") {
        e.preventDefault();
        openAssistant();
        return;
      }
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        emitShell(SHELL_EVENTS.palette);
        return;
      }
      if (mod || e.altKey || isTyping(e.target)) return;
      // The palette and the shortcuts help are modal: single keys must not act on the page behind the scrim.
      // (`?` stays a toggle so the help can be closed the way it was opened.)
      if (e.key !== "?" && document.querySelector('[aria-modal="true"]')) return;
      if (e.key === "/") {
        e.preventDefault();
        const launcher = document.querySelector<HTMLInputElement>("[data-launcher-search]");
        if (launcher) launcher.focus();
        else emitShell(SHELL_EVENTS.palette);
      } else if (e.key === "a") {
        e.preventDefault();
        openAssistant();
      } else if (e.key === "?") {
        emitShell(SHELL_EVENTS.help);
      } else if (e.key === "b") {
        toggleSidebar();
      } else if (e.key === "[") {
        step(-1);
      } else if (e.key === "]") {
        step(1);
      } else if (e.key === "g") {
        chord.current = Date.now();
      } else if (e.key === "h" && Date.now() - chord.current < 900) {
        chord.current = 0;
        router.push("/");
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(SHELL_EVENTS.sidebar, toggleSidebar);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(SHELL_EVENTS.sidebar, toggleSidebar);
    };
  }, [activeSlug, collapsed, pathname, router]);

  return (
    <div className="flex min-h-dvh flex-col">
      <div className="sticky top-0 z-40 shrink-0">
        <header className="group/header sk-glass flex h-14 items-center gap-3 border-b border-line px-3 sm:px-4">
          <IconButton label="Toggle sidebar (b)" onClick={() => emitShell(SHELL_EVENTS.sidebar)}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </IconButton>
          <Brand />
          {tool ? (
            <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-2 text-sm md:flex">
              <span aria-hidden className="text-line-strong">/</span>
              <span className="text-faint">{categoryLabel(tool.category)}</span>
              <span aria-hidden className="text-line-strong">/</span>
              <span className="truncate font-medium text-ink">{tool.name}</span>
            </nav>
          ) : null}
          <div className="ml-auto flex min-w-0 items-center gap-2">
            <AgentPill />
            <button
              autoComplete="off"
              type="button"
              onClick={() => emitShell(SHELL_EVENTS.palette)}
              aria-label="Search tools (Ctrl K)"
              className="inline-flex h-9 min-w-9 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 text-sm text-muted shadow-xs transition-colors hover:border-line-strong hover:text-ink sm:w-64 sm:px-3"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                <circle cx="11" cy="11" r="6.5" />
                <path d="M16 16l4.5 4.5" />
              </svg>
              <span className="hidden flex-1 text-left sm:block">Jump to a tool…</span>
              <kbd className="sk-kbd hidden sm:block">Ctrl K</kbd>
            </button>
            <IconButton label="Keyboard shortcuts (?)" onClick={() => emitShell(SHELL_EVENTS.help)} className="max-sm:hidden">
              <span aria-hidden className="font-mono text-sm">?</span>
            </IconButton>
            <ThemeToggle />
          </div>
        </header>
        <div className="bg-bg sm:hidden">
          <AgentStrip />
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside
          className={cx(
            "sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-64 shrink-0 overflow-y-auto overscroll-contain border-r border-line bg-surface/40 xl:w-72",
            collapsed ? "" : "lg:block",
          )}
        >
          <Sidebar activeSlug={activeSlug} />
        </aside>

        {drawerOpen ? (
          <div className="fixed inset-0 top-14 z-[60] lg:hidden" onMouseDown={(e) => { if (e.target === e.currentTarget) setDrawerAt(null); }}>
            <div className="sk-scrim absolute inset-0 backdrop-blur-sm" aria-hidden />
            <aside className="sk-slide absolute inset-y-0 left-0 w-[min(20rem,88vw)] overflow-y-auto border-r border-line bg-bg shadow-pop">
              <Sidebar activeSlug={activeSlug} onNavigate={() => setDrawerAt(null)} />
            </aside>
          </div>
        ) : null}

        <div className="sk-dock-pad min-w-0 flex-1">{children}</div>
      </div>

      <CommandPalette />
      <ShortcutsHelp />
    </div>
  );
}
