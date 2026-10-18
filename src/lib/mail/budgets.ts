import { COLLISION_KINDS, type MailClass, type MailKind } from "@/lib/mail/kinds";
import { MAIL_HASH, PersistedFile } from "@/lib/mail/persist";

/**
 * Send budgets of the mail queue (pure, clock passed in; docs/ACCOUNTS.md "Mail queue"). Threat model: every public flow
 * can make the server send mail, so an attacker could bomb one mailbox (+tag/dot variants share the canonical key), one
 * domain, or everybody at once and get the mail server listed. Budgets: a global per-minute pace (mail waits), global
 * hour/day budgets (lower classes may use only a share, so security mail keeps headroom), per-domain (big webmail /
 * others / newly seen or DNS-risky domains), per-mailbox, and collision notices. Maps are bounded; a full map refuses
 * new keys and never evicts a bucket that still counts. Optionally persisted (keyed hashes, persist.ts) so a restart
 * keeps the day's counts.
 */

export interface Rate {
  max: number;
  windowMs: number;
}

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 60 * 60_000, d: 24 * 60 * 60_000 };

/** "30/m,300/h,1500/d" -> rates; anything malformed -> the fallback (a typo never lifts a budget). */
export function parseRates(spec: string | undefined, fallback: Rate[]): Rate[] {
  if (spec === undefined || !spec.trim()) return fallback;
  const rates: Rate[] = [];
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const match = /^(\d{1,7})\s*\/\s*(\d{0,4})\s*([smhd])$/.exec(part);
    if (!match) return fallback;
    const count = match[2] ? Number(match[2]) : 1;
    if (count < 1) return fallback;
    rates.push({ max: Number(match[1]), windowMs: count * UNIT_MS[match[3]] });
  }
  return rates.length > 0 ? rates : fallback;
}

export interface MailBudgetConfig {
  /** Global pace: at most this many admissions per `paceWindowMs` (mail waits, it is not dropped). */
  perMinute: number;
  paceWindowMs: number;
  global: Rate[];
  bigDomain: Rate[];
  domain: Rate[];
  newDomain: Rate[];
  mailbox: Rate[];
  collision: Rate[];
  /** A domain first mailed less than this long ago is "new" (newDomain budget on top of the domain budget). */
  newDomainMs: number;
  /** Share of each global budget a class may use. */
  shares: Record<MailClass, number>;
  /** Cap per key map (mailboxes, domains). */
  maxKeys: number;
}

const H = 60 * 60_000;
const D = 24 * H;

export function mailBudgetConfig(env: NodeJS.ProcessEnv = process.env): MailBudgetConfig {
  const pace = parseRates(env.KNIFE_MAIL_PER_MINUTE ? `${env.KNIFE_MAIL_PER_MINUTE}/m` : undefined, [{ max: 30, windowMs: 60_000 }])[0];
  return {
    perMinute: Math.max(1, pace.max),
    paceWindowMs: 60_000,
    global: parseRates(env.KNIFE_MAIL_GLOBAL_LIMITS, [{ max: 300, windowMs: H }, { max: 1_500, windowMs: D }]),
    bigDomain: parseRates(env.KNIFE_MAIL_BIG_DOMAIN_LIMITS, [{ max: 300, windowMs: D }]),
    domain: parseRates(env.KNIFE_MAIL_DOMAIN_LIMITS, [{ max: 20, windowMs: H }, { max: 60, windowMs: D }]),
    newDomain: parseRates(env.KNIFE_MAIL_NEW_DOMAIN_LIMITS, [{ max: 5, windowMs: H }]),
    mailbox: parseRates(env.KNIFE_MAIL_MAILBOX_LIMITS, [{ max: 3, windowMs: H }, { max: 6, windowMs: D }]),
    collision: parseRates(env.KNIFE_MAIL_COLLISION_LIMITS, [{ max: 1, windowMs: D }]),
    newDomainMs: H,
    shares: { security: 1, verification: 0.9, notice: 0.5 },
    maxKeys: 50_000,
  };
}

export interface BudgetSubject {
  kind: MailKind;
  cls: MailClass;
  /** Canonical mailbox key (email-policy canonicalEmailKey). */
  mailbox: string;
  domain: string;
  big: boolean;
  /** DNS failed for the domain (email-policy mailRisk): the new-domain budget applies. */
  risky: boolean;
}

export type BudgetDenial = "global" | "domain" | "mailbox" | "collision" | "capacity";

interface Stamps {
  t: number[];
  /** Keyed name in the saved file, computed once. */
  h?: string;
}

/**
 * Timestamps per key, bounded in keys; a key whose newest stamp is older than `horizonMs` is expired. With a `hash`,
 * buckets restored from disk (by keyed hash) are adopted on first use of their key.
 */
class Windows {
  readonly map = new Map<string, Stamps>();
  readonly restored = new Map<string, number[]>();
  readonly maxKeys: number;
  readonly horizonMs: number;
  readonly keep: number;
  private readonly hash: ((key: string) => string) | null;

  constructor(maxKeys: number, horizonMs: number, keep: number, hash: ((key: string) => string) | null) {
    this.maxKeys = maxKeys;
    this.horizonMs = horizonMs;
    this.keep = keep;
    this.hash = hash;
  }

  private get(key: string): Stamps | undefined {
    const entry = this.map.get(key);
    if (entry || this.restored.size === 0 || !this.hash) return entry;
    const h = this.hash(key);
    const saved = this.restored.get(h);
    if (!saved) return undefined;
    this.restored.delete(h);
    const adopted = { t: saved, h };
    this.map.set(key, adopted);
    return adopted;
  }

  count(key: string, windowMs: number, now: number): number {
    const list = this.get(key)?.t;
    if (!list) return 0;
    let n = 0;
    for (let i = list.length - 1; i >= 0 && list[i] > now - windowMs; i -= 1) n += 1;
    return n;
  }

  /** Oldest stamp still inside the window when `max` stamps are in it (for the pace delay). */
  nthNewest(key: string, n: number): number | null {
    const list = this.get(key)?.t;
    return list && list.length >= n ? list[list.length - n] : null;
  }

  /** Room for `key`: it exists, or the map has space after dropping expired keys. */
  hasRoom(key: string, now: number): boolean {
    if (this.get(key) || this.map.size < this.maxKeys) return true;
    for (const [k, entry] of this.map) if (entry.t[entry.t.length - 1] <= now - this.horizonMs) this.map.delete(k);
    return this.map.size < this.maxKeys;
  }

  add(key: string, now: number): void {
    const entry = this.get(key) ?? { t: [] };
    entry.t.push(now);
    const fresh = entry.t.filter((time) => time > now - this.horizonMs);
    entry.t = fresh.length > this.keep ? fresh.slice(fresh.length - this.keep) : fresh;
    this.map.set(key, entry);
  }

  /** Saved rows `[hash, stamps]`: live buckets only, at most `maxKeys`. */
  rows(now: number): [string, number[]][] {
    if (!this.hash) return [];
    const out: [string, number[]][] = [];
    const from = now - this.horizonMs;
    for (const [key, entry] of this.map) {
      if (out.length >= this.maxKeys) break;
      const t = entry.t.filter((time) => time > from);
      if (t.length) out.push([(entry.h ??= this.hash(key)), t]);
    }
    for (const [h, list] of this.restored) {
      if (out.length >= this.maxKeys) break;
      const t = list.filter((time) => time > from);
      if (t.length) out.push([h, t]);
    }
    return out;
  }

  restore(rows: unknown, now: number): void {
    if (!Array.isArray(rows)) return;
    for (const row of rows.slice(0, this.maxKeys)) {
      if (!Array.isArray(row) || row.length !== 2) continue;
      const [h, list] = row as [unknown, unknown];
      if (typeof h !== "string" || !MAIL_HASH.test(h) || !Array.isArray(list) || this.restored.has(h)) continue;
      const t = list
        .filter((time): time is number => typeof time === "number" && time > now - this.horizonMs && time <= now + 60_000)
        .sort((a, b) => a - b)
        .slice(-this.keep);
      if (t.length) this.restored.set(h, t);
    }
  }

  sweep(now: number): void {
    const from = now - this.horizonMs;
    for (const [k, entry] of this.map) if (entry.t[entry.t.length - 1] <= from) this.map.delete(k);
    for (const [h, list] of this.restored) if (list[list.length - 1] <= from) this.restored.delete(h);
  }
}

const horizon = (...groups: Rate[][]): number => Math.max(60_000, ...groups.flat().map((r) => r.windowMs));
const keepFor = (...groups: Rate[][]): number => Math.max(1, ...groups.flat().map((r) => r.max)) + 1;

const MAX_FILE_BYTES = 32 * 1024 * 1024;

export interface BudgetPersistence {
  /** File to save to (`$KNIFE_DATA_DIR/mail/budgets.json`). */
  path: string;
  /** Keyed hash for mailbox/domain names on disk (persist.ts `mailKeyHash`). */
  hash: (key: string) => string;
}

export class MailBudgets {
  private readonly global: Windows;
  private readonly domains: Windows;
  private readonly mailboxes: Windows;
  private readonly collisions: Windows;
  private readonly firstSeen = new Map<string, number>();
  private readonly file: PersistedFile | null;
  readonly config: MailBudgetConfig;

  /**
   * With `persistence`, every bucket (global hour/day, per-domain, per-mailbox, collisions) survives a restart: a restart
   * never hands out a fresh day of budget. Domains seen for the first time stay "new" again after a restart (stricter).
   */
  constructor(config: MailBudgetConfig, persistence: BudgetPersistence | null = null) {
    this.config = config;
    const c = config;
    const hash = persistence?.hash ?? null;
    const paceRate = [{ max: c.perMinute, windowMs: c.paceWindowMs }];
    this.global = new Windows(1, horizon(c.global, paceRate), keepFor(c.global, paceRate), hash);
    this.domains = new Windows(c.maxKeys, horizon(c.bigDomain, c.domain, c.newDomain), keepFor(c.bigDomain, c.domain, c.newDomain), hash);
    this.mailboxes = new Windows(c.maxKeys, horizon(c.mailbox), keepFor(c.mailbox), hash);
    this.collisions = new Windows(c.maxKeys, horizon(c.collision), keepFor(c.collision), hash);
    this.file = persistence
      ? new PersistedFile({
        path: persistence.path,
        maxBytes: MAX_FILE_BYTES,
        serialize: (now) => {
          this.sweep(now);
          return JSON.stringify({ v: 1, savedAt: new Date(now).toISOString(), ...Object.fromEntries(this.windows().map(([name, w]) => [name, w.rows(now)])) });
        },
        restore: (data, now) => {
          if ((data as { v?: unknown })?.v !== 1) return;
          for (const [name, w] of this.windows()) w.restore((data as Record<string, unknown>)[name], now);
        },
      })
      : null;
  }

  private windows(): [string, Windows][] {
    return [["global", this.global], ["domains", this.domains], ["mailboxes", this.mailboxes], ["collisions", this.collisions]];
  }

  /** Resolves once the previous process's counters are loaded (the queue waits for it before admitting mail). */
  ready(): Promise<void> {
    return this.file?.ready() ?? Promise.resolve();
  }

  /** Writes the counters now (tests, shutdown). */
  save(): Promise<void> {
    return this.file?.save() ?? Promise.resolve();
  }

  dispose(): Promise<void> {
    return this.file?.dispose() ?? Promise.resolve();
  }

  sweep(now: number): void {
    for (const [, w] of this.windows()) w.sweep(now);
  }

  /** Milliseconds until the global pace admits one more message (0 = now). */
  paceDelay(now: number): number {
    const { perMinute, paceWindowMs } = this.config;
    if (this.global.count("all", paceWindowMs, now) < perMinute) return 0;
    const oldest = this.global.nthNewest("all", perMinute);
    return oldest === null ? 0 : Math.max(1, oldest + paceWindowMs - now);
  }

  isNewDomain(domain: string, now: number): boolean {
    const seen = this.firstSeen.get(domain);
    return seen === undefined || now - seen < this.config.newDomainMs;
  }

  private domainRates(subject: BudgetSubject, now: number): Rate[] {
    if (subject.big) return this.config.bigDomain;
    return subject.risky || this.isNewDomain(subject.domain, now) ? [...this.config.domain, ...this.config.newDomain] : this.config.domain;
  }

  private full(windows: Windows, key: string, rates: Rate[], now: number, share = 1): boolean {
    return rates.some((rate) => windows.count(key, rate.windowMs, now) >= Math.max(1, Math.floor(rate.max * share)));
  }

  /** Read-only: why this message may not be sent now (null = it may). Security mail only meets the global budget. */
  check(subject: BudgetSubject, now: number): BudgetDenial | null {
    if (this.full(this.global, "all", this.config.global, now, this.config.shares[subject.cls])) return "global";
    if (subject.cls === "security") return null;
    if (COLLISION_KINDS.has(subject.kind)) {
      if (!this.collisions.hasRoom(subject.mailbox, now)) return "capacity";
      if (this.full(this.collisions, subject.mailbox, this.config.collision, now)) return "collision";
    }
    if (!this.mailboxes.hasRoom(subject.mailbox, now) || !this.domains.hasRoom(subject.domain, now)) return "capacity";
    if (this.full(this.mailboxes, subject.mailbox, this.config.mailbox, now)) return "mailbox";
    if (this.full(this.domains, subject.domain, this.domainRates(subject, now), now)) return "domain";
    return null;
  }

  /** Counts one admitted message against every bucket it belongs to (security mail too, so others see it). */
  commit(subject: BudgetSubject, now: number): void {
    this.global.add("all", now);
    if (this.domains.hasRoom(subject.domain, now)) this.domains.add(subject.domain, now);
    if (this.mailboxes.hasRoom(subject.mailbox, now)) this.mailboxes.add(subject.mailbox, now);
    if (COLLISION_KINDS.has(subject.kind) && this.collisions.hasRoom(subject.mailbox, now)) this.collisions.add(subject.mailbox, now);
    if (!this.firstSeen.has(subject.domain)) {
      // Forgetting the oldest only makes a domain "new" (stricter) again.
      if (this.firstSeen.size >= this.config.maxKeys) this.firstSeen.delete(this.firstSeen.keys().next().value as string);
      this.firstSeen.set(subject.domain, now);
    }
    this.file?.changed();
  }

  usage(now: number): { minute: number; hour: number; day: number; domains: number; mailboxes: number } {
    return {
      minute: this.global.count("all", this.config.paceWindowMs, now),
      hour: this.global.count("all", H, now),
      day: this.global.count("all", D, now),
      domains: this.domains.map.size + this.domains.restored.size,
      mailboxes: this.mailboxes.map.size + this.mailboxes.restored.size,
    };
  }
}
