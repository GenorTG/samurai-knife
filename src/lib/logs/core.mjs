// Log files: one root, one folder per source, daily files with a size cap, old days gzipped, retention from the legal
// config. Plain JavaScript because scripts/serve.mjs (no TS loader) writes the app log; the Next server imports the same
// module for the sidecar op logs (src/lib/logs/server.ts) and the admin viewer (src/lib/logs/viewer.ts).
//
//   $KNIFE_LOG_DIR (default <cwd>/logs, gitignored; the systemd unit sets <app-root>/logs; "off" = no files)
//     app/app-YYYY-MM-DD.log           the Next server's stdout/stderr + serve.mjs's own lines (scripts/serve.mjs)
//     app/app-YYYY-MM-DD.1.log ...     the same day after the size cap (.1 = the newest full part)
//     app/app-YYYY-MM-DD.log.gz        a past day, gzipped by the maintenance run
//     sidecars/<id>/ops-YYYY-MM-DD.log sidecar install/start/stop/update/remove progress (src/lib/services/ops.ts)
//     update/update-YYYY-MM-DD.log     knife-update runs (deploy/bin/knife-update, written as knife-deploy)
//
// Dates are UTC. Every line is `<ISO time> <out|err> <text>`, stripped of ANSI/control characters and of anything that
// looks like a secret (redactLine). Writing never throws and never blocks the server for long (sync appends of a line).
// Retention: a day file is removed once its day is `logRetentionDays` (legal.json, default 30) old; the maintenance run
// happens at startup and every hour, so no line outlives the number the privacy notice states. Tests:
// tests/log_files.test.mjs. Contract: docs/DEPLOY.md "Log files".
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { lstat, mkdir, readdir, rename, stat, unlink, chmod } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_PARTS = 9;
const MAX_LINE = 8_000;
/** `<prefix>-<UTC day>[.<part>].log[.gz]`: every file a writer makes (the viewer and the pruning accept nothing else). */
export const LOG_FILE = /^([a-z][a-z0-9-]{0,31})-(\d{4}-\d{2}-\d{2})(?:\.([1-9]\d?))?\.log(\.gz)?$/;
/** A sidecar id as a folder name (definitions use short lowercase ids). */
export const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** The log root, or null when file logging is off (`KNIFE_LOG_DIR=off`). */
export function logRoot(/** @type {Record<string, string | undefined>} */ env = process.env, cwd = process.cwd()) {
  const configured = env.KNIFE_LOG_DIR?.trim();
  if (configured && /^(off|none|0|false)$/i.test(configured)) return null;
  return resolve(cwd, configured || "logs");
}

/** `logRetentionDays` from the instance's legal.json (docs/LEGAL.md), 1..3650, default 30. Read on every call. */
export function retentionDays(/** @type {Record<string, string | undefined>} */ env = process.env) {
  const legal = env.KNIFE_LEGAL_DIR?.trim() || join(env.KNIFE_DATA_DIR?.trim() || join(homedir(), ".local", "share", "samurai-knife"), "legal");
  try {
    const parsed = JSON.parse(readFileSync(join(legal, "legal.json"), "utf8"));
    const raw = parsed && typeof parsed === "object" ? parsed.logRetentionDays : undefined;
    const days = typeof raw === "number" ? raw : typeof raw === "string" && /^\s*\d{1,4}\s*$/.test(raw) ? Number(raw) : NaN;
    if (Number.isInteger(days) && days >= 1 && days <= 3650) return days;
  } catch {
    // no legal.json (private installs) or a hand-edited one that does not parse: the default
  }
  return DEFAULT_RETENTION_DAYS;
}

export const utcDay = (/** @type {Date} */ date) => date.toISOString().slice(0, 10);

// -- redaction -------------------------------------------------------------------------------------------------------

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
/** @type {Array<[RegExp, string]>} */
const SECRETS = [
  // whole header values: credentials and session cookies
  [/\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-opencode-session)(["']?\s*[:=]\s*)(["']?)[^\n]*/gi, "$1$2$3[redacted]"],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 [redacted]"],
  // key=value / "key": "value" pairs whose name says secret
  // (the name must END in the word: `max_tokens=4096` is a counter, `KNIFE_SMTP_PASSWORD=` is not)
  [/\b([a-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|session[_-]?id))(["']?\s*[:=]\s*)(["']?)[^\s"'&,;}]+/gi, "$1$2$3[redacted]"],
  // capabilities in URLs (office tickets, OAuth codes, signed links)
  [/([?&#](?:t|token|code|state|key|sig|signature|ticket|access_token|refresh_token)=)[^&#\s"']+/gi, "$1[redacted]"],
  // well-known key shapes
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, "[redacted-key]"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "[redacted-key]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted-jwt]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted-private-key]"],
  // URL userinfo (https://user:pass@host)
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[redacted]@"],
];

/** One log line without colours, control characters or anything that looks like a credential; capped at 8000 chars. */
export function redactLine(/** @type {string} */ line) {
  let out = String(line).replace(ANSI, "").replace(CONTROL, " ");
  if (out.length > MAX_LINE) out = `${out.slice(0, MAX_LINE)}… [${out.length - MAX_LINE} more chars]`;
  for (const [pattern, replacement] of SECRETS) out = out.replace(pattern, replacement);
  return out;
}

// -- writing ---------------------------------------------------------------------------------------------------------

/**
 * @typedef {object} LogWriter
 * @property {(stream: "out" | "err", chunk: string | Buffer) => void} write  Appends text; a partial last line waits for its end.
 * @property {(stream: "out" | "err", text: string) => void} line  Appends one complete line.
 * @property {() => void} flush  Writes waiting partial lines.
 * @property {() => void} close
 * @property {() => string | null} currentFile  Absolute path of the file being written (null before the first write).
 */

/**
 * A writer for `<root>/<source>/<prefix>-<day>.log`: a new file at the UTC day boundary, rotation to `.1` (.. `.9`, the
 * oldest dropped) past `maxBytes`. Synchronous appends (a line at a time; volumes are small) so a crash loses nothing.
 * Errors disable writing for a minute and are reported once on stderr; they never reach the caller.
 * @param {{ root: string, source: string, prefix: string, maxBytes?: number, maxParts?: number, now?: () => Date, onError?: (message: string) => void }} options
 * @returns {LogWriter}
 */
export function createLogWriter({ root, source, prefix, maxBytes = DEFAULT_MAX_BYTES, maxParts = DEFAULT_MAX_PARTS, now = () => new Date(), onError }) {
  const dir = join(root, source);
  /** @type {number | null} */
  let fd = null;
  let day = "";
  let size = 0;
  let pausedUntil = 0;
  let reported = false;
  /** @type {Record<string, string>} */
  const partial = { out: "", err: "" };
  const report = onError ?? ((message) => process.stderr.write(`[logs] ${message}\n`));

  const base = (d) => join(dir, `${prefix}-${d}`);
  function closeFd() {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // already gone
      }
      fd = null;
    }
  }
  function open(d) {
    closeFd();
    mkdirSync(dir, { recursive: true, mode: 0o750 });
    fd = openSync(`${base(d)}.log`, "a", 0o640);
    size = fstatSync(fd).size;
    day = d;
  }
  function rotate() {
    closeFd();
    const b = base(day);
    try {
      unlinkSync(`${b}.${maxParts}.log`);
    } catch {
      // not there
    }
    for (let part = maxParts - 1; part >= 1; part -= 1) {
      try {
        renameSync(`${b}.${part}.log`, `${b}.${part + 1}.log`);
      } catch {
        // gap
      }
    }
    renameSync(`${b}.log`, `${b}.1.log`);
    open(day);
  }
  function append(text) {
    if (Date.now() < pausedUntil) return;
    try {
      const at = now();
      const d = utcDay(at);
      if (fd === null || d !== day) open(d);
      const data = Buffer.from(text, "utf8");
      if (size > 0 && size + data.length > maxBytes) rotate();
      writeSync(/** @type {number} */ (fd), data);
      size += data.length;
      reported = false;
    } catch (error) {
      closeFd();
      pausedUntil = Date.now() + 60_000;
      if (!reported) {
        reported = true;
        report(`cannot write ${dir}: ${error instanceof Error ? error.message : String(error)} (retrying in a minute)`);
      }
    }
  }
  const stamp = (stream, text) => `${now().toISOString()} ${stream} ${redactLine(text)}\n`;

  return {
    write(stream, chunk) {
      const text = partial[stream] + (typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      const lines = text.split(/\r?\n/);
      partial[stream] = lines.pop() ?? "";
      if (partial[stream].length > MAX_LINE * 2) {
        lines.push(partial[stream]);
        partial[stream] = "";
      }
      if (lines.length) append(lines.map((line) => stamp(stream, line)).join(""));
    },
    line(stream, text) {
      append(String(text).split(/\r?\n/).map((line) => stamp(stream, line)).join(""));
    },
    flush() {
      for (const stream of /** @type {const} */ (["out", "err"])) {
        if (partial[stream]) {
          append(stamp(stream, partial[stream]));
          partial[stream] = "";
        }
      }
    },
    close() {
      this.flush();
      closeFd();
    },
    currentFile: () => (fd === null ? null : `${base(day)}.log`),
  };
}

// -- maintenance: retention + gzip -----------------------------------------------------------------------------------

/** The folders the maintenance run looks at (only those this process can change matter; the others fail quietly). */
async function sourceDirs(root) {
  const dirs = [join(root, "app"), join(root, "update")];
  try {
    for (const entry of await readdir(join(root, "sidecars"), { withFileTypes: true })) {
      if (entry.isDirectory() && SOURCE_ID.test(entry.name)) dirs.push(join(root, "sidecars", entry.name));
    }
  } catch {
    // no sidecar logs yet
  }
  return dirs;
}

/** First UTC day still kept: a file of day D goes once D <= today - days (its newest line is then a day under the limit). */
export function cutoffDay(/** @type {Date} */ now, /** @type {number} */ days) {
  return utcDay(new Date(Date.parse(`${utcDay(now)}T00:00:00Z`) - (days - 1) * 86_400_000));
}

async function gzipFile(path) {
  const tmp = `${path}.gz.tmp`;
  try {
    await pipeline(createReadStream(path), createGzip({ level: 6 }), createWriteStream(tmp, { mode: 0o640, flags: "wx" }));
    const { mode } = await stat(path);
    await chmod(tmp, mode & 0o777);
    await rename(tmp, `${path}.gz`);
    await unlink(path);
    return true;
  } catch {
    await unlink(tmp).catch(() => undefined);
    return false;
  }
}

/**
 * Removes day files older than the retention and gzips past days' plain files, in every source folder under `root`.
 * Never follows a symlink, never touches a name that is not a log file, never throws.
 * @param {{ root: string, days?: number, now?: Date, gzip?: boolean }} options
 * @returns {Promise<{ removed: string[], compressed: string[] }>}
 */
export async function maintainLogs({ root, days = DEFAULT_RETENTION_DAYS, now = new Date(), gzip = true }) {
  const removed = [];
  const compressed = [];
  const cutoff = cutoffDay(now, days);
  const today = utcDay(now);
  for (const dir of await sourceDirs(root)) {
    let names = [];
    try {
      const info = await lstat(dir);
      if (!info.isDirectory()) continue;
      names = await readdir(/*turbopackIgnore: true*/ dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const match = LOG_FILE.exec(name);
      if (!match) continue;
      const path = join(dir, name);
      try {
        if (!(await lstat(path)).isFile()) continue;
        if (match[2] < cutoff) {
          await unlink(path);
          removed.push(path);
        } else if (gzip && !match[4] && match[2] < today && (await gzipFile(path))) {
          compressed.push(path);
        }
      } catch {
        // not ours (update/ belongs to knife-deploy) or gone meanwhile
      }
    }
  }
  return { removed, compressed };
}

/** Creates the root (0750) when it is missing; returns false when it cannot be made (read-only, permissions). */
export async function ensureLogRoot(/** @type {string} */ root) {
  try {
    await mkdir(root, { recursive: true, mode: 0o750 });
    return true;
  } catch {
    return false;
  }
}
