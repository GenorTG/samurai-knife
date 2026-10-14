"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { errorText, getPhotoMeta, photoUrl, removePhoto, uploadPhoto, type CvPhotoMeta } from "@/lib/cv/client";

/**
 * The account's CV photo, shared by every CV tab on the page (Profile uploads it, Versions previews it). One fetch per
 * page load; an upload or removal updates every subscriber at once.
 */

type PhotoState = { phase: "loading" | "ready" | "error"; meta: CvPhotoMeta | null; error: string };

let state: PhotoState = { phase: "loading", meta: null, error: "" };
let started = false;
const listeners = new Set<() => void>();
const SERVER_STATE: PhotoState = { phase: "loading", meta: null, error: "" };

function set(next: PhotoState): void {
  state = next;
  listeners.forEach((l) => l());
}

function load(): void {
  getPhotoMeta().then(
    (r) => set({ phase: "ready", meta: r.photo, error: "" }),
    (e: unknown) => set({ phase: "error", meta: null, error: errorText(e) }),
  );
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export interface CvPhoto {
  phase: PhotoState["phase"];
  error: string;
  meta: CvPhotoMeta | null;
  /** Image URL, or null when there is no photo. */
  url: string | null;
  upload: (dataUrl: string) => Promise<void>;
  remove: () => Promise<void>;
}

export function useCvPhoto(): CvPhoto {
  const current = useSyncExternalStore(subscribe, () => state, () => SERVER_STATE);
  useEffect(() => {
    if (started) return;
    started = true;
    load();
  }, []);
  const upload = useCallback(async (dataUrl: string) => {
    const r = await uploadPhoto(dataUrl);
    set({ phase: "ready", meta: r.photo, error: "" });
  }, []);
  const remove = useCallback(async () => {
    await removePhoto();
    set({ phase: "ready", meta: null, error: "" });
  }, []);
  return { phase: current.phase, error: current.error, meta: current.meta, url: current.meta ? photoUrl(current.meta) : null, upload, remove };
}
