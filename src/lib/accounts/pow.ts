import { createHash, randomBytes } from "node:crypto";
import * as z from "zod/v4";
import { signValue, verifySigned } from "@/lib/accounts/auth-secret";
import { clientPrefix, prefixTag } from "@/lib/accounts/ip-prefix";
import { leadingZeroBitsOfBytes, MAX_NONCE_DIGITS } from "@/lib/pow/solve";
import { POW_FORMS, type PowForm, type PowSolution } from "@/lib/pow/types";
import { recordSecurityEvent } from "@/lib/security/events";

/**
 * Self-hosted proof-of-work for the forms used before login (register, forgot, resend, reset, and login after failures).
 * `GET /api/account/challenge?form=` hands out `c` = signed {form, client prefix tag, time, random id, bits}; the browser
 * finds a nonce with SHA-256(`c:nonce`) starting with `bits` zero bits (`src/lib/pow/solve.ts`, in a Web Worker) and
 * posts `pow: {c, nonce}` with the form. The server checks it here BEFORE any password hashing, store access or mail:
 * signature, form, client prefix, age (10 min), difficulty, work, and one use (bounded replay set, refusing when full).
 * Threat: bots paying nothing per attempt. It limits volume, not a determined attacker: the rate limits stay.
 *
 * Difficulty: KNIFE_POW_BITS (default 18, ~0.2 s on a laptop) raised under load from one client prefix (+3 past 5
 * protected submissions in 10 min, +5 past 20), for registrations while the server-wide sign-up rate is high (+3 past
 * KNIFE_POW_REGISTER_SURGE per hour, default 20), and for logins against an identifier whose failure bucket is full
 * (+3); never above KNIFE_POW_MAX_BITS (default 24). Test suites set KNIFE_POW_BITS low and solve challenges themselves
 * (tests/pow_client.py, docs/TESTING.md); nothing turns the check off.
 */

export { POW_FORMS, type PowForm, type PowSolution } from "@/lib/pow/types";

const CHALLENGE_TTL_MS = 10 * 60_000;
const CLOCK_SKEW_MS = 60_000;
const WINDOW_MS = 10 * 60_000;
const HOUR = 60 * 60_000;
const MAX_REPLAY = 50_000;
const MAX_PREFIXES = 20_000;
const MAX_REGISTER_TIMES = 10_000;

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw >= min && raw <= max ? raw : fallback;
}

export function powSettings(): { base: number; max: number; registerSurge: number } {
  const base = envInt("KNIFE_POW_BITS", 18, 1, 30);
  return { base, max: Math.max(base, envInt("KNIFE_POW_MAX_BITS", 24, 1, 30)), registerSurge: envInt("KNIFE_POW_REGISTER_SURGE", 20, 0, 1_000_000) };
}

export function isPowForm(value: unknown): value is PowForm {
  return typeof value === "string" && (POW_FORMS as readonly string[]).includes(value);
}

/* --------------------------------------------------------------------------------- bounded process state */

interface PowState {
  /** challenge id -> expiry (ms). */
  used: Map<string, number>;
  /** client prefix -> times of accepted protected submissions (last 10 min). */
  recent: Map<string, number[]>;
  /** times of accepted registrations, server-wide (last hour). */
  registers: number[];
}

const KEY = Symbol.for("samurai-knife.pow.v1");

function state(): PowState {
  const g = globalThis as unknown as Record<symbol, PowState | undefined>;
  const current = g[KEY];
  if (current && current.used instanceof Map && current.recent instanceof Map && Array.isArray(current.registers)) return current;
  const fresh: PowState = { used: new Map(), recent: new Map(), registers: [] };
  g[KEY] = fresh;
  return fresh;
}

/** Tests only. */
export function resetPowState(): void {
  const s = state();
  s.used.clear();
  s.recent.clear();
  s.registers.length = 0;
}

function recentCount(prefix: string, now: number): number | null {
  const s = state();
  const list = s.recent.get(prefix);
  if (!list) return s.recent.size >= MAX_PREFIXES ? null : 0;
  const live = list.filter((t) => t > now - WINDOW_MS);
  if (live.length === 0) s.recent.delete(prefix);
  else s.recent.set(prefix, live);
  return live.length;
}

function noteUse(form: PowForm, prefix: string, now: number): void {
  const s = state();
  if (!s.recent.has(prefix) && s.recent.size >= MAX_PREFIXES) {
    for (const [key, list] of s.recent) if (list.every((t) => t <= now - WINDOW_MS)) s.recent.delete(key);
  }
  if (s.recent.has(prefix) || s.recent.size < MAX_PREFIXES) {
    const list = (s.recent.get(prefix) ?? []).filter((t) => t > now - WINDOW_MS);
    list.push(now);
    s.recent.set(prefix, list.slice(-100));
  }
  if (form === "register") {
    s.registers = s.registers.filter((t) => t > now - HOUR);
    if (s.registers.length < MAX_REGISTER_TIMES) s.registers.push(now);
  }
}

/** Context that raises the difficulty for one request. */
export interface PowContext {
  /** Login: the identifier's failure bucket (or the server-wide failed-login budget) is full. */
  identifierUnderAttack?: boolean;
  /**
   * Challenges only: issue at least this difficulty (capped at KNIFE_POW_MAX_BITS). A client asks for the difficulty a
   * 428 named; asking for more only costs that client, never less than the server's own requirement.
   */
  atLeastBits?: number;
}

/** The difficulty this client prefix must meet for `form` right now. */
export function requiredBits(form: PowForm, ip: string, context: PowContext = {}, now = Date.now()): number {
  const { base, max, registerSurge } = powSettings();
  const recent = recentCount(clientPrefix(ip), now);
  // A full prefix table fails closed: an unknown prefix pays the top difficulty until entries expire.
  let extra = recent === null ? max - base : recent > 20 ? 5 : recent > 5 ? 3 : 0;
  if (form === "register" && state().registers.filter((t) => t > now - HOUR).length > registerSurge) extra += 3;
  if (context.identifierUnderAttack) extra += 3;
  const asked = Number.isInteger(context.atLeastBits) ? (context.atLeastBits as number) : 0;
  return Math.min(max, Math.max(base + extra, asked));
}

/* ---------------------------------------------------------------------------------------- challenges */

interface ChallengePayload {
  v: 1;
  f: PowForm;
  p: string;
  t: number;
  r: string;
  b: number;
}

export function issueChallenge(form: PowForm, ip: string, context: PowContext = {}, now = Date.now()): { c: string; bits: number; expiresInSeconds: number } {
  const bits = requiredBits(form, ip, context, now);
  const payload: ChallengePayload = { v: 1, f: form, p: prefixTag(ip), t: now, r: randomBytes(12).toString("base64url"), b: bits };
  return { c: signValue("pow", Buffer.from(JSON.stringify(payload)).toString("base64url")), bits, expiresInSeconds: CHALLENGE_TTL_MS / 1000 };
}

export type PowVerdict =
  | { ok: true }
  /** 428: no or unusable proof; the client fetches a challenge (at `bits`) and tries again. 503: replay set full. */
  | { ok: false; status: 428 | 503; error: "challenge_required" | "challenge_invalid" | "busy"; bits: number; retryAfterSeconds?: number };

function parsePayload(c: string): ChallengePayload | null {
  const encoded = verifySigned("pow", c);
  if (!encoded) return null;
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<ChallengePayload>;
    if (value.v !== 1 || !isPowForm(value.f) || typeof value.p !== "string" || typeof value.t !== "number" || typeof value.r !== "string" || typeof value.b !== "number") return null;
    return value as ChallengePayload;
  } catch {
    return null;
  }
}

/**
 * The gate: call first, before anything costly. A proof is accepted once; a valid one counts toward this prefix's
 * difficulty (and, for register, the server-wide sign-up rate).
 */
export function checkPow(form: PowForm, ip: string, pow: PowSolution | null | undefined, context: PowContext = {}, now = Date.now()): PowVerdict {
  const bits = requiredBits(form, ip, context, now);
  const refuse = (error: "challenge_required" | "challenge_invalid"): PowVerdict => {
    if (error === "challenge_invalid") recordSecurityEvent({ kind: "pow_fail", ipPrefix: clientPrefix(ip), path: form });
    return { ok: false, status: 428, error, bits };
  };
  if (!pow) return refuse("challenge_required");
  if (typeof pow.c !== "string" || typeof pow.nonce !== "string" || pow.c.length > 600 || !new RegExp(`^\\d{1,${MAX_NONCE_DIGITS}}$`).test(pow.nonce)) return refuse("challenge_invalid");
  const payload = parsePayload(pow.c);
  if (!payload || payload.f !== form || payload.p !== prefixTag(ip)) return refuse("challenge_invalid");
  if (payload.t > now + CLOCK_SKEW_MS || now - payload.t > CHALLENGE_TTL_MS) return refuse("challenge_required");
  // Difficulty may have gone up since the challenge was issued: easy challenges collected earlier stop working.
  if (payload.b < bits) return refuse("challenge_required");
  const digest = createHash("sha256").update(`${pow.c}:${pow.nonce}`).digest();
  if (leadingZeroBitsOfBytes(digest) < payload.b) return refuse("challenge_invalid");
  const s = state();
  if (s.used.has(payload.r)) return refuse("challenge_invalid");
  if (s.used.size >= MAX_REPLAY) {
    for (const [id, expiry] of s.used) if (expiry <= now) s.used.delete(id);
    if (s.used.size >= MAX_REPLAY) return { ok: false, status: 503, error: "busy", bits, retryAfterSeconds: 60 };
  }
  s.used.set(payload.r, payload.t + CHALLENGE_TTL_MS + CLOCK_SKEW_MS);
  noteUse(form, clientPrefix(ip), now);
  return { ok: true };
}

/** The optional `pow` member of every protected route body. */
export const powField = z.object({ c: z.string().max(600), nonce: z.string().max(MAX_NONCE_DIGITS) }).strict().nullish();
