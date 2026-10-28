import { MAX_STORED_MESSAGES, capTranscript, repairTranscript } from "@/lib/agent-client/loop";
import type { TranscriptMessage } from "@/lib/agent-client/types";

/** localStorage persistence for the widget. Every call is safe when storage is unavailable. */

export const UI_KEY = "sk.agent.ui.v1";
const chatKey = (accountId: string) => `sk.agent.chat.v1.${accountId}`;

export const MIN_WIDTH = 320;
export const MIN_HEIGHT = 360;

export interface UiPrefs {
  open: boolean;
  width: number;
  height: number;
  /** Pinned beside the page (desktop) instead of floating over it. */
  dock: boolean;
  /** Known conversation ids; the server remains the durable source of transcripts. */
  chatIds: string[];
}

export const DEFAULT_PREFS: UiPrefs = { open: false, width: 400, height: 560, dock: false, chatIds: ["default"] };
const CHAT_ID = /^[a-zA-Z0-9_-]{1,64}$/;

function clampSize(value: unknown, min: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(2000, Math.round(value))) : fallback;
}

export function loadPrefs(): UiPrefs {
  try {
    const raw = window.localStorage.getItem(UI_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_PREFS;
    const p = parsed as Record<string, unknown>;
    const chatIds = Array.isArray(p.chatIds)
      ? [...new Set(p.chatIds.filter((id): id is string => typeof id === "string" && CHAT_ID.test(id)))].slice(0, 50)
      : ["default"];
    return {
      open: p.open === true,
      dock: p.dock === true,
      chatIds: chatIds.length > 0 ? chatIds : ["default"],
      width: clampSize(p.width, MIN_WIDTH, DEFAULT_PREFS.width),
      height: clampSize(p.height, MIN_HEIGHT, DEFAULT_PREFS.height),
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(prefs: UiPrefs): void {
  try {
    const latest = loadPrefs();
    const chatIds = [...new Set([...latest.chatIds, ...prefs.chatIds])].slice(0, 50);
    window.localStorage.setItem(UI_KEY, JSON.stringify({ ...prefs, chatIds }));
  } catch {
    /* Quota or privacy mode: the widget still works, it just forgets. */
  }
}

export function subscribePrefs(listener: (prefs: UiPrefs) => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === UI_KEY || event.key === null) listener(loadPrefs());
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

function isToolCall(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const fn = v.function as Record<string, unknown> | undefined;
  return typeof v.id === "string" && typeof fn?.name === "string" && typeof fn.arguments === "string";
}

function isTranscriptMessage(value: unknown): value is TranscriptMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  switch (m.role) {
    case "user":
      return typeof m.content === "string";
    case "assistant":
      return (
        (typeof m.content === "string" || m.content === null) &&
        (m.tool_calls === undefined || (Array.isArray(m.tool_calls) && m.tool_calls.every(isToolCall)))
      );
    case "tool":
      return typeof m.tool_call_id === "string" && typeof m.content === "string";
    case "notice":
      return (m.level === "error" || m.level === "info" || m.level === "usage") && typeof m.content === "string";
    default:
      return false;
  }
}

/** Raw stored transcript (no pairing repair: a live run legitimately has tool calls whose result is still coming). */
function parseChat(raw: string | null): TranscriptMessage[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? capTranscript(parsed.filter(isTranscriptMessage)) : [];
  } catch {
    return [];
  }
}

/** Accounts whose transcript could not be written (blocked or full localStorage): this tab keeps them in memory so its chat still works. */
const memoryOnly = new Map<string, TranscriptMessage[]>();

function persistChat(accountId: string, messages: TranscriptMessage[]): TranscriptMessage[] {
  const capped = capTranscript(messages, MAX_STORED_MESSAGES);
  let stored = capped;
  try {
    window.localStorage.setItem(chatKey(accountId), JSON.stringify(capped));
  } catch {
    stored = capTranscript(capped, 40);
    try {
      window.localStorage.setItem(chatKey(accountId), JSON.stringify(stored));
    } catch {
      memoryOnly.set(accountId, stored);
      return stored;
    }
  }
  memoryOnly.delete(accountId);
  return stored;
}

/** The shared transcript as it is stored right now (other tabs' appends included). */
export function readChat(accountId: string): TranscriptMessage[] {
  const local = memoryOnly.get(accountId);
  if (local) return local;
  try {
    return parseChat(window.localStorage.getItem(chatKey(accountId)));
  } catch {
    return [];
  }
}

/**
 * Append to the shared transcript: read what is stored now, add, write. Never replaces, so a tab that
 * was idle (or loaded earlier) cannot overwrite what another tab appended in the meantime.
 */
export function appendChat(accountId: string, additions: TranscriptMessage[]): TranscriptMessage[] {
  return persistChat(accountId, [...readChat(accountId), ...additions]);
}

/** Replace the whole transcript (pairing repair at turn start, under the run lock). */
export function replaceChat(accountId: string, messages: TranscriptMessage[]): TranscriptMessage[] {
  return persistChat(accountId, messages);
}

/** Calls `listener` when ANOTHER tab changes this account's transcript (the `storage` event never fires in the writing tab). `removed` = it was cleared. */
export function subscribeChat(accountId: string, listener: (removed: boolean) => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === chatKey(accountId)) listener(event.newValue === null);
    else if (event.key === null) listener(true); // storage.clear()
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

/** Initial load for display and for the model: stored transcript with tool calls paired. */
export function loadChat(accountId: string): TranscriptMessage[] {
  return repairTranscript(readChat(accountId));
}

export function saveChat(accountId: string, messages: TranscriptMessage[]): void {
  persistChat(accountId, messages);
}

export function clearChat(accountId: string): void {
  memoryOnly.delete(accountId);
  try {
    window.localStorage.removeItem(chatKey(accountId));
  } catch {
    /* ignore */
  }
}
