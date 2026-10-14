import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ensureDataDir, writePrivateFile } from "@/lib/accounts/store";
import { cvDataSchema, emptyCvData, type CvData } from "./schema";

/**
 * Server-only persistence: `$KNIFE_DATA_DIR/cv/<account id>.json` plus a rolling ring of snapshots for undo.
 * Synchronous reads/writes on the single Node thread serialise concurrent requests (same model as the usage ledger).
 * Personal data: lives in the data dir, never in the repo.
 */

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const KEEP_SNAPSHOTS = 40;

export class CvStoreError extends Error {}

function dirs(accountId: string): { file: string; snaps: string } {
  if (!SAFE_ID.test(accountId)) throw new CvStoreError("invalid account id");
  const base = join(ensureDataDir(), "cv");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  return { file: join(base, `${accountId}.json`), snaps: join(base, `${accountId}.snapshots`) };
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

function snapshot(file: string, snaps: string, revision: number): void {
  if (!existsSync(file)) return;
  mkdirSync(snaps, { recursive: true, mode: 0o700 });
  // Millisecond stamp + the revision being saved over: two saves in one millisecond (parallel tool calls) used to share a name,
  // so the older state was overwritten and one undo step vanished. Names still sort oldest to newest.
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-r${String(revision).padStart(8, "0")}`;
  writePrivateFile(join(snaps, `${stamp}.json`), readFileSync(file, "utf8"));
  const all = readdirSync(snaps).filter((n) => n.endsWith(".json")).sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP_SNAPSHOTS))) unlinkSync(join(snaps, old));
}

/** Validate, snapshot the previous state, bump the revision, write. Returns what was stored. */
export function saveCv(accountId: string, data: CvData): CvData {
  const { file, snaps } = dirs(accountId);
  const current = existsSync(file) ? loadCv(accountId) : null;
  const next = cvDataSchema.parse({ ...data, revision: (current?.revision ?? data.revision) + 1 });
  snapshot(file, snaps, current?.revision ?? 0);
  writePrivateFile(file, JSON.stringify(next, null, 2));
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
  writePrivateFile(file, JSON.stringify({ ...restored, revision: live.revision + 1 }, null, 2));
  unlinkSync(path);
  return true;
}
