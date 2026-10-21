import { constants } from "node:fs";
import { lstat, open, readdir, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createGunzip } from "node:zlib";
import { securityDir } from "@/lib/security/events-core.mjs";
import { LOG_FILE, logRoot, retentionDays, SOURCE_ID } from "./core.mjs";

/**
 * Read side of the log files for the admin viewer (`GET /api/admin/logs`, /account/admin/logs). Read-only, admins only
 * (the route checks), and strict: a source is one of a fixed set of ids, a file name must match its source's pattern
 * (no `/`, no `..`, no other names), the resolved path must sit directly in the source folder, neither the folder nor the
 * file may be a symlink (O_NOFOLLOW), only regular files are read (a FIFO would hang: O_NONBLOCK + fstat), and every read
 * is bounded (the last `maxBytes` of a file; gzip streams are capped by decompressed size).
 */

export type LogSourceId = "app" | "update" | "security" | `sidecar:${string}`;

export interface LogFileView {
  name: string;
  size: number;
  mtime: string;
}

export interface LogSourceView {
  id: LogSourceId;
  label: string;
  description: string;
  files: LogFileView[];
}

export interface LogTail {
  source: LogSourceId;
  file: string;
  size: number;
  mtime: string;
  lines: string[];
  /** True when the file holds more than the returned lines. */
  truncated: boolean;
}

export class LogAccessError extends Error {
  readonly status: 400 | 404;
  constructor(message: string, status: 400 | 404) {
    super(message);
    this.status = status;
  }
}

export const MAX_TAIL_LINES = 5000;
const DEFAULT_TAIL_LINES = 500;
const MAX_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_GUNZIP_BYTES = 128 * 1024 * 1024;
const MAX_FILES_PER_SOURCE = 1000;
const SOURCE = /^(?:app|update|security|sidecar:[a-z0-9][a-z0-9-]{0,40})$/;
const SECURITY_FILE = /^events-(\d{4}-\d{2}-\d{2})(?:\.legacy)?\.jsonl$/;

interface SourceDef {
  dir: string;
  /** The file names this source may serve. */
  accepts: (name: string) => boolean;
  label: string;
  description: string;
}

const logFileOf = (prefix: string) => (name: string) => LOG_FILE.exec(name)?.[1] === prefix;

function sourceDef(id: string): SourceDef | null {
  if (!SOURCE.test(id)) return null;
  if (id === "security") {
    return { dir: securityDir(), accepts: (name) => SECURITY_FILE.test(name), label: "Security events", description: "Abuse-guard and policy events (JSON lines, kept 30 days in the data directory)." };
  }
  const root = logRoot();
  if (!root) return null;
  if (id === "app") return { dir: join(root, "app"), accepts: logFileOf("app"), label: "App server", description: "The server's output: startup checks, warnings, errors." };
  if (id === "update") return { dir: join(root, "update"), accepts: logFileOf("update"), label: "Updates", description: "Release builds and switches by knife-update (production installs)." };
  const sidecar = id.slice("sidecar:".length);
  if (!SOURCE_ID.test(sidecar)) return null;
  return { dir: join(root, "sidecars", sidecar), accepts: logFileOf("ops"), label: `Sidecar ${sidecar}`, description: `Install, start, stop, update and remove runs of the ${sidecar} sidecar.` };
}

/** A real directory (not a symlink), else null. */
async function realDir(dir: string): Promise<boolean> {
  try {
    const info = await lstat(dir);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function listFiles(def: SourceDef): Promise<LogFileView[]> {
  if (!(await realDir(def.dir))) return [];
  const files: LogFileView[] = [];
  for (const entry of await readdir(def.dir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !def.accepts(entry.name)) continue;
    try {
      const info = await lstat(join(def.dir, entry.name));
      files.push({ name: entry.name, size: info.size, mtime: info.mtime.toISOString() });
    } catch {
      // removed meanwhile
    }
  }
  // Newest first: by day in the name, then the live file before its rotated parts (.1 newest).
  const rank = (name: string) => {
    const match = LOG_FILE.exec(name) ?? SECURITY_FILE.exec(name);
    const day = match?.[2] ?? match?.[1] ?? "";
    const part = Number(LOG_FILE.exec(name)?.[3] ?? 0);
    return `${day}:${String(99 - part).padStart(2, "0")}`;
  };
  return files.sort((a, b) => (rank(a.name) < rank(b.name) ? 1 : rank(a.name) > rank(b.name) ? -1 : 0)).slice(0, MAX_FILES_PER_SOURCE);
}

/** Every source with its files (sidecar folders as they exist), plus where the logs live and how long they are kept. */
export async function listLogSources(): Promise<{ root: string | null; retentionDays: number; sources: LogSourceView[] }> {
  const root = logRoot();
  const ids: string[] = ["app", "update"];
  if (root && (await realDir(join(root, "sidecars")))) {
    const entries = await readdir(join(root, "sidecars"), { withFileTypes: true }).catch(() => []);
    for (const entry of entries.filter((e) => e.isDirectory() && SOURCE_ID.test(e.name)).sort((a, b) => a.name.localeCompare(b.name))) ids.push(`sidecar:${entry.name}`);
  }
  ids.push("security");
  const sources: LogSourceView[] = [];
  for (const id of ids) {
    const def = sourceDef(id);
    if (!def) continue;
    sources.push({ id: id as LogSourceId, label: def.label, description: def.description, files: await listFiles(def) });
  }
  return { root, retentionDays: retentionDays(), sources };
}

/** Opens one log file read-only after every check above; the caller closes the handle. */
export async function openLogFile(source: string, file: string): Promise<{ handle: FileHandle; size: number; mtime: Date; gz: boolean; name: string; source: LogSourceId }> {
  const def = sourceDef(source);
  if (!def) throw new LogAccessError("Unknown log source.", 400);
  if (!def.accepts(file)) throw new LogAccessError("Not a log file of this source.", 400);
  const dir = resolve(/*turbopackIgnore: true*/ def.dir);
  const path = resolve(dir, file);
  if (dirname(path) !== dir || basename(path) !== file) throw new LogAccessError("Not a log file of this source.", 400);
  if (!(await realDir(dir))) throw new LogAccessError("No such log file.", 404);
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    // ENOENT, or ELOOP for a symlink: the same answer, nothing to learn from the difference
    throw new LogAccessError("No such log file.", 404);
  }
  const info = await handle.stat();
  if (!info.isFile()) {
    await handle.close();
    throw new LogAccessError("No such log file.", 404);
  }
  return { handle, size: info.size, mtime: info.mtime, gz: file.endsWith(".gz"), name: file, source: source as LogSourceId };
}

/** The last `maxBytes` of a plain file. */
async function tailPlain(handle: FileHandle, size: number, maxBytes: number): Promise<{ text: string; cut: boolean }> {
  const length = Math.min(size, maxBytes);
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, size - length);
  return { text: buffer.subarray(0, bytesRead).toString("utf8"), cut: size > length };
}

/** The last `maxBytes` of a gzipped file's content, decompressing at most MAX_GUNZIP_BYTES (a bomb stops there). */
async function tailGzip(handle: FileHandle, maxBytes: number): Promise<{ text: string; cut: boolean; note?: string }> {
  const gunzip = createGunzip();
  const input = handle.createReadStream({ autoClose: false });
  input.pipe(gunzip);
  let chunks: Buffer[] = [];
  let held = 0;
  let total = 0;
  let note: string | undefined;
  try {
    for await (const chunk of gunzip as AsyncIterable<Buffer>) {
      total += chunk.length;
      chunks.push(chunk);
      held += chunk.length;
      if (held > maxBytes * 2) {
        const joined = Buffer.concat(chunks).subarray(-maxBytes);
        chunks = [joined];
        held = joined.length;
      }
      if (total > MAX_GUNZIP_BYTES) {
        note = `stopped after ${MAX_GUNZIP_BYTES / 1024 / 1024} MiB of decompressed text: download the file for the rest`;
        break;
      }
    }
  } catch {
    note = "the gzip stream is damaged: showing what could be read";
  } finally {
    input.unpipe(gunzip);
    input.destroy();
    gunzip.destroy();
  }
  const all = Buffer.concat(chunks);
  return { text: all.subarray(-maxBytes).toString("utf8"), cut: total > Math.min(all.length, maxBytes), note };
}

/** The last `lines` lines (at most 5000, within the last 2 MiB of text) of one file. */
export async function readLogTail(source: string, file: string, lines = DEFAULT_TAIL_LINES): Promise<LogTail> {
  const count = Math.max(1, Math.min(MAX_TAIL_LINES, Math.floor(lines) || DEFAULT_TAIL_LINES));
  const opened = await openLogFile(source, file);
  try {
    const read = opened.gz ? await tailGzip(opened.handle, MAX_TAIL_BYTES) : await tailPlain(opened.handle, opened.size, MAX_TAIL_BYTES);
    const all = read.text.split("\n");
    if (all.at(-1) === "") all.pop();
    if (read.cut) all.shift(); // the first line of a cut window is partial
    const out = all.slice(-count);
    if ("note" in read && read.note) out.unshift(`[viewer] ${read.note}`);
    return { source: opened.source, file: opened.name, size: opened.size, mtime: opened.mtime.toISOString(), lines: out, truncated: read.cut || all.length > count };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}
