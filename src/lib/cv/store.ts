import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertCanStore, removeAccountPath, writeAccountFile } from "@/lib/storage/quota";
import { accountScope, ensurePrivateDir, StorageScopeError } from "@/lib/storage/scope";
import { cvDataSchema, emptyCvData, type CvData } from "./schema";

/**
 * Server-only persistence: `$KNIFE_DATA_DIR/cv/<account id>.json` plus a rolling ring of snapshots for undo (paths from
 * `accountScope`). Retention: the newest KEEP_SNAPSHOTS snapshots and at most SNAPSHOT_BYTES of them; the CV file and its
 * snapshots count toward the account's storage quota (a save that would not fit is refused with QuotaExceededError).
 * Synchronous reads/writes on the single Node thread serialise concurrent requests (same model as the usage ledger).
 * Personal data: lives in the data dir, never in the repo.
 */

const KEEP_SNAPSHOTS = 40;
const SNAPSHOT_BYTES = 20 * 1024 * 1024;

export class CvStoreError extends Error {}

function dirs(accountId: string): { file: string; snaps: string } {
  try {
    const { cv } = accountScope(accountId);
    ensurePrivateDir(cv.dir);
    return { file: cv.file, snaps: cv.snapshots };
  } catch (error) {
    if (error instanceof StorageScopeError) throw new CvStoreError("invalid account id");
    throw error;
  }
}

/** JSON.parse that fails as a CvStoreError (a hand-edited or truncated file otherwise escapes as a bare SyntaxError and an opaque 500). */
function readStoredJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new CvStoreError("stored CV data is not valid JSON (edited by hand or cut short); restore it from a snapshot");
  }
}

export function loadCv(accountId: string): CvData {
  const { file } = dirs(accountId);
  if (!existsSync(file)) return emptyCvData();
  const parsed = cvDataSchema.safeParse(readStoredJson(file));
  if (!parsed.success) {
    throw new CvStoreError(`stored CV data is invalid at ${parsed.error.issues[0].path.join("/") || "/"}: ${parsed.error.issues[0].message}`);
  }
  return parsed.data;
}

function snapshot(accountId: string, file: string, snaps: string, revision: number): void {
  if (!existsSync(file)) return;
  ensurePrivateDir(snaps);
  // Millisecond stamp + the revision being saved over: two saves in one millisecond (parallel tool calls) used to share a name,
  // so the older state was overwritten and one undo step vanished. Names still sort oldest to newest.
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-r${String(revision).padStart(8, "0")}`;
  // Snapshots are bookkeeping of a save that already passed the quota check: never refused on their own.
  writeAccountFile(accountId, join(snaps, `${stamp}.json`), readFileSync(file, "utf8"), { enforce: false });
  pruneSnapshots(accountId, snaps);
}

/** Retention: newest KEEP_SNAPSHOTS, and the newest ones that fit in SNAPSHOT_BYTES (the newest one always stays). */
function pruneSnapshots(accountId: string, snaps: string): void {
  const all = readdirSync(snaps).filter((n) => n.endsWith(".json")).sort().reverse();
  let bytes = 0;
  all.forEach((name, index) => {
    const path = join(snaps, name);
    bytes += statSync(path).size;
    if (index >= KEEP_SNAPSHOTS || (index > 0 && bytes > SNAPSHOT_BYTES)) removeAccountPath(accountId, path);
  });
}

/** Validate, snapshot the previous state, bump the revision, write. Returns what was stored. */
export function saveCv(accountId: string, data: CvData): CvData {
  const { file, snaps } = dirs(accountId);
  const current = existsSync(file) ? loadCv(accountId) : null;
  const next = cvDataSchema.parse({ ...data, revision: (current?.revision ?? data.revision) + 1 });
  const text = JSON.stringify(next, null, 2);
  // Growth = the new file (it replaces the old one, whose bytes move into a snapshot). Checked first, so a refused save
  // leaves no orphan snapshot behind.
  assertCanStore(accountId, Buffer.byteLength(text));
  snapshot(accountId, file, snaps, current?.revision ?? 0);
  writeAccountFile(accountId, file, text, { enforce: false });
  return next;
}

/** Read-modify-write in one synchronous step. */
export function mutateCv<T>(accountId: string, fn: (data: CvData) => { data: CvData; result: T }): { data: CvData; result: T } {
  const { data, result } = fn(loadCv(accountId));
  return { data: saveCv(accountId, data), result };
}

/** Restore the newest snapshot (the state before the last save). False when there is nothing to undo. */
export function undoCv(accountId: string): boolean {
  const { file, snaps } = dirs(accountId);
  if (!existsSync(snaps)) return false;
  const all = readdirSync(snaps).filter((n) => n.endsWith(".json")).sort();
  const newest = all.at(-1);
  if (!newest) return false;
  const path = join(snaps, newest);
  const restored = cvDataSchema.parse(readStoredJson(path));
  const live = existsSync(file) ? loadCv(accountId) : restored;
  // Keep the revision monotonic so pollers see the undo as a change.
  writeAccountFile(accountId, file, JSON.stringify({ ...restored, revision: live.revision + 1 }, null, 2), { enforce: false });
  removeAccountPath(accountId, path);
  return true;
}
