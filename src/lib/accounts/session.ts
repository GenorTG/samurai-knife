import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ensureDataDir,
  getAccount,
  getDefaultAccount,
  writePrivateFile,
  type Account,
} from "@/lib/accounts/store";
import { verifyPassword } from "@/lib/accounts/password";

export const SESSION_COOKIE = "knife_session";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const MAX_LOGIN_FAILURES = 5;
const LOGIN_WINDOW_MS = 60_000;

function sessionSecret(): Buffer {
  const path = join(ensureDataDir(), "session.secret");
  if (!existsSync(path)) writePrivateFile(path, randomBytes(32).toString("hex"));
  return Buffer.from(readFileSync(path, "utf8").trim(), "hex");
}

/** Short fingerprint so changing a password invalidates existing sessions. */
function passwordFingerprint(account: Account): string {
  return createHash("sha256").update(account.passwordHash ?? "").digest("hex").slice(0, 12);
}

function sign(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

function issueToken(account: Account): string {
  const payload = Buffer.from(JSON.stringify({
    id: account.id,
    exp: Math.floor(Date.now() / 1_000) + SESSION_MAX_AGE_SECONDS,
    pf: passwordFingerprint(account),
  })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function readToken(token: string): Account | null {
  const [payload, signature, ...rest] = token.split(".");
  if (!payload || !signature || rest.length > 0) return null;
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      id?: unknown;
      exp?: unknown;
      pf?: unknown;
    };
    if (typeof data.id !== "string" || typeof data.exp !== "number" || typeof data.pf !== "string") return null;
    if (data.exp * 1_000 < Date.now()) return null;
    const account = getAccount(data.id);
    if (!account || passwordFingerprint(account) !== data.pf) return null;
    return account;
  } catch {
    return null;
  }
}

function cookieValue(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

/**
 * Valid session cookie, else the default account when it has no password
 * (the tailnet boundary is the auth), else null (caller answers 401).
 */
export function resolveAccount(request: Request): Account | null {
  const token = cookieValue(request, SESSION_COOKIE);
  if (token) {
    const fromCookie = readToken(token);
    if (fromCookie) return fromCookie;
  }
  const fallback = getDefaultAccount();
  return fallback.passwordHash ? null : fallback;
}

export function isHttps(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwarded) return forwarded === "https";
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function sessionCookieHeader(request: Request, account: Account): string {
  const attributes = [
    `${SESSION_COOKIE}=${issueToken(account)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
  ];
  if (isHttps(request)) attributes.push("Secure");
  return attributes.join("; ");
}

export function clearedCookieHeader(request: Request): string {
  const attributes = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (isHttps(request)) attributes.push("Secure");
  return attributes.join("; ");
}

// In-memory login rate limit: 5 failures per minute per account (and per client address when a trusted proxy supplies one).
const failures = new Map<string, number[]>();
/** Upper bound on tracked keys: the account id is attacker-chosen, so unknown ids must not grow the map without limit. */
const MAX_TRACKED_KEYS = 1_000;

function recentFailures(key: string): number[] {
  const cutoff = Date.now() - LOGIN_WINDOW_MS;
  const list = (failures.get(key) ?? []).filter((time) => time > cutoff);
  if (list.length > 0) failures.set(key, list);
  else failures.delete(key);
  return list;
}

function pruneFailures(): void {
  if (failures.size <= MAX_TRACKED_KEYS) return;
  for (const key of Array.from(failures.keys())) recentFailures(key);
  // Still over (a burst of distinct ids inside one window): drop the oldest entries first (Map keeps insertion order).
  for (const key of failures.keys()) {
    if (failures.size <= MAX_TRACKED_KEYS) break;
    failures.delete(key);
  }
}

/**
 * Address used to bucket login failures. `X-Forwarded-For` is client-controlled when nothing fronts the app (the normal
 * Tailscale-bind setup), so honouring it would hand every attacker a fresh budget per request: it is only read when the
 * operator says a proxy sets it (`KNIFE_TRUST_PROXY=1`). Otherwise all clients share one bucket per account.
 */
export function clientIp(request: Request): string {
  if (process.env.KNIFE_TRUST_PROXY !== "1") return "local";
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

export type LoginResult =
  | { ok: true; account: Account }
  | { ok: false; reason: "invalid_credentials" | "rate_limited"; retryAfterSeconds?: number };

export function attemptLogin(id: string, password: string, ip: string): LoginResult {
  const key = `${id}|${ip}`;
  if (recentFailures(key).length >= MAX_LOGIN_FAILURES) {
    return { ok: false, reason: "rate_limited", retryAfterSeconds: Math.ceil(LOGIN_WINDOW_MS / 1_000) };
  }
  const account = getAccount(id);
  // Passwordless accounts cannot be signed into (only the default is reachable, implicitly).
  const valid = verifyPassword(password, account?.passwordHash);
  if (!account || !valid) {
    failures.set(key, [...recentFailures(key), Date.now()]);
    pruneFailures();
    return { ok: false, reason: "invalid_credentials" };
  }
  failures.delete(key);
  return { ok: true, account };
}
