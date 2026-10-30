/**
 * Live feedback for the AI agent. The run itself (phase, draft, steps) lives in the runtime store
 * (runtime-store.ts); this module keeps the page-level cues (toast, progress bar, "AI is here" badge,
 * output flashing) and exposes both as one `FeedbackState` through the same functions the shell and
 * widget have always used. <FeedbackLayer> and the widget read it (useSyncExternalStore) and CSS reacts
 * to the data attributes it sets:
 *   html[data-agent-active]      while a run is in progress (value = phase)
 *   [data-agent-highlight]       the control the agent just touched (fill|click|read|upload)
 *   [data-agent-flash]           an output region whose content just changed
 * Nothing here touches the page layout or the tool components.
 */

import { foregroundChat, runtime, runtimeFor, type LiveStep, type RunState, type RuntimeState, type RuntimeStore, type StepStatus } from "./runtime-store";

export type { LiveStep, StepStatus };
export type AgentPhase = "idle" | "thinking" | "writing" | "tool" | "stopping";
export type HighlightKind = "fill" | "click" | "read" | "upload";

export interface FeedbackState {
  active: boolean;
  phase: AgentPhase;
  /** Assistant text streamed so far in the current model round. */
  draft: string;
  /** Characters of model reasoning seen this round (content itself is not shown). */
  reasoningChars: number;
  steps: LiveStep[];
  toast: { id: number; text: string } | null;
  /** Page-switch progress bar visible. */
  navigating: boolean;
  /** Position of the "AI is here" badge (viewport px). */
  here: { id: number; x: number; y: number; label: string } | null;
}

interface Cues {
  toast: FeedbackState["toast"];
  navigating: boolean;
  here: FeedbackState["here"];
}

const NO_CUES: Cues = { toast: null, navigating: false, here: null };
const IDLE: FeedbackState = { active: false, phase: "idle", draft: "", reasoningChars: 0, steps: [], ...NO_CUES };

let cues: Cues = NO_CUES;
const cueListeners = new Set<() => void>();
let counter = 0;

function setCues(patch: Partial<Cues>): void {
  cues = { ...cues, ...patch };
  for (const l of cueListeners) l();
}

export function subscribeFeedback(listener: () => void): () => void {
  cueListeners.add(listener);
  const off = runtime.subscribe(listener);
  return () => {
    cueListeners.delete(listener);
    off();
  };
}

/** What the old three-phase indicator showed for each run state. */
function phaseOf(run: RunState, writing: boolean): AgentPhase {
  switch (run) {
    case "idle":
      return "idle";
    case "thinking":
      return writing ? "writing" : "thinking";
    case "tool":
    case "awaiting_approval":
    case "awaiting_user":
      return "tool";
    case "stopping":
      return "stopping";
    default:
      return "thinking"; // preparing, summarising
  }
}

let cache: { run: RunState; writing: boolean; draft: string; reasoningChars: number; steps: LiveStep[]; cues: Cues; value: FeedbackState } | null = null;

/** Memoised: the same object until a field a feedback consumer reads changes (queue / lock edits do not re-render them). */
export function getFeedback(): FeedbackState {
  const rt: RuntimeState = runtime.get();
  const c = cache;
  if (c && c.run === rt.run && c.writing === rt.writing && c.draft === rt.draft && c.reasoningChars === rt.reasoningChars && c.steps === rt.steps && c.cues === cues) {
    return c.value;
  }
  const value: FeedbackState = {
    active: rt.run !== "idle",
    phase: phaseOf(rt.run, rt.writing),
    draft: rt.draft,
    reasoningChars: rt.reasoningChars,
    steps: rt.steps,
    ...cues,
  };
  cache = { run: rt.run, writing: rt.writing, draft: rt.draft, reasoningChars: rt.reasoningChars, steps: rt.steps, cues, value };
  return value;
}
export const getServerFeedback = (): FeedbackState => IDLE;

/* ---------------------------------------------------------------- run state */

function root(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.documentElement;
}

function mirrorPhase(): void {
  const el = root();
  if (!el) return;
  const { active, phase } = getFeedback();
  if (active) el.setAttribute("data-agent-active", phase);
  else el.removeAttribute("data-agent-active");
  if (document.body) {
    if (active) document.body.setAttribute("data-agent-active", phase);
    else document.body.removeAttribute("data-agent-active");
  }
}

/**
 * Every run-state function takes the chat it reports for (several chats can run at once in one tab); without one it
 * means the foreground chat. Page cues (data-agent-active, toasts, output highlights) follow the foreground chat only.
 */
const storeOf = (chatId?: string): RuntimeStore => (chatId === undefined ? runtime : runtimeFor(chatId));
const isForeground = (chatId?: string): boolean => chatId === undefined || chatId === foregroundChat();

export function runStarted(chatId?: string): void {
  storeOf(chatId).begin();
  if (isForeground(chatId)) {
    setCues(NO_CUES);
    baselineOutputs();
  }
  mirrorPhase();
}

export function runEnded(chatId?: string): void {
  if (isForeground(chatId)) clearHighlight();
  storeOf(chatId).end();
  if (isForeground(chatId)) setCues({ navigating: false, here: null });
  mirrorPhase();
}

/** Late phase reports (after Stop, after the run ended) are dropped by the store. */
export function setPhase(phase: AgentPhase, chatId?: string): void {
  const rt = storeOf(chatId);
  if (phase === "idle") rt.end();
  else if (phase === "stopping") rt.stop();
  else if (phase === "tool") rt.advance("tool");
  else if (phase === "writing") rt.advance("thinking");
  else rt.advance("thinking");
  mirrorPhase();
}

/** A new model round begins: drop the previous round's draft, keep the step list. */
export function roundStarted(chatId?: string): void {
  const rt = storeOf(chatId);
  if (rt.advance("thinking")) rt.newRound();
  mirrorPhase();
}

export function appendDraft(delta: string, chatId?: string): void {
  storeOf(chatId).appendDraft(delta);
  mirrorPhase();
}

export function addReasoning(delta: string, chatId?: string): void {
  storeOf(chatId).addReasoning(delta);
}

/** The model named a tool: show the step immediately, before its arguments finish. */
export function stepStarted(id: string, name: string, label: string, chatId?: string): void {
  const rt = storeOf(chatId);
  rt.stepStarted(id, name, label);
  rt.advance("tool");
  mirrorPhase();
}

export function stepFinished(id: string, ok: boolean, chatId?: string): void {
  storeOf(chatId).stepFinished(id, ok);
}

export function clearSteps(chatId?: string): void {
  storeOf(chatId).clearSteps();
}

export function stopRequested(chatId?: string): void {
  storeOf(chatId).stop();
  mirrorPhase();
}

/* ------------------------------------------------------------------- toasts */

let toastTimer: ReturnType<typeof setTimeout> | undefined;
let navTimer: ReturnType<typeof setTimeout> | undefined;

export function showToast(text: string, ttlMs = 2600): void {
  counter += 1;
  setCues({ toast: { id: counter, text } });
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setCues({ toast: null }), ttlMs);
}

/** Page switch cue: top progress bar plus a toast. */
export function navigationStarted(label: string): void {
  showToast(`AI is opening ${label}…`, 5000);
  setCues({ navigating: true });
  if (navTimer) clearTimeout(navTimer);
  navTimer = setTimeout(() => setCues({ navigating: false }), 8000);
}

export function navigationFinished(label: string | null): void {
  if (navTimer) clearTimeout(navTimer);
  setCues({ navigating: false });
  if (label) showToast(`AI opened ${label}`);
  baselineOutputs();
}

/* --------------------------------------------------------------- highlights */

const HIGHLIGHT_MS = 1600;
let highlighted: Element | null = null;
let highlightTimer: ReturnType<typeof setTimeout> | undefined;
let hereTimer: ReturnType<typeof setTimeout> | undefined;

function clearHighlight(): void {
  if (highlightTimer) clearTimeout(highlightTimer);
  highlighted?.removeAttribute("data-agent-highlight");
  highlighted = null;
}

function inViewport(rect: DOMRect): boolean {
  return rect.top >= 0 && rect.bottom <= window.innerHeight && rect.left >= 0 && rect.right <= window.innerWidth;
}

function describeKind(kind: HighlightKind): string {
  return kind === "fill" ? "Filling" : kind === "click" ? "Clicking" : kind === "upload" ? "Attaching" : "Reading";
}

/** Scroll the control into view, ring it, and park the "AI is here" badge on it. */
export function highlight(el: Element, kind: HighlightKind): void {
  scanOutputs(); // flash what the previous action changed before this one starts
  try {
    if (!inViewport(el.getBoundingClientRect())) el.scrollIntoView({ block: "center", inline: "nearest" });
  } catch {
    /* cosmetic */
  }
  clearHighlight();
  highlighted = el;
  el.setAttribute("data-agent-highlight", kind);
  highlightTimer = setTimeout(clearHighlight, HIGHLIGHT_MS);

  const rect = el.getBoundingClientRect();
  counter += 1;
  setCues({
    here: {
      id: counter,
      x: Math.max(8, Math.min(window.innerWidth - 28, rect.right - 6)),
      y: Math.max(8, Math.min(window.innerHeight - 28, rect.top - 10)),
      label: describeKind(kind),
    },
  });
  if (hereTimer) clearTimeout(hereTimer);
  hereTimer = setTimeout(() => setCues({ here: null }), 3000);
}

/* ---------------------------------------------------------- output flashing */

const OUTPUT_SELECTOR = [
  "pre",
  "output",
  "[role=status]",
  "[role=alert]",
  "[aria-live]",
  "[data-agent-region]",
  "table",
  "textarea[readonly]",
  "input[readonly]",
  "canvas",
].join(",");

const signatures = new WeakMap<Element, string>();
let baselined = false;
let scanTimers: ReturnType<typeof setTimeout>[] = [];
let settleUntil = 0;
let observer: MutationObserver | null = null;
const FLASH_MS = 1200;

function signatureOf(el: Element): string {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return `v:${el.value.length}:${el.value.slice(0, 400)}`;
  if (el instanceof HTMLCanvasElement) return `c:${el.width}x${el.height}`;
  const text = el.textContent ?? "";
  return `t:${text.length}:${text.slice(0, 400)}`;
}

function outputElements(): Element[] {
  const scope = document.querySelector("main") ?? document.body;
  return Array.from(scope.querySelectorAll(OUTPUT_SELECTOR)).filter(
    (el) => !el.closest("[data-agent-widget]") && !el.closest("[data-agent-feedback]"),
  );
}

export function baselineOutputs(): void {
  if (typeof document === "undefined") return;
  for (const el of outputElements()) signatures.set(el, signatureOf(el));
  baselined = true;
}

function flashEl(el: Element): void {
  el.setAttribute("data-agent-flash", "1");
  setTimeout(() => el.removeAttribute("data-agent-flash"), FLASH_MS);
}

/** Flash every output region whose content differs from the last baseline. */
export function scanOutputs(): void {
  if (!baselined || (runtime.get().run === "idle" && Date.now() > settleUntil)) return;
  for (const el of outputElements()) {
    if (el === highlighted) continue;
    const sig = signatureOf(el);
    const prev = signatures.get(el);
    signatures.set(el, sig);
    if (prev !== sig) flashEl(el);
  }
}

/** Call right after the agent changes the page: scans now and as results settle. */
export function settleOutputs(): void {
  settleUntil = Date.now() + 2000;
  for (const t of scanTimers) clearTimeout(t);
  scanTimers = [0, 80, 200, 450, 900, 1800].map((ms) => setTimeout(scanOutputs, ms));
}

/** Start/stop watching for async output changes (workers, lazy panels) during a run. */
export function watchOutputs(on: boolean): void {
  if (typeof document === "undefined") return;
  if (!on) {
    observer?.disconnect();
    observer = null;
    return;
  }
  if (observer) return;
  let pending: ReturnType<typeof setTimeout> | undefined;
  observer = new MutationObserver(() => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = undefined;
      scanOutputs();
    }, 120);
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
  });
}
