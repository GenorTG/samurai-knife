import { existsSync, lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { isPublicMode } from "@/lib/accounts/mode";
import { getAccount, writePrivateFile } from "@/lib/accounts/store";
import { sealAccountBytes } from "./sealed";
import { formatBytes } from "@/lib/format";
import { jobStore } from "@/lib/jobs";
import { accountScope, parentDir } from "./scope";

/**
 * Per-account storage quota (docs/ACCOUNTS.md "Storage quota"). The limit is the account's `storageQuotaBytes` (1 GiB for
 * registered users, `null` = unlimited); administrators are always unlimited (private mode: every account). Usage = every
 * byte under the account's data locations (`accountScope(id).locations()` + its CV files) plus the scratch bytes of its live
 * async jobs. It is computed by one walk and cached in memory; every write through `writeAccountFile` / removal through
 * `removeAccountPath` adjusts the cache by the exact delta, and the cache is re-walked after `recountMs()` to pick up
 * changes made outside the server (CLI, hand edits).
 *
 * Writes of user content check BEFORE writing (`enforce`, the default) and throw `QuotaExceededError` (HTTP 507 with a
 * readable message). Bookkeeping writes (token ledger, course progress, the assistant's continuation state, document
 * metadata) pass `enforce: false`: they are tiny and refusing them would break the feature instead of the upload.
 * Deleting is never refused.
 */

/** KNIFE_STORAGE_RECOUNT_SEC (default 600): how long a counted total is trusted before the disk is walked again. */
function recountMs(): number {
  const parsed = Number.parseFloat(process.env.KNIFE_STORAGE_RECOUNT_SEC ?? "");
  return (Number.isFinite(parsed) && parsed >= 0 ? parsed : 600) * 1000;
}
const CACHE_KEY = Symbol.for("samurai-knife.storage-usage.v1");

export type StorageArea = "docs" | "cv" | "conversations" | "learn" | "usage" | "workspace" | "site" | "jobs";

export interface StorageUsage {
  usedBytes: number;
  /** null = unlimited (administrator, or no quota set). */
  quotaBytes: number | null;
  /** 0..1 of the quota (0 when unlimited). */
  fraction: number;
  areas: Record<StorageArea, number>;
}

export class QuotaExceededError extends Error {
  readonly status = 507;
  readonly code = "storage_quota_exceeded";
  readonly usedBytes: number;
  readonly quotaBytes: number;
  readonly neededBytes: number;
  constructor(usedBytes: number, quotaBytes: number, neededBytes: number) {
    const free = Math.max(0, quotaBytes - usedBytes);
    super(
      `Not enough storage: this needs ${formatBytes(neededBytes)} but only ${formatBytes(free)} of your ${formatBytes(quotaBytes)} is free ` +
        `(${formatBytes(usedBytes)} used). Free space by deleting files, emptying the office trash or pruning old document versions.`,
    );
    this.name = "QuotaExceededError";
    this.usedBytes = usedBytes;
    this.quotaBytes = quotaBytes;
    this.neededBytes = neededBytes;
  }

  /** Body for `jsonError(message, 507, extra)`. */
  details(): Record<string, unknown> {
    return { code: this.code, usedBytes: this.usedBytes, quotaBytes: this.quotaBytes, neededBytes: this.neededBytes };
  }
}

interface Cached {
  areas: Omit<Record<StorageArea, number>, "jobs">;
  at: number;
}

function cache(): Map<string, Cached> {
  const holder = globalThis as unknown as Record<symbol, Map<string, Cached> | undefined>;
  holder[CACHE_KEY] ??= new Map();
  return holder[CACHE_KEY];
}

/** Bytes under a path (files only, symlinks not followed). */
export function pathBytes(path: string): number {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return 0;
  }
  if (stat.isSymbolicLink()) return 0;
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const name of readdirSync(path)) total += pathBytes(join(path, name));
  return total;
}

/** The account's CV files (`cv/<id>.*`: data, snapshots dir, photo, anything else with the prefix). */
export function cvPaths(accountId: string): string[] {
  const { cv } = accountScope(accountId);
  if (!existsSync(cv.dir)) return [];
  return readdirSync(cv.dir).filter((name) => name.startsWith(cv.prefix)).map((name) => join(cv.dir, name));
}

function walk(accountId: string): Cached {
  const scope = accountScope(accountId);
  return {
    areas: {
      docs: pathBytes(scope.docs),
      cv: cvPaths(accountId).reduce((sum, p) => sum + pathBytes(p), 0),
      conversations: pathBytes(scope.conversations),
      learn: pathBytes(scope.learnFile),
      usage: pathBytes(scope.usageFile),
      workspace: pathBytes(scope.workspaceFile),
      site: pathBytes(scope.siteFile),
    },
    at: Date.now(),
  };
}

function cached(accountId: string): Cached {
  const map = cache();
  let entry = map.get(accountId);
  if (!entry || Date.now() - entry.at > recountMs()) {
    entry = walk(accountId);
    map.set(accountId, entry);
  }
  return entry;
}

/** Which area a path belongs to (for the cache delta). */
function areaOf(accountId: string, path: string): Exclude<StorageArea, "jobs"> {
  const scope = accountScope(accountId);
  if (path === scope.docs || path.startsWith(scope.docs + sep)) return "docs";
  if (path === scope.conversations || path.startsWith(scope.conversations + sep)) return "conversations";
  if (path === scope.learnFile) return "learn";
  if (path === scope.usageFile) return "usage";
  if (path === scope.workspaceFile) return "workspace";
  if (path === scope.siteFile) return "site";
  return "cv";
}

function note(accountId: string, path: string, delta: number): void {
  const entry = cache().get(accountId);
  if (!entry || delta === 0) return;
  const area = areaOf(accountId, path);
  entry.areas[area] = Math.max(0, entry.areas[area] + delta);
}

/** Forget the cached total (next read walks the disk again). */
export function invalidateUsage(accountId: string): void {
  cache().delete(accountId);
}

/**
 * null = unlimited. An id without an account record has no quota to apply: every route resolves the account before it
 * writes (`authenticate`, the office callback's `getAccount`), so this only happens to the stores' own unit tests.
 */
export function quotaFor(accountId: string): number | null {
  const account = getAccount(accountId);
  if (!account) return null;
  // Same rule as `isAdmin` (src/lib/accounts/authz.ts), restated here because authz pulls in next/server, which the
  // stores (and their node:test unit tests) must not load.
  if (!isPublicMode() || account.role === "admin") return null;
  return account.storageQuotaBytes;
}

export function storageUsage(accountId: string): StorageUsage {
  const { areas } = cached(accountId);
  const jobs = jobStore().usedBytes(accountId);
  const usedBytes = Object.values(areas).reduce((a, b) => a + b, 0) + jobs;
  const quotaBytes = quotaFor(accountId);
  return {
    usedBytes,
    quotaBytes,
    fraction: quotaBytes === null ? 0 : quotaBytes === 0 ? 1 : Math.min(1, usedBytes / quotaBytes),
    areas: { ...areas, jobs },
  };
}

/** Throws QuotaExceededError when `addBytes` more would not fit. No-op for unlimited accounts and for `addBytes <= 0`. */
export function assertCanStore(accountId: string, addBytes: number): void {
  if (addBytes <= 0) return;
  const quota = quotaFor(accountId);
  if (quota === null) return;
  const { usedBytes } = storageUsage(accountId);
  if (usedBytes + addBytes > quota) throw new QuotaExceededError(usedBytes, quota, addBytes);
}

/** assertCanStore as a boolean. */
export function canStore(accountId: string, addBytes: number): boolean {
  try {
    assertCanStore(accountId, addBytes);
    return true;
  } catch (error) {
    if (error instanceof QuotaExceededError) return false;
    throw error;
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Atomic 0600 write of one per-account file, sealed with the account's storage key (`./sealed.ts`; read it back with
 * `readAccountFile` / `readAccountText`), with the quota check: only the growth counts (overwriting a file with a
 * smaller one always passes). Creates the parent directory (0700).
 */
export function writeAccountFile(accountId: string, path: string, contents: string | Uint8Array, options: { enforce?: boolean } = {}): void {
  const sealed = sealAccountBytes(accountId, contents);
  const delta = sealed.byteLength - sizeOf(path);
  if (options.enforce !== false) assertCanStore(accountId, delta);
  parentDir(path);
  writePrivateFile(path, sealed);
  note(accountId, path, delta);
}

/** rm -rf of a per-account path; returns the bytes freed. */
export function removeAccountPath(accountId: string, path: string): number {
  if (!existsSync(path)) return 0;
  const bytes = pathBytes(path);
  rmSync(path, { recursive: true, force: true });
  note(accountId, path, -bytes);
  return bytes;
}

/** Bytes appeared or went away by other means (a rename inside the account changes nothing; a copy does). */
export function noteBytes(accountId: string, path: string, delta: number): void {
  note(accountId, path, delta);
}
