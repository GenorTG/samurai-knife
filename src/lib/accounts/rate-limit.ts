/**
 * In-memory sliding-window rate limits (reset on restart, per server process; fine for one Next process). Each call names
 * every bucket it counts against (e.g. per client address AND per email), and is refused when any one is full. Buckets are
 * keyed by attacker-chosen strings, so the map is bounded: past MAX_KEYS the expired entries go first, then the oldest.
 */
export interface Limit {
  /** Bucket name, already namespaced by the caller (e.g. `register:ip:1.2.3.4`). */
  key: string;
  max: number;
  windowMs: number;
}

type Store = Map<string, number[]>;

const MAX_KEYS = 5_000;
const globalKey = Symbol.for("samurai-knife.rate-limit.v1");
const holder = globalThis as unknown as Record<symbol, Store | undefined>;

function store(): Store {
  let map = holder[globalKey];
  if (!(map instanceof Map)) {
    map = new Map();
    holder[globalKey] = map;
  }
  return map;
}

function recent(map: Store, key: string, windowMs: number, now: number): number[] {
  const list = (map.get(key) ?? []).filter((time) => time > now - windowMs);
  if (list.length > 0) map.set(key, list);
  else map.delete(key);
  return list;
}

function prune(map: Store, now: number): void {
  if (map.size <= MAX_KEYS) return;
  for (const [key, list] of map) if (list.every((time) => time < now - 24 * 60 * 60_000)) map.delete(key);
  for (const key of map.keys()) {
    if (map.size <= MAX_KEYS) break;
    map.delete(key);
  }
}

export type LimitCheck = { ok: true } | { ok: false; retryAfterSeconds: number };

/** Read-only check: is any bucket full? */
export function checkLimits(limits: Limit[], now = Date.now()): LimitCheck {
  const map = store();
  let wait = 0;
  for (const limit of limits) {
    const list = recent(map, limit.key, limit.windowMs, now);
    if (list.length >= limit.max) wait = Math.max(wait, list[list.length - limit.max] + limit.windowMs - now);
  }
  return wait > 0 ? { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(wait / 1_000)) } : { ok: true };
}

/** Counts one event against every bucket. */
export function hitLimits(limits: Limit[], now = Date.now()): void {
  const map = store();
  for (const limit of limits) map.set(limit.key, [...recent(map, limit.key, limit.windowMs, now), now]);
  prune(map, now);
}

/** Check, and count the attempt when it is allowed (for actions where every attempt counts: register, resend, forgot). */
export function consumeLimits(limits: Limit[], now = Date.now()): LimitCheck {
  const verdict = checkLimits(limits, now);
  if (verdict.ok) hitLimits(limits, now);
  return verdict;
}

export function clearLimit(key: string): void {
  store().delete(key);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The policy, in one place (docs/ACCOUNTS.md "Rate limits"). Login counts failures only; the others count every request. */
export const LIMITS = {
  /** Private mode keeps the old rule exactly: 5 failures per minute per account and client address. */
  loginPair: (id: string, ip: string): Limit => ({ key: `login:pair:${id}|${ip}`, max: 5, windowMs: MINUTE }),
  loginAccount: (id: string): Limit => ({ key: `login:account:${id}`, max: 20, windowMs: 15 * MINUTE }),
  loginIp: (ip: string): Limit => ({ key: `login:ip:${ip}`, max: 50, windowMs: 15 * MINUTE }),
  registerIp: (ip: string): Limit => ({ key: `register:ip:${ip}`, max: 10, windowMs: HOUR }),
  registerEmail: (email: string): Limit => ({ key: `register:email:${email}`, max: 3, windowMs: HOUR }),
  resendIp: (ip: string): Limit => ({ key: `resend:ip:${ip}`, max: 10, windowMs: HOUR }),
  resendEmail: (email: string): Limit => ({ key: `resend:email:${email}`, max: 3, windowMs: 15 * MINUTE }),
  forgotIp: (ip: string): Limit => ({ key: `forgot:ip:${ip}`, max: 10, windowMs: HOUR }),
  forgotEmail: (email: string): Limit => ({ key: `forgot:email:${email}`, max: 3, windowMs: 15 * MINUTE }),
  /** Change email / password / delete with a wrong password: per account. */
  sensitive: (id: string): Limit => ({ key: `sensitive:${id}`, max: 10, windowMs: 15 * MINUTE }),
  /** Outbound requests a non-admin steers in public mode (`src/lib/net/outbound.ts`): model rounds, provider Test, pages. */
  outboundProvider: (id: string): Limit => ({ key: `outbound:provider:${id}`, max: 300, windowMs: 10 * MINUTE }),
  outboundProviderTest: (id: string): Limit => ({ key: `outbound:provider-test:${id}`, max: 20, windowMs: 10 * MINUTE }),
  outboundPage: (id: string): Limit => ({ key: `outbound:page:${id}`, max: 30, windowMs: 10 * MINUTE }),
};
