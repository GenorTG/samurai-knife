import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeScratchDir, type PythonRunResult } from "@/lib/python";

/** Shared by the synchronous and the async (`?async=1`) paths of `POST /api/pdf`. */

export const PDF_MAX_FILE_BYTES = 200 * 1024 * 1024;
export const PDF_MAX_FILES = 40;
export const PDF_TIMEOUT_MS = 180_000;
export const PDF_OCR_MAX_FILE_BYTES = 50 * 1024 * 1024;

export interface PdfInput {
  action: string;
  params: Record<string, unknown>;
  uploads: File[];
}

export type PdfFormResult = { ok: true; input: PdfInput } | { ok: false; status: number; error: string };

export function readPdfForm(form: FormData): PdfFormResult {
  const action = String(form.get("action") ?? "").trim();
  if (!action) return { ok: false, status: 400, error: "Missing action." };

  let params: Record<string, unknown> = {};
  const rawParams = form.get("params");
  if (typeof rawParams === "string" && rawParams.trim()) {
    try {
      const value: unknown = JSON.parse(rawParams);
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return { ok: false, status: 400, error: "params must be a JSON object." };
      }
      params = value as Record<string, unknown>;
    } catch {
      return { ok: false, status: 400, error: "params must be JSON." };
    }
  }

  const uploads = form.getAll("file").filter((entry): entry is File => entry instanceof File);
  if (uploads.length === 0) return { ok: false, status: 400, error: "No PDF attached." };
  if (action === "ocr") {
    if (uploads.length !== 1) return { ok: false, status: 400, error: "OCR needs exactly one PDF." };
    if (Object.keys(params).some((key) => !["language", "deskew", "rotatePages"].includes(key))) {
      return { ok: false, status: 400, error: "OCR accepts only language, deskew and rotatePages parameters." };
    }
    const { language = "eng", deskew = true, rotatePages = true } = params;
    if (typeof language !== "string" || !["eng", "pol", "eng+pol"].includes(language)) {
      return { ok: false, status: 400, error: "OCR language must be eng, pol or eng+pol." };
    }
    if (typeof deskew !== "boolean" || typeof rotatePages !== "boolean") {
      return { ok: false, status: 400, error: "OCR deskew and rotatePages must be booleans." };
    }
    if (uploads[0].size > PDF_OCR_MAX_FILE_BYTES) {
      return { ok: false, status: 413, error: "OCR supports PDFs up to 50 MB. Split or reduce the scan first." };
    }
    params = { language, deskew, rotatePages };
  }
  if (uploads.length > PDF_MAX_FILES) {
    return { ok: false, status: 413, error: `Too many files (${uploads.length}); the cap is ${PDF_MAX_FILES}.` };
  }
  const oversized = uploads.find((file) => file.size > PDF_MAX_FILE_BYTES);
  if (oversized) {
    return { ok: false, status: 413, error: `${oversized.name} is over ${Math.round(PDF_MAX_FILE_BYTES / 1024 / 1024)} MB.` };
  }
  return { ok: true, input: { action, params, uploads } };
}

export interface StagedPdf {
  workDir: string;
  outDir: string;
  paths: string[];
  bytes: number;
}

/** Write the uploads to a scratch dir (the python script reads paths) and allocate the output dir. */
export async function stagePdfInputs(uploads: File[]): Promise<StagedPdf> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "knife-pdf-"));
  const outDir = await makeScratchDir("knife-pdf-out-");
  const paths: string[] = [];
  let bytes = 0;
  try {
    for (const [index, file] of uploads.entries()) {
      const safe = path.basename(file.name).replace(/[^\w.\-()+]/g, "_") || "input.pdf";
      const target = path.join(workDir, `${index + 1}-${safe}`);
      await fs.writeFile(target, Buffer.from(await file.arrayBuffer()));
      bytes += file.size;
      paths.push(target);
    }
  } catch (error) {
    await Promise.all([workDir, outDir].map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {})));
    throw error;
  }
  return { workDir, outDir, paths, bytes };
}

export function pdfScriptRequest(input: PdfInput, staged: StagedPdf): { action: string; files: string[]; out_dir: string; params: Record<string, unknown> } {
  return { action: input.action, files: staged.paths, out_dir: staged.outDir, params: input.params };
}

export type PdfOutcome =
  | { kind: "error"; error: string; logs: string[] }
  | { kind: "file"; path: string; filename: string; mime: string; bytes: number; payload: unknown }
  | { kind: "json"; data: unknown };

interface Artifact {
  file: string;
  mime: string;
}

function pickArtifact(data: unknown): Artifact | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (typeof record.file === "string" && typeof record.mime === "string") return { file: record.file, mime: record.mime };
  const list = record.files;
  if (Array.isArray(list) && list.length > 0) {
    const first = list[0] as Record<string, unknown>;
    if (typeof first.file === "string" && typeof first.mime === "string") return { file: first.file, mime: first.mime };
  }
  return null;
}

/** Turn the script's answer into an outcome. Artifact verbs report file/mime/bytes at the top level of the payload. */
export async function interpretPdfResult(result: PythonRunResult<Record<string, unknown>>, outDir: string): Promise<PdfOutcome> {
  if (!result.ok) {
    return { kind: "error", error: result.error ?? "The PDF worker failed.", logs: result.logs.slice(0, 6) };
  }
  const payload = result.payload ?? result.data;
  const artifact = pickArtifact(payload);
  if (artifact) {
    const resolved = path.resolve(outDir, artifact.file);
    if (!resolved.startsWith(path.resolve(outDir) + path.sep)) {
      return { kind: "error", error: "The PDF worker returned a file outside its output directory.", logs: [] };
    }
    const stat = await fs.stat(resolved);
    return {
      kind: "file",
      path: resolved,
      filename: path.basename(artifact.file).replace(/"/g, ""),
      mime: artifact.mime,
      bytes: stat.size,
      payload: payload ?? {},
    };
  }
  return { kind: "json", data: result.data ?? {} };
}

export function knifeDataHeader(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload ?? {})).toString("base64url");
}
