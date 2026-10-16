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
import { verifyPasswordAsync } from "@/lib/accounts/password";
import { isPublicMode } from "@/lib/accounts/mode";
import { clientIp, isHttps } from "@/lib/accounts/network";
import { checkLimits, clearLimit, hitLimits, LIMITS, type Limit } from "@/lib/accounts/rate-limit";

export { clientIp, isHttps };

/**
 * Sessions are server-side records in `$KNIFE_DATA_DIR/sessions.json` (0600): the cookie holds 32 random bytes, the file
 * only their SHA-256, so a leaked data dir holds no usable cookie and any session can be revoked. A record also pins a
 * fingerprint of the password hash: a password set through the CLI ends every session without touching this file.
 * Written only by this server process (synchronously, so requests cannot interleave a read-modify-write).
 */
export const SESSION_COOKIE = "knife_session";
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
function passwordFingerprint(account: Account): string {
  return createHash("sha256").update(account.passwordHash ?? "").digest("hex").slice(0, 12);
}

export function createSession(account: Account): string {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  writeSessions((sessions) => [...sessions, {
    hash: hashToken(token),
    accountId: account.id,
    pf: passwordFingerprint(account),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1_000).toISOString(),
    lastSeenAt: now.toISOString(),
  }]);
  return token;
}

export function revokeSessionToken(token: string | undefined): void {
  if (!token) return;
  const hash = hashToken(token);
  if (!readSessions().sessions.some((s) => s.hash === hash)) return;
  writeSessions((sessions) => sessions.filter((s) => s.hash !== hash));
}

/** Ends every session of one account (password change/reset, disable, delete, "log out everywhere"). */
export function revokeAllSessions(accountId: string): number {
  const count = readSessions().sessions.filter((s) => s.accountId === accountId).length;
  if (count > 0) writeSessions((sessions) => sessions.filter((s) => s.accountId !== accountId));
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

/** May this account act at all right now? Public mode also needs a password and a verified address. */
export function accountUsable(account: Account, publicMode = isPublicMode()): boolean {
  if (account.status !== "active") return false;
  if (!publicMode) return true;
  return Boolean(account.passwordHash) && account.emailVerifiedAt !== null && account.email !== null;
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
  | { ok: false; reason: "invalid_credentials" | "rate_limited" | "email_not_verified" | "account_disabled"; retryAfterSeconds?: number };

/**
 * Username (or, in public mode, email) + password. Rate limit counts failures only: 5/min per account+address (both modes),
 * plus per-account and per-address caps in public mode. "Not verified"/"disabled" are only told to someone who knows the
 * password; every other failure is the same `invalid_credentials`.
 */
export async function attemptLogin(identifier: string, password: string, ip: string): Promise<LoginResult> {
  const publicMode = isPublicMode();
  const key = identifier.trim().toLowerCase();
  const limits: Limit[] = [LIMITS.loginPair(key, ip), ...(publicMode ? [LIMITS.loginAccount(key), LIMITS.loginIp(ip)] : [])];
  const verdict = checkLimits(limits);
  if (!verdict.ok) return { ok: false, reason: "rate_limited", retryAfterSeconds: verdict.retryAfterSeconds };
  const account = publicMode ? findByIdentifier(identifier) : getAccount(identifier);
  // Passwordless accounts cannot be signed into (only the private-mode default is reachable, implicitly).
  const valid = await verifyPasswordAsync(password, account?.passwordHash);
  if (!account || !valid) {
    hitLimits(limits);
    return { ok: false, reason: "invalid_credentials" };
  }
  clearLimit(LIMITS.loginPair(key, ip).key);
  if (account.status === "disabled") return { ok: false, reason: "account_disabled" };
  if (publicMode && (account.status === "pending" || account.emailVerifiedAt === null || account.email === null)) {
    return { ok: false, reason: "email_not_verified" };
  }
  const now = new Date().toISOString();
  const updated = mutateStore((store) => {
    const target = store.accounts.find((candidate) => candidate.id === account.id);
    if (target) target.lastLoginAt = now;
    return target ?? account;
  });
  return { ok: true, account: updated };
}
