// SERVER ONLY.
/**
 * Server-wide outbound budgets (docs/ARCHITECTURE.md "Outbound requests"): one sliding window per purpose across all
 * non-admin accounts, and one per destination host. Threat: many cheap accounts turning the server into a crawler, a
 * stolen-key checker or a flood against one third party; per-account limits alone multiply with the number of accounts.
 * Self-contained and bounded: purposes are a fixed set; host buckets are capped at MAX_HOSTS and, when the table is
 * full of still-active buckets, a NEW host is refused (fail closed) instead of evicting an active bucket.
 */

export interface Budget {
  max: number;
  windowMs: number;
}

export type BudgetVerdict = { ok: true } | { ok: false; retryAfterSeconds: number; key: string };

export const MAX_HOSTS = 4_000;
const KEY = Symbol.for("samurai-knife.outbound-budgets.v1");

interface Store {
  purposes: Map<string, number[]>;
  hosts: Map<string, number[]>;
}

function store(): Store {
  const g = globalThis as unknown as Record<symbol, Store | undefined>;
  const s = g[KEY];
  if (s && s.purposes instanceof Map && s.hosts instanceof Map) return s;
  return (g[KEY] = { purposes: new Map(), hosts: new Map() });
}

function live(list: number[] | undefined, windowMs: number, now: number): number[] {
  return (list ?? []).filter((t) => t > now - windowMs);
}

function pruneHosts(hosts: Map<string, number[]>, windowMs: number, now: number): void {
  for (const [host, list] of hosts) if (!list.some((t) => t > now - windowMs)) hosts.delete(host);
}

export interface BudgetRequest {
  /** Purpose bucket (fixed set) and its budget. */
  purpose?: { key: string; budget: Budget };
  /** Destination host bucket and its budget. */
  host?: { key: string; budget: Budget };
}

/** Check both buckets; count the request in both only when both have room (atomic on the single Node thread). */
export function takeBudget(request: BudgetRequest, now = Date.now()): BudgetVerdict {
  const s = store();
  const wait = (list: number[], budget: Budget): number => list[list.length - budget.max] + budget.windowMs - now;
  let purposeList: number[] | null = null;
  if (request.purpose) {
    const { key, budget } = request.purpose;
    purposeList = live(s.purposes.get(key), budget.windowMs, now);
    if (purposeList.length >= budget.max) return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(wait(purposeList, budget) / 1000)), key: `purpose:${key}` };
  }
  let hostList: number[] | null = null;
  if (request.host) {
    const { key, budget } = request.host;
    if (!s.hosts.has(key) && s.hosts.size >= MAX_HOSTS) {
      pruneHosts(s.hosts, budget.windowMs, now);
      if (s.hosts.size >= MAX_HOSTS) return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(budget.windowMs / 1000)), key: "host-table-full" };
    }
    hostList = live(s.hosts.get(key), budget.windowMs, now);
    if (hostList.length >= budget.max) return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(wait(hostList, budget) / 1000)), key: `host:${key}` };
  }
  if (request.purpose && purposeList) s.purposes.set(request.purpose.key, [...purposeList, now]);
  if (request.host && hostList) s.hosts.set(request.host.key, [...hostList, now]);
  return { ok: true };
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
