"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Badge, Button, EmptyState, Notice, SegmentedControl } from "@/components/ui";
import { describeChanges } from "@/lib/cv/diff";
import type { CvData, CvLang } from "@/lib/cv/schema";
import { useCvLang } from "./prefs";
import type { CvLive } from "./useCvData";
import { useT } from "@/lib/i18n/react";
import { msg } from "@/lib/i18n/msg";

const TOAST_MS = 9000;
const FLASH_MS = 1800;

/* ---------------------------------------------------------------- flashing */

/** The nearest rendered `[data-cv-path]` for a changed path: the path itself, else its closest ancestor. */
function findPathElements(path: string): HTMLElement[] {
  const all = Array.from(document.querySelectorAll<HTMLElement>("[data-cv-path]"));
  let probe = path;
  while (probe) {
    const hit = all.filter((el) => el.dataset.cvPath === probe);
    if (hit.length > 0) return hit;
    probe = probe.slice(0, Math.max(0, probe.lastIndexOf("/")));
  }
  return [];
}

export function flashElement(el: HTMLElement): void {
  el.setAttribute("data-cv-flash", "1");
  if (typeof el.animate === "function" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    el.animate(
      [
        { backgroundColor: "color-mix(in srgb, var(--c-accent) 40%, transparent)", boxShadow: "0 0 0 3px color-mix(in srgb, var(--c-accent) 45%, transparent)" },
        { backgroundColor: "transparent", boxShadow: "0 0 0 0 transparent" },
      ],
      { duration: FLASH_MS, easing: "ease-out" },
    );
  }
  setTimeout(() => el.removeAttribute("data-cv-flash"), FLASH_MS);
}

export function flashPaths(paths: readonly string[]): void {
  const seen = new Set<HTMLElement>();
  for (const path of paths) for (const el of findPathElements(path)) if (!seen.has(el)) {
    seen.add(el);
    flashElement(el);
  }
}

/* ------------------------------------------------------------------ toasts */

interface Toast {
  id: number;
  text: string;
}

/**
 * Toast + field flash for every change batch the poller reports, whoever made it. `Updated <label>: before -> after`
 * with an Undo button (POST /api/cv/undo). Rendered inline (not a portal) so the assistant's UI tools can click Undo.
 */
export function LiveLayer({ live }: { live: CvLive }) {
  const { t: tr } = useT();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [undoError, setUndoError] = useState("");
  const lastSeq = useRef(0);
  const { batch } = live;

  useEffect(() => {
    if (!batch || batch.seq === lastSeq.current) return;
    lastSeq.current = batch.seq;
    const frame = requestAnimationFrame(() => flashPaths(batch.changes.map((c) => c.path)));
    const toast: Toast = { id: batch.seq, text: describeChanges(batch.changes) };
    setToasts((current) => [...current.slice(-2), toast]);
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== toast.id)), TOAST_MS);
    return () => cancelAnimationFrame(frame);
  }, [batch]);

  if (toasts.length === 0 && !undoError) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4" data-cv-toasts>
      {undoError ? (
        <div role="alert" className="pointer-events-auto w-full max-w-lg"><Notice tone="error">{undoError}</Notice></div>
      ) : null}
      <div role="status" aria-live="polite" className="flex w-full max-w-lg flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            data-cv-toast
            className="sk-pop pointer-events-auto flex items-start gap-2 rounded-xl border border-line-strong bg-surface px-3 py-2.5 text-[13px] text-ink shadow-pop"
          >
            <span className="min-w-0 flex-1 wrap-anywhere">{toast.text}</span>
            <Button
              size="sm"
              variant="primary"
              onClick={async () => {
                const message = await live.undo();
                setUndoError(message);
                setToasts((current) => current.filter((t) => t.id !== toast.id));
              }}
            >
              {tr("Undo")}
            </Button>
            <Button size="sm" variant="ghost" aria-label={tr("Dismiss notification")} onClick={() => setToasts((current) => current.filter((t) => t.id !== toast.id))}>
              {tr("Dismiss")}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- tab frame */

/** Loading / error / ready wrapper that every CV tab renders through; mounts the live layer once per tab. */
export function CvFrame({ live, children }: { live: CvLive; children: (data: CvData) => ReactNode }) {
  const { t: tr } = useT();
  return (
    <div className="space-y-4">
      {live.data ? children(live.data) : live.status === "error" ? (
        <Notice tone="error">{tr("Could not load the CV workspace:")}{" "} {live.error}</Notice>
      ) : (
        <p role="status" className="py-10 text-center text-sm text-muted">{tr("Loading CV workspace…")}</p>
      )}
      {live.data && live.error ? <Notice tone="warn">{tr("Connection problem, showing the last known data:")}{" "} {live.error}</Notice> : null}
      <LiveLayer live={live} />
    </div>
  );
}

/** PL | EN switch, remembered per tab. */
export function LangToggle({ tab, label = msg("Document language") }: { tab: string; label?: string }) {
  const [lang, setLang] = useCvLang(tab);
  return (
    <SegmentedControl<CvLang>
      label={label}
      value={lang}
      onChange={setLang}
      options={[{ value: "pl", label: "PL", ariaLabel: "Polish" }, { value: "en", label: "EN", ariaLabel: "English" }]}
    />
  );
}

export function useLang(tab: string): CvLang {
  return useCvLang(tab)[0];
}

/** Shown on every tab when no profile exists yet. */
export function NoProfileNotice() {
  const { t: tr } = useT();
  return (
    <EmptyState
      title={tr("No profile yet")}
      action={<Link href="/tools/cv-studio?tab=profile" className="sk-btn-primary inline-flex h-9 items-center rounded-lg bg-accent px-3.5 text-sm font-semibold text-accent-fg">{tr("Open the Profile tab")}</Link>}
    >
      {tr("Import your master CV first (paste a JSON profile or ask the assistant to structure your CV). Versions, offers and matching all build on it.")}
    </EmptyState>
  );
}

export function profileIsEmpty(data: CvData): boolean {
  const p = data.profile;
  return !p.contact.name && p.experience.length === 0 && p.projects.length === 0 && !p.summary.pl && !p.summary.en;
}

/* ------------------------------------------------------------------ misc */

/** Evidence/finding path -> the Profile tab, focused on that field. */
export function profileHref(path: string): string {
  return `/tools/cv-studio?tab=profile&focus=${encodeURIComponent(path)}`;
}

export function externalUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** A saved link that always opens safely in a new tab (http/https only). */
export function SafeLink({ href, children, className }: { href: string; children?: ReactNode; className?: string }) {
  const url = externalUrl(href);
  if (!url) return <span className="wrap-anywhere text-muted">{href}</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className={className ?? "wrap-anywhere text-accent-soft underline underline-offset-2 hover:text-ink"}>
      {children ?? url}
    </a>
  );
}

export function SeverityBadge({ severity }: { severity: string }) {
  const tone = /err|high|critical/i.test(severity) ? "danger" : /warn|medium/i.test(severity) ? "warn" : "neutral";
  return <Badge tone={tone}>{severity}</Badge>;
}

