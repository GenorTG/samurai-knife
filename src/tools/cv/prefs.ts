"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { CvLang } from "@/lib/cv/schema";

/**
 * Per-tab remembered choices (document language, theme, filters) in localStorage, same external-store pattern as
 * `tool-preferences.ts`: the server snapshot is the fallback, so SSR and hydration agree and the stored value lands after.
 */

const STORAGE_KEY = "samurai-knife:cv-studio:v1";
const subscribers = new Set<() => void>();
let installed = false;

function readAll(): Record<string, string> {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    return typeof raw === "object" && raw !== null ? (raw as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function subscribe(listener: () => void): () => void {
  subscribers.add(listener);
  if (!installed) {
    window.addEventListener("storage", notify);
    installed = true;
  }
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0 && installed) {
      window.removeEventListener("storage", notify);
      installed = false;
    }
  };
}

function notify(): void {
  subscribers.forEach((listener) => listener());
}

/** A remembered string choice limited to `allowed`. */
export function usePref<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, (value: T) => void] {
  const stored = useSyncExternalStore(
    subscribe,
    () => readAll()[key] ?? "",
    () => "",
  );
  const value = (allowed as readonly string[]).includes(stored) ? (stored as T) : fallback;
  const set = useCallback(
    (next: T) => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readAll(), [key]: next }));
      } catch {
        // Storage blocked: the choice lasts only until reload.
      }
      notify();
    },
    [key],
  );
  return [value, set];
}

/** Document language (PL | EN) for one tab. */
export function useCvLang(tab: string): [CvLang, (lang: CvLang) => void] {
  return usePref<CvLang>(`lang:${tab}`, "pl", ["pl", "en"]);
}
