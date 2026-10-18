import { statfsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Free-space floor for the filesystems the server writes user bytes to: the data dir (account files, `quota.ts`) and the
 * upload/scratch dir (`os.tmpdir()`, `upload-budget.ts`). docs/ACCOUNTS.md "Storage quota".
 *
 * Threat model: per-account quotas bound one account, not N disposable accounts together, and an upload burst can fill a
 * (possibly RAM-backed) /tmp; once a filesystem is full every account, the admin and the account store itself break.
 * So a write that would leave less than the floor free is refused before any byte is written (fail closed: an
 * unreadable filesystem counts as full). This module only answers; the callers throw their own typed errors
 * (`StorageFullError` in quota.ts = 507, `UploadBudgetError` in upload-budget.ts = 503).
 *
 * The floor is the LARGER of KNIFE_DISK_FLOOR_GB (default 10) and KNIFE_DISK_FLOOR_PERCENT (default 10) of the filesystem;
 * 0 disables that part. `statfs` is cached per path for KNIFE_DISK_FLOOR_CACHE_SEC (default 10 s) and the bytes admitted
 * since the last call are subtracted from the cached free space, so a burst inside one cache window cannot overshoot it.
 */

export interface DiskSpace {
  totalBytes: number;
  freeBytes: number;
}

interface Cached {
  space: DiskSpace | null;
  at: number;
  /** Bytes admitted since `at` (not yet visible in `space`). */
  admitted: number;
}

const MAX_PATHS = 64;
const CACHE_KEY = Symbol.for("samurai-knife.disk-floor.v1");

function cache(): Map<string, Cached> {
  const holder = globalThis as unknown as Record<symbol, Map<string, Cached> | undefined>;
  if (!(holder[CACHE_KEY] instanceof Map)) holder[CACHE_KEY] = new Map();
  return holder[CACHE_KEY];
}

function numberFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** The floor in bytes for a filesystem of `totalBytes`. */
export function floorBytes(totalBytes: number): number {
  const gb = numberFromEnv("KNIFE_DISK_FLOOR_GB", 10) * 1024 ** 3;
  const percent = Math.min(100, numberFromEnv("KNIFE_DISK_FLOOR_PERCENT", 10));
  return Math.max(gb, (totalBytes * percent) / 100);
}

/** Test seam: replaces statfs (null = the real one). */
let probe: ((path: string) => DiskSpace) | null = null;
export function setDiskProbeForTests(fn: ((path: string) => DiskSpace) | null): void {
  probe = fn;
  cache().clear();
}

function measure(path: string): DiskSpace | null {
  try {
    if (probe) return probe(path);
    const stats = statfsSync(path);
    // bavail: blocks an unprivileged writer may use (the root reserve is not ours).
    return { totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize };
  } catch {
    return null;
  }
}

function entry(path: string): Cached {
  const key = resolve(path);
  const map = cache();
  const ttl = numberFromEnv("KNIFE_DISK_FLOOR_CACHE_SEC", 10) * 1000;
  let found = map.get(key);
  if (!found || Date.now() - found.at > ttl) {
    found = { space: measure(key), at: Date.now(), admitted: 0 };
    map.delete(key);
    // Keys are server paths (data dir, tmpdir), never request data; the cap is a backstop.
    if (map.size >= MAX_PATHS) map.delete(map.keys().next().value as string);
    map.set(key, found);
  }
  return found;
}

/** Free bytes as the floor sees them (cached statfs minus what was admitted since), or null when unreadable. */
export function freeBytes(path: string): number | null {
  const found = entry(path);
  return found.space ? Math.max(0, found.space.freeBytes - found.admitted) : null;
}

/**
 * True (and the bytes are counted as admitted) when writing `addBytes` more under `path` leaves at least the floor free.
 * `addBytes <= 0` (an overwrite that shrinks, a delete) always passes; an unreadable filesystem never does.
 */
export function admitDiskBytes(path: string, addBytes: number): boolean {
  if (addBytes <= 0) return true;
  const found = entry(path);
  if (!found.space) return false;
  const free = found.space.freeBytes - found.admitted;
  if (free - addBytes < floorBytes(found.space.totalBytes)) return false;
  found.admitted += addBytes;
  return true;
}

/** Forget every cached measurement (tests, or after an operator freed space). */
export function resetDiskFloorCache(): void {
  cache().clear();
}
