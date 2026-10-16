import * as z from "zod/v4";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { assertCanStore, canStore, removeAccountPath, writeAccountFile } from "@/lib/storage/quota";
import { accountScope, ensurePrivateDir, StorageScopeError } from "@/lib/storage/scope";
import { OFFICE_FORMATS, type OfficeFormat } from "./templates";

/**
 * Per-account office library: `$KNIFE_DATA_DIR/docs/<account>/` (the path comes from `accountScope`) with
 *   folders.json                 the folder tree (folders.ts)
 *   <docId>/meta.json            name, format, folder, version, the Document Server `key`, kept versions, trash state
 *   <docId>/current.<fmt>        the latest bytes
 *   <docId>/history/v<N>.<fmt>   earlier versions (every save keeps the previous bytes as a version), at most MAX_VERSIONS
 *                                per document; restore = a new version with the old bytes, prune = drop the oldest
 * The `key` identifies one version for the Document Server's cache: it changes whenever the bytes change outside an
 * editing session (upload, restore, a finished session's save), so the server never serves a stale cached copy.
 *
 * Trash: `trashedAt` + `trashedWith` (the id the user trashed: the document itself, or a folder whose whole subtree went
 * with it). Trashed documents keep their bytes (and count toward the quota) until restored, deleted for good, or purged
 * TRASH_DAYS after trashing. Every byte here counts toward the account's storage quota (src/lib/storage/quota.ts).
 */

export const MAX_DOC_BYTES = 50 * 1024 * 1024;
export const MAX_VERSIONS = 25;
export const TRASH_DAYS = 30;
const DOC_ID = /^[a-f0-9]{16}$/;

export const VERSION_SOURCES = ["blank", "upload", "assistant", "editor", "restore", "copy"] as const;
export type VersionSource = (typeof VERSION_SOURCES)[number];

const versionSchema = z.object({
  version: z.number().int().min(1),
  format: z.enum(OFFICE_FORMATS),
  bytes: z.number().int().min(0),
  savedAt: z.string(),
  savedBy: z.string().max(200).optional(),
  source: z.enum(VERSION_SOURCES).optional(),
  /** Restores name the version they brought back. */
  restoredFrom: z.number().int().min(1).optional(),
});

export type DocVersion = z.infer<typeof versionSchema>;

const metaSchema = z.object({
  id: z.string().regex(DOC_ID),
  name: z.string().min(1).max(160),
  format: z.enum(OFFICE_FORMATS),
  bytes: z.number().int().min(0),
  version: z.number().int().min(1),
  key: z.string().regex(/^[0-9A-Za-z._=-]{1,128}$/),
  createdAt: z.string(),
  updatedAt: z.string(),
  source: z.enum(["blank", "upload", "assistant"]),
  lastSavedBy: z.string().optional(),
  /** Folder id (folders.ts), null = the library root. Absent in files from before folders. */
  folderId: z.string().regex(DOC_ID).nullable().default(null),
  /** When the CURRENT bytes were written (updatedAt also moves on rename/move). Absent in older files = updatedAt. */
  contentAt: z.string().optional(),
  /** How the current bytes came to be. */
  versionSource: z.enum(VERSION_SOURCES).optional(),
  restoredFrom: z.number().int().min(1).optional(),
  /** Earlier versions kept in history/, oldest first (absent in older files: derived from the directory). */
  versions: z.array(versionSchema).max(MAX_VERSIONS + 5).optional(),
  trashedAt: z.string().optional(),
  trashedWith: z.string().regex(DOC_ID).optional(),
  /** Set when the editor's last save was refused (storage full); cleared by the next successful save. */
  lastSaveError: z.object({ at: z.string(), message: z.string().max(500) }).optional(),
});

export type DocMeta = z.infer<typeof metaSchema>;

export class DocError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.status = status;
  }
}

function scopeOf(accountId: string) {
  try {
    return accountScope(accountId);
  } catch (error) {
    if (error instanceof StorageScopeError) throw new DocError("invalid account id", 400);
    throw error;
  }
}

/** `docs/<account>/`, created 0700. */
export function libraryDir(accountId: string): string {
  return ensurePrivateDir(scopeOf(accountId).docs);
}

/** A path inside one document's directory (the id is checked first: a bad id is a plain 404). */
function docPath(accountId: string, docId: string, ...parts: string[]): string {
  if (!DOC_ID.test(docId)) throw new DocError("unknown document", 404);
  return scopeOf(accountId).join("docs", docId, ...parts);
}

function historyFile(accountId: string, docId: string, version: number, format: OfficeFormat): string {
  return docPath(accountId, docId, "history", `v${version}.${format}`);
}

function newKey(docId: string, version: number): string {
  return `${docId}.${version}.${randomBytes(4).toString("hex")}`;
}

export function newId(): string {
  return randomBytes(8).toString("hex");
}

export function isDocId(value: string): boolean {
  return DOC_ID.test(value);
}

export function isOfficeFormat(value: string): value is OfficeFormat {
  return (OFFICE_FORMATS as readonly string[]).includes(value);
}

/** "My file.DOCX" -> {base "My file", format "docx"}; null when the extension is not supported. */
export function splitName(fileName: string): { base: string; format: OfficeFormat } | null {
  const match = /^(.*)\.([A-Za-z0-9]+)$/.exec(fileName.trim());
  if (!match) return null;
  const format = match[2].toLowerCase();
  return isOfficeFormat(format) ? { base: match[1], format } : null;
}

/** A display name without path separators/control characters, `max` chars, never empty or starting with a dot. */
export function cleanBase(name: string, max = 120): string {
  const base = name.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
  return base.replace(/^[.\s]+/, "").slice(0, max).trim() || "Untitled";
}

/** Display name with the format's extension; path separators/control characters removed, 120 chars max. */
export function cleanName(name: string, format: OfficeFormat): string {
  const split = splitName(name);
  return `${cleanBase(split && split.format === format ? split.base : name)}.${format}`;
}

function baseOf(name: string): string {
  return name.replace(/\.[A-Za-z0-9]+$/, "");
}

export function isZipContainer(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function readMeta(accountId: string, docId: string): DocMeta | null {
  const file = docPath(accountId, docId, "meta.json");
  if (!existsSync(file)) return null;
  try {
    return metaSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

function writeMeta(accountId: string, meta: DocMeta): DocMeta {
  // Metadata is bookkeeping of a change whose bytes already passed the quota check.
  writeAccountFile(accountId, docPath(accountId, meta.id, "meta.json"), `${JSON.stringify(metaSchema.parse(meta), null, 2)}\n`, { enforce: false });
  return meta;
}

/** Every document of the account, trashed ones included (callers filter). Purges trash older than TRASH_DAYS. */
export function allDocs(accountId: string): DocMeta[] {
  const dir = libraryDir(accountId);
  const out: DocMeta[] = [];
  const purgeBefore = new Date(Date.now() - TRASH_DAYS * 86_400_000).toISOString();
  for (const entry of readdirSync(dir)) {
    if (!DOC_ID.test(entry)) continue;
    const meta = readMeta(accountId, entry);
    if (!meta) continue;
    if (meta.trashedAt && meta.trashedAt < purgeBefore) {
      deleteDoc(accountId, meta.id);
      continue;
    }
    out.push(meta);
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Documents outside the trash, newest first. */
export function listDocs(accountId: string): DocMeta[] {
  return allDocs(accountId).filter((d) => !d.trashedAt);
}

export function getDoc(accountId: string, docId: string): DocMeta {
  const meta = readMeta(accountId, docId);
  if (!meta) throw new DocError("unknown document", 404);
  return meta;
}

/** Same as getDoc, but a trashed document is refused (opening, editing, copying need it restored first). */
export function getLiveDoc(accountId: string, docId: string): DocMeta {
  const meta = getDoc(accountId, docId);
  if (meta.trashedAt) throw new DocError(`${meta.name} is in the trash: restore it first.`, 409);
  return meta;
}

export function docFile(accountId: string, meta: DocMeta): string {
  return docPath(accountId, meta.id, `current.${meta.format}`);
}

export function readDocBytes(accountId: string, meta: DocMeta): Buffer {
  return readFileSync(docFile(accountId, meta));
}

function checkBytes(bytes: Uint8Array): void {
  if (bytes.length > MAX_DOC_BYTES) throw new DocError(`file is ${bytes.length} bytes; the limit is ${MAX_DOC_BYTES}`, 413);
  if (!isZipContainer(bytes)) throw new DocError("not an office file: OOXML (docx/xlsx/pptx) and ODF (odt/ods/odp) files are ZIP containers");
}

export interface CreateInput {
  name: string;
  format: OfficeFormat;
  bytes: Uint8Array;
  source: DocMeta["source"];
  folderId?: string | null;
  versionSource?: VersionSource;
}

/** New document (QuotaExceededError when it does not fit). The folder must exist: callers check with folders.ts. */
export function createDoc(accountId: string, input: CreateInput): DocMeta {
  checkBytes(input.bytes);
  // The file plus its metadata (~1 KB).
  assertCanStore(accountId, input.bytes.length + 1024);
  libraryDir(accountId);
  let id = newId();
  while (existsSync(docPath(accountId, id))) id = newId();
  ensurePrivateDir(docPath(accountId, id));
  const now = new Date().toISOString();
  const meta: DocMeta = {
    id,
    name: cleanName(input.name, input.format),
    format: input.format,
    bytes: input.bytes.length,
    version: 1,
    key: newKey(id, 1),
    createdAt: now,
    updatedAt: now,
    contentAt: now,
    source: input.source,
    versionSource: input.versionSource ?? input.source,
    folderId: input.folderId ?? null,
    versions: [],
  };
  writeAccountFile(accountId, docPath(accountId, id, `current.${input.format}`), input.bytes, { enforce: false });
  return writeMeta(accountId, meta);
}

/** Versions kept in history/, oldest first: the recorded list, plus files from before the list existed. */
export function listVersions(accountId: string, meta: DocMeta): DocVersion[] {
  const known = new Map((meta.versions ?? []).map((v) => [v.version, v]));
  const dir = docPath(accountId, meta.id, "history");
  const out: DocVersion[] = [];
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      const match = /^v(\d+)\.([a-z]+)$/.exec(name);
      if (!match || !isOfficeFormat(match[2])) continue;
      const version = Number(match[1]);
      const recorded = known.get(version);
      if (recorded && recorded.format === match[2]) {
        out.push(recorded);
        continue;
      }
      const stat = statSync(docPath(accountId, meta.id, "history", name));
      out.push({ version, format: match[2], bytes: stat.size, savedAt: stat.mtime.toISOString() });
    }
  }
  return out.sort((a, b) => a.version - b.version);
}

/** One kept version (404 when it is not there). */
export function getVersion(accountId: string, meta: DocMeta, version: number): DocVersion {
  const found = listVersions(accountId, meta).find((v) => v.version === version);
  if (!found) throw new DocError(`version ${version} of ${meta.name} is not kept`, 404);
  return found;
}

export function readVersionBytes(accountId: string, meta: DocMeta, version: number): { version: DocVersion; bytes: Buffer } {
  const found = getVersion(accountId, meta, version);
  return { version: found, bytes: readFileSync(historyFile(accountId, meta.id, found.version, found.format)) };
}

function dropVersions(accountId: string, meta: DocMeta, versions: DocVersion[]): number {
  let freed = 0;
  for (const v of versions) freed += removeAccountPath(accountId, historyFile(accountId, meta.id, v.version, v.format));
  return freed;
}

export interface SaveOptions {
  rotateKey: boolean;
  savedBy?: string;
  format?: OfficeFormat;
  source?: VersionSource;
  restoredFrom?: number;
  /**
   * The editor's save (Document Server callback): when the new bytes do not fit the quota, this document's OLDEST kept
   * versions are dropped first (the newest content wins over old backups); only if it still does not fit is it refused.
   */
  makeRoom?: boolean;
}

/**
 * New bytes for a document; the previous current bytes become a kept version. `rotateKey` = the editing session that
 * produced them is over (status 2) or they came from outside the editor: the next open must not reuse the server's cached
 * copy. A force-save inside a live session (status 6) keeps the key, as the session continues on it.
 */
export function saveVersion(accountId: string, docId: string, bytes: Uint8Array, options: SaveOptions): DocMeta {
  checkBytes(bytes);
  const meta = getDoc(accountId, docId);
  let kept = listVersions(accountId, meta);
  // Growth = the new current file (the old one moves into history).
  if (options.makeRoom) {
    while (kept.length && !canStore(accountId, bytes.length)) {
      dropVersions(accountId, meta, [kept[0]]);
      kept = kept.slice(1);
    }
  }
  assertCanStore(accountId, bytes.length);
  const format = options.format ?? meta.format;
  ensurePrivateDir(docPath(accountId, docId, "history"));
  const current = docFile(accountId, meta);
  if (existsSync(current)) {
    writeAccountFile(accountId, historyFile(accountId, docId, meta.version, meta.format), readFileSync(current), { enforce: false });
    kept.push({
      version: meta.version,
      format: meta.format,
      bytes: meta.bytes,
      savedAt: meta.contentAt ?? meta.updatedAt,
      ...(meta.lastSavedBy ? { savedBy: meta.lastSavedBy } : {}),
      ...(meta.versionSource ? { source: meta.versionSource } : {}),
      ...(meta.restoredFrom ? { restoredFrom: meta.restoredFrom } : {}),
    });
  }
  if (kept.length > MAX_VERSIONS) {
    dropVersions(accountId, meta, kept.slice(0, kept.length - MAX_VERSIONS));
    kept = kept.slice(kept.length - MAX_VERSIONS);
  }
  // The server may hand back another format than it was given (it reports `filetype`): rename with the bytes.
  if (format !== meta.format) removeAccountPath(accountId, current);
  writeAccountFile(accountId, docPath(accountId, docId, `current.${format}`), bytes, { enforce: false });
  const version = meta.version + 1;
  const now = new Date().toISOString();
  return writeMeta(accountId, {
    ...meta,
    format,
    name: format === meta.format ? meta.name : cleanName(baseOf(meta.name), format),
    bytes: bytes.length,
    version,
    key: options.rotateKey ? newKey(docId, version) : meta.key,
    updatedAt: now,
    contentAt: now,
    lastSavedBy: options.savedBy,
    versionSource: options.source ?? "editor",
    restoredFrom: options.restoredFrom,
    versions: kept,
    lastSaveError: undefined,
  });
}

/** The editor's save was refused (storage full): remembered on the document so the open editor page can say so. */
export function noteSaveError(accountId: string, docId: string, message: string): void {
  const meta = readMeta(accountId, docId);
  if (meta) writeMeta(accountId, { ...meta, lastSaveError: { at: new Date().toISOString(), message: message.slice(0, 500) } });
}

/** Bring back version N as a NEW version (nothing is lost: the current bytes become a kept version too). */
export function restoreVersion(accountId: string, docId: string, version: number, savedBy?: string): DocMeta {
  const meta = getLiveDoc(accountId, docId);
  const { version: found, bytes } = readVersionBytes(accountId, meta, version);
  return saveVersion(accountId, docId, bytes, { rotateKey: true, savedBy, format: found.format, source: "restore", restoredFrom: found.version });
}

/** Keep only the newest `keep` versions; returns the bytes freed and how many went. */
export function pruneVersions(accountId: string, docId: string, keep: number): { doc: DocMeta; removed: number; freedBytes: number } {
  const meta = getDoc(accountId, docId);
  const kept = listVersions(accountId, meta);
  const drop = kept.slice(0, Math.max(0, kept.length - Math.max(0, keep)));
  const freedBytes = dropVersions(accountId, meta, drop);
  const doc = writeMeta(accountId, { ...meta, versions: kept.slice(drop.length) });
  return { doc, removed: drop.length, freedBytes };
}

/** Session over without changes after force-saves: give the next open a fresh key. */
export function rotateKey(accountId: string, docId: string, expectedKey: string): DocMeta | null {
  const meta = readMeta(accountId, docId);
  if (!meta || meta.key !== expectedKey) return meta;
  return writeMeta(accountId, { ...meta, key: newKey(docId, meta.version) });
}

export function renameDoc(accountId: string, docId: string, name: string): DocMeta {
  const meta = getDoc(accountId, docId);
  return writeMeta(accountId, { ...meta, name: cleanName(name, meta.format), updatedAt: new Date().toISOString() });
}

/** Move into a folder (null = root). The folder's existence is checked by the caller (folders.ts `assertFolder`). */
export function moveDoc(accountId: string, docId: string, folderId: string | null): DocMeta {
  const meta = getLiveDoc(accountId, docId);
  if (folderId !== null && !DOC_ID.test(folderId)) throw new DocError("unknown folder", 404);
  return writeMeta(accountId, { ...meta, folderId, updatedAt: new Date().toISOString() });
}

/** A copy of the current bytes as a new document "<name> (copy)" (its own history starts empty). */
export function duplicateDoc(accountId: string, docId: string, folderId?: string | null): DocMeta {
  const meta = getLiveDoc(accountId, docId);
  return createDoc(accountId, {
    name: `${baseOf(meta.name)} (copy)`,
    format: meta.format,
    bytes: readDocBytes(accountId, meta),
    source: "upload",
    versionSource: "copy",
    folderId: folderId === undefined ? meta.folderId : folderId,
  });
}

/** Into the trash (bytes kept). `withId` = the folder trashed together with it (default: the document itself). */
export function trashDoc(accountId: string, docId: string, withId?: string, at = new Date().toISOString()): DocMeta {
  const meta = getDoc(accountId, docId);
  if (meta.trashedAt) return meta;
  return writeMeta(accountId, { ...meta, trashedAt: at, trashedWith: withId ?? meta.id });
}

/** Out of the trash; `folderId` = where it lands (the caller resolves a folder that is gone or still trashed to root). */
export function untrashDoc(accountId: string, docId: string, folderId: string | null): DocMeta {
  const meta = getDoc(accountId, docId);
  return writeMeta(accountId, { ...meta, trashedAt: undefined, trashedWith: undefined, folderId, updatedAt: new Date().toISOString() });
}

/** Deletes the document and every kept version for good; returns whether it existed. */
export function deleteDoc(accountId: string, docId: string): boolean {
  const dir = docPath(accountId, docId);
  if (!existsSync(dir)) return false;
  removeAccountPath(accountId, dir);
  return true;
}

/** Bytes of one document's files (current + kept versions). */
export function docDiskBytes(accountId: string, meta: DocMeta): number {
  return listVersions(accountId, meta).reduce((sum, v) => sum + v.bytes, meta.bytes);
}

export function docStats(accountId: string): { count: number; bytes: number } {
  let bytes = 0;
  const docs = listDocs(accountId);
  for (const doc of docs) {
    try {
      bytes += statSync(docFile(accountId, doc)).size;
    } catch {
      /* missing file */
    }
  }
  return { count: docs.length, bytes };
}
