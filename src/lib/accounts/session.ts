import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ensureDataDir,
  findByIdentifier,
  getAccount,
  getDefaultAccount,
  mutateStore,
  writePrivateFile,
  type Account,
} from "@/lib/accounts/store";
import { HashBusyError, hashPasswordAsync, needsRehash, verifyPasswordAsync } from "@/lib/accounts/password";
import { isPublicMode } from "@/lib/accounts/mode";
import { clientIp, isHttps } from "@/lib/accounts/network";
import { checkLimits, clearLimit, consumeLimits, hitLimits, LIMITS, type Limit } from "@/lib/accounts/rate-limit";
import { knownDeviceFor } from "@/lib/accounts/known-device";
import { checkPow, type PowSolution } from "@/lib/accounts/pow";
import { clientPrefix } from "@/lib/accounts/ip-prefix";
import { recordSecurityEvent } from "@/lib/security/events";
import { publicBaseUrl, sendMail } from "@/lib/mail";
import { loginLockoutMail } from "@/lib/mail/templates";

export { clientIp, isHttps };

/**
 * Sessions are server-side records in `$KNIFE_DATA_DIR/sessions.json` (0600): the cookie holds 32 random bytes, the file
 * only their SHA-256, so a leaked data dir holds no usable cookie and any session can be revoked. A record also pins a
 * fingerprint of the password hash: a password set through the CLI ends every session without touching this file.
 * Written only by this server process (synchronously, so requests cannot interleave a read-modify-write). At most
 * MAX_SESSIONS_PER_ACCOUNT live per account (the oldest go first), and successful logins are rate-limited per account, so
 * one account cannot grow the file without bound.
 */
export const SESSION_COOKIE = "knife_session";
export const MAX_SESSIONS_PER_ACCOUNT = 20;
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const TOUCH_EVERY_MS = 10 * 60_000;

interface SessionRecord {
  hash: string;
  accountId: string;
  pf: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
}

interface SessionFile {
  version: 1;
  sessions: SessionRecord[];
}

function sessionsPath(): string {
  return join(ensureDataDir(), "sessions.json");
}

let cache: { mtimeMs: number; size: number; path: string; data: SessionFile } | null = null;

function isSessionRecord(value: unknown): value is SessionRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return ["hash", "accountId", "pf", "createdAt", "expiresAt", "lastSeenAt"].every((key) => typeof r[key] === "string");
}

function readSessions(): SessionFile {
  const path = sessionsPath();
  if (!existsSync(path)) return { version: 1, sessions: [] };
  const stat = statSync(path);
  if (cache && cache.path === path && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return cache.data;
  let data: SessionFile = { version: 1, sessions: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { sessions?: unknown };
    if (Array.isArray(raw.sessions)) data = { version: 1, sessions: raw.sessions.filter(isSessionRecord) };
  } catch {
    // Damaged file: every session is gone and users log in again; never a crash on every request.
  }
  cache = { mtimeMs: stat.mtimeMs, size: stat.size, path, data };
  return data;
}

function writeSessions(mutate: (sessions: SessionRecord[]) => SessionRecord[]): void {
  const now = Date.now();
  const next = mutate(readSessions().sessions.map((s) => ({ ...s }))).filter((s) => Date.parse(s.expiresAt) > now);
  writePrivateFile(sessionsPath(), `${JSON.stringify({ version: 1, sessions: next } satisfies SessionFile)}\n`);
  cache = null;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Short fingerprint so changing a password (also through the CLI) invalidates existing sessions. */
export function passwordFingerprint(account: Pick<Account, "passwordHash">): string {
  return createHash("sha256").update(account.passwordHash ?? "").digest("hex").slice(0, 12);
}

export function createSession(account: Account): string {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  writeSessions((sessions) => {
    const live = sessions.filter((s) => Date.parse(s.expiresAt) > now.getTime());
    const mine = live.filter((s) => s.accountId === account.id).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    // Room for the new one: the account's oldest sessions end first.
    const evict = new Set(mine.slice(0, Math.max(0, mine.length - (MAX_SESSIONS_PER_ACCOUNT - 1))).map((s) => s.hash));
    return [...live.filter((s) => !evict.has(s.hash)), {
      hash: hashToken(token),
      accountId: account.id,
      pf: passwordFingerprint(account),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1_000).toISOString(),
      lastSeenAt: now.toISOString(),
    }];
  });
  return token;
}

/**
 * The server rehashed a password with new parameters (same password): move the account's sessions to the new
 * fingerprint so nobody is signed out. Called synchronously right after the store write (no request can run between).
 */
function repinSessions(accountId: string, oldPf: string, newPf: string): void {
  if (oldPf === newPf || !readSessions().sessions.some((s) => s.accountId === accountId && s.pf === oldPf)) return;
  writeSessions((sessions) => sessions.map((s) => (s.accountId === accountId && s.pf === oldPf ? { ...s, pf: newPf } : s)));
}

export function revokeSessionToken(token: string | undefined): void {
  if (!token) return;
  const hash = hashToken(token);
  if (!readSessions().sessions.some((s) => s.hash === hash)) return;
  writeSessions((sessions) => sessions.filter((s) => s.hash !== hash));
}

/**
 * Ends every session of one account (password change/reset, disable, delete, "log out everywhere"); `exceptToken` keeps
 * the session of the browser that made the change (a confirmed email change signs out the other devices only).
 */
export function revokeAllSessions(accountId: string, exceptToken?: string): number {
  const keep = exceptToken ? hashToken(exceptToken) : null;
  const doomed = (s: SessionRecord) => s.accountId === accountId && s.hash !== keep;
  const count = readSessions().sessions.filter(doomed).length;
  if (count > 0) writeSessions((sessions) => sessions.filter((s) => !doomed(s)));
  return count;
}

export function sessionCount(accountId: string): number {
  const now = Date.now();
  return readSessions().sessions.filter((s) => s.accountId === accountId && Date.parse(s.expiresAt) > now).length;
}

export function cookieValue(request: Request, name: string = SESSION_COOKIE): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

/**
 * May this account act at all right now? Public mode also needs a way to sign in (a password, or a linked GitHub user:
 * "Sign in with GitHub" accounts have no password; unlinking is refused for them) and a verified address.
 */
export function accountUsable(account: Account, publicMode = isPublicMode()): boolean {
  if (account.status !== "active") return false;
  if (!publicMode) return true;
  return (Boolean(account.passwordHash) || account.github !== null) && account.emailVerifiedAt !== null && account.email !== null;
}

function accountFromToken(token: string): Account | null {
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return null;
  const hash = hashToken(token);
  const record = readSessions().sessions.find((s) => s.hash === hash);
  if (!record) return null;
  const now = Date.now();
  if (Date.parse(record.expiresAt) <= now) return null;
  const account = getAccount(record.accountId);
  if (!account || passwordFingerprint(account) !== record.pf || !accountUsable(account)) return null;
  if (now - Date.parse(record.lastSeenAt) > TOUCH_EVERY_MS) {
    writeSessions((sessions) => sessions.map((s) => (s.hash === hash ? { ...s, lastSeenAt: new Date(now).toISOString() } : s)));
  }
  return account;
}

/** Server components (no Request): the account behind a raw session cookie value, never the private-mode fallback. */
export function accountForSessionToken(token: string | undefined): Account | null {
  return token ? accountFromToken(token) : null;
}

/**
 * Valid session cookie, else (private mode only) the default account when it has no password (the tailnet boundary is the
 * auth), else null (caller answers 401). Public mode never falls back to any account.
 */
export function resolveAccount(request: Request): Account | null {
  const token = cookieValue(request);
  if (token) {
    const fromCookie = accountFromToken(token);
    if (fromCookie) return fromCookie;
  }
  if (isPublicMode()) return null;
  const fallback = getDefaultAccount();
  return fallback.passwordHash || fallback.status === "disabled" ? null : fallback;
}

/** SameSite=Strict in private mode (unchanged); Lax in public mode so a link from an email or another site arrives signed in. */
function cookieAttributes(request: Request, maxAge: number): string[] {
  const attributes = ["Path=/", "HttpOnly", `SameSite=${isPublicMode() ? "Lax" : "Strict"}`, `Max-Age=${maxAge}`];
  if (isHttps(request)) attributes.push("Secure");
  return attributes;
}

export function sessionCookieHeader(request: Request, token: string): string {
  return [`${SESSION_COOKIE}=${token}`, ...cookieAttributes(request, SESSION_MAX_AGE_SECONDS)].join("; ");
}

export function clearedCookieHeader(request: Request): string {
  return [`${SESSION_COOKIE}=`, ...cookieAttributes(request, 0)].join("; ");
}

/** New session for `account` on this browser: the request's old session (if any) is revoked first (rotation). */
export function rotateSession(request: Request, account: Account): string {
  revokeSessionToken(cookieValue(request));
  return sessionCookieHeader(request, createSession(account));
}

export type LoginResult =
  | { ok: true; account: Account }
  | {
    ok: false;
    reason: "invalid_credentials" | "rate_limited" | "email_not_verified" | "account_disabled" | "challenge_required" | "busy";
    retryAfterSeconds?: number;
    /** challenge_required: the difficulty to fetch a challenge for (`GET /api/account/challenge?form=login`). */
    bits?: number;
  };

export interface LoginOptions {
  /** The `knife_device` cookie (`known-device.ts`). */
  deviceCookie?: string;
  /** Proof-of-work, needed in public mode after failures (`pow.ts`). */
  pow?: PowSolution | null;
}

const LOCKOUT_MAIL_EVERY_MS = 24 * 60 * 60_000;
const LOCKOUT_MAIL_KEY = Symbol.for("samurai-knife.lockout-mail.v1");
const LOCKOUT_MAIL_MAX = 10_000;

/** The identifier's failure bucket just filled: log it, and tell the account owner (at most one mail per day). */
function onLockout(account: Account | undefined, ip: string): void {
  recordSecurityEvent({ kind: "login_lockout", account: account?.id, ipPrefix: clientPrefix(ip), detail: account ? undefined : "unknown identifier" });
  if (!account || account.status !== "active" || !account.email) return;
  const g = globalThis as unknown as Record<symbol, Map<string, number> | undefined>;
  const sent = (g[LOCKOUT_MAIL_KEY] ??= new Map());
  const now = Date.now();
  const last = sent.get(account.id);
  if (last !== undefined && now - last < LOCKOUT_MAIL_EVERY_MS) return;
  if (last === undefined && sent.size >= LOCKOUT_MAIL_MAX) {
    for (const [id, time] of sent) if (now - time >= LOCKOUT_MAIL_EVERY_MS) sent.delete(id);
    if (sent.size >= LOCKOUT_MAIL_MAX) return; // fewer notices rather than an unbounded map
  }
  sent.set(account.id, now);
  sendMail(account.email, loginLockoutMail(account.id, `${publicBaseUrl()}/forgot-password`));
}

/** Records the login and, when the stored hash uses old parameters, the rehash (sessions follow the new fingerprint). */
function recordLogin(account: Account, rehashed: string | null): Account {
  const oldPf = passwordFingerprint(account);
  const now = new Date().toISOString();
  const updated = mutateStore((store) => {
    const target = store.accounts.find((candidate) => candidate.id === account.id);
    if (!target) return account;
    target.lastLoginAt = now;
    // Only when nobody changed the password meanwhile (the CLI, a reset in another request).
    if (rehashed && target.passwordHash === account.passwordHash) target.passwordHash = rehashed;
    return target;
  });
  repinSessions(account.id, oldPf, passwordFingerprint(updated));
  return updated;
}

/**
 * Username (or, in public mode, email) + password. "Not verified"/"disabled" are only told to someone who knows the
 * password; every other failure is the same `invalid_credentials`. Rate limits count failures only:
 * - both modes: 5/min per identifier + address;
 * - public mode, unknown device: 5/min per identifier+address and 50/15 min per address (/64, 250 per /48) are hard
 *   ceilings; after 3 failures for the identifier or from the address, proof-of-work is required. A full 20/15 min or
 *   200/day identifier bucket, or the server-wide failed-login budget (`LIMITS.loginGlobal`, credential stuffing), raises
 *   difficulty instead of refusing, so strangers cannot keep the owner, or everyone, locked out;
 * - public mode, known device (`knife_device` cookie vouching for this account): only its own 10/15 min failure bucket,
 *   and a full rate-limit namespace never refuses it (`trusted`).
 * Successful logins: 30/h per account. Password hashing waits for the global hash budget (busy -> 503).
 */
export async function attemptLogin(identifier: string, password: string, ip: string, options: LoginOptions = {}): Promise<LoginResult> {
  const publicMode = isPublicMode();
  const key = identifier.trim().toLowerCase();
  const pair = LIMITS.loginPair(key, ip);
  const account = publicMode ? findByIdentifier(identifier) : getAccount(identifier);
  const device = publicMode && account?.passwordHash ? knownDeviceFor(options.deviceCookie, account.id, passwordFingerprint(account)) : null;

  let failBuckets: Limit[];
  let watchLockout = false;
  if (!publicMode) {
    failBuckets = [pair];
  } else if (device) {
    // This signed device bypasses every identifier/address failure bucket; only its own bounded bucket applies.
    failBuckets = [LIMITS.loginDevice(device)];
  } else {
    failBuckets = [pair, LIMITS.loginIp(ip), LIMITS.loginAccount(key), LIMITS.loginAccountDay(key), LIMITS.loginFailAccount(key), LIMITS.loginFailIp(ip), LIMITS.loginGlobal()];
    watchLockout = true;
  }
  // A signed device is vouched for: a rate-limit namespace filled by strangers never refuses it (rate-limit.ts, E1).
  const trust = { trusted: Boolean(device) };
  // Refusing buckets (the identifier buckets, the failure signals and the global budget are not among them).
  const blocking = !publicMode || device ? failBuckets : [pair, LIMITS.loginIp(ip)];
  const verdict = checkLimits(blocking, Date.now(), trust);
  if (!verdict.ok) return { ok: false, reason: "rate_limited", retryAfterSeconds: verdict.retryAfterSeconds };
  const lockedOut = watchLockout && !checkLimits([LIMITS.loginAccount(key)]).ok;
  const identifierDailyPressure = watchLockout && !checkLimits([LIMITS.loginAccountDay(key)]).ok;
  // Signals only (E2): like the identifier buckets, the global failed-login budget only makes proof-of-work required at
  // the raised difficulty; it never refuses a login by itself.
  const globalPressure = watchLockout && !checkLimits([LIMITS.loginGlobal()]).ok;
  if (watchLockout) {
    const needsPow = lockedOut || identifierDailyPressure || globalPressure || !checkLimits([LIMITS.loginFailAccount(key)]).ok || !checkLimits([LIMITS.loginFailIp(ip)]).ok;
    if (needsPow) {
      const pow = checkPow("login", ip, options.pow, { identifierUnderAttack: lockedOut || identifierDailyPressure || globalPressure });
      if (!pow.ok) return { ok: false, reason: pow.status === 503 ? "busy" : "challenge_required", bits: pow.bits, retryAfterSeconds: pow.retryAfterSeconds };
    }
  }

  let valid: boolean;
  try {
    // Passwordless accounts cannot be signed into (only the private-mode default is reachable, implicitly).
    valid = await verifyPasswordAsync(password, account?.passwordHash);
  } catch (error) {
    if (error instanceof HashBusyError) return { ok: false, reason: "busy", retryAfterSeconds: error.retryAfterSeconds };
    throw error;
  }
  if (!account || !valid) {
    hitLimits(failBuckets, Date.now(), trust);
    if (watchLockout && !lockedOut && !checkLimits([LIMITS.loginAccount(key)]).ok) onLockout(account, ip);
    return { ok: false, reason: "invalid_credentials" };
  }
  clearLimit(pair.key);
  if (account.status === "disabled") return { ok: false, reason: "account_disabled" };
  if (publicMode && (account.status === "pending" || account.emailVerifiedAt === null || account.email === null)) {
    return { ok: false, reason: "email_not_verified" };
  }
  const success = consumeLimits([LIMITS.loginSuccess(account.id)]);
  if (!success.ok) return { ok: false, reason: "rate_limited", retryAfterSeconds: success.retryAfterSeconds };
  let rehashed: string | null = null;
  if (needsRehash(account.passwordHash)) {
    try {
      rehashed = await hashPasswordAsync(password);
    } catch {
      // Busy: keep the old hash this time; the next login tries again.
    }
  }
  return { ok: true, account: recordLogin(account, rehashed) };
}
