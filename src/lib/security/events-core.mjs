// Security event log, the implementation behind src/lib/security/events.ts (the typed API every module calls). Plain
// JavaScript because the abuse-guard preload (scripts/abuse-guard.mjs) records events before any TS loader runs; one state
// per process on globalThis, so the preload's copy and the copy bundled into the Next server share a buffer, a ring of
// recent events and the listeners.
// Files: `$KNIFE_DATA_DIR/security/events-YYYY-MM-DD.jsonl` (dir 0700, files 0600, one file per UTC day, 30 days kept;
// a `events.jsonl` from older builds is renamed `events-<its day>.legacy.jsonl` and ages out the same way).
// Threat model: an attacker can make the app log as fast as it can send requests, so recording never blocks or throws:
// identical events are coalesced (one line with a count), buffered, appended asynchronously, and dropped (counted, then
// reported once) when the buffer is full; every field is length-capped and stripped of control characters, and client
// addresses are reduced to their prefix. Tests: tests/security_events.test.mjs.
import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { appendFile, mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { addressBuckets } from "../net/client-ip.mjs";

/** Known event kinds (documented in src/lib/security/events.ts). `mail_<anything>` is accepted too; the rest is `other`. */
export const SECURITY_EVENT_KINDS = [
  "rate_block",
  "scanner_block",
  "login_lockout",
  "pow_fail",
  "hash_busy",
  "pending_full",
  "oauth_flow_full",
  "github_app_access_lost",
  "quota_full",
  "queue_full",
  "outbound_refused",
  "outbound_budget",
  "tool_timeout",
  "mail_budget",
  "mail_suppressed",
  "register_surge",
  "disk_low",
  "unblock",
  "other",
];
const KINDS = new Set(SECURITY_EVENT_KINDS);
const MAIL_KIND = /^mail_[a-z0-9_]{1,40}$/;

const RETENTION_DAYS = 30;
const MAX_BUFFER = 2_000; // pending lines before new events are dropped
const RING = 500; // recent events kept in memory for the admin view
const FLUSH_MS = 1_000;
const RING_LOAD_BYTES = 256 * 1024; // per file, when the admin view first loads history
const FILE = /^events-(\d{4}-\d{2}-\d{2})(?:\.legacy)?\.jsonl$/;
const DETAIL_KEYS = 8;

const KEY = Symbol.for("samurai-knife.security-events.v2");

function freshState() {
  return { buffer: [], pending: new Map(), ring: [], dropped: 0, timer: null, flushing: null, listeners: new Set(), history: null, prunedDay: "" };
}

function state() {
  const holder = /** @type {Record<symbol, any>} */ (globalThis);
  const current = holder[KEY];
  if (!current || !Array.isArray(current.buffer) || !(current.pending instanceof Map) || !(current.listeners instanceof Set)) holder[KEY] = freshState();
  return holder[KEY];
}

/** `$KNIFE_DATA_DIR/security` (not created). */
export function securityDir(/** @type {Record<string, string | undefined>} */ env = process.env) {
  const base = env.KNIFE_DATA_DIR?.trim() || join(homedir(), ".local", "share", "samurai-knife");
  return join(base, "security");
}

/** Creates the security dir (0700) synchronously and returns it (process exit, startup only). */
export function ensureSecurityDir() {
  const dir = securityDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // not ours (shared mount): best effort
  }
  return dir;
}

/** @param {unknown} value @param {number} max */
function text(value, max) {
  if (value === undefined || value === null || value === "") return undefined;
  const out = String(value).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
  return out || undefined;
}

/** A string detail, or a flat record of at most 8 short scalar fields (never nested, never long). */
function cleanDetail(/** @type {unknown} */ detail) {
  if (detail === undefined || detail === null) return undefined;
  if (typeof detail !== "object" || Array.isArray(detail)) return text(detail, 200);
  /** @type {Record<string, string | number | boolean>} */
  const out = {};
  let kept = 0;
  for (const [name, value] of Object.entries(detail)) {
    if (kept >= DETAIL_KEYS) break;
    if (!/^[A-Za-z0-9_]{1,32}$/.test(name)) continue;
    if (typeof value === "string") {
      const cleaned = text(value, 120);
      if (cleaned === undefined) continue;
      out[name] = cleaned;
    } else if (typeof value === "number" && Number.isFinite(value)) out[name] = value;
    else if (typeof value === "boolean") out[name] = value;
    else continue;
    kept += 1;
  }
  return kept ? out : undefined;
}

/** `rate-block`, `Rate_Block` -> `rate_block`; unknown kinds become `other` with the original as `label`. */
function cleanKind(/** @type {unknown} */ raw) {
  const kind = String(raw ?? "").trim().toLowerCase().replace(/[-\s.]+/g, "_").slice(0, 48);
  if (KINDS.has(kind) || MAIL_KIND.test(kind)) return { kind };
  return { kind: "other", label: text(kind, 48) };
}

/**
 * The stored shape of any accepted input (see events.ts `SecurityEventInput`; `type`, `accountId` and `ip` are accepted
 * aliases of `kind`, `account` and `ipPrefix`).
 * @param {Record<string, any>} input
 */
export function normalizeSecurityEvent(input) {
  const { kind, label } = cleanKind(input?.kind ?? input?.type);
  const rawIp = input?.ipPrefix ?? input?.ip;
  const ipPrefix = typeof rawIp === "string" && rawIp.trim() ? addressBuckets(rawIp).narrow : undefined;
  const rawPath = typeof input?.path === "string" ? input.path.split("?")[0] : input?.path;
  const event = {
    ts: typeof input?.ts === "string" && !Number.isNaN(Date.parse(input.ts)) ? new Date(input.ts).toISOString() : new Date().toISOString(),
    kind,
    label,
    ipPrefix: text(ipPrefix, 64),
    account: text(input?.account ?? input?.accountId, 64),
    credHash: text(input?.credHash, 32),
    path: text(rawPath, 200),
    status: Number.isInteger(input?.status) ? input.status : undefined,
    count: Number.isInteger(input?.count) && input.count > 0 ? Math.min(input.count, 1e9) : 1,
    detail: cleanDetail(input?.detail),
  };
  for (const name of Object.keys(event)) if (event[name] === undefined) delete event[name];
  return event;
}

// -- writing ---------------------------------------------------------------------------------------------------------

async function prune(dir, today) {
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
  try {
    for (const name of await readdir(dir)) {
      const match = FILE.exec(name);
      if (match && match[1] < cutoff) await unlink(join(dir, name)).catch(() => undefined);
    }
  } catch {
    // best effort
  }
}

/** The single `events.jsonl` of older builds becomes a dated legacy file, so retention covers it. */
async function adoptLegacy(dir) {
  const legacy = join(dir, "events.jsonl");
  try {
    const info = await stat(legacy);
    await rename(legacy, join(dir, `events-${new Date(info.mtimeMs).toISOString().slice(0, 10)}.legacy.jsonl`));
  } catch {
    // none
  }
}

function takeBatch(s) {
  const batch = s.buffer;
  s.buffer = [];
  s.pending = new Map();
  if (s.dropped > 0) {
    batch.push(normalizeSecurityEvent({ kind: "quota_full", detail: `security log buffer full: ${s.dropped} event(s) dropped` }));
    s.dropped = 0;
  }
  const byDay = new Map();
  for (const event of batch) {
    const day = event.ts.slice(0, 10);
    byDay.set(day, `${byDay.get(day) ?? ""}${JSON.stringify(event)}\n`);
  }
  return byDay;
}

async function flushNow(s) {
  if (s.buffer.length === 0 && s.dropped === 0) return;
  const byDay = takeBatch(s);
  try {
    const dir = securityDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const today = new Date().toISOString().slice(0, 10);
    if (s.prunedDay !== today) {
      s.prunedDay = today;
      await adoptLegacy(dir);
      await prune(dir, today);
    }
    for (const [day, lines] of byDay) await appendFile(join(dir, `events-${day}.jsonl`), lines, { mode: 0o600 });
  } catch (error) {
    console.error(`[security] event log write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function schedule(s) {
  if (s.timer || s.flushing) return;
  s.timer = setTimeout(() => {
    s.timer = null;
    s.flushing = flushNow(s).finally(() => {
      s.flushing = null;
      if (s.buffer.length || s.dropped) schedule(s);
    });
  }, FLUSH_MS);
  s.timer.unref?.();
  const flags = /** @type {Record<symbol, any>} */ (globalThis);
  const hooked = Symbol.for("samurai-knife.security-events.exit-hook");
  if (!flags[hooked]) {
    flags[hooked] = true;
    // Whatever is still buffered when the process exits is written synchronously (bounded by MAX_BUFFER lines).
    process.once("exit", () => {
      const left = state();
      if (left.buffer.length === 0 && left.dropped === 0) return;
      try {
        const dir = ensureSecurityDir();
        for (const [day, lines] of takeBatch(left)) appendFileSync(join(dir, `events-${day}.jsonl`), lines, { mode: 0o600 });
      } catch {
        // exiting anyway
      }
    });
  }
}

/**
 * Records one security event; never throws, never blocks. Identical events (kind, client prefix, account, path, status,
 * detail) waiting for the same flush are merged into one line whose `count` grows.
 * @param {Record<string, any>} input
 */
export function recordSecurityEvent(input) {
  try {
    const s = state();
    const event = normalizeSecurityEvent(input);
    const key = [event.kind, event.label, event.ipPrefix, event.account, event.credHash, event.path, event.status, JSON.stringify(event.detail ?? null)].join("\u0001");
    const waiting = s.pending.get(key);
    if (waiting) {
      waiting.count = Math.min(1e9, waiting.count + event.count);
    } else if (s.buffer.length >= MAX_BUFFER) {
      s.dropped += 1;
      return;
    } else {
      s.pending.set(key, event);
      s.buffer.push(event);
      s.ring.push(event);
      if (s.ring.length > RING) s.ring.splice(0, s.ring.length - RING);
    }
    for (const listener of s.listeners) {
      try {
        listener(waiting ?? event);
      } catch {
        // a listener never breaks recording
      }
    }
    schedule(s);
  } catch {
    // recording must never break the request that triggered it
  }
}

// -- reading ---------------------------------------------------------------------------------------------------------

/** Last `maxBytes` of a file as complete lines (bounded read, never the whole file). */
async function tailLines(path, maxBytes) {
  let handle;
  try {
    handle = await open(path, "r");
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    if (size > length) lines.shift();
    return lines.filter(Boolean);
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Loads the tail of the two newest day files into the ring once (asynchronously, bounded), so the admin view survives a
 * restart. Resolves when done; later calls return the same promise.
 */
export function loadSecurityHistory() {
  const s = state();
  s.history ??= (async () => {
    let files = [];
    try {
      files = (await readdir(securityDir())).filter((name) => FILE.test(name)).sort().slice(-2);
    } catch {
      return;
    }
    const loaded = [];
    for (const name of files) {
      for (const line of await tailLines(join(securityDir(), name), RING_LOAD_BYTES)) {
        try {
          const event = JSON.parse(line);
          if (event && typeof event.kind === "string" && typeof event.ts === "string") loaded.push(normalizeSecurityEvent(event));
        } catch {
          // a torn line: skip
        }
      }
    }
    // Events this process already flushed are in the files too: keep the in-memory copy.
    const seen = new Set(s.ring.map((event) => JSON.stringify(event)));
    s.ring = [...loaded.filter((event) => !seen.has(JSON.stringify(event))), ...s.ring].slice(-RING);
  })();
  return s.history;
}

/** Most recent events in memory, newest last (at most 500). */
export function recentSecurityEvents(limit = RING) {
  const s = state();
  return s.ring.slice(-Math.max(0, Math.min(limit, RING))).map((event) => ({ ...event }));
}

/** Called with every recorded (or merged) event, in-process; returns an unsubscribe function. */
export function onSecurityEvent(listener) {
  const s = state();
  s.listeners.add(listener);
  return () => s.listeners.delete(listener);
}

/** Writes everything buffered now (tests, shutdown). */
export async function flushSecurityEvents() {
  const s = state();
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  if (s.flushing) await s.flushing;
  await flushNow(s);
}

/** Tests only: forget the in-memory state (buffer, ring, listeners). */
export function resetSecurityEventsForTests() {
  const s = state();
  if (s.timer) clearTimeout(s.timer);
  /** @type {Record<symbol, any>} */ (globalThis)[KEY] = freshState();
}
