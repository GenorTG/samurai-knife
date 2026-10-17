import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDataDir, writePrivateFile } from "@/lib/accounts/store";

/**
 * One server secret for everything the sign-in pages sign or seal: proof-of-work challenges, the "known device" cookie,
 * the GitHub OAuth state cookie, and the keyed hashes of client address prefixes stored with pending accounts.
 * `$KNIFE_DATA_DIR/auth.key` (64 hex chars, 0600, created on first use; `KNIFE_AUTH_KEY_FILE` = an absolute path
 * elsewhere). Each use derives its own key (HMAC(master, purpose)), so a value made for one purpose never verifies as
 * another. Threat model: whoever holds this file can forge challenges and device cookies (not sessions, passwords or
 * stored data); losing it only invalidates outstanding challenges, device cookies and GitHub sign-ins in flight.
 */

const KEY_NAME = "auth.key";

export type AuthPurpose = "pow" | "device" | "github-state" | "ip-prefix";

let cached: { path: string; key: Buffer } | null = null;

function keyPath(): string {
  const configured = process.env.KNIFE_AUTH_KEY_FILE?.trim();
  return configured || join(ensureDataDir(), KEY_NAME);
}

function masterKey(): Buffer {
  const path = keyPath();
  if (cached && cached.path === path) return cached.key;
  let key: Buffer;
  if (existsSync(path)) {
    const text = readFileSync(path, "utf8").trim();
    if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`${KEY_NAME} is malformed (expected 64 hex characters)`);
    key = Buffer.from(text, "hex");
  } else {
    key = randomBytes(32);
    writePrivateFile(path, `${key.toString("hex")}\n`);
  }
  cached = { path, key };
  return key;
}

/** Tests: forget the cached key (a new data dir gets its own). */
export function resetAuthSecretCache(): void {
  cached = null;
}

function purposeKey(purpose: AuthPurpose): Buffer {
  return createHmac("sha256", masterKey()).update(`knife-auth:${purpose}`).digest();
}

export function authMac(purpose: AuthPurpose, data: string): Buffer {
  return createHmac("sha256", purposeKey(purpose)).update(data).digest();
}

/** `payload.signature`, both base64url. */
export function signValue(purpose: AuthPurpose, payload: string): string {
  return `${payload}.${authMac(purpose, payload).toString("base64url")}`;
}

/** The payload of a value made by `signValue` for the same purpose, or null (constant-time comparison). */
export function verifySigned(purpose: AuthPurpose, value: string | undefined | null): string | null {
  if (!value || value.length > 4096) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1), "base64url");
  const expected = authMac(purpose, payload);
  return given.length === expected.length && timingSafeEqual(given, expected) ? payload : null;
}

/** AES-256-GCM with the purpose key: `iv.tag.body` (base64url). Confidential and tamper-evident. */
export function sealValue(purpose: AuthPurpose, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", purposeKey(purpose), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((part) => part.toString("base64url")).join(".");
}

export function openValue(purpose: AuthPurpose, sealed: string | undefined | null): string | null {
  if (!sealed || sealed.length > 4096) return null;
  const parts = sealed.split(".");
  if (parts.length !== 3) return null;
  try {
    const [iv, tag, body] = parts.map((part) => Buffer.from(part, "base64url"));
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = createDecipheriv("aes-256-gcm", purposeKey(purpose), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
