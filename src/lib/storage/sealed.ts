import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { ensureDataDir, writePrivateFile } from "@/lib/accounts/store";

/**
 * Per-account files at rest (CV, office library, conversations, course progress, usage ledger, tool drafts): every file
 * written through `writeAccountFile` is AES-256-GCM sealed with a key derived for that account (HKDF-SHA256 of the server
 * storage key, info = account id) and the account id as additional data, so a file copied into another account's
 * directory does not open. Layout: MAGIC (8 bytes) | iv (12) | tag (16) | ciphertext (same length as the plaintext).
 *
 * The storage key is `$KNIFE_DATA_DIR/storage.key` (64 hex chars, 0600, created by the first write that needs it), or the
 * file named by KNIFE_STORAGE_KEY_FILE (keep it outside the data dir so a copy of the data dir alone opens nothing). Losing
 * the key loses every sealed file: back it up separately from the data.
 *
 * Files written before sealing (plaintext) still read as they are and are sealed by their next write.
 */

const MAGIC = Buffer.from("\0SKENC01", "latin1");
export const SEALED_OVERHEAD = MAGIC.length + 12 + 16;
const KEY_NAME = "storage.key";
const INFO_SALT = Buffer.from("samurai-knife:account-storage:v1", "utf8");

let cachedKey: { path: string; key: Buffer } | null = null;

export function storageKeyPath(): string {
  const configured = process.env.KNIFE_STORAGE_KEY_FILE?.trim();
  if (configured) {
    if (!isAbsolute(configured)) throw new Error("KNIFE_STORAGE_KEY_FILE must be an absolute path");
    return configured;
  }
  return join(ensureDataDir(), KEY_NAME);
}

function parseKey(path: string): Buffer {
  const text = readFileSync(path, "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`${path} is malformed (expected 64 hex characters)`);
  return Buffer.from(text, "hex");
}

/** The master key; created (0600) only when `create` is set and no key exists yet. A malformed key is never replaced. */
function masterKey(create: boolean): Buffer {
  const path = storageKeyPath();
  if (cachedKey?.path === path && existsSync(path)) return cachedKey.key;
  let key: Buffer;
  if (existsSync(path)) key = parseKey(path);
  else if (create) {
    key = randomBytes(32);
    writePrivateFile(path, `${key.toString("hex")}\n`);
  } else throw new Error("account storage key is missing: sealed files cannot be opened (restore storage.key from a backup)");
  cachedKey = { path, key };
  return key;
}

function accountKey(accountId: string, create: boolean): Buffer {
  return Buffer.from(hkdfSync("sha256", masterKey(create), INFO_SALT, Buffer.from(accountId, "utf8"), 32));
}

export function isSealedBytes(data: Uint8Array): boolean {
  return data.byteLength >= SEALED_OVERHEAD && Buffer.from(data.buffer, data.byteOffset, MAGIC.length).equals(MAGIC);
}

export function sealAccountBytes(accountId: string, plain: string | Uint8Array): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", accountKey(accountId, true), iv);
  cipher.setAAD(Buffer.from(accountId, "utf8"));
  const body = Buffer.concat([cipher.update(typeof plain === "string" ? Buffer.from(plain, "utf8") : plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

/** Plaintext of a stored file's bytes; bytes that are not sealed (written before sealing) come back unchanged. */
export function openAccountBytes(accountId: string, data: Buffer): Buffer {
  if (!isSealedBytes(data)) return data;
  const iv = data.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = data.subarray(MAGIC.length + 12, SEALED_OVERHEAD);
  const decipher = createDecipheriv("aes-256-gcm", accountKey(accountId, false), iv);
  decipher.setAAD(Buffer.from(accountId, "utf8"));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data.subarray(SEALED_OVERHEAD)), decipher.final()]);
  } catch {
    throw new Error("a stored file does not open with this account's key (another account's file, or a different storage key)");
  }
}

export function readAccountFile(accountId: string, path: string): Buffer {
  return openAccountBytes(accountId, readFileSync(path));
}

export function readAccountText(accountId: string, path: string): string {
  return readAccountFile(accountId, path).toString("utf8");
}

/** Plaintext size of a stored file from its on-disk size (reads only the header). */
export function plainSize(path: string, diskSize: number): number {
  if (diskSize < SEALED_OVERHEAD) return diskSize;
  const head = Buffer.alloc(MAGIC.length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, head, 0, head.length, 0);
  } finally {
    closeSync(fd);
  }
  return head.equals(MAGIC) ? diskSize - SEALED_OVERHEAD : diskSize;
}

/** Tests only: forget the cached key (a test switches KNIFE_DATA_DIR / KNIFE_STORAGE_KEY_FILE). */
export function resetStorageKeyCache(): void {
  cachedKey = null;
}
