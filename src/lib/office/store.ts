import * as z from "zod/v4";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { ACCOUNT_ID_PATTERN, ensureDataDir, writePrivateFile } from "@/lib/accounts/store";
import { OFFICE_FORMATS, type OfficeFormat } from "./templates";

/**
 * Per-account office document library: `$KNIFE_DATA_DIR/docs/<account>/<docId>/` with
 *   meta.json        name, format, version, the Document Server `key`, timestamps
 *   current.<fmt>    the latest bytes
 *   history/v<N>.<fmt>  the previous KEEP_VERSIONS versions (a bad save is recoverable by hand)
 * The `key` identifies one version for the Document Server's cache: it changes whenever the bytes change outside an
 * editing session (upload replace, a finished session's save), so the server never serves a stale cached copy.
 */

export const MAX_DOC_BYTES = 50 * 1024 * 1024;
const KEEP_VERSIONS = 5;
const DOC_ID = /^[a-f0-9]{16}$/;

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
});

export type DocMeta = z.infer<typeof metaSchema>;

export class DocError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.status = status;
  }
}

function accountDir(accountId: string): string {
  if (!ACCOUNT_ID_PATTERN.test(accountId)) throw new DocError("invalid account id", 400);
  const dir = join(ensureDataDir(), "docs", accountId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function docDir(accountId: string, docId: string): string {
  if (!DOC_ID.test(docId)) throw new DocError("unknown document", 404);
  return join(accountDir(accountId), docId);
}

function newKey(docId: string, version: number): string {
  return `${docId}.${version}.${randomBytes(4).toString("hex")}`;
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

/** Display name with the format's extension; path separators/control characters removed, 120 chars max. */
export function cleanName(name: string, format: OfficeFormat): string {
  const split = splitName(name);
  let base = (split && split.format === format ? split.base : name).replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
  base = base.replace(/^[.\s]+/, "").slice(0, 120).trim() || "Untitled";
  return `${base}.${format}`;
}

export function isZipContainer(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function readMeta(accountId: string, docId: string): DocMeta | null {
  const file = join(docDir(accountId, docId), "meta.json");
  if (!existsSync(file)) return null;
  try {
    return metaSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

function writeMeta(accountId: string, meta: DocMeta): DocMeta {
  writePrivateFile(join(docDir(accountId, meta.id), "meta.json"), `${JSON.stringify(metaSchema.parse(meta), null, 2)}\n`);
  return meta;
}

export function listDocs(accountId: string): DocMeta[] {
  const dir = accountDir(accountId);
  const out: DocMeta[] = [];
  for (const entry of readdirSync(dir)) {
    if (!DOC_ID.test(entry)) continue;
    const meta = readMeta(accountId, entry);
    if (meta) out.push(meta);
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getDoc(accountId: string, docId: string): DocMeta {
  const meta = readMeta(accountId, docId);
  if (!meta) throw new DocError("unknown document", 404);
  return meta;
}

export function docFile(accountId: string, meta: DocMeta): string {
  return join(docDir(accountId, meta.id), `current.${meta.format}`);
}

export function readDocBytes(accountId: string, meta: DocMeta): Buffer {
  return readFileSync(docFile(accountId, meta));
}

function checkBytes(bytes: Uint8Array): void {
  if (bytes.length > MAX_DOC_BYTES) throw new DocError(`file is ${bytes.length} bytes; the limit is ${MAX_DOC_BYTES}`, 413);
  if (!isZipContainer(bytes)) throw new DocError("not an office file: OOXML (docx/xlsx/pptx) and ODF (odt/ods/odp) files are ZIP containers");
}

export function createDoc(accountId: string, input: { name: string; format: OfficeFormat; bytes: Uint8Array; source: DocMeta["source"] }): DocMeta {
  checkBytes(input.bytes);
  let id = randomBytes(8).toString("hex");
  while (existsSync(join(accountDir(accountId), id))) id = randomBytes(8).toString("hex");
  mkdirSync(docDir(accountId, id), { recursive: true, mode: 0o700 });
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
    source: input.source,
  };
  writePrivateFile(join(docDir(accountId, id), `current.${input.format}`), input.bytes);
  return writeMeta(accountId, meta);
}

/**
 * New bytes for a document. `rotateKey` = the editing session that produced them is over (status 2) or they came from
 * outside the editor: the next open must not reuse the server's cached copy. A force-save inside a live session (status 6)
 * keeps the key, as the session continues on it.
 */
export function saveVersion(accountId: string, docId: string, bytes: Uint8Array, options: { rotateKey: boolean; savedBy?: string; format?: OfficeFormat }): DocMeta {
  checkBytes(bytes);
  const meta = getDoc(accountId, docId);
  const format = options.format ?? meta.format;
  const dir = docDir(accountId, docId);
  const history = join(dir, "history");
  mkdirSync(history, { recursive: true, mode: 0o700 });
  const current = docFile(accountId, meta);
  if (existsSync(current)) writePrivateFile(join(history, `v${meta.version}.${meta.format}`), readFileSync(current));
  for (const old of readdirSync(history)) {
    const n = Number(/^v(\d+)\./.exec(old)?.[1]);
    if (Number.isFinite(n) && n <= meta.version - KEEP_VERSIONS) rmSync(join(history, old), { force: true });
  }
  // The server may hand back another format than it was given (it reports `filetype`): rename with the bytes.
  if (format !== meta.format) rmSync(current, { force: true });
  writePrivateFile(join(dir, `current.${format}`), bytes);
  const version = meta.version + 1;
  return writeMeta(accountId, {
    ...meta,
    format,
    name: format === meta.format ? meta.name : cleanName(meta.name.replace(/\.[A-Za-z0-9]+$/, ""), format),
    bytes: bytes.length,
    version,
    key: options.rotateKey ? newKey(docId, version) : meta.key,
    updatedAt: new Date().toISOString(),
    lastSavedBy: options.savedBy,
  });
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

export function deleteDoc(accountId: string, docId: string): boolean {
  const dir = docDir(accountId, docId);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
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
