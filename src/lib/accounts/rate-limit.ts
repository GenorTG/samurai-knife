import { createHmac, createSecretKey, type KeyObject } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { authMac } from "@/lib/accounts/auth-secret";
import { emailLimitKey } from "@/lib/accounts/email-address";
import { wideKeyOf } from "@/lib/net/client-ip.mjs";
import { securityDir } from "@/lib/security/events-core.mjs";
import { recordSecurityEvent, type SecurityEventKind } from "@/lib/security/events";

/**
 * Sliding-window rate limits for everything that needs meaning (per account, per email, per client prefix), one process.
 * Each call names every bucket it counts against and is refused when any one is full.
 *
 * Threat model: bucket keys are attacker-chosen (random emails and identifiers, rotating addresses), so the store is
 * bounded, and a flood of new keys must never push out the bucket that is currently stopping an attacker (audit abuse
 * #2: the old single 5,000-key map evicted the oldest-inserted key, so ~2,000 junk logins reset `login:account:<victim>`),
 * nor lock everyone else out (E1). Hence:
 * - one store per namespace (the key's first segment: `login`, `login-day`, `register`, `outbound`...), each with a cap;
 * - expired buckets are swept on a timer and whenever a namespace is full; a limiting bucket is never evicted;
 * - pre-login namespaces never evict: past the soft cap a new key is refused only for a "heavy creator" (the client
 *   /48 or /24 that already created more than its fair share of keys in 15 min), past the hard cap (1.25x) for everyone
 *   except calls marked `trusted` (a known device), which make room by evicting the least recently hit non-limiting
 *   bucket. Signed-in namespaces evict the least recently hit non-limiting bucket;
 * - per-address limits carry a coarse companion (IPv6 /48 at 5x always; IPv4 /24 where a limit asks for it);
 * - security-relevant buckets are saved every minute (asynchronously, at most 50,000 rows, limiting ones first) and on
 *   exit to `$KNIFE_DATA_DIR/security/rate-limits.json` (0600) under HMAC(auth.key) names, so a restart does not reset
 *   them and the file holds no email or address; it is loaded asynchronously (bounded size) at startup.
 * Every refusal is a security event (`rate_block`, once per bucket and window) naming only the bucket kind, never the
 * attacker-chosen part of the key. Signal buckets (`quiet`) decide proof-of-work and never refuse or log by themselves.
 */
export interface Limit {
  /** Bucket name, already namespaced by the caller (e.g. `register:ip:1.2.3.4`); the namespace is the first segment. */
  key: string;
  max: number;
  windowMs: number;
  /** Companion buckets counted with this one (coarser address prefixes). */
  also?: Limit[];
  /** Event kind recorded when this bucket refuses (default `rate_block`). */
  event?: SecurityEventKind;
  /** Signal bucket: a full one never records a refusal event (the caller decides what it means). */
  quiet?: boolean;
  /** Client prefix the bucket belongs to: the event's `ipPrefix` and the call's key creator. */
  ip?: string;
  /** Account id the bucket belongs to, for the event. */
  account?: string;
}

export type LimitCheck = { ok: true } | { ok: false; retryAfterSeconds: number };

export interface LimitOptions {
  /** A caller already vouched for (a signed known-device cookie): new keys are never refused for a full namespace. */
  trusted?: boolean;
}

interface NamespacePolicy {
  /** Soft cap on distinct keys; pre-login namespaces refuse heavy creators past it and everyone past 1.25x. */
  maxKeys: number;
  /** Pre-login namespace: never evicts (keys there are cheap for an attacker to create). */
  preAuth: boolean;
  /** Keys saved across restarts. */
  persist?: RegExp;
}

const NAMESPACES: Record<string, NamespacePolicy> = {
  login: { maxKeys: 100_000, preAuth: true, persist: /^login:(?:account|fail|ip|ip48):/ },
  // 24 h identifier buckets live long, so they get their own space: they can never fill `login` (E1).
  "login-day": { maxKeys: 100_000, preAuth: true, persist: /^login-day:/ },
  "login-global": { maxKeys: 16, preAuth: true, persist: /^login-global:/ },
  // Created only after a correct password / by a signed device cookie: an attacker cannot mint these keys freely.
  "login-ok": { maxKeys: 20_000, preAuth: false },
  "login-device": { maxKeys: 20_000, preAuth: false },
  register: { maxKeys: 50_000, preAuth: true, persist: /^register:/ },
  resend: { maxKeys: 50_000, preAuth: true, persist: /^resend:/ },
  forgot: { maxKeys: 50_000, preAuth: true, persist: /^forgot:/ },
  verify: { maxKeys: 50_000, preAuth: true, persist: /^verify:/ },
  reset: { maxKeys: 50_000, preAuth: true, persist: /^reset:/ },
  github: { maxKeys: 50_000, preAuth: true },
  "mcp-auth": { maxKeys: 50_000, preAuth: true, persist: /^mcp-auth:/ },
  sensitive: { maxKeys: 20_000, preAuth: false, persist: /^sensitive:/ },
  "mcp-key": { maxKeys: 20_000, preAuth: false },
  outbound: { maxKeys: 50_000, preAuth: false },
  // Workflow webhooks (docs/WORKFLOWS.md "Triggers"): callers are anonymous by design.
  hook: { maxKeys: 50_000, preAuth: true },
  "hook-wf": { maxKeys: 20_000, preAuth: false },
  "wf-runs": { maxKeys: 20_000, preAuth: false },
};
const DEFAULT_POLICY: NamespacePolicy = { maxKeys: 20_000, preAuth: true };

const HARD_FACTOR = 1.25;
const CREATOR_WINDOW_MS = 15 * 60_000;
/** A new key refused for a full namespace waits this long. */
const FULL_RETRY_SECONDS = 60;
const TIMER_MS = 60_000;
const MAX_SAVED = 50_000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const HASH = /^[A-Za-z0-9_-]{22}$/;

interface Bucket {
  hits: number[];
  windowMs: number;
  max: number;
  /** When this bucket last recorded a refusal event. */
  reported: number;
  /** Its keyed name in the saved file, computed once. */
  hash?: string;
}

interface Creator {
  n: number;
  start: number;
}

interface Namespace {
  name: string;
  policy: NamespacePolicy;
  /** Insertion order = least recently hit first (a hit re-inserts its key). */
  map: Map<string, Bucket>;
  /** Pre-login namespaces: keys created per client /48 or /24 in the current 15 min. */
  creators: Map<string, Creator>;
  lastSweep: number;
}

interface Store {
  version: 3;
  spaces: Map<string, Namespace>;
  /** Buckets loaded from disk, by keyed hash, adopted on first use. */
  restored: Map<string, Bucket>;
  loading: Promise<void> | null;
  dirty: boolean;
  saving: boolean;
  timer: ReturnType<typeof setInterval> | null;
  fullReported: Map<string, number>;
  overrides: Map<string, NamespacePolicy>;
  /** Derived once from auth.key (reading the key file per hash would stall the event loop). */
  nameKey: KeyObject | null;
}

const globalKey = Symbol.for("samurai-knife.rate-limit.v3");
const holder = globalThis as unknown as Record<symbol, Store | undefined>;

function store(): Store {
  let current = holder[globalKey];
  if (!current || current.version !== 3 || !(current.spaces instanceof Map)) {
    current = { version: 3, spaces: new Map(), restored: new Map(), loading: null, dirty: false, saving: false, timer: null, fullReported: new Map(), overrides: new Map(), nameKey: null };
    holder[globalKey] = current;
  }
  current.loading ??= load(current);
  if (!current.timer) {
    const s = current;
    s.timer = setInterval(() => {
      const now = Date.now();
      for (const space of s.spaces.values()) sweep(space, now, true);
      for (const [hash, bucket] of s.restored) if (live(bucket, now).length === 0) s.restored.delete(hash);
      if (s.dirty) void saveAsync(s, now);
    }, TIMER_MS);
    s.timer.unref?.();
    const hooked = Symbol.for("samurai-knife.rate-limit.exit-hook");
    const flags = globalThis as unknown as Record<symbol, boolean | undefined>;
    if (!flags[hooked]) {
      flags[hooked] = true;
      process.once("exit", () => {
        const last = holder[globalKey];
        if (last?.dirty) saveSync(last, Date.now());
      });
    }
  }
  return current;
}

function namespaceOf(key: string): string {
  const index = key.indexOf(":");
  return index > 0 ? key.slice(0, index) : key;
}

function space(s: Store, key: string): Namespace {
  const name = namespaceOf(key);
  let found = s.spaces.get(name);
  if (!found) {
    found = { name, policy: s.overrides.get(name) ?? NAMESPACES[name] ?? DEFAULT_POLICY, map: new Map(), creators: new Map(), lastSweep: 0 };
    s.spaces.set(name, found);
  }
  return found;
}

const hardCap = (ns: Namespace) => Math.ceil(ns.policy.maxKeys * HARD_FACTOR);
const fairShare = (ns: Namespace) => Math.max(20, Math.floor(ns.policy.maxKeys / 2_000));

/** Keyed hash of a bucket name for the saved file (no email, identifier or address on disk; not recomputable from a guess). */
function hashKey(key: string): string {
  const s = store();
  s.nameKey ??= createSecretKey(authMac("rate-limit", "bucket-names/v1"));
  return createHmac("sha256", s.nameKey).update(key).digest("base64url").slice(0, 22);
}

function live(bucket: Bucket, now: number): number[] {
  const from = now - bucket.windowMs;
  if (bucket.hits.length && bucket.hits[0] <= from) bucket.hits = bucket.hits.filter((time) => time > from);
  return bucket.hits;
}

const limiting = (bucket: Bucket, now: number) => live(bucket, now).length >= bucket.max;

/** Drops buckets with no hit inside their window and stale creator counts. At most once a second unless `force`. */
function sweep(ns: Namespace, now: number, force = false): void {
  if (!force && now - ns.lastSweep < 1_000) return;
  ns.lastSweep = now;
  for (const [key, bucket] of ns.map) if (live(bucket, now).length === 0) ns.map.delete(key);
  for (const [key, creator] of ns.creators) if (now - creator.start >= CREATOR_WINDOW_MS) ns.creators.delete(key);
}

/** The bucket for `key` (adopting one restored from disk), or undefined. */
function find(s: Store, ns: Namespace, key: string): Bucket | undefined {
  const bucket = ns.map.get(key);
  if (bucket || s.restored.size === 0) return bucket;
  const hash = hashKey(key);
  const saved = s.restored.get(hash);
  if (!saved) return undefined;
  s.restored.delete(hash);
  saved.hash = hash;
  ns.map.set(key, saved);
  return saved;
}

/** Who creates keys in a call: the client's coarse prefix (/48, /24), so rotating /64s or addresses is one creator. */
function creatorOf(limits: Limit[]): string {
  const ip = limits.find((limit) => limit.ip)?.ip;
  return ip ? wideKeyOf(ip) ?? ip : "unattributed";
}

function creatorCount(ns: Namespace, creator: string, now: number): number {
  const entry = ns.creators.get(creator);
  return entry && now - entry.start < CREATOR_WINDOW_MS ? entry.n : 0;
}

/**
 * May a new key be created in `ns` by `creator` right now? Below the soft cap: yes. Pre-login, between soft and hard
 * cap: only for a creator under its fair share; at the hard cap: no (trusted calls make room instead). Signed-in
 * namespaces: yes while a non-limiting bucket can be evicted.
 */
function admits(ns: Namespace, creator: string, now: number, options: LimitOptions, evict: boolean): boolean {
  if (ns.map.size < ns.policy.maxKeys) return true;
  sweep(ns, now);
  if (ns.map.size < ns.policy.maxKeys) return true;
  if (ns.policy.preAuth && !options.trusted) {
    return ns.map.size < hardCap(ns) && creatorCount(ns, creator, now) < fairShare(ns);
  }
  if (ns.policy.preAuth && ns.map.size < hardCap(ns)) return true;
  for (const [key, bucket] of ns.map) {
    if (!limiting(bucket, now)) {
      if (evict) ns.map.delete(key);
      return true;
    }
  }
  return false;
}

function noteCreation(ns: Namespace, creator: string, now: number): void {
  if (!ns.policy.preAuth) return;
  const entry = ns.creators.get(creator);
  if (entry && now - entry.start < CREATOR_WINDOW_MS) entry.n += 1;
  else if (entry || ns.creators.size < hardCap(ns)) ns.creators.set(creator, { n: 1, start: now });
  // A full creator table only stops the counting; admits() still caps the namespace itself at the hard cap.
}

/** The limits as listed (a bucket listed twice counts twice, as before), plus each companion once. */
function expand(limits: Limit[]): Limit[] {
  const out: Limit[] = [];
  const companions = new Set<string>();
  for (const limit of limits) {
    out.push(limit);
    for (const extra of limit.also ?? []) {
      if (companions.has(extra.key)) continue;
      companions.add(extra.key);
      out.push(extra);
    }
  }
  return out;
}

/** `login:account:<identifier>` -> `login:account`: the attacker-chosen part (emails, identifiers) never reaches the log. */
function bucketKind(key: string): string {
  return key.split(":").slice(0, 2).join(":");
}

function report(limit: Limit, bucket: Bucket, now: number): void {
  if (limit.quiet || now - bucket.reported < bucket.windowMs) return;
  bucket.reported = now;
  recordSecurityEvent({ kind: limit.event ?? "rate_block", ipPrefix: limit.ip, account: limit.account, detail: bucketKind(limit.key) });
}

function reportFull(s: Store, ns: Namespace, creator: string, now: number): void {
  if (now - (s.fullReported.get(ns.name) ?? 0) < 60_000) return;
  s.fullReported.set(ns.name, now);
  recordSecurityEvent({ kind: "quota_full", ipPrefix: creator === "unattributed" ? undefined : creator, detail: `rate-limit namespace ${ns.name} full (${ns.map.size} keys): new keys refused` });
}

/** Read-only check: is any bucket full (or, for a new key, its namespace full for this caller)? */
export function checkLimits(limits: Limit[], now = Date.now(), options: LimitOptions = {}): LimitCheck {
  const s = store();
  const all = expand(limits);
  const creator = creatorOf(all);
  let wait = 0;
  for (const limit of all) {
    const ns = space(s, limit.key);
    const bucket = find(s, ns, limit.key);
    if (!bucket) {
      if (!admits(ns, creator, now, options, false)) {
        reportFull(s, ns, creator, now);
        wait = Math.max(wait, FULL_RETRY_SECONDS * 1_000);
      }
      continue;
    }
    const list = live(bucket, now);
    const max = Math.min(bucket.max, limit.max);
    if (list.length >= max) {
      wait = Math.max(wait, list[list.length - max] + limit.windowMs - now);
      report(limit, bucket, now);
    }
  }
  return wait > 0 ? { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(wait / 1_000)) } : { ok: true };
}

/** Counts one event against every bucket. A new key that its namespace does not admit is not stored (see checkLimits). */
export function hitLimits(limits: Limit[], now = Date.now(), options: LimitOptions = {}): void {
  const s = store();
  const all = expand(limits);
  const creator = creatorOf(all);
  for (const limit of all) {
    const ns = space(s, limit.key);
    let bucket = find(s, ns, limit.key);
    if (bucket) {
      ns.map.delete(limit.key);
    } else {
      if (!admits(ns, creator, now, options, true)) {
        reportFull(s, ns, creator, now);
        continue;
      }
      noteCreation(ns, creator, now);
      bucket = { hits: [], windowMs: limit.windowMs, max: limit.max, reported: 0 };
    }
    bucket.windowMs = limit.windowMs;
    bucket.max = limit.max;
    const list = live(bucket, now);
    list.push(now);
    // Never more timestamps than the limit needs: the oldest beyond `max` can no longer decide anything.
    if (list.length > limit.max) list.splice(0, list.length - limit.max);
    ns.map.set(limit.key, bucket);
    if (ns.policy.persist?.test(limit.key)) s.dirty = true;
  }
}

/** Check, and count the attempt when it is allowed (for actions where every attempt counts: register, resend, forgot). */
export function consumeLimits(limits: Limit[], now = Date.now(), options: LimitOptions = {}): LimitCheck {
  const verdict = checkLimits(limits, now, options);
  if (verdict.ok) hitLimits(limits, now, options);
  return verdict;
}

export function clearLimit(key: string): void {
  const s = store();
  space(s, key).map.delete(key);
  if (s.restored.size) s.restored.delete(hashKey(key));
}

// -- persistence ------------------------------------------------------------------------------------------------------

function persistPath(): string {
  return join(securityDir(), "rate-limits.json");
}

async function load(s: Store): Promise<void> {
  const path = persistPath();
  try {
    const info = await stat(path);
    if (info.size > MAX_FILE_BYTES) return;
    const parsed = JSON.parse(await readFile(path, "utf8")) as { v?: number; buckets?: unknown };
    if (parsed.v !== 2 || !Array.isArray(parsed.buckets)) return;
    const now = Date.now();
    for (const row of parsed.buckets.slice(0, MAX_SAVED)) {
      if (!Array.isArray(row) || row.length !== 4) continue;
      const [hash, windowMs, max, hits] = row as [unknown, unknown, unknown, unknown];
      if (typeof hash !== "string" || !HASH.test(hash) || !Number.isInteger(windowMs) || !Number.isInteger(max) || (max as number) < 1 || !Array.isArray(hits)) continue;
      const kept = hits
        .slice(0, max as number)
        .filter((time): time is number => typeof time === "number" && time > now - (windowMs as number) && time <= now + 60_000)
        .sort((a, b) => a - b);
      if (kept.length && !s.restored.has(hash)) s.restored.set(hash, { hits: kept, windowMs: windowMs as number, max: max as number, reported: 0 });
    }
  } catch {
    // No file yet, or a damaged one: start empty; the next save rewrites it.
  }
}

/** The rows to save: limiting buckets first, then the rest, at most MAX_SAVED. */
function rows(s: Store, now: number): [string, number, number, number[]][] {
  const hot: [string, number, number, number[]][] = [];
  const rest: [string, number, number, number[]][] = [];
  const add = (hash: string, bucket: Bucket) => {
    const hits = live(bucket, now);
    if (!hits.length) return;
    (hits.length >= bucket.max ? hot : rest).push([hash, bucket.windowMs, bucket.max, [...hits]]);
  };
  for (const ns of s.spaces.values()) {
    if (!ns.policy.persist) continue;
    for (const [key, bucket] of ns.map) {
      if (hot.length + rest.length >= MAX_SAVED * 2) break;
      if (ns.policy.persist.test(key)) add((bucket.hash ??= hashKey(key)), bucket);
    }
  }
  for (const [hash, bucket] of s.restored) {
    if (hot.length + rest.length >= MAX_SAVED * 2) break;
    add(hash, bucket);
  }
  return [...hot, ...rest].slice(0, MAX_SAVED);
}

const serialize = (s: Store, now: number) => JSON.stringify({ v: 2, savedAt: new Date(now).toISOString(), buckets: rows(s, now) });

async function saveAsync(s: Store, now: number): Promise<void> {
  if (s.saving) return;
  s.saving = true;
  s.dirty = false;
  const path = persistPath();
  const temp = `${path}.${process.pid}.tmp`;
  try {
    await mkdir(securityDir(), { recursive: true, mode: 0o700 });
    await writeFile(temp, serialize(s, now), { mode: 0o600 });
    await rename(temp, path);
  } catch (error) {
    s.dirty = true;
    console.error(`[rate-limit] saving buckets failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    s.saving = false;
  }
}

function saveSync(s: Store, now: number): void {
  try {
    mkdirSync(securityDir(), { recursive: true, mode: 0o700 });
    chmodSync(securityDir(), 0o700);
    const temp = `${persistPath()}.${process.pid}.tmp`;
    writeFileSync(temp, serialize(s, now), { mode: 0o600 });
    renameSync(temp, persistPath());
    s.dirty = false;
  } catch {
    // exiting anyway
  }
}

/** Saves the persistent buckets now (tests, shutdown). */
export async function saveRateLimits(now = Date.now()): Promise<void> {
  const s = store();
  while (s.saving) await new Promise((resolve) => setTimeout(resolve, 5));
  await saveAsync(s, now);
}

/** Resolves once the buckets saved by the previous process are loaded (startup is asynchronous). */
export function rateLimitsReady(): Promise<void> {
  return store().loading ?? Promise.resolve();
}

/** Per-namespace key counts (admin view, tests). */
export function rateLimitStats(): Record<string, { keys: number; maxKeys: number; preAuth: boolean }> {
  const out: Record<string, { keys: number; maxKeys: number; preAuth: boolean }> = {};
  for (const [name, ns] of store().spaces) out[name] = { keys: ns.map.size, maxKeys: ns.policy.maxKeys, preAuth: ns.policy.preAuth };
  return out;
}

/** Tests only: drop every bucket, optionally override namespace policies (e.g. a tiny `maxKeys`) and reload from disk. */
export function resetRateLimitsForTests(overrides: Record<string, Partial<NamespacePolicy>> = {}): Promise<void> {
  const old = holder[globalKey];
  if (old?.timer) clearInterval(old.timer);
  holder[globalKey] = undefined;
  const s = store();
  for (const [name, policy] of Object.entries(overrides)) s.overrides.set(name, { ...(NAMESPACES[name] ?? DEFAULT_POLICY), ...policy });
  return s.loading ?? Promise.resolve();
}

// -- the policy ---------------------------------------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]?.trim());
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * A per-client limit (`ip` = network.ts `clientIp`: IPv4 address or IPv6 /64) as `<prefix>:ip:<ip>`, with its coarse
 * companion `<prefix>:ip48:` (IPv6 /48, 5x the limit, always) or `<prefix>:ip24:` (IPv4 /24, only with `v4Wide`:
 * NAT, offices and carrier networks share a /24).
 */
function addressLimit(prefix: string, ip: string, max: number, windowMs: number, options: { v4Wide?: number; quiet?: boolean } = {}): Limit {
  const base: Limit = { key: `${prefix}:ip:${ip}`, max, windowMs, ip, quiet: options.quiet };
  const wide = wideKeyOf(ip);
  if (!wide) return base;
  const v6 = wide.endsWith("/48");
  const factor = v6 ? 5 : options.v4Wide;
  if (!factor) return base;
  return { ...base, also: [{ key: `${prefix}:${v6 ? "ip48" : "ip24"}:${wide}`, max: max * factor, windowMs, ip: wide, quiet: options.quiet }] };
}

/**
 * The policy, in one place (docs/ACCOUNTS.md "Rate limits"). Login counts failures only; the others count every request.
 * Every per-address limit goes through `addressLimit` (the /64 plus its /48 companion). Per-email limits key on the
 * canonical mailbox (`emailLimitKey`: `+tag`, gmail dots and googlemail share one bucket; audit abuse #5a).
 */
export const LIMITS = {
  /** Private mode keeps the old rule exactly: 5 failures per minute per account and client address. */
  loginPair: (id: string, ip: string): Limit => ({ key: `login:pair:${id}|${ip}`, max: 5, windowMs: MINUTE, ip }),
  /** Signal, never a refusal: a full identifier bucket raises the proof-of-work difficulty (session.ts attemptLogin). */
  loginAccount: (id: string): Limit => ({ key: `login:account:${id}`, max: 20, windowMs: 15 * MINUTE, quiet: true }),
  loginIp: (ip: string): Limit => addressLimit("login", ip, 50, 15 * MINUTE),
  /**
   * Signal, never a refusal: failed logins across every account and address (credential stuffing from a botnet). When
   * full, every login from a browser that is not a known device needs proof-of-work at the raised difficulty
   * (KNIFE_LOGIN_GLOBAL_FAILS per 15 min, default 600). Logged once per window (alert-worthy).
   */
  loginGlobal: (): Limit => ({ key: "login-global:all", max: envInt("KNIFE_LOGIN_GLOBAL_FAILS", 600), windowMs: 15 * MINUTE, event: "login_lockout" }),
  registerIp: (ip: string): Limit => addressLimit("register", ip, 10, HOUR, { v4Wide: 3 }),
  registerEmail: (email: string): Limit => ({ key: `register:email:${emailLimitKey(email)}`, max: 3, windowMs: HOUR }),
  resendIp: (ip: string): Limit => addressLimit("resend", ip, 10, HOUR),
  resendEmail: (email: string): Limit => ({ key: `resend:email:${emailLimitKey(email)}`, max: 3, windowMs: 15 * MINUTE }),
  forgotIp: (ip: string): Limit => addressLimit("forgot", ip, 10, HOUR),
  forgotEmail: (email: string): Limit => ({ key: `forgot:email:${emailLimitKey(email)}`, max: 3, windowMs: 15 * MINUTE }),
  /** Change email / password / delete with a wrong password: per account. */
  sensitive: (id: string): Limit => ({ key: `sensitive:${id}`, max: 10, windowMs: 15 * MINUTE, account: id }),
  /** MCP requests with a wrong or revoked key: per client address (a key is 256 random bits; this stops log spam). */
  mcpAuthIp: (ip: string): Limit => addressLimit("mcp-auth", ip, 30, 15 * MINUTE),
  /** Creating MCP keys: per account. */
  mcpKeyCreate: (id: string): Limit => ({ key: `mcp-key:create:${id}`, max: 20, windowMs: HOUR, account: id }),
  /** Outbound requests a non-admin steers in public mode (`src/lib/net/outbound.ts`): model rounds, provider Test, pages. */
  outboundProvider: (id: string): Limit => ({ key: `outbound:provider:${id}`, max: 300, windowMs: 10 * MINUTE, account: id }),
  outboundProviderTest: (id: string): Limit => ({ key: `outbound:provider-test:${id}`, max: 20, windowMs: 10 * MINUTE, account: id }),
  outboundPage: (id: string): Limit => ({ key: `outbound:page:${id}`, max: 30, windowMs: 10 * MINUTE, account: id }),
  /** Website studio: one audit fetches up to ~15 pages + PageSpeed; counted per run. */
  outboundAudit: (id: string): Limit => ({ key: `outbound:audit:${id}`, max: 6, windowMs: 60 * MINUTE, account: id }),
  /** Website screenshots: each one runs a browser on the server (src/lib/vision/screenshot.ts). */
  outboundScreenshot: (id: string): Limit => ({ key: `outbound:screenshot:${id}`, max: 20, windowMs: 60 * MINUTE, account: id }),
  /** Website studio: GitHub API calls made with the account's own token. */
  outboundGithub: (id: string): Limit => ({ key: `outbound:github:${id}`, max: 600, windowMs: 10 * MINUTE, account: id }),
  /* Sign-in hardening (docs/ACCOUNTS.md "Rate limits"): link checks, login signals, GitHub start. */
  /** Verify / reset links: every request counts, per client address and per token hash (cheap refusals first). */
  verifyIp: (ip: string): Limit => addressLimit("verify", ip, 20, 10 * MINUTE),
  verifyToken: (hash: string): Limit => ({ key: `verify:token:${hash}`, max: 5, windowMs: 10 * MINUTE }),
  resetIp: (ip: string): Limit => addressLimit("reset", ip, 20, 10 * MINUTE),
  resetToken: (hash: string): Limit => ({ key: `reset:token:${hash}`, max: 5, windowMs: 10 * MINUTE }),
  /** Successful logins per account (each one writes a session). Created only after a correct password. */
  loginSuccess: (id: string): Limit => ({ key: `login-ok:${id}`, max: 30, windowMs: HOUR, account: id }),
  /** Failures from one known device (its own bucket instead of the identifier's). Device ids come from signed cookies. */
  loginDevice: (device: string): Limit => ({ key: `login-device:${device}`, max: 10, windowMs: 15 * MINUTE }),
  /** Signals, never refusals: 3 failures for an identifier or from an address (/64, or 15 from its /48) need proof-of-work. */
  loginFailAccount: (id: string): Limit => ({ key: `login:fail:account:${id}`, max: 3, windowMs: 15 * MINUTE, quiet: true }),
  loginFailIp: (ip: string): Limit => addressLimit("login:fail", ip, 3, 15 * MINUTE, { quiet: true }),
  /** Signal, never a refusal: the daily identifier ceiling raises difficulty like `loginAccount` (own namespace, E1). */
  loginAccountDay: (id: string): Limit => ({ key: `login-day:${id}`, max: 200, windowMs: 24 * HOUR, quiet: true }),
  /** `GET /api/github/start` for sign-in/sign-up (no session): per client address. */
  githubStartIp: (ip: string): Limit => addressLimit("github:start", ip, 20, 10 * MINUTE),
  /** Workflow webhook / resume calls (anonymous callers): per client address, and per workflow once the token matched. */
  hookIp: (ip: string): Limit => addressLimit("hook", ip, envInt("KNIFE_WF_HOOK_IP_PER_MIN", 300), MINUTE),
  hookWorkflow: (key: string): Limit => ({ key: `hook-wf:${key}`, max: envInt("KNIFE_WF_HOOK_PER_MIN", 120), windowMs: MINUTE }),
  /** Runs started by triggers (schedule, webhook, resume) per account. */
  workflowRuns: (id: string): Limit => ({ key: `wf-runs:${id}`, max: envInt("KNIFE_WF_RUNS_PER_HOUR", 1000), windowMs: HOUR, account: id }),
};
