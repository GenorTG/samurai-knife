"use client";

import { useCallback, useSyncExternalStore } from "react";
import { canonicalSlug } from "@/lib/registry";
import { showcaseHref } from "@/lib/showcase";

/**
 * Whether launcher and home cards open a tool's showcase (`/tools/<slug>/about`) first or the tool itself
 * (docs/SHOWCASE.md). Local storage of this browser only, described in the privacy notice § 6 (edition 8):
 * `direct` = "Open tools straight away", `skip` = tools whose showcase the user chose not to see again.
 */
export const SHOWCASE_PREFS_KEY = "samurai-knife:showcase:v1";

export interface ShowcasePrefs {
  direct: boolean;
  skip: string[];
}

const EMPTY: ShowcasePrefs = { direct: false, skip: [] };
const subscribers = new Set<() => void>();
let memorySnapshot: string | undefined;

export function decodeShowcasePrefs(raw: string | null): ShowcasePrefs {
  if (!raw) return EMPTY;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return EMPTY;
    const stored = value as Record<string, unknown>;
    const skip = Array.isArray(stored.skip)
      ? [...new Set(stored.skip.filter((slug): slug is string => typeof slug === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)).map(canonicalSlug))].slice(0, 200)
      : [];
    return { direct: stored.direct === true, skip };
  } catch {
    return EMPTY;
  }
}

function getSnapshot(): string {
  if (memorySnapshot !== undefined) return memorySnapshot;
  try {
    return window.localStorage.getItem(SHOWCASE_PREFS_KEY) ?? "";
  } catch {
    return "";
  }
}

/** The server (and hydration) always renders the showcase links; the stored choice applies right after. */
function getServerSnapshot(): null {
  return null;
}

function onStorage(event: StorageEvent) {
  if (event.key !== SHOWCASE_PREFS_KEY && event.key !== null) return;
  memorySnapshot = undefined;
  subscribers.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  subscribers.add(fn);
  if (subscribers.size === 1) window.addEventListener("storage", onStorage);
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0) window.removeEventListener("storage", onStorage);
  };
}

function update(change: (current: ShowcasePrefs) => ShowcasePrefs) {
  memorySnapshot = JSON.stringify(change(decodeShowcasePrefs(getSnapshot())));
  try {
    window.localStorage.setItem(SHOWCASE_PREFS_KEY, memorySnapshot);
  } catch {
    // Storage blocked: the choice holds for this page visit.
  }
  subscribers.forEach((fn) => fn());
}

/** Where a card for `slug` (optionally a tab of it) leads: its showcase, unless the user chose the tool directly. */
export function entryHref(prefs: ShowcasePrefs, slug: string, tab?: string | null): string {
  const canonical = canonicalSlug(slug);
  if (prefs.direct || prefs.skip.includes(canonical)) return `/tools/${slug}${tab ? `?tab=${encodeURIComponent(tab)}` : ""}`;
  return showcaseHref(canonical, tab);
}

export function useShowcasePrefs() {
  const raw = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const prefs = decodeShowcasePrefs(raw);
  const setDirect = useCallback((direct: boolean) => update((current) => ({ ...current, direct })), []);
  const setSkip = useCallback(
    (slug: string, skip: boolean) =>
      update((current) => ({ ...current, skip: skip ? [...new Set([slug, ...current.skip])] : current.skip.filter((s) => s !== slug) })),
    [],
  );
  return { prefs, ready: raw !== null, setDirect, setSkip };
}
