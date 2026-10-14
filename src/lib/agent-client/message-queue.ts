import { runtime, type PauseReason, type QueuedMessage } from "./runtime-store";

/**
 * The message queue: texts typed while a run is active (or while another tab runs the conversation).
 * Persisted per account (`sk.agent.queue.v1.<account>`) so it survives navigation and reload, shared by
 * every tab of that account (`storage` events keep the store in sync), and edited only by
 * read-modify-write against what is stored right now, never by replacing from a stale copy.
 * The runtime store mirrors it for the UI; this module is the only writer of both.
 */

interface StoredQueue {
  items: QueuedMessage[];
  paused: PauseReason | null;
}

const EMPTY: StoredQueue = { items: [], paused: null };
const queueKey = (accountId: string) => `sk.agent.queue.v1.${accountId}`;
export const MAX_QUEUED = 20;

function isQueued(value: unknown): value is QueuedMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.text === "string" && typeof v.at === "number";
}

function parse(raw: string | null): StoredQueue {
  if (!raw) return EMPTY;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return EMPTY;
    const p = parsed as Record<string, unknown>;
    const items = Array.isArray(p.items) ? p.items.filter(isQueued) : [];
    const paused = p.paused === "stopped" || p.paused === "failed" ? p.paused : null;
    return { items, paused: items.length > 0 ? paused : null };
  } catch {
    return EMPTY;
  }
}

/** Queues that could not be stored (blocked/full localStorage) live only in this tab. */
let memoryOnly: { accountId: string; queue: StoredQueue } | null = null;

function read(accountId: string): StoredQueue {
  if (memoryOnly?.accountId === accountId) return memoryOnly.queue;
  try {
    return parse(window.localStorage.getItem(queueKey(accountId)));
  } catch {
    return EMPTY;
  }
}

function write(accountId: string, queue: StoredQueue): void {
  const clean: StoredQueue = { items: queue.items, paused: queue.items.length > 0 ? queue.paused : null };
  try {
    if (clean.items.length === 0) window.localStorage.removeItem(queueKey(accountId));
    else window.localStorage.setItem(queueKey(accountId), JSON.stringify(clean));
    if (memoryOnly?.accountId === accountId) memoryOnly = null;
  } catch {
    memoryOnly = { accountId, queue: clean };
  }
  if (runtime.get().accountId === accountId) runtime.setQueue(clean.items, clean.paused);
}

function mutate(fn: (q: StoredQueue) => StoredQueue): void {
  const accountId = runtime.get().accountId;
  if (!accountId) return;
  write(accountId, fn(read(accountId)));
}

let counter = 0;
const newId = (): string => {
  counter += 1;
  return `q${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
};

/** Point the store at an account's queue and keep it in sync with other tabs. Call again on account change; returns the detach function. */
export function attachQueue(accountId: string | null): () => void {
  runtime.setAccount(accountId);
  if (!accountId) {
    runtime.setQueue([], null);
    return () => {};
  }
  const sync = (): void => {
    const q = read(accountId);
    runtime.setQueue(q.items, q.paused);
  };
  sync();
  const onStorage = (event: StorageEvent): void => {
    if (event.key === queueKey(accountId) || event.key === null) sync();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

export function enqueue(text: string): QueuedMessage | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const item: QueuedMessage = { id: newId(), text: trimmed, at: Date.now() };
  let added = false;
  mutate((q) => {
    if (q.items.length >= MAX_QUEUED) return q;
    added = true;
    return { ...q, items: [...q.items, item] };
  });
  return added ? item : null;
}

export function cancelQueued(id: string): void {
  mutate((q) => ({ ...q, items: q.items.filter((i) => i.id !== id) }));
}

/** Change a queued text in place (order preserved). An emptied text cancels the item. */
export function editQueued(id: string, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return cancelQueued(id);
  mutate((q) => ({ ...q, items: q.items.map((i) => (i.id === id ? { ...i, text: trimmed } : i)) }));
}

/**
 * Remove and return one item, or null when it is already gone (another tab took it): this is what makes
 * delivery exactly-once. `unlessPaused` is for the automatic drain, which must honour a pause another
 * tab may have just written; an explicit "send now" ignores it.
 */
export function takeQueued(id: string, options: { unlessPaused?: boolean } = {}): QueuedMessage | null {
  const accountId = runtime.get().accountId;
  if (!accountId) return null;
  const q = read(accountId);
  const item = q.items.find((i) => i.id === id);
  if (!item || (options.unlessPaused && q.paused)) {
    runtime.setQueue(q.items, q.paused); // our copy was stale (another tab changed it): catch up
    return null;
  }
  write(accountId, { ...q, items: q.items.filter((i) => i.id !== id) });
  return item;
}

export function pauseQueue(reason: PauseReason): void {
  mutate((q) => ({ ...q, paused: reason }));
}

export function resumeQueue(): void {
  mutate((q) => ({ ...q, paused: null }));
}

export function clearQueue(): void {
  mutate(() => EMPTY);
  runtime.setSteering([]);
}

/* ----------------------------------------------------------------- steering */

/** "Send now" on a chip: it leaves the queue and waits in the steering inbox for the loop's next round boundary. */
export function moveToSteering(id: string): boolean {
  const item = takeQueued(id);
  if (!item) return false;
  runtime.setSteering([...runtime.get().steering, item]);
  return true;
}

/** The loop's inbox read: everything steered so far, once. */
export function takeSteeringTexts(): string[] {
  const items = runtime.get().steering;
  if (items.length === 0) return [];
  runtime.setSteering([]);
  return items.map((i) => i.text);
}

/** The run ended before the loop reached a boundary: undelivered steering goes back to the front of the queue, in order. */
export function reclaimSteering(): void {
  const items = runtime.get().steering;
  if (items.length === 0) return;
  runtime.setSteering([]);
  mutate((q) => ({ ...q, items: [...items, ...q.items] }));
}
