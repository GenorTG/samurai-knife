// SERVER ONLY. The bridge between agents outside the app (MCP clients) and the app tabs the user has open.
import { randomUUID } from "node:crypto";

/**
 * Open tabs report where they are (presence); an MCP agent reads that (`knife_ui_state`) and can ask the most recently
 * active tab to show a tool/tab (`knife_ui_show`), picked up by the tab's short poll (every 1.5 s while visible: no
 * long-lived connection, so the app's network goes idle and HTTP/1.1's 6-connections limit is never held). In memory, per account,
 * nothing persisted: a server restart forgets the tabs until they report again (every 20 s). Kept on `globalThis` so the
 * MCP route and the stream route share one store even when the dev server bundles them separately.
 *
 * Bounded by construction (an account polling with random client ids must not grow server memory): presence is capped
 * at MAX_TABS per account (oldest report evicted), and `polls` / `pending` only ever hold ids that have presence: a
 * poll from a tab that never reported is answered but not recorded, and whatever removes a presence entry (TTL or the
 * cap) removes its poll and pending entries with it. Stale polls are swept by POLL_TTL_MS; empty accounts are dropped.
 *
 * Calls (`knife_ui_call`): an agent asks the visible tab to run one of the page's live tools (doc_live_*, craft_*). The
 * call rides the same poll; the MCP request waits on a promise until the tab answers (POST /api/ui/call), the tab goes
 * away or the deadline passes. At most MAX_CALLS in flight per account; a call id is random and only the account AND the
 * tab it was sent to can answer it.
 */

export interface UiPresence {
  clientId: string;
  path: string;
  title: string;
  visible: boolean;
  /** ms epoch of the last report */
  at: number;
  /** ms epoch of the last time this tab was visible and focused (user activity) */
  activeAt: number;
  /** Live tools the page offers right now (doc_live_* while a document is connected, craft_* while an app is). */
  tools: string[];
  /** One line on the page's live state ("Live editing CONNECTED to …"), empty when the page has none. */
  live: string;
}

export interface UiShowEvent {
  kind: "show";
  id: number;
  path: string;
  note: string;
  /** The tab that should act (the most recently active one). */
  target: string;
  from: string;
}

export interface UiCallEvent {
  kind: "call";
  id: number;
  /** Random: what the tab answers with. */
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  target: string;
  from: string;
  /** The account the call is for: the tab refuses it when it was loaded by another account (a sign-in elsewhere in
   *  the same browser switched the cookie under it; its file chain and app state are the other account's). */
  account: string;
  /** ms epoch after which nobody waits for the answer (the tab drops an approval card still open then). */
  expiresAt: number;
  /** Set when handed to the tab: ms left until expiresAt (the tab's clock may differ from the server's). */
  ttlMs?: number;
}

export type UiEvent = UiShowEvent | UiCallEvent;

/** What the tab reports back. */
export interface UiCallAnswer {
  /** done = the tool ran (ok says whether it succeeded); declined = the user said no; busy = the in-page assistant runs; unavailable = the page does not offer the tool now. */
  status: "done" | "declined" | "busy" | "unavailable";
  ok: boolean;
  content: string;
}

/** What the waiting MCP call gets: the tab's answer, or why there is none. */
export type UiCallOutcome = UiCallAnswer | { status: "timeout"; pickedUp: boolean } | { status: "gone" };

interface CallWaiter {
  clientId: string;
  tool: string;
  pickedUp: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve: (outcome: UiCallOutcome) => void;
}

interface AccountBridge {
  presence: Map<string, UiPresence>;
  /** clientId -> last poll (ms epoch): a tab that polled recently is "connected" */
  polls: Map<string, number>;
  /** clientId -> show requests and calls not picked up yet */
  pending: Map<string, UiEvent[]>;
  /** callId -> the MCP request waiting for that call's answer */
  calls: Map<string, CallWaiter>;
}

interface BridgeState {
  accounts: Map<string, AccountBridge>;
  nextId: number;
}

/** A tab that has not reported for this long is gone (closed, slept, lost its network). */
export const PRESENCE_TTL_MS = 60_000;
/** A visible tab polls every 1.5 s; one that has not for this long is not listening (hidden, asleep, closed). */
export const POLL_TTL_MS = 5_000;
export const MAX_TABS = 32;
/** Calls in flight per account (an agent loop gone wrong must not pile up work in the user's tab). */
export const MAX_CALLS = 4;
export const CALL_TIMEOUT_MS = 60_000;
export const MAX_CALL_TIMEOUT_MS = 120_000;
/** Serialized arguments of one call (they travel to the tab in a poll response and wait in memory until then). */
export const MAX_CALL_ARGS_BYTES = 1024 * 1024;
/** What a tab may answer (bigger answers are cut; tool results the in-page assistant sees are ~14 KB). */
export const MAX_CALL_RESULT_CHARS = 60_000;
/** Names a tab may report and an agent may call: the page's live tools, plus list_tools (their definitions). */
export const LIVE_TOOL_NAME = /^(doc_live_|craft_)[a-z0-9_]{1,40}$/;
export const LIST_TOOLS = "list_tools";

const KEY = Symbol.for("samurai-knife.ui-bridge.v3");
function state(): BridgeState {
  const g = globalThis as unknown as Record<symbol, BridgeState | undefined>;
  // A long-running dev server keeps globalThis across HMR: replace a state left by an older shape of this module.
  const s = g[KEY];
  if (s?.accounts instanceof Map && typeof s.nextId === "number") return s;
  return (g[KEY] = { accounts: new Map(), nextId: 1 });
}

function bridge(accountId: string): AccountBridge {
  const accounts = state().accounts;
  let b = accounts.get(accountId);
  if (!b) {
    b = { presence: new Map(), polls: new Map(), pending: new Map(), calls: new Map() };
    accounts.set(accountId, b);
  }
  return b;
}

const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;
export const validClientId = (id: string): boolean => CLIENT_ID.test(id);

export function reportPresence(accountId: string, report: { clientId: string; path: string; title: string; visible: boolean; active: boolean; tools?: string[]; live?: string }, now = Date.now()): void {
  const b = bridge(accountId);
  const prev = b.presence.get(report.clientId);
  b.presence.set(report.clientId, {
    clientId: report.clientId,
    path: report.path.slice(0, 500),
    title: report.title.slice(0, 200),
    visible: report.visible,
    at: now,
    activeAt: report.active ? now : prev?.activeAt ?? 0,
    tools: [...new Set((report.tools ?? []).filter((t) => LIVE_TOOL_NAME.test(t)))].slice(0, 64),
    live: (report.live ?? "").slice(0, 300),
  });
  prune(b, now);
}

function forget(b: AccountBridge, clientId: string): void {
  b.presence.delete(clientId);
  b.polls.delete(clientId);
  b.pending.delete(clientId);
  for (const [callId, waiter] of b.calls) if (waiter.clientId === clientId) settle(b, callId, { status: "gone" });
}

/** Ends a call: whoever waits gets `outcome`, the call leaves the tab's pending list. Once only. */
function settle(b: AccountBridge, callId: string, outcome: UiCallOutcome): boolean {
  const waiter = b.calls.get(callId);
  if (!waiter) return false;
  clearTimeout(waiter.timer);
  b.calls.delete(callId);
  const queue = b.pending.get(waiter.clientId);
  if (queue) {
    const rest = queue.filter((e) => e.kind !== "call" || e.callId !== callId);
    if (rest.length) b.pending.set(waiter.clientId, rest);
    else b.pending.delete(waiter.clientId);
  }
  waiter.resolve(outcome);
  return true;
}

function prune(b: AccountBridge, now: number): void {
  for (const [id, p] of b.presence) {
    if (now - p.at > PRESENCE_TTL_MS && !listening(b, id, now)) forget(b, id);
  }
  if (b.presence.size > MAX_TABS) {
    const oldest = [...b.presence.values()].sort((x, y) => x.at - y.at).slice(0, b.presence.size - MAX_TABS);
    for (const p of oldest) forget(b, p.clientId);
  }
  // Only tabs with presence may have these (also cleans a state left by an older version of this module).
  for (const [id, at] of b.polls) if (!b.presence.has(id) || now - at > POLL_TTL_MS) b.polls.delete(id);
  for (const id of b.pending.keys()) if (!b.presence.has(id)) b.pending.delete(id);
}

/** Drops an account's bridge once nothing is left in it. */
function dropIfEmpty(accountId: string, b: AccountBridge): void {
  if (b.presence.size === 0 && b.polls.size === 0 && b.pending.size === 0 && b.calls.size === 0) state().accounts.delete(accountId);
}

const listening = (b: AccountBridge, clientId: string, now: number): boolean => now - (b.polls.get(clientId) ?? 0) <= POLL_TTL_MS;

/** Open tabs, most recently active first. */
export function openTabs(accountId: string, now = Date.now()): (UiPresence & { connected: boolean })[] {
  const b = bridge(accountId);
  prune(b, now);
  dropIfEmpty(accountId, b);
  return [...b.presence.values()]
    .map((p) => ({ ...p, connected: listening(b, p.clientId, now) }))
    .sort((x, y) => y.activeAt - x.activeAt || y.at - x.at);
}

/**
 * A tab's poll: marks it as listening and hands over (and forgets) what was asked of it. A tab without presence (its
 * first poll raced its first report, or the server restarted) is not recorded: `known: false` tells it to report now
 * and poll again.
 */
export function takePoll(accountId: string, clientId: string, now = Date.now()): { known: boolean; events: UiEvent[] } {
  const b = state().accounts.get(accountId);
  if (!b?.presence.has(clientId)) return { known: false, events: [] };
  b.polls.set(clientId, now);
  const events = b.pending.get(clientId) ?? [];
  b.pending.delete(clientId);
  for (const e of events) if (e.kind === "call") {
    const waiter = b.calls.get(e.callId);
    if (waiter) waiter.pickedUp = true;
  }
  return { known: true, events: events.map((e) => (e.kind === "call" ? { ...e, ttlMs: Math.max(0, e.expiresAt - now) } : e)) };
}

export function takePending(accountId: string, clientId: string, now = Date.now()): UiEvent[] {
  return takePoll(accountId, clientId, now).events;
}

/** Ask the most recently active listening tab (or `clientId`) to open `path`. Returns the target, or null if no tab listens. */
export function requestShow(accountId: string, path: string, note: string, from: string, clientId?: string, now = Date.now()): { event: UiShowEvent; tab: UiPresence & { connected: boolean } } | null {
  const tabs = openTabs(accountId, now).filter((t) => t.connected);
  const tab = clientId ? tabs.find((t) => t.clientId === clientId) : tabs[0];
  if (!tab) return null;
  const event: UiShowEvent = { kind: "show", id: state().nextId++, path, note: note.slice(0, 300), target: tab.clientId, from: from.slice(0, 80) };
  const b = bridge(accountId);
  // only the latest request counts: a tab asked twice before it polls goes straight to the second page (calls stay)
  b.pending.set(tab.clientId, [...(b.pending.get(tab.clientId) ?? []).filter((e) => e.kind === "call"), event]);
  return { event, tab };
}

export type CallRefusal =
  | { refused: "no_tab" | "too_many" }
  | { refused: "not_offered"; tab: UiPresence & { connected: boolean } }
  | { refused: "args_too_big"; bytes: number };

/**
 * Ask the most recently active VISIBLE, listening tab that offers `tool` (or `clientId`) to run it. Refused at once when no such tab
 * exists, the page does not offer the tool right now, MAX_CALLS are in flight or the arguments are too big; otherwise
 * `outcome` settles with the tab's answer, `gone` (the tab closed / went away) or `timeout`.
 */
export function requestCall(
  accountId: string,
  call: { tool: string; args: Record<string, unknown>; from: string; clientId?: string; timeoutMs?: number },
  now = Date.now(),
): CallRefusal | { callId: string; tab: UiPresence & { connected: boolean }; outcome: Promise<UiCallOutcome> } {
  const tabs = openTabs(accountId, now).filter((t) => t.connected && t.visible);
  // Without a clientId: the most recently active tab that offers the tool (list_tools: one with any live tool), so a
  // second visible window on another page never takes a call meant for the open document or Craft app.
  const fits = (t: UiPresence) => (call.tool === LIST_TOOLS ? t.tools.length > 0 : t.tools.includes(call.tool));
  const tab = call.clientId ? tabs.find((t) => t.clientId === call.clientId) : tabs.find(fits) ?? tabs[0];
  if (!tab) return { refused: "no_tab" };
  if (call.tool !== LIST_TOOLS && !tab.tools.includes(call.tool)) return { refused: "not_offered", tab };
  const bytes = Buffer.byteLength(JSON.stringify(call.args));
  if (bytes > MAX_CALL_ARGS_BYTES) return { refused: "args_too_big", bytes };
  const b = bridge(accountId);
  if (b.calls.size >= MAX_CALLS) return { refused: "too_many" };
  const timeoutMs = Math.min(Math.max(call.timeoutMs ?? CALL_TIMEOUT_MS, 1), MAX_CALL_TIMEOUT_MS);
  const callId = randomUUID();
  const event: UiCallEvent = { kind: "call", id: state().nextId++, callId, tool: call.tool, args: call.args, target: tab.clientId, from: call.from.slice(0, 80), account: accountId, expiresAt: now + timeoutMs };
  const outcome = new Promise<UiCallOutcome>((resolve) => {
    const timer = setTimeout(() => {
      const waiter = b.calls.get(callId);
      settle(b, callId, { status: "timeout", pickedUp: waiter?.pickedUp ?? false });
      dropIfEmpty(accountId, b);
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    b.calls.set(callId, { clientId: tab.clientId, tool: call.tool, pickedUp: false, timer, resolve });
  });
  b.pending.set(tab.clientId, [...(b.pending.get(tab.clientId) ?? []), event]);
  return { callId, tab, outcome };
}

/** The tab's answer to a call. False (ignored) unless this account sent that call to this tab and it is still waited for. */
export function answerCall(accountId: string, clientId: string, callId: string, answer: UiCallAnswer): boolean {
  const b = state().accounts.get(accountId);
  const waiter = b?.calls.get(callId);
  if (!b || !waiter || waiter.clientId !== clientId) return false;
  const done = settle(b, callId, { status: answer.status, ok: answer.ok, content: answer.content.slice(0, MAX_CALL_RESULT_CHARS) });
  dropIfEmpty(accountId, b);
  return done;
}

/** Test hook: entry counts across every account. */
export function uiBridgeSize(): { accounts: number; presence: number; polls: number; pending: number; calls: number } {
  let presence = 0;
  let polls = 0;
  let pending = 0;
  let calls = 0;
  for (const b of state().accounts.values()) {
    presence += b.presence.size;
    polls += b.polls.size;
    pending += b.pending.size;
    calls += b.calls.size;
  }
  return { accounts: state().accounts.size, presence, polls, pending, calls };
}

/** Test hook. */
export function resetUiBridge(): void {
  const s = state();
  for (const b of s.accounts.values()) for (const callId of [...b.calls.keys()]) settle(b, callId, { status: "gone" });
  s.accounts.clear();
  s.nextId = 1;
}
