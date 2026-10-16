// SERVER ONLY (node:fs). Streams a multipart/form-data request body to disk.
import { createWriteStream, type WriteStream } from "node:fs";
import path from "node:path";

/**
 * `request.formData()` buffers the whole body in memory before any check runs (and a chunked body declares no length),
 * so uploads are parsed here instead: file parts go straight to `dir` while they arrive, with a running byte count that
 * aborts past the request cap or a file cap; text fields are small and kept in memory (capped). Memory use is one chunk
 * plus a delimiter's worth of look-behind, whatever the upload size.
 */

export interface UploadedFile {
  field: string;
  /** Client file name (not trusted: basenamed and sanitised before it becomes part of `path`). */
  name: string;
  size: number;
  path: string;
}

export interface StreamedForm {
  fields: Map<string, string[]>;
  files: UploadedFile[];
}

export interface UploadLimits {
  /** Whole request body (bytes on the wire). */
  maxTotalBytes: number;
  /** One file part; `fileTooLarge` names the message. */
  maxFileBytes: number;
  maxFiles: number;
  /** One text field. */
  maxFieldBytes?: number;
  /** Message for a file over `maxFileBytes`. */
  fileTooLarge?: (name: string) => string;
}

export class UploadError extends Error {
  readonly status: 400 | 413 | 415;
  constructor(status: 400 | 413 | 415, message: string) {
    super(message);
    this.status = status;
  }
}

const MAX_HEADER_BYTES = 16 * 1024;
const CRLF = Buffer.from("\r\n");

function boundaryOf(contentType: string): string | null {
  if (!/^multipart\/form-data\s*;/i.test(contentType.trim())) return null;
  const match = /;\s*boundary=(?:"([^"]{1,70})"|([^\s;]{1,70}))/i.exec(contentType);
  return match ? (match[1] ?? match[2]) : null;
}

function headerParam(header: string, name: string): string | null {
  const match = new RegExp(`;\\s*${name}=(?:"((?:[^"\\\\]|\\\\.)*)"|([^\\s;]+))`, "i").exec(header);
  if (!match) return null;
  return match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : match[2];
}

export function safeFileName(name: string, index: number): string {
  const safe = path.basename(name.replace(/\\/g, "/")).replace(/[^\w.\-()+]/g, "_").slice(-120) || "input.pdf";
  return `${index + 1}-${safe}`;
}

function write(stream: WriteStream, chunk: Buffer): Promise<void> {
  if (stream.errored) return Promise.reject(stream.errored);
  return new Promise((resolve, reject) => {
    if (stream.write(chunk)) resolve();
    else {
      const done = (error?: Error): void => {
        stream.off("drain", done);
        stream.off("error", done);
        if (error) reject(error);
        else resolve();
      };
      stream.once("drain", done);
      stream.once("error", done);
    }
  });
}

function close(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => stream.end((error?: Error | null) => (error ? reject(error) : resolve())));
}

/**
 * Parses the body of `request` into text fields and files written under `dir` (which the caller owns and removes).
 * Throws UploadError: 415 not multipart, 413 over a cap (the rest of the body is not read), 400 malformed.
 */
export async function receiveMultipart(request: Request, dir: string, limits: UploadLimits): Promise<StreamedForm> {
  const boundary = boundaryOf(request.headers.get("content-type") ?? "");
  if (!boundary) throw new UploadError(415, "Expected multipart form data.");
  const declared = request.headers.get("content-length");
  const tooBig = (): UploadError => new UploadError(413, `Upload is over ${Math.round(limits.maxTotalBytes / 1024 / 1024)} MB.`);
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > limits.maxTotalBytes) throw tooBig();
  if (!request.body) throw new UploadError(400, "Expected multipart form data.");

  const delimiter = Buffer.from(`\r\n--${boundary}`);
  const maxField = limits.maxFieldBytes ?? 64 * 1024;
  const form: StreamedForm = { fields: new Map(), files: [] };
  // The body starts with "--boundary" (no CRLF before the first one): prepend one so every delimiter looks the same.
  let buffer: Buffer = Buffer.from(CRLF);
  let total = 0;
  let state: "preamble" | "headers" | "body" | "done" = "preamble";
  let part: { field: string; file: UploadedFile | null; stream: WriteStream | null; text: Buffer[]; size: number } | null = null;

  const finishPart = async (): Promise<void> => {
    if (!part) return;
    if (part.stream) {
      await close(part.stream);
      if (part.file) form.files.push({ ...part.file, size: part.size });
    } else {
      const list = form.fields.get(part.field) ?? [];
      list.push(Buffer.concat(part.text).toString("utf8"));
      form.fields.set(part.field, list);
    }
    part = null;
  };

  const feed = async (data: Buffer): Promise<void> => {
    if (!part) return;
    part.size += data.byteLength;
    if (part.stream) {
      if (part.size > limits.maxFileBytes) {
        const name = part.file?.name ?? "file";
        throw new UploadError(413, limits.fileTooLarge?.(name) ?? `${name} is over ${Math.round(limits.maxFileBytes / 1024 / 1024)} MB.`);
      }
      await write(part.stream, data);
    } else {
      if (part.size > maxField) throw new UploadError(413, `Form field ${part.field} is too large.`);
      part.text.push(data);
    }
  };

  const startPart = (headerBlock: string): void => {
    const disposition = headerBlock.split("\r\n").find((line) => /^content-disposition\s*:/i.test(line)) ?? "";
    if (!/:\s*form-data\b/i.test(disposition)) throw new UploadError(400, "Malformed multipart body (part without form-data disposition).");
    const field = headerParam(disposition, "name") ?? "";
    const filename = headerParam(disposition, "filename");
    if (filename === null) {
      part = { field, file: null, stream: null, text: [], size: 0 };
      return;
    }
    if (form.files.length + 1 > limits.maxFiles) throw new UploadError(413, `Too many files; the cap is ${limits.maxFiles}.`);
    const target = path.join(dir, safeFileName(filename, form.files.length));
    const stream = createWriteStream(target, { flags: "wx", mode: 0o600 });
    stream.on("error", () => undefined); // surfaced through `stream.errored` / write(); never an uncaught 'error' event
    part = { field, file: { field, name: filename, size: 0, path: target }, stream, text: [], size: 0 };
  };

  const reader = request.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limits.maxTotalBytes) throw tooBig();
      buffer = buffer.length ? Buffer.concat([buffer, value]) : Buffer.from(value);
      // Drain everything decidable in the buffer.
      for (;;) {
        if (state === "done") {
          buffer = Buffer.alloc(0); // epilogue: ignored
          break;
        }
        if (state === "preamble") {
          const at = buffer.indexOf(delimiter);
          if (at < 0) {
            if (buffer.length > MAX_HEADER_BYTES) throw new UploadError(400, "Malformed multipart body (no boundary).");
            break;
          }
          if (buffer.length < at + delimiter.length + 2) break;
          const after = buffer.subarray(at + delimiter.length, at + delimiter.length + 2).toString("latin1");
          buffer = buffer.subarray(at + delimiter.length + 2);
          state = after === "--" ? "done" : "headers";
          continue;
        }
        if (state === "headers") {
          const end = buffer.indexOf("\r\n\r\n");
          if (end < 0) {
            if (buffer.length > MAX_HEADER_BYTES) throw new UploadError(400, "Malformed multipart body (part headers too long).");
            break;
          }
          startPart(buffer.subarray(0, end).toString("utf8"));
          buffer = buffer.subarray(end + 4);
          state = "body";
          continue;
        }
        // body: everything before the next delimiter belongs to the part; keep a tail that could start a delimiter.
        const at = buffer.indexOf(delimiter);
        if (at < 0) {
          const keep = Math.min(buffer.length, delimiter.length - 1);
          const flush = buffer.subarray(0, buffer.length - keep);
          if (flush.length) await feed(Buffer.from(flush));
          buffer = Buffer.from(buffer.subarray(buffer.length - keep));
          break;
        }
        if (buffer.length < at + delimiter.length + 2) {
          if (at > 0) {
            await feed(Buffer.from(buffer.subarray(0, at)));
            buffer = Buffer.from(buffer.subarray(at));
          }
          break;
        }
        await feed(Buffer.from(buffer.subarray(0, at)));
        await finishPart();
        const after = buffer.subarray(at + delimiter.length, at + delimiter.length + 2).toString("latin1");
        buffer = buffer.subarray(at + delimiter.length + 2);
        state = after === "--" ? "done" : "headers";
      }
    }
    if (state !== "done") throw new UploadError(400, "Malformed multipart body (unexpected end).");
    return form;
  } catch (error) {
    reader.cancel().catch(() => undefined);
    const open = part as { stream: WriteStream | null } | null;
    open?.stream?.destroy();
    if (error instanceof UploadError) throw error;
    throw new UploadError(400, "Could not read the upload.");
  }
}
