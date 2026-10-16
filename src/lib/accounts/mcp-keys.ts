import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { accountUsable } from "@/lib/accounts/session";
import { ensureDataDir, getAccount, writePrivateFile, type Account } from "@/lib/accounts/store";

/**
 * Per-account MCP credentials (docs/MCP.md "Connecting"). An agent outside the browser sends its username and one of that
 * account's keys; the tools then act on that account only. `$KNIFE_DATA_DIR/mcp-keys.json` (0600) stores the SHA-256 of
 * each key (32 random bytes, so a plain hash is enough), never the key: it is shown once, at creation. Written only by
 * this server process, synchronously (same pattern as sessions.json).
 */

export const MCP_KEY_PREFIX = "skm_";
export const MAX_KEYS_PER_ACCOUNT = 10;
const TOUCH_EVERY_MS = 60_000;
const KEY_PATTERN = /^skm_[A-Za-z0-9_-]{43}$/;

interface McpKeyRecord {
  id: string;
  accountId: string;
  name: string;
  hash: string;
  /** First characters of the key, shown in the list so the owner can tell keys apart. */
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface McpKeyFile {
  version: 1;
  keys: McpKeyRecord[];
}

/** What the account page shows: never the hash. */
export interface McpKeyView {
  id: string;
  name: string;
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export class McpKeyError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "McpKeyError";
  }
}

function keysPath(): string {
  return join(ensureDataDir(), "mcp-keys.json");
}

let cache: { mtimeMs: number; size: number; path: string; data: McpKeyFile } | null = null;

function isRecord(value: unknown): value is McpKeyRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return ["id", "accountId", "name", "hash", "hint", "createdAt"].every((key) => typeof r[key] === "string")
    && (r.lastUsedAt === null || typeof r.lastUsedAt === "string");
}

function readKeys(): McpKeyFile {
  const path = keysPath();
  if (!existsSync(path)) return { version: 1, keys: [] };
  const stat = statSync(path);
  if (cache && cache.path === path && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return cache.data;
  let data: McpKeyFile = { version: 1, keys: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { keys?: unknown };
    if (Array.isArray(raw.keys)) data = { version: 1, keys: raw.keys.filter(isRecord) };
  } catch {
    // Damaged file: every key stops working (fail closed) and owners create new ones; never a crash per request.
  }
  cache = { mtimeMs: stat.mtimeMs, size: stat.size, path, data };
  return data;
}

function writeKeys(mutate: (keys: McpKeyRecord[]) => McpKeyRecord[]): void {
  const next = mutate(readKeys().keys.map((k) => ({ ...k })));
  writePrivateFile(keysPath(), `${JSON.stringify({ version: 1, keys: next } satisfies McpKeyFile)}\n`);
  cache = null;
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function toView(record: McpKeyRecord): McpKeyView {
  return { id: record.id, name: record.name, hint: record.hint, createdAt: record.createdAt, lastUsedAt: record.lastUsedAt };
}

export function listMcpKeys(accountId: string): McpKeyView[] {
  return readKeys().keys.filter((k) => k.accountId === accountId).map(toView);
}

/** Creates a key; the raw key is in the return value only (show it once). */
export function createMcpKey(accountId: string, name: string): { key: string; view: McpKeyView } {
  const label = name.trim();
  if (!label || label.length > 60) throw new McpKeyError("Give the key a name (1-60 characters).", 400);
  if (listMcpKeys(accountId).length >= MAX_KEYS_PER_ACCOUNT) {
    throw new McpKeyError(`At most ${MAX_KEYS_PER_ACCOUNT} MCP keys per account: revoke one first.`, 409);
  }
  const key = `${MCP_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  const record: McpKeyRecord = {
    id: `mk_${randomBytes(6).toString("hex")}`,
    accountId,
    name: label,
    hash: hashKey(key),
    hint: `${key.slice(0, MCP_KEY_PREFIX.length + 4)}…`,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  writeKeys((keys) => [...keys, record]);
  return { key, view: toView(record) };
}

/** Revokes one of the account's keys; false when the id is not one of its keys (same answer as a missing id). */
export function revokeMcpKey(accountId: string, keyId: string): boolean {
  if (!readKeys().keys.some((k) => k.id === keyId && k.accountId === accountId)) return false;
  writeKeys((keys) => keys.filter((k) => !(k.id === keyId && k.accountId === accountId)));
  return true;
}

/** Every key of an account (account deletion). */
export function revokeAllMcpKeys(accountId: string): number {
  const count = readKeys().keys.filter((k) => k.accountId === accountId).length;
  if (count > 0) writeKeys((keys) => keys.filter((k) => k.accountId !== accountId));
  return count;
}

export type McpCredentials = { username: string; key: string };

/**
 * Reads the credentials of an MCP request: `Authorization: Basic base64(username:key)`, or `Authorization: Bearer <key>`
 * with `X-Knife-User: <username>`. null = none sent; "malformed" = an Authorization header that is neither.
 */
export function mcpCredentials(request: Request): McpCredentials | null | "malformed" {
  const header = request.headers.get("authorization")?.trim();
  if (!header) return null;
  const space = header.indexOf(" ");
  const scheme = space > 0 ? header.slice(0, space).toLowerCase() : "";
  const value = space > 0 ? header.slice(space + 1).trim() : "";
  if (scheme === "basic") {
    let decoded: string;
    try {
      decoded = Buffer.from(value, "base64").toString("utf8");
    } catch {
      return "malformed";
    }
    const colon = decoded.indexOf(":");
    if (colon <= 0) return "malformed";
    return { username: decoded.slice(0, colon).trim().toLowerCase(), key: decoded.slice(colon + 1).trim() };
  }
  if (scheme === "bearer") {
    const username = request.headers.get("x-knife-user")?.trim().toLowerCase();
    return username && value ? { username, key: value } : "malformed";
  }
  return "malformed";
}

/** The account the key belongs to, when it matches the given username and the account may act; else null. */
export function accountForMcpKey(credentials: McpCredentials): Account | null {
  if (!KEY_PATTERN.test(credentials.key)) return null;
  const hash = hashKey(credentials.key);
  const record = readKeys().keys.find((k) => k.hash === hash);
  if (!record || record.accountId !== credentials.username) return null;
  const account = getAccount(record.accountId);
  if (!account || !accountUsable(account)) return null;
  const now = Date.now();
  if (!record.lastUsedAt || now - Date.parse(record.lastUsedAt) > TOUCH_EVERY_MS) {
    writeKeys((keys) => keys.map((k) => (k.hash === hash ? { ...k, lastUsedAt: new Date(now).toISOString() } : k)));
  }
  return account;
}
