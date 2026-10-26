import { msgf } from "@/lib/i18n/msg";
/**
 * Browser side of `POST /api/pdf?async=1`: enqueue, poll with backoff, fetch the result, cancel.
 * No React in here so the state machine can be read (and tested) on its own.
 */

export type PdfJobPhase =
  | { kind: "uploading" }
  | { kind: "queued"; ahead: number }
  | { kind: "running" };

export interface PdfJsonData {
  documents?: unknown;
  text?: string;
  chars?: number;
  parts?: number;
}

export type PdfJobOutcome =
  | { kind: "json"; data: PdfJsonData | undefined; ms?: number }
  | { kind: "file"; blob: Blob; filename: string }
  | { kind: "cancelled" };

export interface PdfJob {
  /** Resolves with the outcome; rejects with a user-readable Error. */
  result: Promise<PdfJobOutcome>;
  /** Stops polling and deletes the server job (the server kills its process once it is running). Safe to call twice. */
  cancel: () => Promise<void>;
}

interface JobView {
  ok?: boolean;
  jobId: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  position?: number;
  error?: string;
  result?: { kind: string; data?: PdfJsonData; ms?: number; url?: string; filename?: string; error?: string };
}

const POLL_FIRST_MS = 120;
const POLL_MAX_MS = 2_000;
const POLL_BACKOFF = 1.5;
const MAX_POLL_FAILURES = 5;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

async function errorFrom(response: Response, fallback: string): Promise<Error> {
  let message = fallback;
  try {
    const body = (await response.json()) as { error?: string; retryAfterSec?: number };
    if (response.status === 503) {
      const wait = body.retryAfterSec ?? Number(response.headers.get("retry-after"));
      message = msgf("The PDF worker is busy{value}.", { value: wait ? ` — try again in about ${wait} s` : "" });
    } else if (response.status === 401) {
      message = "You are signed out — sign in again to process PDFs.";
    } else if (body.error) message = body.error;
  } catch {
    // keep the fallback
  }
  return new Error(message);
}

export function startPdfJob(form: FormData, onPhase: (phase: PdfJobPhase) => void): PdfJob {
  const controller = new AbortController();
  let jobId: string | null = null;
  let cancelled = false;

  const deleteJob = async (id: string): Promise<void> => {
    try {
      await fetch(`/api/jobs/${id}`, { method: "DELETE", keepalive: true });
    } catch {
      // best effort: the server reaps it by TTL anyway
    }
  };

  const cancel = async (): Promise<void> => {
    if (cancelled) return;
    cancelled = true;
    controller.abort();
    if (jobId) await deleteJob(jobId);
  };

  const result = (async (): Promise<PdfJobOutcome> => {
    onPhase({ kind: "uploading" });
    let response: Response;
    try {
      response = await fetch("/api/pdf?async=1", { method: "POST", body: form, signal: controller.signal });
    } catch (error) {
      if (cancelled) return { kind: "cancelled" };
      throw error instanceof Error ? error : new Error("Request failed — is the dev server running?");
    }
    if (response.status !== 202) throw await errorFrom(response, "The server refused the request.");
    const accepted = (await response.json()) as { jobId: string; position?: number };
    jobId = accepted.jobId;
    if (cancelled) {
      await deleteJob(jobId);
      return { kind: "cancelled" };
    }
    onPhase({ kind: "queued", ahead: accepted.position ?? 0 });

    let delay = POLL_FIRST_MS;
    let failures = 0;
    for (;;) {
      await sleep(delay, controller.signal);
      if (cancelled) return { kind: "cancelled" };
      delay = Math.min(POLL_MAX_MS, Math.round(delay * POLL_BACKOFF));

      let view: JobView;
      try {
        const poll = await fetch(`/api/jobs/${jobId}`, { cache: "no-store", signal: controller.signal });
        if (poll.status === 404) throw new Error("The job expired or was removed on the server.");
        if (!poll.ok) throw await errorFrom(poll, "Could not read the job status.");
        view = (await poll.json()) as JobView;
        failures = 0;
      } catch (error) {
        if (cancelled) return { kind: "cancelled" };
        if (error instanceof Error && /expired or was removed/.test(error.message)) throw error;
        if (++failures >= MAX_POLL_FAILURES) throw error instanceof Error ? error : new Error("Lost contact with the server.");
        continue;
      }

      if (view.status === "queued") onPhase({ kind: "queued", ahead: view.position ?? 0 });
      else if (view.status === "running") onPhase({ kind: "running" });
      else if (view.status === "cancelled") return { kind: "cancelled" };
      else if (view.status === "failed") throw new Error(view.error ?? view.result?.error ?? "The PDF worker failed.");
      else {
        // done
        const finished = view.result;
        if (finished?.kind === "file" && finished.url) {
          const download = await fetch(finished.url, { cache: "no-store", signal: controller.signal });
          if (!download.ok) throw await errorFrom(download, "Could not download the result.");
          const blob = await download.blob();
          const match = /filename="([^"]+)"/.exec(download.headers.get("content-disposition") ?? "");
          return { kind: "file", blob, filename: match?.[1] ?? finished.filename ?? "output.pdf" };
        }
        return { kind: "json", data: finished?.data, ms: finished?.ms };
      }
    }
  })();

  // The result is also consumed by the caller; this keeps a never-awaited rejection from being "unhandled".
  result.catch(() => {});
  return { result, cancel };
}
