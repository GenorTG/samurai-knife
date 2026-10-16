"use client";

import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
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

/** Saved fields that differ from what the tool shows now (the restore offer appears only when there is something to bring back). */
function differs(root: HTMLElement, tool: string, saved: Record<string, ControlValue> | undefined): boolean {
  if (!saved) return false;
  const now = read(root, tool, {})[tool];
  return Object.entries(saved).some(([key, value]) => key in now && now[key] !== value);
}

function restore(root: HTMLElement, fields: Record<string, ControlValue>): void {
  controls(root).forEach((element, index) => {
    const value = fields[controlKey(element, index)];
    if (value === undefined) return;
    if (element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")) {
      // React's onChange for checkboxes and radios listens to click: a synthetic change event never reaches the tool.
      if (typeof value === "boolean" && element.checked !== value && (element.type === "checkbox" || value)) element.click();
      return;
    }
    if (typeof value !== "string" || element.value === value) return;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/**
 * Saves a browser tool's form state to the account (`/api/workspace`, sealed at rest), so work survives a reload and
 * follows the account to another machine. A visit always starts from the tool's own defaults: when a saved draft
 * differs from them, a "Restore saved draft" / "Discard" offer appears; the first edit instead of restoring makes the new
 * work the draft. Signed out: nothing is offered or saved.
 */
export function WorkspaceDraft({ tool, Component }: DraftProps) {
  const ref = useRef<HTMLDivElement>(null);
  const savedRef = useRef<Record<string, ControlValue> | undefined>(undefined);
  const restoringRef = useRef(false);
  const [phase, setPhase] = useState<"loading" | "ready" | "off">("loading");
  const [offer, setOffer] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  // The same element on every render: the wrapper's own state (draft loaded, save status, offer) never re-renders the
  // tool, so a controlled field is never reset under the user's (or the assistant's) typing.
  const toolElement = useMemo(() => <Component />, [Component]);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let active = true;
    let ready = false;
    let touched = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: Record<string, ControlValue> | null = null;

    const flushDraft = (keepalive = false) => {
      if (!pending) return;
      const body = JSON.stringify({ tool, fields: pending });
      pending = null;
      void fetch("/api/workspace", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: keepalive && new Blob([body]).size <= 60_000,
      }).then((response) => {
        void response.body?.cancel();
        if (active) setSaveState(response.ok ? "saved" : "error");
      }).catch(() => {
        if (active) setSaveState("error");
      });
    };
    const scheduleSave = () => {
      pending = read(root, tool, {})[tool];
      savedRef.current = pending;
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        setSaveState("saving");
        flushDraft();
      }, 700);
    };
    // React's delegated onChange handler must observe the edit before our state updates rerender this wrapper.
    const onEdit = (event: Event) => queueMicrotask(() => {
      if (restoringRef.current || !(event.target instanceof Element) || event.target.closest("[data-workspace-offer]")) return;
      touched = true;
      setOffer(false);
      if (ready) scheduleSave();
    });
    const decide = () => {
      if (!ready || controls(root).length === 0) return;
      observer.disconnect();
      if (touched) scheduleSave(); // edited before the draft arrived: the edit becomes the draft
      else setOffer(differs(root, tool, savedRef.current));
    };
    const observer = new MutationObserver(decide);
    const onPageHide = () => {
      if (!timer) return;
      clearTimeout(timer);
      timer = undefined;
      flushDraft(true);
    };

    root.addEventListener("input", onEdit);
    root.addEventListener("change", onEdit);
    window.addEventListener("pagehide", onPageHide);
    observer.observe(root, { childList: true, subtree: true });

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
        if (state === null) {
          observer.disconnect();
          setPhase("off");
          return;
        }
        savedRef.current = state[tool];
        ready = true;
        setPhase("ready");
        decide();
      })
      .catch(() => {
        if (!active) return;
        observer.disconnect();
        setSaveState("error");
        setPhase("off");
      });

    return () => {
      active = false;
      observer.disconnect();
      root.removeEventListener("input", onEdit);
      root.removeEventListener("change", onEdit);
      window.removeEventListener("pagehide", onPageHide);
      if (timer) {
        clearTimeout(timer);
        flushDraft();
      }
    };
  }, [tool]);

  const restoreDraft = () => {
    const root = ref.current;
    if (!root || !savedRef.current) return;
    restoringRef.current = true;
    restore(root, savedRef.current);
    // The synthetic events above are handled in microtasks: stop ignoring edits after them.
    queueMicrotask(() => queueMicrotask(() => { restoringRef.current = false; }));
    setOffer(false);
  };
  const discardDraft = () => {
    setOffer(false);
    savedRef.current = undefined;
    void fetch(`/api/workspace?tool=${encodeURIComponent(tool)}`, { method: "DELETE" })
      .then((response) => { void response.body?.cancel(); })
      .catch(() => setSaveState("error"));
  };

  const status = saveState === "error" ? "Could not save this draft"
    : saveState === "saving" ? "Saving…"
    : saveState === "saved" ? "Draft saved to your account"
    : phase === "ready" && !offer ? "Edits are saved to your account" : "";
  return (
    <div ref={ref} data-workspace-tool={tool}>
      {/* Not role=status: automation reads the first `main [role=status]` as the tool's own progress line. Always rendered at
          one fixed height so the tool never moves when the draft state or the offer arrives. */}
      <div className="mb-2 flex h-6 items-center justify-end gap-2 overflow-hidden whitespace-nowrap text-xs text-muted">
        {offer ? (
          <span data-workspace-offer className="flex items-center gap-2" role="group" aria-label="Saved draft">
            <span>Saved draft:</span>
            <button type="button" className="rounded border border-line px-2 leading-5 text-ink hover:bg-raised" onClick={restoreDraft}>Restore saved draft</button>
            <button type="button" className="rounded px-2 leading-5 hover:bg-raised" onClick={discardDraft}>Discard</button>
          </span>
        ) : null}
        <span aria-live="polite">{status}</span>
      </div>
      {toolElement}
    </div>
  );
}
