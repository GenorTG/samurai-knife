// SERVER ONLY.
/**
 * Server-wide outbound budgets (docs/ARCHITECTURE.md "Outbound requests"): one sliding window per purpose across all
 * non-admin accounts, and one per user-chosen destination host. Threat: many cheap accounts turning the server into a
 * crawler, a stolen-key checker or a flood against one third party; per-account limits alone multiply with the number
 * of accounts. The opposite threat counts as much: a handful of bot accounts must not use a shared budget up and lock
 * every other user out, so every bucket is FAIR-SHARE:
 *  - below `max` anyone is admitted;
 *  - from `max` to the hard ceiling (HARD_FACTOR x max) only an account still under its share is admitted, share =
 *    max(minShare, max / accounts active in the window): the heavy accounts that filled the bucket wait, a light one
 *    goes on; at the hard ceiling nobody is (fail closed);
 *  - every bucket is bounded: its entries by the hard ceiling, host buckets by MAX_HOSTS (a NEW host is refused when the
 *    table is full of still-active buckets, never an active bucket evicted).
 * Admins never reach this module (outbound.ts `outboundBudgeted`).
 */

export interface Budget {
  max: number;
  windowMs: number;
}

export type BudgetVerdict = { ok: true } | { ok: false; retryAfterSeconds: number; key: string };

export const MAX_HOSTS = 4_000;
/** The hard ceiling of a bucket, as a multiple of its `max`. */
export const HARD_FACTOR = 2;
const KEY = Symbol.for("samurai-knife.outbound-budgets.v2");

/** One sliding window with per-account counts; entries are appended in time order and expire from the head. */
interface Bucket {
  times: number[];
  accounts: string[];
  head: number;
  counts: Map<string, number>;
}

interface Store {
  version: 2;
  purposes: Map<string, Bucket>;
  hosts: Map<string, Bucket>;
}

function store(): Store {
  const g = globalThis as unknown as Record<symbol, Store | undefined>;
  const s = g[KEY];
  if (s && s.version === 2 && s.purposes instanceof Map && s.hosts instanceof Map) return s;
  return (g[KEY] = { version: 2, purposes: new Map(), hosts: new Map() });
}

const emptyBucket = (): Bucket => ({ times: [], accounts: [], head: 0, counts: new Map() });

function expire(bucket: Bucket, windowMs: number, now: number): void {
  const from = now - windowMs;
  while (bucket.head < bucket.times.length && bucket.times[bucket.head] <= from) {
    const account = bucket.accounts[bucket.head];
    const n = (bucket.counts.get(account) ?? 1) - 1;
    if (n > 0) bucket.counts.set(account, n);
    else bucket.counts.delete(account);
    bucket.head += 1;
  }
  // Compact once the expired prefix dominates, so the arrays stay bounded by the live entries (<= the hard ceiling).
  if (bucket.head > 64 && bucket.head * 2 > bucket.times.length) {
    bucket.times = bucket.times.slice(bucket.head);
    bucket.accounts = bucket.accounts.slice(bucket.head);
    bucket.head = 0;
  }
}

const size = (bucket: Bucket): number => bucket.times.length - bucket.head;

/** The guaranteed per-account share of a full bucket (1 % of max, at least one request). */
export function minShare(budget: Budget): number {
  return Math.max(1, Math.floor(budget.max / 100));
}

/** Seconds until `account` would be admitted, 0 when it may go now. A pure check: counts nothing. */
function waitFor(bucket: Bucket, budget: Budget, account: string, now: number): number {
  const live = size(bucket);
  if (budget.max <= 0) return Math.max(1, Math.ceil(budget.windowMs / 1000)); // a budget set to 0 disables the purpose
  if (live < budget.max) return 0;
  const hard = Math.max(budget.max, Math.floor(budget.max * HARD_FACTOR));
  const secs = (t: number) => Math.max(1, Math.ceil((t + budget.windowMs - now) / 1000));
  if (live >= hard) return secs(bucket.times[bucket.head + live - hard]);
  const own = bucket.counts.get(account) ?? 0;
  const active = bucket.counts.size + (own === 0 ? 1 : 0);
  const share = Math.max(minShare(budget), Math.floor(budget.max / active));
  if (own < share) return 0;
  // Over its share: at least until its own oldest entry leaves the window.
  for (let i = bucket.head; i < bucket.times.length; i += 1) if (bucket.accounts[i] === account) return secs(bucket.times[i]);
  return secs(bucket.times[bucket.head]);
}

function count(bucket: Bucket, account: string, now: number): void {
  bucket.times.push(now);
  bucket.accounts.push(account);
  bucket.counts.set(account, (bucket.counts.get(account) ?? 0) + 1);
}

export interface BudgetRequest {
  /** The account spending the budget (its fair share is tracked per bucket). */
  account: string;
  /** Purpose bucket (fixed set) and its budget. */
  purpose?: { key: string; budget: Budget };
  /** Destination host bucket and its budget. */
  host?: { key: string; budget: Budget };
}

/** Check both buckets; count the request in both only when both admit it (atomic on the single Node thread). */
export function takeBudget(request: BudgetRequest, now = Date.now()): BudgetVerdict {
  const s = store();
  let purposeBucket: Bucket | null = null;
  if (request.purpose) {
    const { key, budget } = request.purpose;
    purposeBucket = s.purposes.get(key) ?? emptyBucket();
    expire(purposeBucket, budget.windowMs, now);
    const wait = waitFor(purposeBucket, budget, request.account, now);
    if (wait > 0) return { ok: false, retryAfterSeconds: wait, key: `purpose:${key}` };
  }
  let hostBucket: Bucket | null = null;
  if (request.host) {
    const { key, budget } = request.host;
    const existing = s.hosts.get(key);
    if (!existing && s.hosts.size >= MAX_HOSTS) {
      pruneHosts(s.hosts, budget.windowMs, now);
      if (s.hosts.size >= MAX_HOSTS) return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(budget.windowMs / 1000)), key: "host-table-full" };
    }
    hostBucket = existing ?? emptyBucket();
    expire(hostBucket, budget.windowMs, now);
    const wait = waitFor(hostBucket, budget, request.account, now);
    if (wait > 0) return { ok: false, retryAfterSeconds: wait, key: `host:${key}` };
  }
  if (request.purpose && purposeBucket) {
    count(purposeBucket, request.account, now);
    s.purposes.set(request.purpose.key, purposeBucket);
  }
  if (request.host && hostBucket) {
    count(hostBucket, request.account, now);
    s.hosts.set(request.host.key, hostBucket);
  }
  return { ok: true };
}

function pruneHosts(hosts: Map<string, Bucket>, windowMs: number, now: number): void {
  for (const [host, bucket] of hosts) {
    expire(bucket, windowMs, now);
    if (size(bucket) === 0) hosts.delete(host);
  }
}

/** Tests only. */
export function resetBudgets(): void {
  const s = store();
  s.purposes.clear();
  s.hosts.clear();
}

/** Tests and stats: how many host buckets are held. */
export function hostBucketCount(): number {
  return store().hosts.size;
}

const UNIT: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 };

/** "60/10m" -> {max 60, window 10 minutes}; null when malformed. */
export function parseBudget(text: string): Budget | null {
  const m = /^\s*(\d{1,7})\s*\/\s*(\d{1,4})?\s*([smh])\s*$/.exec(text);
  if (!m) return null;
  const max = Number(m[1]);
  const windowMs = Number(m[2] ?? 1) * UNIT[m[3]];
  return max >= 0 && windowMs > 0 ? { max, windowMs } : null;
}

/** `KNIFE_OUTBOUND_BUDGETS="page=1000/1h, host=60/10m"` -> overrides by name; malformed entries are ignored. */
export function parseBudgetOverrides(text: string | undefined): Record<string, Budget> {
  const out: Record<string, Budget> = {};
  for (const part of (text ?? "").split(",")) {
    const [name, value] = part.split("=", 2).map((x) => x?.trim() ?? "");
    const budget = value ? parseBudget(value) : null;
    if (name && /^[a-z-]{2,30}$/.test(name) && budget) out[name] = budget;
  }
  return out;
}
