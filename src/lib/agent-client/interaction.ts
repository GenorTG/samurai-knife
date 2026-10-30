import { useSyncExternalStore } from "react";
import { controlElement } from "./dom-bridge";
import { runtime, runtimeFor, type PendingApproval, type PendingWait } from "./runtime-store";
import { msg } from "@/lib/i18n/msg";

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
  { id: "strict", label: msg("All"), hint: msg("Asks before every action, even typing into a field.") },
  { id: "standard", label: msg("Most"), hint: msg("Asks before running, opening a page or uploading; typing is free.") },
  { id: "destructive", label: msg("Risky"), hint: msg("Asks before deleting, overwriting or leaving unsaved input.") },
  { id: "free", label: msg("None"), hint: msg("Never asks: it acts on its own.") },
];

export interface WaitResult {
  resumedBy: "upload" | "input" | "continue" | "message" | "aborted" | "timeout";
  message?: string;
}

/** A chat running in the background reached a step that needs the live page: it waits for the user to open it. */
export interface PendingPage {
  tool: string;
  label: string;
}

export interface InteractionState {
  mode: TrustMode;
  approval: PendingApproval | null;
  wait: PendingWait | null;
  page: PendingPage | null;
}

const modeKey = (chatId: string) => chatId === "default" ? "sk.agent.mode.v1" : `sk.agent.mode.v1.${chatId}`;
const WAIT_TIMEOUT_MS = 30 * 60_000;
const INPUT_SETTLE_MS = 1500;
const FILE_SETTLE_MS = 350;
export const AWAIT_ATTR = "data-agent-await";

/** Risky: the assistant drives the app freely but must confirm anything that discards work. A stored choice wins. */
export const DEFAULT_TRUST_MODE: TrustMode = "destructive";

const SERVER: InteractionState = { mode: DEFAULT_TRUST_MODE, approval: null, wait: null, page: null };
const modes = new Map<string, TrustMode>();
const hydratedModes = new Set<string>();
const modeListeners = new Set<() => void>();
const snapshots = new Map<string, InteractionState>();
const pendingApprovals = new Map<string, PendingApproval>();
const pendingWaits = new Map<string, PendingWait>();
const pendingPages = new Map<string, PendingPage>();

function ensureMode(chatId: string): void {
  if (hydratedModes.has(chatId) || typeof window === "undefined") return;
  hydratedModes.add(chatId);
  try {
    const stored = window.localStorage.getItem(modeKey(chatId));
    // "ask" was the first two-mode version of Standard.
    const found = stored === "ask" ? "standard" : TRUST_MODES.find((m) => m.id === stored)?.id;
    if (found) modes.set(chatId, found);
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
export function getInteraction(chatId = "default"): InteractionState {
  ensureMode(chatId);
  const approval = pendingApprovals.get(chatId) ?? null;
  const wait = pendingWaits.get(chatId) ?? null;
  const page = pendingPages.get(chatId) ?? null;
  const mode = modes.get(chatId) ?? DEFAULT_TRUST_MODE;
  const previous = snapshots.get(chatId);
  if (previous && previous.mode === mode && previous.approval === approval && previous.wait === wait && previous.page === page) return previous;
  const next = { mode, approval, wait, page };
  snapshots.set(chatId, next);
  return next;
}
const getServerInteraction = (): InteractionState => SERVER;

export function useInteraction(chatId = "default"): InteractionState {
  return useSyncExternalStore(subscribeInteraction, () => getInteraction(chatId), getServerInteraction);
}

export function getTrustMode(chatId = "default"): TrustMode {
  return getInteraction(chatId).mode;
}

export function setTrustMode(next: TrustMode, chatId = "default"): void {
  ensureMode(chatId);
  try {
    window.localStorage.setItem(modeKey(chatId), next);
  } catch {
    /* ignore */
  }
  modes.set(chatId, next);
  for (const l of modeListeners) l();
}

/* -------------------------------------------------------------- approvals */

const approvalResolves = new Map<string, (d: ApprovalDecision) => void>();
/** "Allow for the rest of this run" was chosen: skips non-destructive prompts until the run ends. */
const runAllowed = new Set<string>();

export function resetRunTrust(chatId = "default"): void {
  runAllowed.delete(chatId);
}
export function isRunAllowed(chatId = "default"): boolean {
  return runAllowed.has(chatId);
}

export function requestApproval(req: PendingApproval, signal?: AbortSignal, chatId = "default"): Promise<ApprovalDecision> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve("deny");
    // Fail closed: if the run cannot park here (not a running tool step), the action is not allowed.
    pendingApprovals.set(chatId, req);
    if (!runtimeFor(chatId).enterAwaiting("awaiting_approval", req)) {
      pendingApprovals.delete(chatId);
      return resolve("deny");
    }
    const finish = (d: ApprovalDecision) => {
      approvalResolves.delete(chatId);
      pendingApprovals.delete(chatId);
      signal?.removeEventListener("abort", onAbort);
      runtimeFor(chatId).leaveAwaiting("awaiting_approval");
      resolve(d);
    };
    const onAbort = () => finish("deny");
    signal?.addEventListener("abort", onAbort, { once: true });
    approvalResolves.set(chatId, finish);
  });
}

export function answerApproval(decision: ApprovalDecision, chatId = "default"): void {
  if (decision === "allow_run") runAllowed.add(chatId);
  approvalResolves.get(chatId)?.(decision);
}

/* ------------------------------------------------------------------ waits */

const waitResolves = new Map<string, (r: WaitResult) => void>();

export function requestWait(
  req: { message: string; targetId: string | null },
  signal?: AbortSignal,
  chatId = "default",
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
      waitResolves.delete(chatId);
      pendingWaits.delete(chatId);
      runtimeFor(chatId).leaveAwaiting("awaiting_user");
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

    waitResolves.set(chatId, finish);
    const pending: PendingWait = {
      message: req.message,
      targetId: req.targetId,
      targetLabel: el ? (el.getAttribute("aria-label") ?? el.getAttribute("name")) : null,
    };
    pendingWaits.set(chatId, pending);
    if (!runtimeFor(chatId).enterAwaiting("awaiting_user", pending)) finish({ resumedBy: "aborted" });
  });
}

/** Continue pressed, or the user typed a reply while the run was waiting. */
export function answerWait(r: "continue" | "message", message?: string, chatId = "default"): void {
  waitResolves.get(chatId)?.({ resumedBy: r, message });
}

export function isWaiting(chatId = "default"): boolean {
  return waitResolves.has(chatId);
}

/* ------------------------------------------------- a background chat needs the page */

export type ForegroundDecision = "open" | "skip" | "aborted";
const pageResolves = new Map<string, (d: ForegroundDecision) => void>();

/**
 * A chat running in the background wants a page tool: it parks (awaiting_user) with a card in its own chat ("This step
 * needs … Open it now?"); the widget shows a badge on that chat. "open" once the user opened the chat and accepted,
 * "skip" when they declined, "aborted" on Stop.
 */
export function requestForeground(req: PendingPage, signal?: AbortSignal, chatId = "default"): Promise<ForegroundDecision> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve("aborted");
    const rt = runtimeFor(chatId);
    const finish = (d: ForegroundDecision) => {
      pageResolves.delete(chatId);
      pendingPages.delete(chatId);
      signal?.removeEventListener("abort", onAbort);
      rt.leaveAwaiting("awaiting_user");
      resolve(d);
    };
    const onAbort = () => finish("aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
    pendingPages.set(chatId, req);
    pageResolves.set(chatId, finish);
    if (!rt.enterAwaiting("awaiting_user", { message: req.label, targetId: null, targetLabel: null })) finish("aborted");
  });
}

export function answerForeground(decision: "open" | "skip", chatId = "default"): void {
  pageResolves.get(chatId)?.(decision);
}

/** Chats (of `chatIds`) that wait for the user: an approval, a wait_for_user or a page step. */
export function chatsNeedingUser(chatIds: readonly string[]): string[] {
  return chatIds.filter((id) => pendingApprovals.has(id) || pendingWaits.has(id) || pendingPages.has(id));
}
