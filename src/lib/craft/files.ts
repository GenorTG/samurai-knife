import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { ARTCRAFT_APPS } from "@/lib/services/definitions";
import { readAccountFile, readAccountText } from "@/lib/storage/sealed";
import { assertCanStore, removeAccountPath, writeAccountFile } from "@/lib/storage/quota";
import { accountScope, ensurePrivateDir, safeJoin } from "@/lib/storage/scope";

/**
 * Files the Craft apps save to the signed-in account (docs/SIDECARS.md "Craft files"): an app's Save/Export is caught on
 * the craft origin by the bridge page (sidecars/craft/knife-bridge/) and handed to the Smart Knife page, which uploads
 * it here; an app's Open shows Smart Knife's own chooser, which reads them back. One folder per account,
 * `craft-files/<id>/`: `index.json` (metadata) and one `<file id>.bin` per file, both sealed at rest and counted by the
 * quota (area `craft`). Saving the same name again from the same app replaces the file (that is what Save means in the
 * app). Never served with a type a browser renders: downloads are `application/octet-stream` attachments.
 */

export const MAX_CRAFT_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_CRAFT_FILES = 500;
const ID = /^[0-9a-f]{20}$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;

export interface CraftFile {
  id: string;
  name: string;
  /** The app that saved it (an ARTCRAFT_APPS id). */
  app: string;
  mime: string;
  size: number;
  createdAt: string;
  updatedAt: string;
}

export class CraftFileError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** A file name a person would recognise and no filesystem or header can misread: no paths, controls, quotes. */
export function cleanFileName(name: string): string {
  const base = String(name ?? "")
    .split(/[\\/]/)
    .pop()!
    .replace(/[\u0000-\u001f\u007f"<>|*?:]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  const cut = base.length > 160 ? base.slice(0, 160) : base;
  return cut || "untitled";
}

export function cleanMime(mime: string): string {
  const value = String(mime ?? "").trim().toLowerCase().split(";")[0];
  return MIME.test(value) ? value : "application/octet-stream";
}

function dir(accountId: string): string {
  return ensurePrivateDir(accountScope(accountId).craftFiles);
}

function indexPath(accountId: string): string {
  return safeJoin(dir(accountId), "index.json");
}

function blobPath(accountId: string, id: string): string {
  if (!ID.test(id)) throw new CraftFileError("Unknown file.", 404);
  return safeJoin(dir(accountId), `${id}.bin`);
}

function readIndex(accountId: string): CraftFile[] {
  const path = indexPath(accountId);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readAccountText(accountId, path)) as unknown;
    return Array.isArray(parsed) ? (parsed as CraftFile[]).filter((file) => file && ID.test(file.id)) : [];
  } catch {
    return [];
  }
}

function writeIndex(accountId: string, files: CraftFile[]): void {
  // Metadata is bookkeeping (tiny): never refused, like the office library's (quota.ts header).
  writeAccountFile(accountId, indexPath(accountId), JSON.stringify(files), { enforce: false });
}

export function listCraftFiles(accountId: string): CraftFile[] {
  return readIndex(accountId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getCraftFile(accountId: string, id: string): CraftFile {
  const file = readIndex(accountId).find((candidate) => candidate.id === id);
  if (!file) throw new CraftFileError("Unknown file.", 404);
  return file;
}

export function readCraftFile(accountId: string, id: string): { file: CraftFile; bytes: Buffer } {
  const file = getCraftFile(accountId, id);
  const path = blobPath(accountId, id);
  if (!existsSync(path)) throw new CraftFileError("The file's contents are missing.", 410);
  return { file, bytes: readAccountFile(accountId, path) };
}

/**
 * Stores what an app saved. Same app + same name = the same file, replaced (only the growth counts against the quota);
 * otherwise a new one. Throws QuotaExceededError (507) when it does not fit, CraftFileError for bad input.
 */
export function saveCraftFile(accountId: string, input: { app: string; name: string; mime?: string; bytes: Uint8Array }, now = new Date()): CraftFile {
  if (!ARTCRAFT_APPS.some((app) => app.id === input.app)) throw new CraftFileError("Unknown app.");
  if (input.bytes.byteLength === 0) throw new CraftFileError("The app saved an empty file.");
  if (input.bytes.byteLength > MAX_CRAFT_FILE_BYTES) throw new CraftFileError(`Files over ${MAX_CRAFT_FILE_BYTES / 1048576} MB cannot be saved to your files; download it instead.`, 413);
  const name = cleanFileName(input.name);
  const files = readIndex(accountId);
  const existing = files.find((file) => file.app === input.app && file.name === name);
  if (!existing && files.length >= MAX_CRAFT_FILES) throw new CraftFileError(`You have ${MAX_CRAFT_FILES} Craft files; delete some first.`, 409);
  const at = now.toISOString();
  const file: CraftFile = existing
    ? { ...existing, mime: cleanMime(input.mime ?? existing.mime), size: input.bytes.byteLength, updatedAt: at }
    : { id: randomBytes(10).toString("hex"), name, app: input.app, mime: cleanMime(input.mime ?? ""), size: input.bytes.byteLength, createdAt: at, updatedAt: at };
  // Quota first (writeAccountFile counts only the growth over the file it replaces), then the index.
  writeAccountFile(accountId, blobPath(accountId, file.id), input.bytes);
  writeIndex(accountId, [file, ...files.filter((candidate) => candidate.id !== file.id)]);
  return file;
}

export function deleteCraftFile(accountId: string, id: string): void {
  const files = readIndex(accountId);
  if (!files.some((file) => file.id === id)) throw new CraftFileError("Unknown file.", 404);
  removeAccountPath(accountId, blobPath(accountId, id));
  writeIndex(accountId, files.filter((file) => file.id !== id));
}

/** Room check before reading a big body: the declared size must fit (the write checks again, exactly). */
export function assertCraftRoom(accountId: string, bytes: number): void {
  assertCanStore(accountId, bytes);
}

const RATE = Symbol.for("samurai-knife.craft-files.rate.v1");

/**
 * At most `perMinute` saves a minute per account (default 30): app code on the craft origin can reach the bridge, so a
 * buggy or hostile app must not be able to fill an account with files at full speed (docs/SIDECARS.md "Craft files").
 */
export function takeSaveSlot(accountId: string, perMinute = 30, now = Date.now()): boolean {
  const holder = globalThis as unknown as Record<symbol, Map<string, number[]> | undefined>;
  const map: Map<string, number[]> = (holder[RATE] ??= new Map<string, number[]>());
  const recent = (map.get(accountId) ?? []).filter((at) => now - at < 60_000);
  if (recent.length >= perMinute) {
    map.set(accountId, recent);
    return false;
  }
  recent.push(now);
  map.set(accountId, recent);
  if (map.size > 10_000) map.delete(map.keys().next().value as string);
  return true;
}
