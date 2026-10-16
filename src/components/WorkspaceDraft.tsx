"use client";

import { useEffect, useRef, useState, type ComponentType } from "react";
import type { WorkspaceState } from "@/lib/workspace-state/store";

type ControlValue = string | boolean;
type DraftProps = { tool: string; Component: ComponentType };

function controlKey(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, index: number): string {
  const identity = element.id || element.name || element.getAttribute("aria-label") || element.getAttribute("placeholder") || "";
  return `${element.tagName.toLowerCase()}:${element instanceof HTMLInputElement ? element.type : ""}:${identity}:${index}`;
}

function controls(root: HTMLElement): Array<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement> {
  return Array.from(root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select"))
    .filter((element) => {
      if (element instanceof HTMLInputElement && ["button", "submit", "reset", "file", "password", "hidden"].includes(element.type)) return false;
      // Read-only and disabled controls show results, not the user's input.
      if (element.disabled || ("readOnly" in element && element.readOnly)) return false;
      const identity = `${element.name} ${element.id} ${element.getAttribute("aria-label") ?? ""} ${element.getAttribute("placeholder") ?? ""} ${element.getAttribute("autocomplete") ?? ""} ${Array.from(element.labels ?? []).map((label) => label.textContent).join(" ")}`;
      return !/(password|secret|token|api.?key|authorization|cookie)/i.test(identity);
    });
}

function read(root: HTMLElement, tool: string, current: WorkspaceState): WorkspaceState {
  const fields: Record<string, ControlValue> = {};
  controls(root).forEach((element, index) => {
    const key = controlKey(element, index);
    fields[key] = element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")
      ? element.checked
      : element.value;
  });
  return { ...current, [tool]: fields };
}

function restore(root: HTMLElement, tool: string, state: WorkspaceState): void {
  const fields = state[tool];
  if (!fields) return;
  controls(root).forEach((element, index) => {
    const value = fields[controlKey(element, index)];
    if (value === undefined) return;
    if (element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")) {
      if (typeof value === "boolean") {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set;
        setter?.call(element, value);
      }
    } else if (typeof value === "string") {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
      setter?.call(element, value);
    }
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

export function WorkspaceDraft({ tool, Component }: DraftProps) {
  const ref = useRef<HTMLDivElement>(null);
  const stateRef = useRef<WorkspaceState>({});
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");

  useEffect(() => {
    let active = true;
    fetch(`/api/workspace?tool=${encodeURIComponent(tool)}`, { cache: "no-store" })
      .then(async (response) => {
        // Always read the body (an unread one keeps the request in flight and the page never goes network-idle).
        const body: unknown = await response.json().catch(() => null);
        if (response.status === 401) return null;
        if (!response.ok) throw new Error("workspace load failed");
        return body as WorkspaceState;
      })
      .then((state) => {
        if (!active) return;
        // Signed out: the tool works as before, nothing is restored or saved.
        if (state === null) setEnabled(false);
        else stateRef.current = state;
        setLoaded(true);
      })
      .catch(() => {
        if (active) {
          setSaveState("error");
          setLoaded(true);
        }
      });
    return () => { active = false; };
  }, [tool]);

  useEffect(() => {
    const root = ref.current;
    if (!root || !loaded || !enabled) return;
    let attached = false;
    const flushDraft = (keepalive = false, updateStatus = true) => {
      const body = JSON.stringify({ tool, fields: stateRef.current[tool] ?? {} });
      void fetch("/api/workspace", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: keepalive && new Blob([body]).size <= 60_000,
      }).then((response) => {
        void response.body?.cancel();
        if (updateStatus) setSaveState(response.ok ? "saved" : "error");
      }).catch(() => {
        if (updateStatus) setSaveState("error");
      });
    };
    const saveCurrentDraft = () => {
      stateRef.current = read(root, tool, stateRef.current);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setSaveState("saving");
        timer.current = undefined;
        flushDraft();
      }, 700);
    };
    // React's delegated onChange handler must observe the edit before our save-status update rerenders this wrapper.
    const schedule = () => queueMicrotask(saveCurrentDraft);
    const attachWhenReady = () => {
      if (attached || controls(root).length === 0) return;
      restore(root, tool, stateRef.current);
      root.addEventListener("input", schedule);
      root.addEventListener("change", schedule);
      attached = true;
      observer.disconnect();
    };
    const observer = new MutationObserver(attachWhenReady);
    const onPageHide = () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = undefined;
        stateRef.current = read(root, tool, stateRef.current);
        flushDraft(true, false);
      }
    };
    observer.observe(root, { childList: true, subtree: true });
    window.addEventListener("pagehide", onPageHide);
    attachWhenReady();
    return () => {
      observer.disconnect();
      window.removeEventListener("pagehide", onPageHide);
      if (attached) {
        root.removeEventListener("input", schedule);
        root.removeEventListener("change", schedule);
      }
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = undefined;
        flushDraft(false, false);
      }
    };
  }, [loaded, enabled, tool]);

  // Same text as the lazy-chunk placeholder: UI automation waits for "Loading tool" to disappear (waitForToolPanel).
  if (!loaded) return <p role="status" className="py-10 text-center text-sm text-muted">Loading tool…</p>;
  if (!enabled) return <Component />;
  return (
    <div ref={ref} data-workspace-tool={tool}>
      {/* Not role=status: automation reads the first `main [role=status]` as the tool's own progress line. */}
      <p aria-live="polite" className="mb-2 text-right text-xs text-muted">
        {saveState === "saving" ? "Saving…" : saveState === "error" ? "Could not save this draft" : "Draft saved to your account"}
      </p>
      <Component />
    </div>
  );
}
