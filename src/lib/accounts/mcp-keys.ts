import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { accountUsable } from "@/lib/accounts/session";
import { ensureDataDir, getAccount, writePrivateFile, type Account } from "@/lib/accounts/store";
import { msg, msgf } from "@/lib/i18n/msg";

/**
 * Per-account MCP credentials (docs/MCP.md "Connecting"). An agent outside the browser sends its username and one of that
 * account's keys (or only the key, on the account's own URL `/api/mcp/u/<username>`); the tools then act on that account
 * only, and a `read-only` key gets only the tools that change nothing. `$KNIFE_DATA_DIR/mcp-keys.json` (0600) stores the SHA-256 of
 * each key (32 random bytes, so a plain hash is enough), never the key: it is shown once, at creation. Written only by
 * this server process, synchronously (same pattern as sessions.json).
 */

export const MCP_KEY_PREFIX = "skm_";
export const MAX_KEYS_PER_ACCOUNT = 10;
const TOUCH_EVERY_MS = 60_000;
const KEY_PATTERN = /^skm_[A-Za-z0-9_-]{43}$/;

/** What a key may do: every tool of the account's role, or only those with readOnlyHint (effect "read"). */
export const MCP_KEY_SCOPES = ["full", "read-only"] as const;
export type McpKeyScope = (typeof MCP_KEY_SCOPES)[number];

interface McpKeyRecord {
  id: string;
  accountId: string;
  name: string;
  hash: string;
  /** First characters of the key, shown in the list so the owner can tell keys apart. */
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** Missing on keys made before scopes existed: full. */
  scope?: McpKeyScope;
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
  scope: McpKeyScope;
}

/** The account an MCP request acts on and what its key may do. */
export interface McpCaller {
  account: Account;
  scope: McpKeyScope;
}

export class McpKeyError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "McpKeyError";
    this.status = status;
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
    && (r.lastUsedAt === null || typeof r.lastUsedAt === "string")
    && (r.scope === undefined || (MCP_KEY_SCOPES as readonly unknown[]).includes(r.scope));
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
  return { id: record.id, name: record.name, hint: record.hint, createdAt: record.createdAt, lastUsedAt: record.lastUsedAt, scope: record.scope ?? "full" };
}

export function listMcpKeys(accountId: string): McpKeyView[] {
  return readKeys().keys.filter((k) => k.accountId === accountId).map(toView);
}

/** Creates a key; the raw key is in the return value only (show it once). */
export function createMcpKey(accountId: string, name: string, scope: McpKeyScope = "full"): { key: string; view: McpKeyView } {
  const label = name.trim();
  if (!label || label.length > 60) throw new McpKeyError(msg("Give the key a name (1-60 characters)."), 400);
  if (listMcpKeys(accountId).length >= MAX_KEYS_PER_ACCOUNT) {
    throw new McpKeyError(msgf("At most {maxKeysPerAccount} MCP keys per account: revoke one first.", { maxKeysPerAccount: MAX_KEYS_PER_ACCOUNT }), 409);
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
    scope,
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

/** The key's record, by hash, comparing every record in constant time per comparison (no early exit on a prefix). */
function recordForKey(key: string): McpKeyRecord | null {
  if (!KEY_PATTERN.test(key)) return null;
  const hash = Buffer.from(hashKey(key), "hex");
  let found: McpKeyRecord | null = null;
  for (const record of readKeys().keys) {
    const stored = Buffer.from(record.hash, "hex");
    if (stored.length === hash.length && timingSafeEqual(stored, hash) && !found) found = record;
  }
  return found;
}

/**
 * The account the key belongs to and the key's scope, when it belongs to exactly `username` (an account id, compared as
 * is: callers lowercase a typed username, the per-user URL does not) and the account may act; else null. Every failure
 * is the same null, so a caller cannot tell a wrong key from a key of another account.
 */
export function callerForMcpKey(credentials: McpCredentials): McpCaller | null {
  const record = recordForKey(credentials.key);
  if (!record || record.accountId !== credentials.username) return null;
  const account = getAccount(record.accountId);
  if (!account || !accountUsable(account)) return null;
  const now = Date.now();
  if (!record.lastUsedAt || now - Date.parse(record.lastUsedAt) > TOUCH_EVERY_MS) {
    writeKeys((keys) => keys.map((k) => (k.hash === record.hash ? { ...k, lastUsedAt: new Date(now).toISOString() } : k)));
  }
  return { account, scope: record.scope ?? "full" };
}

/** Back-compat: only the account (callers that do not care about the scope). */
export function accountForMcpKey(credentials: McpCredentials): Account | null {
  return callerForMcpKey(credentials)?.account ?? null;
}

/** The key of `Authorization: Bearer <key>` (the per-user URL needs nothing else); null = none, "malformed" = other. */
export function bearerKey(request: Request): string | null | "malformed" {
  const header = request.headers.get("authorization")?.trim();
  if (!header) return null;
  const match = /^bearer\s+(\S+)$/i.exec(header);
  return match ? match[1] : "malformed";
}

/** KNIFE_MCP_REQUIRE_KEY=1: private mode refuses MCP requests without a key too (public mode always does). */
export function mcpKeyRequired(publicMode: boolean): boolean {
  return publicMode || /^(1|true|yes|on)$/i.test(process.env.KNIFE_MCP_REQUIRE_KEY?.trim() ?? "");
}

/** Account rename (scripts/storage.ts rename-account): the keys move to the new id; returns how many. */
export function reassignMcpKeys(fromId: string, toId: string): number {
  let moved = 0;
  writeKeys((keys) => keys.map((k) => (k.accountId === fromId ? (moved += 1, { ...k, accountId: toId }) : k)));
  return moved;
}
