import { useSyncExternalStore } from "react";
import { controlElement } from "./dom-bridge";
import { runtime, type PendingApproval, type PendingWait } from "./runtime-store";

export type { PendingApproval, PendingWait };

/**
 * Human-in-the-loop layer for the agent run.
 *  - Trust mode (see TRUST_MODES): how much the assistant asks before acting. One prompt
 *    covers one action; "allow for this run" only waives non-destructive prompts, so a
 *    destructive action is always confirmed on its own.
 *  - Waiting: the assistant can park the run until the user supplies something it
 *    cannot invent (their real file, a secret-free input, a decision). The run
 *    resumes when the watched control changes, the user presses Continue, or the
 *    user replies in the composer.
 * The trust mode is module state persisted in localStorage; a pending approval / wait is run state, so it
 * lives in the runtime store (awaiting_approval / awaiting_user) and this module is its promise-based
 * front: the loop awaits it, the widget renders it, the store keeps the state machine honest.
 */

/**
 * strict      ask before every action, including filling fields
 * standard    ask before anything that runs, navigates or uploads; filling fields is free
 * destructive ask only when work could be lost (delete/clear/reset/reload, leaving a page with input)
 * free        never ask
 */
export type TrustMode = "strict" | "standard" | "destructive" | "free";
export type ApprovalDecision = "allow" | "allow_run" | "deny";

export const TRUST_MODES: { id: TrustMode; label: string; hint: string }[] = [
  { id: "strict", label: "All", hint: "Ask before every action, even filling a field." },
  { id: "standard", label: "Most", hint: "Ask before anything that runs, opens a page or uploads; filling fields is free." },
  { id: "destructive", label: "Risky", hint: "Ask only before deleting, clearing, resetting, overwriting or leaving a page with your input." },
  { id: "free", label: "None", hint: "Never ask; the assistant acts on its own." },
];

export interface WaitResult {
  resumedBy: "upload" | "input" | "continue" | "message" | "aborted" | "timeout";
  message?: string;
}

export interface InteractionState {
  mode: TrustMode;
  approval: PendingApproval | null;
  wait: PendingWait | null;
}

const MODE_KEY = "sk.agent.mode.v1";
const WAIT_TIMEOUT_MS = 30 * 60_000;
const INPUT_SETTLE_MS = 1500;
const FILE_SETTLE_MS = 350;
export const AWAIT_ATTR = "data-agent-await";

/** Risky: the assistant drives the app freely but must confirm anything that discards work. A stored choice wins. */
export const DEFAULT_TRUST_MODE: TrustMode = "destructive";

const SERVER: InteractionState = { mode: DEFAULT_TRUST_MODE, approval: null, wait: null };
let mode: TrustMode = DEFAULT_TRUST_MODE;
let hydratedMode = false;
const modeListeners = new Set<() => void>();
let snapshot: InteractionState = SERVER;

function ensureMode(): void {
  if (hydratedMode || typeof window === "undefined") return;
  hydratedMode = true;
  try {
    const stored = window.localStorage.getItem(MODE_KEY);
    // "ask" was the first two-mode version of Standard.
    const found = stored === "ask" ? "standard" : TRUST_MODES.find((m) => m.id === stored)?.id;
    if (found) mode = found;
  } catch {
    /* storage blocked: stays on the default for this page */
  }
}

export function subscribeInteraction(l: () => void): () => void {
  modeListeners.add(l);
  const off = runtime.subscribe(l);
  return () => {
    modeListeners.delete(l);
    off();
  };
}

/** Memoised: the same object until the mode, the pending approval or the pending wait changes. */
export function getInteraction(): InteractionState {
  ensureMode();
  const { approval, wait } = runtime.get();
  if (snapshot.mode !== mode || snapshot.approval !== approval || snapshot.wait !== wait) snapshot = { mode, approval, wait };
  return snapshot;
}
const getServerInteraction = (): InteractionState => SERVER;

export function useInteraction(): InteractionState {
  return useSyncExternalStore(subscribeInteraction, getInteraction, getServerInteraction);
}

export function getTrustMode(): TrustMode {
  return getInteraction().mode;
}

export function setTrustMode(next: TrustMode): void {
  ensureMode();
  try {
    window.localStorage.setItem(MODE_KEY, next);
  } catch {
    /* ignore */
  }
  mode = next;
  for (const l of modeListeners) l();
}

/* -------------------------------------------------------------- approvals */

let approvalResolve: ((d: ApprovalDecision) => void) | null = null;
/** "Allow for the rest of this run" was chosen: skips non-destructive prompts until the run ends. */
let runAllowed = false;

export function resetRunTrust(): void {
  runAllowed = false;
}
export function isRunAllowed(): boolean {
  return runAllowed;
}

export function requestApproval(req: PendingApproval, signal?: AbortSignal): Promise<ApprovalDecision> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve("deny");
    // Fail closed: if the run cannot park here (not a running tool step), the action is not allowed.
    if (!runtime.enterAwaiting("awaiting_approval", req)) return resolve("deny");
    const finish = (d: ApprovalDecision) => {
      approvalResolve = null;
      signal?.removeEventListener("abort", onAbort);
      runtime.leaveAwaiting("awaiting_approval");
      resolve(d);
    };
    const onAbort = () => finish("deny");
    signal?.addEventListener("abort", onAbort, { once: true });
    approvalResolve = finish;
  });
}

export function answerApproval(decision: ApprovalDecision): void {
  if (decision === "allow_run") runAllowed = true;
  approvalResolve?.(decision);
}

/* ------------------------------------------------------------------ waits */

let waitResolve: ((r: WaitResult) => void) | null = null;

export function requestWait(
  req: { message: string; targetId: string | null },
  signal?: AbortSignal,
): Promise<WaitResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ resumedBy: "aborted" });
    const el = req.targetId ? controlElement(req.targetId) : null;
    const cleanups: (() => void)[] = [];
    let settle: ReturnType<typeof setTimeout> | undefined;

    const finish = (r: WaitResult) => {
      if (settle) clearTimeout(settle);
      clearTimeout(timeout);
      cleanups.forEach((c) => c());
      el?.removeAttribute(AWAIT_ATTR);
      signal?.removeEventListener("abort", onAbort);
      waitResolve = null;
      runtime.leaveAwaiting("awaiting_user");
      resolve(r);
    };
    const onAbort = () => finish({ resumedBy: "aborted" });
    const timeout = setTimeout(() => finish({ resumedBy: "timeout" }), WAIT_TIMEOUT_MS);
    signal?.addEventListener("abort", onAbort, { once: true });

    if (el) {
      el.setAttribute(AWAIT_ATTR, "");
      try {
        el.scrollIntoView({ block: "center", inline: "nearest" });
      } catch {
        /* cosmetic */
      }
      const isFile = el instanceof HTMLInputElement && el.type === "file";
      const onChange = () => {
        if (isFile && !(el as HTMLInputElement).files?.length) return;
        if (settle) clearTimeout(settle);
        // Files are done the moment they are chosen; typing settles after a pause.
        settle = setTimeout(() => finish({ resumedBy: isFile ? "upload" : "input" }), isFile ? FILE_SETTLE_MS : INPUT_SETTLE_MS);
      };
      const events = isFile ? ["change"] : ["input", "change"];
      for (const ev of events) {
        el.addEventListener(ev, onChange);
        cleanups.push(() => el.removeEventListener(ev, onChange));
      }
    }

    waitResolve = finish;
    const pending: PendingWait = {
      message: req.message,
      targetId: req.targetId,
      targetLabel: el ? (el.getAttribute("aria-label") ?? el.getAttribute("name")) : null,
    };
    if (!runtime.enterAwaiting("awaiting_user", pending)) finish({ resumedBy: "aborted" });
  });
}

/** Continue pressed, or the user typed a reply while the run was waiting. */
export function answerWait(r: "continue" | "message", message?: string): void {
  waitResolve?.({ resumedBy: r, message });
}

export function isWaiting(): boolean {
  return waitResolve !== null;
}
