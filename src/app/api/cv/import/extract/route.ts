import { promises as fs } from "node:fs";
import path from "node:path";
import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { extractOfficeText } from "@/lib/office/extract";
import { disposeDir, makeScratchDir, runPythonScript } from "@/lib/python";
import { queueFullOrNull } from "@/lib/queue-http";
import { msg, msgf } from "@/lib/i18n/msg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_CHARS = 60_000;

const bodySchema = z.object({
  name: z.string().min(1).max(200),
  /** The file, base64 (no data: prefix). */
  data: z.string().min(1).max(Math.ceil(MAX_FILE_BYTES / 3) * 4 + 8),
}).strict();

/** The text a person would read in an existing CV file, for the assistant to structure (it never invents anything). */
type Extracted = { text: string; truncated: boolean; kind: string; pages?: number };

/**
 * POST /api/cv/import/extract { name, data: base64 } -> { text, truncated, kind, pages? }: the text of a CV file the user
 * uploads (PDF, DOCX, ODT, TXT, MD), so the assistant can sort it into the CV project's profile. Nothing is stored.
 * Office files are read in the isolate pool (src/lib/office/extract.ts), PDFs on the Python lane (pdf_tool.py text);
 * a scanned PDF without a text layer answers with an empty text and a hint to use OCR.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const read = await readJsonBody(request, Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4096);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) return jsonError(msg("Send { name, data } with the file as base64."), 422);
  const { name } = parsed.data;
  const bytes = Buffer.from(parsed.data.data, "base64");
  if (bytes.length === 0) return jsonError(msg("The file is empty."), 422);
  if (bytes.length > MAX_FILE_BYTES) return jsonError(msgf("The file is too large (at most {mb} MB).", { mb: MAX_FILE_BYTES / 1024 / 1024 }), 413);
  const ext = path.extname(name).toLowerCase().slice(1);
  try {
    let out: Extracted;
    if (ext === "txt" || ext === "md") {
      const text = bytes.toString("utf8");
      out = { text: text.slice(0, MAX_CHARS), truncated: text.length > MAX_CHARS, kind: ext };
    } else if (ext === "docx" || ext === "odt") {
      const got = await extractOfficeText(ext, bytes, { maxChars: MAX_CHARS, owner: auth.account.id, signal: request.signal });
      out = { text: got.text, truncated: got.truncated, kind: ext };
    } else if (ext === "pdf") {
      if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") return jsonError(msg("That file is not a PDF."), 422);
      const dir = await makeScratchDir("knife-cv-in-");
      try {
        const file = path.join(dir, "cv.pdf");
        await fs.writeFile(file, bytes, { mode: 0o600 });
        const result = await runPythonScript<{ text?: string; pages_scanned?: number }>(
          "pdf_tool.py",
          { action: "text", files: [file], out_dir: dir, params: { pages_break: false } },
          { lane: "light", timeoutMs: 60_000, label: "cv:import-pdf", signal: request.signal, owner: auth.account.id, binds: { writable: [dir] } },
        );
        if (result.cancelled) return new Response(null, { status: 499 });
        if (!result.ok) return jsonError(result.error ?? msg("The PDF could not be read."), 422);
        const raw = (result.data?.text ?? "").replace(/^--- .* · page \d+ ---$/gm, "").trim();
        out = { text: raw.slice(0, MAX_CHARS), truncated: raw.length > MAX_CHARS, kind: "pdf", pages: result.data?.pages_scanned };
      } finally {
        await disposeDir(dir);
      }
    } else {
      return jsonError(msg("Upload a PDF, Word (DOCX), OpenDocument (ODT) or text file."), 415);
    }
    if (!out.text.trim()) {
      return jsonError(
        out.kind === "pdf"
          ? msg("This PDF has no text layer (it is a scan or a picture). Make it searchable first in the PDF toolkit (Editor & OCR, Searchable PDF), then upload that file.")
          : msg("No text found in this file."),
        422,
      );
    }
    return json(out);
  } catch (error) {
    const full = queueFullOrNull(error);
    if (full) return full;
    return jsonError(msgf("The file could not be read: {reason}", { reason: error instanceof Error ? error.message : String(error) }), 422);
  }
}
