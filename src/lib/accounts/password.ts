import { randomBytes, scrypt, scryptSync, timingSafeEqual, type ScryptOptions } from "node:crypto";

// Format: scrypt$N$r$p$saltb64$hashb64 (shared with scripts/accounts.mjs).
const N = 16_384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
export const MAX_PASSWORD_CHARS = 1_024;
/** Public-mode minimum (registration, reset, change). The CLI keeps its own 8-character floor for private use. */
export const MIN_PASSWORD_CHARS = 10;
const MAXMEM = 128 * 1024 * 1024;

function scryptAsync(password: string, salt: Buffer, length: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, length, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

function format(salt: Buffer, hash: Buffer): string {
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return format(salt, scryptSync(password, salt, KEY_LENGTH, { N, r: R, p: P }));
}

/** Same as hashPassword, off the event loop (routes use this one: a burst of logins must not stall every other request). */
export async function hashPasswordAsync(password: string): Promise<string> {
  const salt = randomBytes(16);
  return format(salt, await scryptAsync(password, salt, KEY_LENGTH, { N, r: R, p: P }));
}

// Used so unknown accounts cost the same as a wrong password.
const DUMMY_HASH = hashPassword(randomBytes(8).toString("hex"));

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
  return { n, r, p, salt, expected };
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

export async function verifyPasswordAsync(password: string, stored: string | undefined): Promise<boolean> {
  const parsed = parse(stored ?? DUMMY_HASH, password);
  let ok = false;
  if (parsed) {
    const actual = await scryptAsync(password, parsed.salt, parsed.expected.length, { N: parsed.n, r: parsed.r, p: parsed.p, maxmem: MAXMEM });
    ok = timingSafeEqual(actual, parsed.expected);
  }
  return stored !== undefined && ok;
}
