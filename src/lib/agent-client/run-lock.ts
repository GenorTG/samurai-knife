/**
 * One assistant turn per account across all browser tabs.
 *
 * Preferred backend: the Web Locks API (`navigator.locks`), which the browser releases for us even when a
 * tab crashes. It only exists in secure contexts, and this app is normally served over plain HTTP on the
 * Tailscale address, so the fallback is the real thing there: a lease in localStorage (tab id + timestamp)
 * renewed while the run goes on and considered dead after LEASE_TTL_MS without a renewal.
 *
 * Both backends answer the same two questions: "can I run?" (tryAcquireRun) and "is a run going in
 * another tab?" (runHeldElsewhere). Tabs also announce run start/end/activity on a BroadcastChannel so the
 * idle tab reacts at once instead of waiting for its next poll. Every failure mode fails open: when
 * neither locks nor storage work, a tab simply runs (the old behaviour).
 */

export type LockBackend = "web-locks" | "lease";

export interface RunLease {
  release: () => void;
  /** Keep a lease alive (called from run activity; the interval alone is throttled in background tabs). No-op for Web Locks. */
  renew: () => void;
}

export const TAB_ID = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const LEASE_TTL_MS = 20_000;
const LEASE_BEAT_MS = 2_000;
const LEASE_VERIFY_MS = 30;

const lockName = (accountId: string) => `samurai-knife-agent-run-${accountId}`;
const leaseKey = (accountId: string) => `sk.agent.lease.v1.${accountId}`;

export function lockBackend(): LockBackend {
  return typeof navigator !== "undefined" && typeof navigator.locks?.request === "function" ? "web-locks" : "lease";
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/* ---------------------------------------------------------------- web locks */

function acquireWebLock(accountId: string): Promise<RunLease | null> {
  return new Promise((resolve) => {
    navigator.locks
      .request(lockName(accountId), { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(null);
          return undefined;
        }
        // Holding the lock = keeping this promise pending; releasing resolves it.
        return new Promise<void>((held) => resolve({ release: () => held(), renew: () => {} }));
      })
      .catch(() => resolve({ release: () => {}, renew: () => {} })); // fail open
  });
}

async function webLockHeld(accountId: string): Promise<boolean> {
  try {
    const snapshot = await navigator.locks.query();
    return (snapshot.held ?? []).some((l) => l.name === lockName(accountId));
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------- lease */

interface Lease {
  tab: string;
  at: number;
}

function readLease(accountId: string): Lease | null {
  try {
    const raw = window.localStorage.getItem(leaseKey(accountId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    return typeof p.tab === "string" && typeof p.at === "number" ? { tab: p.tab, at: p.at } : null;
  } catch {
    return null;
  }
}

const liveElsewhere = (lease: Lease | null): boolean => lease !== null && lease.tab !== TAB_ID && Date.now() - lease.at < LEASE_TTL_MS;

async function acquireLease(accountId: string): Promise<RunLease | null> {
  if (liveElsewhere(readLease(accountId))) return null;
  const write = (): void => {
    try {
      window.localStorage.setItem(leaseKey(accountId), JSON.stringify({ tab: TAB_ID, at: Date.now() } satisfies Lease));
    } catch {
      /* storage blocked: fail open */
    }
  };
  write();
  // Two tabs can write within the same moment; the last write wins, so look again before believing we hold it.
  await sleep(LEASE_VERIFY_MS);
  const after = readLease(accountId);
  if (after && after.tab !== TAB_ID) return null;
  let lastRenew = Date.now();
  const timer = setInterval(write, LEASE_BEAT_MS);
  return {
    renew: () => {
      if (Date.now() - lastRenew < 1000) return;
      lastRenew = Date.now();
      write();
    },
    release: () => {
      clearInterval(timer);
      try {
        if (readLease(accountId)?.tab === TAB_ID) window.localStorage.removeItem(leaseKey(accountId));
      } catch {
        /* ignore */
      }
    },
  };
}

/* ---------------------------------------------------------------- public API */

/** Take the run lock for this account, or null when another tab already holds it. Never waits. */
export function tryAcquireRun(accountId: string): Promise<RunLease | null> {
  return lockBackend() === "web-locks" ? acquireWebLock(accountId) : acquireLease(accountId);
}

/** Is another tab running a turn for this account? (Ask only while this tab holds no lock of its own.) */
export async function runHeldElsewhere(accountId: string): Promise<boolean> {
  return lockBackend() === "web-locks" ? webLockHeld(accountId) : liveElsewhere(readLease(accountId));
}

/* ------------------------------------------------------------ announcements */

export interface RunAnnouncement {
  accountId: string;
  tab: string;
  running: boolean;
  activity: string | null;
}

const CHANNEL = "samurai-knife-agent-run";
let channel: BroadcastChannel | null | undefined;

function getChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  try {
    channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
  } catch {
    channel = null;
  }
  return channel;
}

export function announceRun(accountId: string, running: boolean, activity: string | null): void {
  getChannel()?.postMessage({ accountId, tab: TAB_ID, running, activity } satisfies RunAnnouncement);
}

export function subscribeRunAnnouncements(listener: (a: RunAnnouncement) => void): () => void {
  const ch = getChannel();
  if (!ch) return () => {};
  const onMessage = (event: MessageEvent<unknown>) => {
    const d = event.data;
    if (typeof d !== "object" || d === null) return;
    const a = d as Record<string, unknown>;
    if (typeof a.accountId !== "string" || typeof a.tab !== "string" || typeof a.running !== "boolean") return;
    if (a.tab === TAB_ID) return;
    listener({ accountId: a.accountId, tab: a.tab, running: a.running, activity: typeof a.activity === "string" ? a.activity : null });
  };
  ch.addEventListener("message", onMessage);
  return () => ch.removeEventListener("message", onMessage);
}
