"use client";

import { useCallback, useSyncExternalStore } from "react";
import { canonicalSlug } from "@/lib/registry";

const STORAGE_KEY = "samurai-knife:tool-preferences:v1";
const RECENT_LIMIT = 12;

interface ToolPreferences {
  favorites: string[];
  recent: string[];
}

const EMPTY_PREFERENCES: ToolPreferences = { favorites: [], recent: [] };
const subscribers = new Set<() => void>();
let memorySnapshot: string | undefined;
let storageListenerInstalled = false;

function uniqueSlugs(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];

  const slugs = value.filter(
    (slug): slug is string =>
      typeof slug === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug),
  );
  // Retired slugs (tools folded into suites) map to their suite so old
  // favorites and history keep working.
  return [...new Set(slugs.map(canonicalSlug))].slice(0, limit);
}

function decodePreferences(raw: string | null): ToolPreferences {
  if (!raw) return EMPTY_PREFERENCES;

  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return EMPTY_PREFERENCES;

    const stored = value as Record<string, unknown>;
    return {
      favorites: uniqueSlugs(stored.favorites, 500),
      recent: uniqueSlugs(stored.recent, RECENT_LIMIT),
    };
  } catch {
    return EMPTY_PREFERENCES;
  }
}

function getSnapshot(): string {
  if (memorySnapshot !== undefined) return memorySnapshot;
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function getServerSnapshot(): null {
  return null;
}

function notifySubscribers() {
  subscribers.forEach((subscriber) => subscriber());
}

function onStorage(event: StorageEvent) {
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  memorySnapshot = undefined;
  notifySubscribers();
}

function subscribe(subscriber: () => void) {
  subscribers.add(subscriber);
  if (!storageListenerInstalled) {
    window.addEventListener("storage", onStorage);
    storageListenerInstalled = true;
  }

  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0 && storageListenerInstalled) {
      window.removeEventListener("storage", onStorage);
      storageListenerInstalled = false;
    }
  };
}

function updatePreferences(update: (current: ToolPreferences) => ToolPreferences) {
  const next = update(decodePreferences(getSnapshot()));
  memorySnapshot = JSON.stringify(next);
  try {
    window.localStorage.setItem(STORAGE_KEY, memorySnapshot);
  } catch {
    // Keep the update in memory for this browser session when storage is blocked.
  }
  notifySubscribers();
}

export function useToolPreferences() {
  const raw = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const preferences = decodePreferences(raw);
  const ready = raw !== null;

  const toggleFavorite = useCallback((slug: string) => {
    updatePreferences((current) => ({
      ...current,
      favorites: current.favorites.includes(slug)
        ? current.favorites.filter((favorite) => favorite !== slug)
        : [slug, ...current.favorites],
    }));
  }, []);

  const recordRecent = useCallback((slug: string) => {
    updatePreferences((current) => ({
      ...current,
      recent: [slug, ...current.recent.filter((recent) => recent !== slug)].slice(
        0,
        RECENT_LIMIT,
      ),
    }));
  }, []);

  const clearRecent = useCallback(() => {
    updatePreferences((current) => ({ ...current, recent: [] }));
  }, []);

  return { ...preferences, ready, toggleFavorite, recordRecent, clearRecent };
}
