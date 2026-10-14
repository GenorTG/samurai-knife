"use client";

import { useSyncExternalStore } from "react";

/** Tiny persisted UI prefs for the app shell (sidebar collapse). */
const KEY = "sk-sidebar";
const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "collapsed";
  } catch {
    return false;
  }
}

export function setSidebarCollapsed(collapsed: boolean) {
  try {
    localStorage.setItem(KEY, collapsed ? "collapsed" : "open");
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
  listeners.forEach((l) => l());
}

/** Server snapshot is always "open", so hydration markup matches. */
export function useSidebarCollapsed(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}

/** Shell-wide events: any component can ask the shell to open overlays. */
export const SHELL_EVENTS = {
  palette: "sk:palette",
  help: "sk:help",
  sidebar: "sk:sidebar",
} as const;

export function emitShell(name: (typeof SHELL_EVENTS)[keyof typeof SHELL_EVENTS]) {
  window.dispatchEvent(new CustomEvent(name));
}
