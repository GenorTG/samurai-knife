import { randomBytes, scrypt, scryptSync, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { withHashSlot } from "@/lib/accounts/hash-gate";

export { HashBusyError } from "@/lib/accounts/hash-gate";

/**
 * Password hashes: scrypt, format `scrypt$N$r$p$saltb64$hashb64` (shared with scripts/accounts.mjs). New hashes use the
 * OWASP parameters N=2^17, r=8, p=1 (~128 MiB, a few hundred ms); older hashes (N=2^14) still verify, and a successful
 * login rehashes them (`needsRehash`). Every async call in the server waits for a slot of the global hash budget
 * (`hash-gate.ts`), so a flood of logins or sign-ups is refused with 503 instead of stalling the process. Unknown
 * accounts are checked against a constant dummy hash with the current parameters, so they cost the same as a real one.
 */
const N = 131_072;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
export const MAX_PASSWORD_CHARS = 1_024;
/** Public-mode minimum (registration, reset, change). The CLI keeps its own 8-character floor for private use. */
export const MIN_PASSWORD_CHARS = 10;
/** Room for N up to 2^18 at r=8 (a stored hash with larger parameters is refused, not attempted). */
const MAXMEM = 288 * 1024 * 1024;
const MAX_N = 262_144;
export const SCRYPT_PARAMS = { N, r: R, p: P } as const;

function scryptAsync(password: string, salt: Buffer, length: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, length, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

function format(salt: Buffer, hash: Buffer): string {
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/** Synchronous (blocks the event loop): CLI-style tools and tests only; routes use `hashPasswordAsync`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return format(salt, scryptSync(password, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAXMEM }));
}

/** Off the event loop and inside the global hash budget (throws HashBusyError when it is full). */
export async function hashPasswordAsync(password: string): Promise<string> {
  const salt = randomBytes(16);
  return format(salt, await withHashSlot(() => scryptAsync(password, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAXMEM })));
}

/**
 * Used so unknown accounts cost the same as a wrong password: a fixed hash at the current parameters of a random password
 * nobody kept (and `stored === undefined` makes the result false regardless).
 */
const DUMMY_HASH = "scrypt$131072$8$1$jh65UAOsiunNOJC7J2Vatw==$jvMkjbBhl0EanfG6eNcmt0mgRNChHa6ng14LzxFeP7KrQTnL7tj9LU3v54AR9HofjrGWazKRZX3MsQcDU+qpig==";

type Parsed = { n: number; r: number; p: number; salt: Buffer; expected: Buffer };

function parse(stored: string, password: string): Parsed | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt" || password.length > MAX_PASSWORD_CHARS) return null;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || expected.length === 0) return null;
  if (n < 2 || n > MAX_N || (n & (n - 1)) !== 0 || r < 1 || r > 16 || p < 1 || p > 4 || expected.length > 128) return null;
  return { n, r, p, salt, expected };
}

/** True when `stored` is a valid hash made with other parameters than the current ones (rehash after a good login). */
export function needsRehash(stored: string | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  return Number(parts[1]) !== N || Number(parts[2]) !== R || Number(parts[3]) !== P || Buffer.from(parts[5], "base64").length !== KEY_LENGTH;
}

export function verifyPassword(password: string, stored: string | undefined): boolean {
  const parsed = parse(stored ?? DUMMY_HASH, password);
  let ok = false;
  if (parsed) {
    const actual = scryptSync(password, parsed.salt, parsed.expected.length, { N: parsed.n, r: parsed.r, p: parsed.p, maxmem: MAXMEM });
    ok = timingSafeEqual(actual, parsed.expected);
  }
  return stored !== undefined && ok;
}

/** Inside the global hash budget (throws HashBusyError when it is full). */
export async function verifyPasswordAsync(password: string, stored: string | undefined): Promise<boolean> {
  const parsed = parse(stored ?? DUMMY_HASH, password);
  let ok = false;
  if (parsed) {
    const actual = await withHashSlot(() => scryptAsync(password, parsed.salt, parsed.expected.length, { N: parsed.n, r: parsed.r, p: parsed.p, maxmem: MAXMEM }));
    ok = timingSafeEqual(actual, parsed.expected);
  }
  return stored !== undefined && ok;
}
