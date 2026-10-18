// SERVER ONLY. The bridge between agents outside the app (MCP clients) and the app tabs the user has open.

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

interface AccountBridge {
  presence: Map<string, UiPresence>;
  /** clientId -> last poll (ms epoch): a tab that polled recently is "connected" */
  polls: Map<string, number>;
  /** clientId -> show requests not picked up yet */
  pending: Map<string, UiShowEvent[]>;
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

const KEY = Symbol.for("samurai-knife.ui-bridge.v2");
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
    b = { presence: new Map(), polls: new Map(), pending: new Map() };
    accounts.set(accountId, b);
  }
  return b;
}

const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;
export const validClientId = (id: string): boolean => CLIENT_ID.test(id);

export function reportPresence(accountId: string, report: { clientId: string; path: string; title: string; visible: boolean; active: boolean }, now = Date.now()): void {
  const b = bridge(accountId);
  const prev = b.presence.get(report.clientId);
  b.presence.set(report.clientId, {
    clientId: report.clientId,
    path: report.path.slice(0, 500),
    title: report.title.slice(0, 200),
    visible: report.visible,
    at: now,
    activeAt: report.active ? now : prev?.activeAt ?? 0,
  });
  prune(b, now);
}

function forget(b: AccountBridge, clientId: string): void {
  b.presence.delete(clientId);
  b.polls.delete(clientId);
  b.pending.delete(clientId);
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
  if (b.presence.size === 0 && b.polls.size === 0 && b.pending.size === 0) state().accounts.delete(accountId);
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
 * A tab's poll: marks it as listening and hands over (and forgets) what was asked of it. A tab that has not reported
 * its presence yet (or any more) is not recorded: it reports on mount and every 20 s, and its next poll counts.
 */
export function takePending(accountId: string, clientId: string, now = Date.now()): UiShowEvent[] {
  const b = state().accounts.get(accountId);
  if (!b?.presence.has(clientId)) return [];
  b.polls.set(clientId, now);
  const events = b.pending.get(clientId) ?? [];
  b.pending.delete(clientId);
  return events;
}

/** Ask the most recently active listening tab (or `clientId`) to open `path`. Returns the target, or null if no tab listens. */
export function requestShow(accountId: string, path: string, note: string, from: string, clientId?: string, now = Date.now()): { event: UiShowEvent; tab: UiPresence & { connected: boolean } } | null {
  const tabs = openTabs(accountId, now).filter((t) => t.connected);
  const tab = clientId ? tabs.find((t) => t.clientId === clientId) : tabs[0];
  if (!tab) return null;
  const event: UiShowEvent = { kind: "show", id: state().nextId++, path, note: note.slice(0, 300), target: tab.clientId, from: from.slice(0, 80) };
  const b = bridge(accountId);
  // only the latest request counts: a tab asked twice before it polls goes straight to the second page
  b.pending.set(tab.clientId, [event]);
  return { event, tab };
}

/** Test hook: entry counts across every account. */
export function uiBridgeSize(): { accounts: number; presence: number; polls: number; pending: number } {
  let presence = 0;
  let polls = 0;
  let pending = 0;
  for (const b of state().accounts.values()) {
    presence += b.presence.size;
    polls += b.polls.size;
    pending += b.pending.size;
  }
  return { accounts: state().accounts.size, presence, polls, pending };
}

/** Test hook. */
export function resetUiBridge(): void {
  const s = state();
  s.accounts.clear();
  s.nextId = 1;
}
