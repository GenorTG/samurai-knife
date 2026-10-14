import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// Format: scrypt$N$r$p$saltb64$hashb64 (shared with scripts/accounts.mjs).
const N = 16_384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const MAX_PASSWORD_CHARS = 1_024;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

// Used so unknown accounts cost the same as a wrong password.
const DUMMY_HASH = hashPassword(randomBytes(8).toString("hex"));

export function verifyPassword(password: string, stored: string | undefined): boolean {
  const candidate = stored ?? DUMMY_HASH;
  const parts = candidate.split("$");
  let ok = false;
  if (parts.length === 6 && parts[0] === "scrypt" && password.length <= MAX_PASSWORD_CHARS) {
    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4], "base64");
    const expected = Buffer.from(parts[5], "base64");
    if (Number.isInteger(n) && Number.isInteger(r) && Number.isInteger(p) && expected.length > 0) {
      const actual = scryptSync(password, salt, expected.length, { N: n, r, p, maxmem: 128 * 1024 * 1024 });
      ok = timingSafeEqual(actual, expected);
    }
  }
  return stored !== undefined && ok;
}
