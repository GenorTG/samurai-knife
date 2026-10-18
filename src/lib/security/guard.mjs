// The abuse guard: request budgets, scanner scoring and escalating blocks, decided before Next routes anything
// (installed by scripts/abuse-guard.mjs, a preload; docs/ACCOUNTS.md "Abuse guard").
// Threat model: an unauthenticated client (a scanner, a flood, someone's LLM agent probing every endpoint) can send as many
// requests as its links allow, from a whole IPv6 /64 or /48, with fresh cookies on every request. So: every client prefix
// (IPv4 /32, IPv6 /64, plus the /48) and every credential (opaque hash of the session cookie or Authorization header) has
// sliding-window budgets per route class; failures (4xx on distinct API paths, probe paths, refused budgets) add to a
// decaying score that blocks the prefix (15 min -> 1 h -> 24 h); the client tables are bounded and, when full, drop idle
// clients and then the least recently seen one (a full table must never turn every new visitor away); blocks live in their
// own bounded table and survive restarts (`$KNIFE_DATA_DIR/security/blocks.json`). Signed-in administrators are never
// blocked but stay budgeted (4x). Private mode (the owner's Tailscale toolbox) never blocks and has 10x budgets. The office
// Document Server's calls to `/api/office/ds/*` (JWT-authenticated, from the container's address) are never scored.
// Plain JavaScript, no dependencies; tests/abuse_guard.test.mjs.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync } from "node:fs";
import { writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { addressBuckets } from "../net/client-ip.mjs";
import { recordSecurityEvent, securityDir } from "./events-core.mjs";

const MIN = 60_000;
const HOUR = 60 * MIN;
const IDLE_MS = 10 * MIN;

export const GUARD_KEY = Symbol.for("samurai-knife.abuse-guard.v1");

/** The guard installed in this process (scripts/abuse-guard.mjs), or null. */
export function currentGuard() {
  const guard = /** @type {Record<symbol, any>} */ (globalThis)[GUARD_KEY];
  return guard && typeof guard.snapshot === "function" ? guard : null;
}

/** Same rule as src/lib/accounts/mode.ts: anything but empty/`private` is public; an empty mode with KNIFE_PUBLIC_URL too. */
export function guardMode(/** @type {Record<string, string | undefined>} */ env = process.env) {
  const value = env.KNIFE_AUTH_MODE?.trim().toLowerCase();
  if (!value) return env.KNIFE_PUBLIC_URL?.trim() ? "public" : "private";
  return value === "private" ? "private" : "public";
}

/**
 * Budgets per route class. Calibrated against a heavy real user (3 tabs, the UI poll every 1.5 s, the CV studio poll
 * every 2 s, the assistant running: about 150-200 /api requests a minute; tests/abuse_guard.test.mjs replays that).
 * `scale` multiplies every budget and the block threshold (KNIFE_GUARD_SCALE: test servers that replay many users from
 * one address); private mode multiplies the budgets by 10 on top.
 */
export function guardPolicy({ mode = "public", scale = 1 } = {}) {
  const k = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const f = (mode === "public" ? 1 : 10) * k;
  const n = (value) => Math.max(1, Math.round(value * f));
  return {
    mode,
    block: mode === "public",
    budgets: {
      // per client prefix
      api: { max: n(600), windowMs: MIN },
      apiBurst: { max: n(150), windowMs: 10_000 },
      auth: { max: n(30), windowMs: 10 * MIN },
      githubStart: { max: n(20), windowMs: 10 * MIN },
      // the office Document Server (one container address for every open document): JWT-checked, generous, never scored
      ds: { max: n(3_000), windowMs: MIN },
      pages: { max: n(1_200), windowMs: MIN },
      pagesBurst: { max: n(400), windowMs: 10_000 },
      // per credential
      credApi: { max: n(400), windowMs: MIN },
      credTool: { max: n(120), windowMs: MIN },
    },
    wideFactor: 5,
    adminFactor: 4,
    scoreThreshold: Math.max(1, Math.round(30 * k)),
    scoreWindowMs: MIN,
    blockLevelsMs: [15 * MIN, HOUR, 24 * HOUR],
    strikeMemoryMs: 7 * 24 * HOUR,
    wideBlockAfter: 4,
    maxClients: 100_000,
    maxCreds: 100_000,
    maxBlocks: 10_000,
    registerAlertPerHour: 50,
  };
}

// Paths only scanners ask for. Answered 404 at once (public mode) and scored +10.
const PROBE = /^\/(?:\.env|\.git|\.aws|\.ssh|\.svn|\.hg|\.ds_store|\.vscode|\.idea|wp-|wordpress|phpmyadmin|pma|myadmin|cgi-bin|actuator|server-status|server-info|vendor\/phpunit|boaform|hnap1|solr|console|manager\/html|owa|autodiscover|xmlrpc\.php|\S*\.php(?:$|\/)|\S*\.(?:asp|aspx|jsp|cgi)(?:$|\/))/i;
const AUTH = /^\/api\/account\/(?:register|forgot|resend|reset|verify|login)\/?$/;
const TOOL = /^\/api\/(?:mcp|agent\/tool)\/?$/;
const DS = /^\/api\/office\/ds\//;
const SCORED_STATUS = new Set([400, 401, 403, 404, 405, 413, 415, 422]);

/** Route class of a path: `auth`, `github`, `tool`, `ds` (office Document Server callbacks), `api` or `page`. */
export function routeClass(/** @type {string} */ path) {
  if (AUTH.test(path)) return "auth";
  if (DS.test(path)) return "ds";
  if (path === "/api/github/start" || path === "/api/github/start/") return "github";
  if (TOOL.test(path)) return "tool";
  if (path === "/api" || path.startsWith("/api/")) return "api";
  return "page";
}

export const isProbePath = (/** @type {string} */ path) => PROBE.test(path);

/** Sliding-window counter (two fixed windows, weighted): O(1) memory per key. */
function take(state, name, budget, now, cost = 1) {
  let counter = state[name];
  if (!counter) counter = state[name] = { start: now, prev: 0, cur: 0 };
  const elapsed = now - counter.start;
  if (elapsed >= budget.windowMs) {
    const windows = Math.floor(elapsed / budget.windowMs);
    counter.prev = windows === 1 ? counter.cur : 0;
    counter.cur = 0;
    counter.start += windows * budget.windowMs;
  }
  const weight = 1 - (now - counter.start) / budget.windowMs;
  const estimate = counter.prev * weight + counter.cur;
  if (estimate + cost > budget.max) {
    // Seconds until the estimate drops below the limit (at most one window).
    const retry = counter.prev > 0 ? Math.ceil(((estimate + cost - budget.max) / counter.prev) * budget.windowMs / 1000) : Math.ceil((counter.start + budget.windowMs - now) / 1000);
    return Math.max(1, Math.min(retry, Math.ceil(budget.windowMs / 1000)));
  }
  counter.cur += cost;
  return 0;
}

const scaled = (budget, factor) => (factor === 1 ? budget : { max: budget.max * factor, windowMs: budget.windowMs });

/** Opaque credential key: hash of the session cookie or the Authorization header (never stored or logged raw). */
export function credentialHash(/** @type {{ cookie?: string | string[], authorization?: string | string[] }} */ headers, cookieName = "knife_session") {
  const auth = [headers.authorization].flat()[0];
  if (auth && String(auth).trim()) return createHash("sha256").update(`a:${String(auth).trim()}`).digest("hex").slice(0, 32);
  const cookie = [headers.cookie].flat().join(";");
  for (const part of cookie.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === cookieName) {
      const value = part.slice(index + 1).trim();
      if (value) return createHash("sha256").update(`c:${value}`).digest("hex").slice(0, 32);
    }
  }
  return null;
}

/**
 * The guard state machine. `check()` decides a request before it reaches the app; `observe()` scores its answer.
 * Both are synchronous and allocation-light. Persisted state: blocks + strikes.
 */
export class AbuseGuard {
  constructor({ policy = guardPolicy(), dataDir = null, now = () => Date.now(), persist = true } = {}) {
    this.policy = policy;
    this.now = now;
    this.persistPath = persist ? join(dataDir ?? securityDir(), "blocks.json") : null;
    /** prefix key -> {last, budgets, score, scoreStart, seen} */
    this.clients = new Map();
    /** credential hash -> {last, budgets, admin} */
    this.creds = new Map();
    /** prefix key -> {until, level, reason, at} */
    this.blocks = new Map();
    /** prefix key -> {count, last} (escalation memory) */
    this.strikes = new Map();
    /** wide prefix -> Map(narrow -> at): distinct /64 blocks under one /48 */
    this.wideHits = new Map();
    this.stats = { refused: 0, blocked: 0, evicted: 0 };
    this.registrations = { start: now(), count: 0, alerted: false };
    this.lastSweep = 0;
    this.saveTimer = null;
    this.load();
  }

  // -- tables ------------------------------------------------------------------------------------------------------

  sweep(now, force = false) {
    if (!force && now - this.lastSweep < 1_000) return;
    this.lastSweep = now;
    // Idle = no request for 10 min (longer than every budget window but auth's, whose counter then restarts). A score
    // older than its window is worth nothing (observe() would reset it), so it never keeps an idle client alive.
    for (const [key, entry] of this.clients) if (now - entry.last > IDLE_MS && (entry.score === 0 || now - entry.scoreStart > this.policy.scoreWindowMs)) this.clients.delete(key);
    for (const [key, entry] of this.creds) if (now - entry.last > IDLE_MS && !entry.admin) this.creds.delete(key);
    for (const [key, entry] of this.creds) if (entry.admin && entry.adminUntil < now) this.creds.delete(key);
    let changed = false;
    for (const [key, block] of this.blocks) if (block.until <= now) {
      this.blocks.delete(key);
      changed = true;
    }
    for (const [key, strike] of this.strikes) if (now - strike.last > this.policy.strikeMemoryMs) {
      this.strikes.delete(key);
      changed = true;
    }
    for (const [wide, hits] of this.wideHits) {
      for (const [narrow, at] of hits) if (now - at > 24 * HOUR) hits.delete(narrow);
      if (hits.size === 0) this.wideHits.delete(wide);
    }
    if (changed) this.scheduleSave();
  }

  /**
   * The record for a client prefix (touched: the map is kept in least-recently-seen order). A full table first drops
   * idle clients, then evicts the least recently seen one, preferring one without a live score: it never refuses a new
   * client (the old fail-closed table answered 429 to every newcomer for good once 100k idle scored clients piled up).
   * Blocks are a separate table, so evicting a client never lifts its block.
   */
  client(key, now) {
    let entry = this.clients.get(key);
    if (entry) {
      this.clients.delete(key);
      this.clients.set(key, entry);
      entry.last = now;
      return entry;
    }
    if (this.clients.size >= this.policy.maxClients) {
      this.sweep(now);
      if (this.clients.size >= this.policy.maxClients) this.evictClient(now);
    }
    entry = { last: now, budgets: {}, score: 0, scoreStart: now, seen: new Set() };
    this.clients.set(key, entry);
    return entry;
  }

  evictClient(now) {
    let scanned = 0;
    let victim = null;
    for (const [key, entry] of this.clients) {
      victim ??= key;
      if (entry.score === 0 || now - entry.scoreStart > this.policy.scoreWindowMs) {
        victim = key;
        break;
      }
      if (++scanned >= 64) break;
    }
    if (victim !== null) {
      this.clients.delete(victim);
      this.stats.evicted += 1;
    }
  }

  /** The record for a credential; when the table is full a new credential is simply not budgeted (its prefix still is). */
  cred(key, now) {
    let entry = this.creds.get(key);
    if (entry) {
      entry.last = now;
      return entry;
    }
    if (this.creds.size >= this.policy.maxCreds) {
      this.sweep(now);
      if (this.creds.size >= this.policy.maxCreds) return null;
    }
    entry = { last: now, budgets: {}, admin: false, adminUntil: 0 };
    this.creds.set(key, entry);
    return entry;
  }

  /** The app marks a credential that resolved to an administrator (src/lib/security/guard-bridge.ts). */
  markAdmin(credHash, ttlMs = 30 * MIN) {
    if (typeof credHash !== "string" || !/^[0-9a-f]{32}$/.test(credHash)) return;
    const now = this.now();
    const entry = this.cred(credHash, now);
    if (!entry) return;
    entry.admin = true;
    entry.adminUntil = now + ttlMs;
    entry.last = now;
  }

  isAdmin(credHash, now) {
    if (!credHash) return false;
    const entry = this.creds.get(credHash);
    return Boolean(entry?.admin && entry.adminUntil > now);
  }

  blockedFor(keys, now) {
    let until = 0;
    for (const key of keys) {
      const block = this.blocks.get(key);
      if (block && block.until > now) until = Math.max(until, block.until);
    }
    return until;
  }

  // -- decisions ---------------------------------------------------------------------------------------------------

  /**
   * Decides a request. `input`: {address, path, method, credHash, office}. Returns {ok:true, ctx} or
   * {ok:false, status, retryAfter, reason, ctx}. `ctx` goes back into observe().
   */
  check({ address, path, method = "GET", credHash = null, office = false }) {
    const now = this.now();
    const { narrow, wide, family } = addressBuckets(address || "unknown");
    const keys = family === 6 ? [narrow, wide] : [narrow];
    const admin = this.isAdmin(credHash, now);
    const cls = office ? "office" : routeClass(path);
    const ctx = { narrow, wide: family === 6 ? wide : null, cls, path, method, credHash, admin, refusedByGuard: false };

    if (this.policy.block && !admin) {
      const until = this.blockedFor(keys, now);
      if (until) {
        this.stats.blocked += 1;
        return { ok: false, status: 429, retryAfter: Math.max(1, Math.ceil((until - now) / 1000)), reason: "blocked", ctx };
      }
    }
    if (office) return { ok: true, ctx };
    if (this.policy.block && !admin && isProbePath(path)) {
      this.client(narrow, now);
      return { ok: false, status: 404, retryAfter: 0, reason: "probe", ctx };
    }

    const factor = admin ? this.policy.adminFactor : 1;
    const b = this.policy.budgets;
    const prefixBudgets = cls === "page" ? [["pages", b.pages], ["pagesBurst", b.pagesBurst]] : cls === "ds" ? [["ds", b.ds]] : [["api", b.api], ["apiBurst", b.apiBurst]];
    if (cls === "auth") prefixBudgets.push(["auth", b.auth]);
    if (cls === "github") prefixBudgets.push(["githubStart", b.githubStart]);

    const narrowEntry = this.client(narrow, now);
    const wideEntry = ctx.wide ? this.client(ctx.wide, now) : null;

    let retry = 0;
    let which = "";
    for (const [name, budget] of prefixBudgets) {
      const r = take(narrowEntry.budgets, name, scaled(budget, factor), now);
      if (r > retry) [retry, which] = [r, name];
      if (wideEntry) {
        const w = take(wideEntry.budgets, name, scaled(budget, factor * this.policy.wideFactor), now);
        if (w > retry) [retry, which] = [w, `${name}/48`];
      }
    }
    if (credHash && cls !== "page" && cls !== "ds") {
      const credEntry = this.cred(credHash, now);
      if (credEntry) {
        const r = take(credEntry.budgets, "credApi", scaled(b.credApi, factor), now);
        if (r > retry) [retry, which] = [r, "credential"];
        if (cls === "tool") {
          const t = take(credEntry.budgets, "credTool", scaled(b.credTool, factor), now);
          if (t > retry) [retry, which] = [t, "credential/tools"];
        }
      }
    }
    if (retry > 0) {
      this.stats.refused += 1;
      ctx.refusedByGuard = true;
      return { ok: false, status: 429, retryAfter: retry, reason: `budget:${which}`, ctx };
    }
    return { ok: true, ctx };
  }

  /** Scores the answer to a request (status code) and blocks the prefix when its score passes the threshold. */
  observe(ctx, status) {
    if (!ctx || !this.policy.block || ctx.admin || ctx.cls === "office" || ctx.cls === "ds") return;
    const now = this.now();
    const entry = this.clients.get(ctx.narrow);
    if (!entry) return;
    if (now - entry.scoreStart > this.policy.scoreWindowMs) {
      entry.score = 0;
      entry.scoreStart = now;
      entry.seen.clear();
    }
    let points = 0;
    if (isProbePath(ctx.path)) points = 10;
    else if (ctx.refusedByGuard) points = 0.5;
    else if (ctx.cls === "auth" && status >= 400 && status < 500) points = 1; // every failed sign-in / flood attempt
    else if (status === 429) points = 1; // a route-level limit refused it
    else if (SCORED_STATUS.has(status) && !(status === 401 && ctx.method === "GET" && ctx.path === "/api/account")) {
      if (ctx.cls !== "page" || status === 404) {
        // Distinct failures only: a tab polling the same route (signed out, 401 every 1.5 s) never adds up.
        const seenKey = `${status} ${ctx.method} ${ctx.path.slice(0, 200)}`;
        if (!entry.seen.has(seenKey)) {
          if (entry.seen.size < 256) entry.seen.add(seenKey);
          points = 1;
        }
      }
    }
    if (ctx.cls === "auth" && ctx.method === "POST" && ctx.path.startsWith("/api/account/register") && status >= 200 && status < 300) this.countRegistration(now);
    if (!points) return;
    entry.score += points;
    if (entry.score >= this.policy.scoreThreshold) {
      entry.score = 0;
      entry.seen.clear();
      this.block(ctx.narrow, "scanner", now, ctx.wide);
    }
  }

  countRegistration(now) {
    const r = this.registrations;
    if (now - r.start > HOUR) Object.assign(r, { start: now, count: 0, alerted: false });
    r.count += 1;
    if (!r.alerted && r.count > this.policy.registerAlertPerHour) {
      r.alerted = true;
      recordSecurityEvent({ kind: "register_surge", count: r.count, detail: `more than ${this.policy.registerAlertPerHour} registrations within an hour` });
    }
  }

  /** Blocks a prefix at the next escalation level; IPv6 /64 blocks pile up on their /48 and block it too. */
  block(key, reason, now = this.now(), wide = null) {
    const strike = this.strikes.get(key) ?? { count: 0, last: now };
    const levels = this.policy.blockLevelsMs;
    const level = Math.min(strike.count, levels.length - 1);
    strike.count += 1;
    strike.last = now;
    this.strikes.set(key, strike);
    if (this.blocks.size >= this.policy.maxBlocks && !this.blocks.has(key)) {
      this.sweep(now, true);
      if (this.blocks.size >= this.policy.maxBlocks) {
        // Keep the longest blocks: drop the one ending soonest.
        let soonest = null;
        for (const [k, b] of this.blocks) if (!soonest || b.until < soonest[1].until) soonest = [k, b];
        if (soonest) this.blocks.delete(soonest[0]);
      }
    }
    const until = now + levels[level];
    this.blocks.set(key, { until, level, reason, at: now });
    const duration = levels[level] >= HOUR ? `${levels[level] / HOUR}h` : `${levels[level] / MIN}m`;
    recordSecurityEvent({ kind: "scanner_block", ipPrefix: key, detail: `${reason}: blocked ${duration} (level ${level + 1})` });
    if (wide && wide !== key) {
      let hits = this.wideHits.get(wide);
      if (!hits) {
        if (this.wideHits.size >= this.policy.maxBlocks) this.sweep(now, true);
        hits = new Map();
        if (this.wideHits.size < this.policy.maxBlocks) this.wideHits.set(wide, hits);
      }
      hits.set(key, now);
      if (hits.size >= this.policy.wideBlockAfter && !(this.blocks.get(wide)?.until > now)) {
        hits.clear();
        this.block(wide, `${this.policy.wideBlockAfter} blocked /64s in this /48`, now);
      }
    }
    this.scheduleSave();
    return { until, level };
  }

  /** Lifts a block (admin action). Also forgets its strikes. True when something was removed. */
  unblock(key) {
    const had = this.blocks.delete(key);
    this.strikes.delete(key);
    this.wideHits.delete(key);
    const entry = this.clients.get(key);
    if (entry) Object.assign(entry, { score: 0, budgets: {} });
    if (had) this.scheduleSave();
    return had;
  }

  snapshot() {
    const now = this.now();
    this.sweep(now);
    const blocks = [...this.blocks].filter(([, b]) => b.until > now).map(([key, b]) => ({
      key,
      until: new Date(b.until).toISOString(),
      since: new Date(b.at).toISOString(),
      level: b.level + 1,
      reason: b.reason,
      strikes: this.strikes.get(key)?.count ?? 1,
    })).sort((a, b) => (a.until < b.until ? 1 : -1));
    return {
      mode: this.policy.mode,
      blocking: this.policy.block,
      blocks,
      tables: { clients: this.clients.size, credentials: this.creds.size, blocks: this.blocks.size, maxClients: this.policy.maxClients, maxBlocks: this.policy.maxBlocks },
      counters: { ...this.stats },
      budgets: this.policy.budgets,
    };
  }

  // -- persistence -------------------------------------------------------------------------------------------------

  load() {
    if (!this.persistPath) return;
    try {
      const parsed = JSON.parse(readFileSync(this.persistPath, "utf8"));
      if (parsed?.v !== 1) return;
      const now = this.now();
      for (const row of (Array.isArray(parsed.blocks) ? parsed.blocks : []).slice(0, this.policy.maxBlocks)) {
        if (!Array.isArray(row)) continue;
        const [key, until, level, reason, at] = row;
        if (typeof key === "string" && key.length <= 64 && Number.isFinite(until) && until > now && Number.isInteger(level)) {
          this.blocks.set(key, { until, level, reason: String(reason ?? "").slice(0, 120), at: Number.isFinite(at) ? at : now });
        }
      }
      for (const row of (Array.isArray(parsed.strikes) ? parsed.strikes : []).slice(0, this.policy.maxBlocks * 4)) {
        if (!Array.isArray(row)) continue;
        const [key, count, last] = row;
        if (typeof key === "string" && key.length <= 64 && Number.isInteger(count) && Number.isFinite(last) && now - last <= this.policy.strikeMemoryMs) {
          this.strikes.set(key, { count, last });
        }
      }
    } catch {
      // no file yet / damaged: start empty
    }
  }

  serialize() {
    return JSON.stringify({
      v: 1,
      savedAt: new Date(this.now()).toISOString(),
      blocks: [...this.blocks].map(([key, b]) => [key, b.until, b.level, b.reason, b.at]),
      strikes: [...this.strikes].map(([key, s]) => [key, s.count, s.last]),
    });
  }

  scheduleSave() {
    if (!this.persistPath || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveAsync();
    }, 1_000);
    this.saveTimer.unref?.();
  }

  async saveAsync() {
    if (!this.persistPath) return;
    const temp = `${this.persistPath}.${process.pid}.tmp`;
    try {
      await mkdir(join(this.persistPath, ".."), { recursive: true, mode: 0o700 });
      await writeFile(temp, this.serialize(), { mode: 0o600 });
      await rename(temp, this.persistPath);
    } catch (error) {
      console.error(`[abuse-guard] saving blocks failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Synchronous save (process exit, tests). */
  saveNow() {
    if (!this.persistPath) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      const dir = join(this.persistPath, "..");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      const temp = `${this.persistPath}.${process.pid}.tmp`;
      writeFileSync(temp, this.serialize(), { mode: 0o600 });
      renameSync(temp, this.persistPath);
    } catch {
      // exiting anyway
    }
  }
}
