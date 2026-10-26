import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { msgf } from "@/lib/i18n/msg";

/**
 * Provider secrets at rest (API keys, extra-header values) in accounts.json: AES-256-GCM with a server key in
 * `$KNIFE_DATA_DIR/provider-keys.key` (64 hex chars, 0600, generated on the first write that needs it). A stored value
 * is `enc:v1:<iv>:<tag>:<ciphertext>` (base64url); the additional data binds it to its account and field, so a value
 * copied into another account or field does not decrypt. scripts/accounts.mjs implements the same format.
 *
 * What this protects: a copy of accounts.json alone (a backup, a misdirected read of one file) no longer carries every
 * user's keys. What it does not: anyone who can read the whole data directory (the key file is next to it).
 */

export const KEY_FILE = "provider-keys.key";
const PREFIX = "enc:v1:";

export function isSealed(value: string): boolean {
  return value.startsWith(PREFIX);
}

function keyPath(dir: string): string {
  return join(dir, KEY_FILE);
}

/** The key, or null when the file does not exist yet. A malformed file is an error (never silently replaced). */
export function readKey(dir: string): Buffer | null {
  const path = keyPath(dir);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(msgf("{keyFile} is malformed (expected 64 hex characters)", { keyFile: KEY_FILE }));
  return Buffer.from(text, "hex");
}

/** Reads the key or creates it (0600) with `write` (the store's atomic private-file writer). */
export function ensureKey(dir: string, write: (path: string, contents: string) => void): Buffer {
  const existing = readKey(dir);
  if (existing) return existing;
  const key = randomBytes(32);
  write(keyPath(dir), `${key.toString("hex")}\n`);
  return key;
}

export function seal(key: Buffer, plain: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${PREFIX}${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${body.toString("base64url")}`;
}

export function open(key: Buffer, sealed: string, context: string): string {
  const parts = sealed.slice(PREFIX.length).split(":");
  if (parts.length !== 3) throw new Error("malformed sealed value");
  const [iv, tag, body] = parts.map((part) => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

/**
 * AAD for one secret: `<account>:apiKey` or `<account>:header:<lower-cased name>`; a saved provider profile's secrets
 * add `:profile:<id>` after the account, so a sealed value cannot be moved between profiles either.
 */
export function secretContext(accountId: string, field: "apiKey" | { header: string }, profileId?: string): string {
  const owner = profileId ? `${accountId}:profile:${profileId}` : accountId;
  return typeof field === "string" ? `${owner}:apiKey` : `${owner}:header:${field.header.toLowerCase()}`;
}
