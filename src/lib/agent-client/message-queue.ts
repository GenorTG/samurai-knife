import { runtimeFor, type PauseReason, type QueuedMessage } from "./runtime-store";

/**
 * The message queue: texts typed while a run is active (or while another tab runs the conversation).
 * Persisted per account and chat so it survives navigation and reload, shared only by tabs on that chat
 * (`storage` events keep the store in sync), and edited only by
 * read-modify-write against what is stored right now, never by replacing from a stale copy.
 * Each chat's runtime store (runtimeFor) mirrors its queue for the UI; this module is the only writer of both.
 */

/** The signed-in account whose queues this tab edits (set by attachQueue). */
let currentAccount: string | null = null;

interface StoredQueue {
  items: QueuedMessage[];
  paused: PauseReason | null;
}

const EMPTY: StoredQueue = { items: [], paused: null };
const queueKey = (accountId: string, chatId: string) => chatId === "default"
  ? `sk.agent.queue.v1.${accountId}`
  : `sk.agent.queue.v1.${accountId}.${chatId}`;
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
const memoryOnly = new Map<string, StoredQueue>();
const keyOf = (accountId: string, chatId: string) => `${accountId}:${chatId}`;

function read(accountId: string, chatId: string): StoredQueue {
  const key = keyOf(accountId, chatId);
  const memory = memoryOnly.get(key);
  if (memory) return memory;
  try {
    return parse(window.localStorage.getItem(queueKey(accountId, chatId)));
  } catch {
    return EMPTY;
  }
}

function write(accountId: string, chatId: string, queue: StoredQueue): void {
  const key = keyOf(accountId, chatId);
  const clean: StoredQueue = { items: queue.items, paused: queue.items.length > 0 ? queue.paused : null };
  try {
    if (clean.items.length === 0) window.localStorage.removeItem(queueKey(accountId, chatId));
    else window.localStorage.setItem(queueKey(accountId, chatId), JSON.stringify(clean));
    memoryOnly.delete(key);
  } catch {
    memoryOnly.set(key, clean);
  }
  if (accountId === currentAccount) runtimeFor(chatId).setQueue(clean.items, clean.paused);
}

function mutate(chatId: string, fn: (q: StoredQueue) => StoredQueue): void {
  const accountId = currentAccount;
  if (!accountId) return;
  write(accountId, chatId, fn(read(accountId, chatId)));
}

let counter = 0;
const newId = (): string => {
  counter += 1;
  return `q${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
};

/** Point the store at an account's queue and keep it in sync with other tabs. Call again on account change; returns the detach function. */
export function attachQueue(accountId: string | null, chatId = "default"): () => void {
  currentAccount = accountId;
  const rt = runtimeFor(chatId);
  rt.setAccount(accountId, chatId);
  if (!accountId) {
    rt.setQueue([], null);
    return () => {};
  }
  const sync = (): void => {
    const q = read(accountId, chatId);
    rt.setQueue(q.items, q.paused);
  };
  sync();
  const onStorage = (event: StorageEvent): void => {
    if (event.key === queueKey(accountId, chatId) || event.key === null) sync();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

export function enqueue(text: string, chatId = "default"): QueuedMessage | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const item: QueuedMessage = { id: newId(), text: trimmed, at: Date.now() };
  let added = false;
  mutate(chatId, (q) => {
    if (q.items.length >= MAX_QUEUED) return q;
    added = true;
    return { ...q, items: [...q.items, item] };
  });
  return added ? item : null;
}

export function cancelQueued(id: string, chatId = "default"): void {
  mutate(chatId, (q) => ({ ...q, items: q.items.filter((i) => i.id !== id) }));
}

/** Change a queued text in place (order preserved). An emptied text cancels the item. */
export function editQueued(id: string, text: string, chatId = "default"): void {
  const trimmed = text.trim();
  if (!trimmed) return cancelQueued(id, chatId);
  mutate(chatId, (q) => ({ ...q, items: q.items.map((i) => (i.id === id ? { ...i, text: trimmed } : i)) }));
}

/**
 * Remove and return one item, or null when it is already gone (another tab took it): this is what makes
 * delivery exactly-once. `unlessPaused` is for the automatic drain, which must honour a pause another
 * tab may have just written; an explicit "send now" ignores it.
 */
export function takeQueued(id: string, options: { unlessPaused?: boolean } = {}, chatId = "default"): QueuedMessage | null {
  const accountId = currentAccount;
  if (!accountId) return null;
  const q = read(accountId, chatId);
  const item = q.items.find((i) => i.id === id);
  if (!item || (options.unlessPaused && q.paused)) {
    runtimeFor(chatId).setQueue(q.items, q.paused);
    return null;
  }
  write(accountId, chatId, { ...q, items: q.items.filter((i) => i.id !== id) });
  return item;
}

export function pauseQueue(reason: PauseReason, chatId = "default"): void {
  mutate(chatId, (q) => ({ ...q, paused: reason }));
}

export function resumeQueue(chatId = "default"): void {
  mutate(chatId, (q) => ({ ...q, paused: null }));
}

export function clearQueue(chatId = "default"): void {
  mutate(chatId, () => EMPTY);
  runtimeFor(chatId).setSteering([]);
}

/** The first queued message of a chat, when its queue may drain by itself (not paused). */
export function nextQueued(chatId = "default"): QueuedMessage | null {
  if (!currentAccount) return null;
  const q = read(currentAccount, chatId);
  return q.paused ? null : q.items[0] ?? null;
}

/* ----------------------------------------------------------------- steering */

/** "Send now" on a chip: it leaves the queue and waits in the steering inbox for the loop's next round boundary. */
export function moveToSteering(id: string, chatId = "default"): boolean {
  const rt = runtimeFor(chatId);
  const item = takeQueued(id, {}, chatId);
  if (!item) return false;
  rt.setSteering([...rt.get().steering, item]);
  return true;
}

/** The loop's inbox read: everything steered so far, once. */
export function takeSteeringTexts(chatId = "default"): string[] {
  const rt = runtimeFor(chatId);
  const items = rt.get().steering;
  if (items.length === 0) return [];
  rt.setSteering([]);
  return items.map((i) => i.text);
}

/** The run ended before the loop reached a boundary: undelivered steering goes back to the front of the queue, in order. */
export function reclaimSteering(chatId = "default"): void {
  const rt = runtimeFor(chatId);
  const items = rt.get().steering;
  if (items.length === 0) return;
  rt.setSteering([]);
  mutate(chatId, (q) => ({ ...q, items: [...items, ...q.items] }));
}
