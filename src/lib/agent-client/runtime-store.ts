import { useSyncExternalStore } from "react";

/**
 * Single source of truth for the assistant's run lifecycle (one per browser tab).
 *
 *   idle -> preparing -> thinking <-> tool <-> awaiting_approval | awaiting_user
 *                            \-> summarising        any active state -> stopping -> idle
 *
 * The agent loop, interaction.ts (approvals / wait_for_user) and feedback.ts (live steps) write to it;
 * the pill, status line, feedback layer and widget read it. It also holds the message queue and the
 * cross-tab lock state, so the widget never infers "is a run going" from scattered flags.
 *
 * Pure state + transitions, no IO (persistence and locks live in message-queue.ts / run-lock.ts) so it
 * can be unit-tested under plain Node. SSR-safe: the server snapshot is a constant idle state and the
 * client store starts identical, so hydration never differs; queued messages are loaded after mount.
 */

export type RunState =
  | "idle"
  | "preparing"
  | "thinking"
  | "tool"
  | "awaiting_approval"
  | "awaiting_user"
  | "summarising"
  | "stopping";

/** Legal moves. A state may always "move" to itself (a new model round while thinking is a no-op). */
export const TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  idle: ["preparing"],
  preparing: ["thinking", "stopping", "idle"],
  thinking: ["tool", "summarising", "stopping", "idle"],
  tool: ["thinking", "awaiting_approval", "awaiting_user", "summarising", "stopping", "idle"],
  awaiting_approval: ["tool", "stopping", "idle"],
  awaiting_user: ["tool", "stopping", "idle"],
  summarising: ["stopping", "idle"],
  stopping: ["idle"],
};

export function canTransition(from: RunState, to: RunState): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export type StepStatus = "running" | "ok" | "error";

export interface LiveStep {
  id: string;
  name: string;
  label: string;
  status: StepStatus;
  startedAt: number;
}

export interface PendingApproval {
  title: string;
  detail: string;
  /** Throws work away: styled as a warning and never covered by "allow for this run". */
  destructive?: boolean;
}

export interface PendingWait {
  message: string;
  /** Control the user is expected to use; pulses until the wait ends. */
  targetId: string | null;
  /** Human label of that control, for the card. */
  targetLabel: string | null;
}

export interface QueuedMessage {
  id: string;
  text: string;
  at: number;
}

/** Why the queue stopped draining by itself. */
export type PauseReason = "stopped" | "failed";

/** free: nobody runs; mine: this tab holds the run lock; other: another tab of the same account runs. */
export type LockState = "free" | "mine" | "other";

export interface RuntimeState {
  run: RunState;
  /** Assistant text is streaming in the current model round (a sub-state of `thinking`). */
  writing: boolean;
  /** Short status line while working (null when idle). */
  activity: string | null;
  /** Assistant text streamed so far in the current model round. */
  draft: string;
  /** Characters of model reasoning seen this round (content itself is not shown). */
  reasoningChars: number;
  steps: LiveStep[];
  approval: PendingApproval | null;
  wait: PendingWait | null;
  /** Account whose queue / lock this tab is looking at. */
  accountId: string | null;
  queue: QueuedMessage[];
  paused: PauseReason | null;
  /** Queued messages the user chose to "send now": the loop delivers them at the next model-round boundary. */
  steering: QueuedMessage[];
  lock: LockState;
  /** What the other tab says it is doing (only while lock === "other"). */
  remoteActivity: string | null;
}

export const IDLE_RUNTIME: RuntimeState = {
  run: "idle",
  writing: false,
  activity: null,
  draft: "",
  reasoningChars: 0,
  steps: [],
  approval: null,
  wait: null,
  accountId: null,
  queue: [],
  paused: null,
  steering: [],
  lock: "free",
  remoteActivity: null,
};

export const isActive = (s: Pick<RuntimeState, "run">): boolean => s.run !== "idle";

const MAX_STEPS = 30;

export interface RuntimeStore {
  get: () => RuntimeState;
  subscribe: (listener: () => void) => () => void;

  /** idle -> preparing. Anything else means the previous run never ended: reported, then reset. */
  begin: () => void;
  /** Always legal: the run is over, whatever state it was in. */
  end: () => void;
  /** Progress report from the running loop. Late events after Stop / after the run ended are dropped silently; anything else illegal is reported and ignored. */
  advance: (to: RunState) => boolean;
  /** Any active state -> stopping. */
  stop: () => boolean;
  /** tool -> awaiting_*; false (nothing changed) when the run is not in a state that can park. */
  enterAwaiting: (kind: "awaiting_approval" | "awaiting_user", pending: PendingApproval | PendingWait) => boolean;
  /** Leave awaiting_*: back to `tool` unless Stop or the end already moved the run on. */
  leaveAwaiting: (kind: "awaiting_approval" | "awaiting_user") => void;

  setActivity: (text: string | null) => void;
  newRound: () => void;
  appendDraft: (delta: string) => void;
  addReasoning: (delta: string) => void;
  stepStarted: (id: string, name: string, label: string) => void;
  stepFinished: (id: string, ok: boolean) => void;
  clearSteps: () => void;

  setAccount: (accountId: string | null) => void;
  setQueue: (queue: QueuedMessage[], paused: PauseReason | null) => void;
  setSteering: (steering: QueuedMessage[]) => void;
  setLock: (lock: LockState, remoteActivity?: string | null) => void;
}

export interface RuntimeOptions {
  /** Called for an illegal transition. Default: console.error outside production. */
  onIllegal?: (from: RunState, to: RunState, why: string) => void;
}

function defaultIllegal(from: RunState, to: RunState, why: string): void {
  if (typeof process !== "undefined" && process.env.NODE_ENV === "production") return;
  console.error(`[agent-runtime] illegal transition ${from} -> ${to}: ${why}`);
}

export function createRuntimeStore(options: RuntimeOptions = {}): RuntimeStore {
  const report = options.onIllegal ?? defaultIllegal;
  let state: RuntimeState = IDLE_RUNTIME;
  const listeners = new Set<() => void>();

  const set = (patch: Partial<RuntimeState>): void => {
    // Only notify when something actually changed, so streaming no-ops do not re-render consumers.
    let changed = false;
    for (const key of Object.keys(patch) as (keyof RuntimeState)[]) {
      if (!Object.is(state[key], patch[key])) changed = true;
    }
    if (!changed) return;
    state = { ...state, ...patch };
    for (const l of listeners) l();
  };

  /** Fields that belong to one run and are wiped when it starts or ends. */
  const RUN_FIELDS: Partial<RuntimeState> = {
    writing: false,
    activity: null,
    draft: "",
    reasoningChars: 0,
    approval: null,
    wait: null,
  };

  const move = (to: RunState, patch: Partial<RuntimeState> = {}): boolean => {
    const from = state.run;
    if (!canTransition(from, to)) {
      report(from, to, "not in the transition table");
      return false;
    }
    set({ run: to, ...patch });
    return true;
  };

  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    begin() {
      if (state.run !== "idle") {
        report(state.run, "preparing", "previous run never ended; resetting");
        set({ run: "idle", ...RUN_FIELDS, steps: [] });
      }
      move("preparing", { ...RUN_FIELDS, steps: [] });
    },
    end() {
      set({ run: "idle", ...RUN_FIELDS });
    },
    advance(to) {
      if (state.run === "idle" || state.run === "stopping") return false;
      const writing = to === "thinking" ? state.writing : false;
      return move(to, { writing });
    },
    stop() {
      if (state.run === "idle") return false;
      return move("stopping", { writing: false, approval: null, wait: null });
    },
    enterAwaiting(kind, pending) {
      if (state.run === "stopping") return false; // Stop won the race: the caller fails closed
      if (state.run !== "tool") {
        report(state.run, kind, "can only park from a running tool step");
        return false;
      }
      return move(kind, kind === "awaiting_approval" ? { approval: pending as PendingApproval } : { wait: pending as PendingWait });
    },
    leaveAwaiting(kind) {
      if (state.run !== kind) return;
      move("tool", { approval: null, wait: null });
    },

    setActivity: (text) => set({ activity: text }),
    newRound: () => set({ draft: "", reasoningChars: 0, writing: false }),
    appendDraft(delta) {
      if (state.run === "stopping" || state.run === "idle") return;
      set({ writing: true, draft: state.draft + delta });
    },
    addReasoning(delta) {
      if (state.run === "stopping" || state.run === "idle") return;
      set({ reasoningChars: state.reasoningChars + delta.length });
    },
    stepStarted(id, name, label) {
      const existing = state.steps.some((s) => s.id === id);
      const steps = existing
        ? state.steps.map((s): LiveStep => (s.id === id ? { ...s, name, label, status: "running" } : s))
        : [...state.steps, { id, name, label, status: "running" as StepStatus, startedAt: Date.now() }].slice(-MAX_STEPS);
      set({ steps });
    },
    stepFinished(id, ok) {
      set({ steps: state.steps.map((s): LiveStep => (s.id === id ? { ...s, status: ok ? "ok" : "error" } : s)) });
    },
    clearSteps() {
      if (state.steps.length > 0) set({ steps: [] });
    },

    setAccount: (accountId) => set({ accountId }),
    setQueue: (queue, paused) => set({ queue, paused }),
    setSteering: (steering) => set({ steering }),
    setLock: (lock, remoteActivity = null) => set({ lock, remoteActivity: lock === "other" ? remoteActivity : null }),
  };
}

/** The tab-wide instance every module shares. */
export const runtime: RuntimeStore = createRuntimeStore();

export const getServerRuntime = (): RuntimeState => IDLE_RUNTIME;

/**
 * Subscribe to a slice. The selector must return a primitive or an existing object from the state
 * (never a freshly built one), or React sees a new snapshot on every read.
 */
export function useRuntime<T>(select: (s: RuntimeState) => T): T {
  return useSyncExternalStore(
    runtime.subscribe,
    () => select(runtime.get()),
    () => select(IDLE_RUNTIME),
  );
}
