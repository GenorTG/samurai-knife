/**
 * Server entry for office text extraction: `extractTextBounded` (text.ts) run in the isolate pool, never on the main
 * thread. Every server caller of extraction on a stored/uploaded file goes through here.
 *
 * Threat model: the file is any user's upload. text.ts bounds the work linearly and the output by `maxChars`; the pool
 * adds a wall-clock timeout (`ISOLATE_TIMEOUT_MS.extractOfficeText`), a worker heap cap and a bounded queue, so a file
 * crafted against a bug we have not found yet still cannot stall the event loop or exhaust the process heap.
 */
import { runIsolated } from "@/lib/isolate/server";
import type { OfficeFormat } from "./templates";
import { TEXT_MAX_CHARS, type ExtractedText } from "./text";

export interface ExtractOptions {
  /** Characters wanted (default and ceiling TEXT_MAX_CHARS); extraction stops once reached. */
  maxChars?: number;
  /** Account id: per-account share of the pool. */
  owner?: string;
  signal?: AbortSignal;
}

/** Plain text of an office file, bounded. Rejects with QueueFullError (pool full) or IsolateStoppedError (limits hit). */
export function extractOfficeText(format: OfficeFormat, bytes: Uint8Array, options: ExtractOptions = {}): Promise<ExtractedText> {
  // A pooled Buffer is a view into a larger shared ArrayBuffer and structured clone copies the whole backing store: send
  // only this file's bytes.
  const own = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : new Uint8Array(bytes);
  return runIsolated(
    "extractOfficeText",
    { format, bytes: own, maxChars: Math.min(options.maxChars ?? TEXT_MAX_CHARS, TEXT_MAX_CHARS) },
    { owner: options.owner, signal: options.signal },
  );
}
