import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

import { authenticate } from "@/lib/accounts/http";
import { jobResultMaxBytes, jobStore, JobStorageFullError, pdfUploadMaxBytes, type JobResult } from "@/lib/jobs";
import { receiveMultipart, UploadError, type StreamedForm } from "@/lib/multipart-upload";
import {
  interpretPdfResult,
  knifeDataHeader,
  makeUploadDir,
  pdfScriptRequest,
  PDF_MAX_FILE_BYTES,
  PDF_MAX_FILES,
  PDF_TIMEOUT_MS,
  readPdfForm,
  stagePdfInputs,
  type StagedPdf,
} from "@/lib/pdf-run";
import { disposeDir, PY_BIN, runPythonScript, startPythonScript, type PythonRunResult } from "@/lib/python";
import { queueFullOrNull } from "@/lib/queue-http";
import { assertCanStore } from "@/lib/storage/quota";
import { quotaErrorResponse } from "@/lib/storage/http";
import { pythonQueue } from "@/lib/work-queue";

/**
 * POST /api/pdf — multipart in, JSON or a file out.
 *
 * fields: action, params (JSON string), file(s)
 * The python script writes artifacts into a scratch dir; we stream the first one back and delete the dir.
 *
 * Runs on the `heavy` Python lane (one at a time by default); a full lane answers 503 + Retry-After.
 * Synchronous by default and the request's abort signal is wired through, so a client that goes away takes the
 * running process group with it. With `?async=1` (or `Prefer: respond-async`) it answers 202 { jobId } after
 * enqueueing; poll `GET /api/jobs/<id>`, fetch the file from `/api/jobs/<id>/file`, cancel with `DELETE`.
 */

function wantsAsync(request: Request): boolean {
  const url = new URL(request.url);
  if (url.searchParams.get("async") === "1") return true;
  return /\brespond-async\b/i.test(request.headers.get("prefer") ?? "");
}

export async function POST(request: Request) {
  const started = Date.now();
  const asyncMode = wantsAsync(request);

  // Every mutating route goes through the Origin/Host guard and resolves the account (docs/ARCHITECTURE.md); async jobs belong to it.
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const owner = auth.account.id;

  // A declared length over the request cap is refused before reading anything; the streamed reader below enforces the
  // same cap (and the per-file caps) on chunked bodies while they arrive, writing file parts straight to disk.
  const maxBytes = pdfUploadMaxBytes();
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > maxBytes) {
    return NextResponse.json({ ok: false, error: `Upload is over ${Math.round(maxBytes / 1024 / 1024)} MB.` }, { status: 413 });
  }

  // Refuse before reading a (possibly huge) upload when the lane cannot take the job anyway.
  try {
    pythonQueue().assertCapacity("heavy", owner);
  } catch (error) {
    const full = queueFullOrNull(error);
    if (full) return full;
    throw error;
  }

  const workDir = await makeUploadDir();
  let staged: StagedPdf | null = null;
  let handedToJob = false;
  try {
    let form: StreamedForm;
    try {
      form = await receiveMultipart(request, workDir, {
        maxTotalBytes: maxBytes,
        maxFileBytes: PDF_MAX_FILE_BYTES,
        maxFiles: PDF_MAX_FILES,
        fileTooLarge: (name) => `${name} is over ${Math.round(PDF_MAX_FILE_BYTES / 1024 / 1024)} MB.`,
      });
    } catch (error) {
      if (error instanceof UploadError) return NextResponse.json({ ok: false, error: error.message }, { status: error.status === 415 ? 400 : error.status });
      throw error;
    }
    const parsed = readPdfForm({ field: (name) => form.fields.get(name)?.[0] ?? null, files: form.files.filter((file) => file.field === "file") });
    if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: parsed.status });
    const { input } = parsed;

    staged = await stagePdfInputs(workDir, input.uploads);
    const script = pdfScriptRequest(input, staged);
    const options = { timeoutMs: PDF_TIMEOUT_MS, lane: "heavy" as const, label: `pdf:${input.action}`, owner };

    if (asyncMode) {
      const stagedDirs = staged;
      // An async job keeps its inputs and result on disk until it is collected: that counts toward the account's quota.
      try {
        assertCanStore(owner, stagedDirs.bytes);
      } catch (error) {
        const full = quotaErrorResponse(error);
        if (full) return full;
        throw error;
      }
      const handle = startPythonScript<Record<string, unknown>>("pdf_tool.py", script, options);
      let jobId: string;
      try {
        jobId = jobStore().add({
          owner,
          kind: `pdf:${input.action}`,
          handle,
          inputDirs: [stagedDirs.workDir],
          inputBytes: stagedDirs.bytes,
          resultDirs: [stagedDirs.outDir],
          settle: async (result: PythonRunResult<Record<string, unknown>>) => {
            const outcome = await interpretPdfResult(result, stagedDirs.outDir);
            return settleJob(outcome, started);
          },
        });
      } catch (error) {
        handle.cancel("Job storage is full.");
        if (error instanceof JobStorageFullError) {
          return NextResponse.json({ ok: false, error: error.message }, { status: error.scope === "owner" ? 429 : 503, headers: { "Retry-After": "30" } });
        }
        throw error;
      }
      handedToJob = true;
      const record = jobStore().get(jobId, owner);
      return NextResponse.json(
        { ok: true, jobId, status: "queued", position: record?.handle.position() ?? 0, statusUrl: `/api/jobs/${jobId}` },
        { status: 202, headers: { Location: `/api/jobs/${jobId}`, "Cache-Control": "no-store", "Preference-Applied": "respond-async" } },
      );
    }

    const result = await runPythonScript<Record<string, unknown>>("pdf_tool.py", script, { ...options, signal: request.signal });
    if (result.cancelled) return new NextResponse(null, { status: 499 });

    const outcome = await interpretPdfResult(result, staged.outDir);
    if (outcome.kind === "error") {
      return NextResponse.json({ ok: false, error: outcome.error, logs: outcome.logs }, { status: 400 });
    }
    if (outcome.kind === "file") {
      const buffer = await fs.readFile(outcome.path);
      return new NextResponse(new Uint8Array(buffer), {
        headers: {
          "Content-Type": outcome.mime,
          "Content-Disposition": `attachment; filename="${outcome.filename}"`,
          "X-Knife-Data": knifeDataHeader(outcome.payload),
          "X-Knife-Ms": String(Date.now() - started),
        },
      });
    }
    return NextResponse.json({ ok: true, data: outcome.data, ms: Date.now() - started, python: path.basename(PY_BIN) });
  } catch (error) {
    const full = queueFullOrNull(error);
    if (full) return full;
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    if (!handedToJob) {
      await disposeDir(workDir);
      if (staged) await disposeDir(staged.outDir);
    }
  }
}

/** Async result: files stay in the job's output dir until it is reaped; oversize results become an error. */
async function settleJob(
  outcome: Awaited<ReturnType<typeof interpretPdfResult>>,
  started: number,
): Promise<{ result: JobResult; resultBytes: number }> {
  if (outcome.kind === "error") return { result: outcome, resultBytes: 0 };
  if (outcome.kind === "json") {
    return { result: { kind: "json", data: outcome.data, ms: Date.now() - started }, resultBytes: 0 };
  }
  if (outcome.bytes > jobResultMaxBytes()) {
    return {
      result: { kind: "error", error: `The result is ${Math.round(outcome.bytes / 1024 / 1024)} MB, over the async result cap.` },
      resultBytes: 0,
    };
  }
  return {
    result: {
      kind: "file",
      path: outcome.path,
      filename: outcome.filename,
      mime: outcome.mime,
      bytes: outcome.bytes,
      data: outcome.payload,
      ms: Date.now() - started,
    },
    resultBytes: outcome.bytes,
  };
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
