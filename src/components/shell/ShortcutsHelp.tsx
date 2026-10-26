"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { SHELL_EVENTS } from "./shell-store";
import { useT } from "@/lib/i18n/react";
import { msg } from "@/lib/i18n/msg";

const ROWS: { keys: string[]; label: string }[] = [
  { keys: [msg("Ctrl/⌘"), "K"], label: msg("Jump to any tool") },
  { keys: ["/"], label: msg("Search (launcher on Home, palette elsewhere)") },
  { keys: ["a"], label: msg("Open the assistant (Ctrl/⌘ J anywhere)") },
  { keys: ["g", "h"], label: msg("Go Home") },
  { keys: ["["], label: msg("Previous tool") },
  { keys: ["]"], label: msg("Next tool") },
  { keys: [msg("Alt"), "1–9"], label: msg("Switch suite tab") },
  { keys: ["b"], label: msg("Toggle sidebar") },
  { keys: ["?"], label: msg("This help") },
];

export function ShortcutsHelp() {
  const { t } = useT();
  const pathname = usePathname();
  // Shown only on the page it was opened on (the shell survives client navigation, see CommandPalette).
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === pathname;
  const setOpen = (value: boolean) => setOpenAt(value ? pathname : null);

  useEffect(() => {
    const toggle = () => setOpenAt((v) => (v === pathname ? null : pathname));
    window.addEventListener(SHELL_EVENTS.help, toggle);
    return () => window.removeEventListener(SHELL_EVENTS.help, toggle);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenAt(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[70] grid place-items-center sk-scrim px-3 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("Keyboard shortcuts")}
        className="sk-pop sk-glass w-full max-w-md rounded-2xl border border-line-strong p-5 shadow-pop"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink">{t("Keyboard shortcuts")}</h2>
          <button autoComplete="off" type="button" onClick={() => setOpen(false)} className="rounded-md px-2 py-1 text-xs text-muted hover:bg-raised hover:text-ink">
            {t("Close")}
          </button>
        </div>
        <dl className="divide-y divide-line">
          {ROWS.map((row) => (
            <div key={row.label} className="flex items-center justify-between gap-4 py-2 text-sm">
              <dt className="text-muted">{t(row.label)}</dt>
              <dd className="flex shrink-0 gap-1">
                {row.keys.map((k) => (
                  <kbd key={k} className="sk-kbd">{k}</kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
