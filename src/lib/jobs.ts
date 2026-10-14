import { promises as fs } from "node:fs";

import { isJobCancelled, isJobTimeout, type JobHandle } from "./work-queue";

/**
 * In-memory async jobs on top of the work queue: one record per accepted job, owned by the creating account.
 * Nothing survives a server restart (the scratch dirs are in os.tmpdir()). Finished jobs are reaped `ttlSec`
 * after completion; scratch bytes held by live jobs are capped.
 */

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

/** What a finished job hands back; `file` results are streamed from `GET /api/jobs/<id>/file`. */
export type JobResult =
  | { kind: "json"; data: unknown; ms?: number }
  | { kind: "file"; path: string; filename: string; mime: string; bytes: number; data: unknown; ms?: number }
  | { kind: "error"; error: string; logs?: string[] };

export interface JobView {
  jobId: string;
  status: JobStatus;
  /** Jobs ahead in the lane while queued (0 = next to run). */
  position?: number;
  queuedMs: number;
  runMs: number;
  result?: unknown;
  error?: string;
}

export class JobStorageFullError extends Error {
  readonly code = "JOB_STORAGE_FULL";
  constructor() {
    super("Job storage is full; wait for running jobs to be collected or expire, or delete finished jobs.");
    this.name = "JobStorageFullError";
  }
}

interface JobRecord {
  id: string;
  owner: string;
  kind: string;
  createdAt: number;
  handle: JobHandle<unknown>;
  /** Set once the job reached a terminal state. */
  final?: { status: "done" | "failed" | "cancelled"; result?: JobResult; error?: string; finishedAt: number };
  /** Directories removed at reap time (results) / right after the run (inputs). */
  inputDirs: string[];
  resultDirs: string[];
  inputBytes: number;
  resultBytes: number;
  expiresAt?: number;
  timer?: ReturnType<typeof setTimeout>;
}

const MAX_LIVE_JOBS = 500;
const GLOBAL_KEY = Symbol.for("samurai-knife.job-store");

function mbFromEnv(name: string, fallbackMb: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return (Number.isInteger(parsed) && parsed > 0 ? parsed : fallbackMb) * 1024 * 1024;
}

/** Largest total request body /api/pdf will buffer (the same budget the job store holds: KNIFE_JOBS_MAX_MB, default 2 GB). */
export function pdfUploadMaxBytes(): number {
  return mbFromEnv("KNIFE_JOBS_MAX_MB", 2048);
}

export function jobTtlMs(): number {
  const parsed = Number.parseFloat(process.env.KNIFE_JOB_TTL_SEC ?? "");
  return (Number.isFinite(parsed) && parsed > 0 ? parsed : 600) * 1000;
}

class JobStore {
  private readonly jobs = new Map<string, JobRecord>();
  private counter = 0;

  /** Total scratch bytes (inputs + results) of all live records. */
  usedBytes(): number {
    let sum = 0;
    for (const job of this.jobs.values()) sum += job.inputBytes + job.resultBytes;
    return sum;
  }

  add<T>(init: {
    owner: string;
    kind: string;
    handle: JobHandle<T>;
    /** Removed right after the run ends, whatever the outcome (uploads). */
    inputDirs: string[];
    inputBytes: number;
    /** Removed at reap time, or at once when the job does not end `done` (output dir). */
    resultDirs: string[];
    /** Turns the queue's value into the job result; may read files from the result dirs. Runs before the job is `done`. */
    settle: (value: T) => Promise<{ result: JobResult; resultBytes: number }>;
  }): string {
    this.sweep();
    if (this.jobs.size >= MAX_LIVE_JOBS || this.usedBytes() + init.inputBytes > mbFromEnv("KNIFE_JOBS_MAX_MB", 2048)) {
      throw new JobStorageFullError();
    }
    const id = `job_${Date.now().toString(36)}${(++this.counter).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const record: JobRecord = {
      id,
      owner: init.owner,
      kind: init.kind,
      createdAt: Date.now(),
      handle: init.handle as JobHandle<unknown>,
      inputDirs: init.inputDirs,
      resultDirs: init.resultDirs,
      inputBytes: init.inputBytes,
      resultBytes: 0,
    };
    this.jobs.set(id, record);

    init.handle.promise.then(
      async (value) => {
        try {
          const settled = await init.settle(value);
          record.resultBytes = settled.resultBytes;
          this.finish(record, settled.result.kind === "error"
            ? { status: "failed", result: settled.result, error: settled.result.error }
            : { status: "done", result: settled.result });
        } catch (error) {
          this.finish(record, { status: "failed", error: error instanceof Error ? error.message : String(error) });
        }
      },
      (error: unknown) => {
        if (isJobCancelled(error)) this.finish(record, { status: "cancelled", error: error.message });
        else this.finish(record, { status: "failed", error: isJobTimeout(error) ? error.message : (error instanceof Error ? error.message : String(error)) });
      },
    );
    return id;
  }

  private finish(record: JobRecord, outcome: { status: "done" | "failed" | "cancelled"; result?: JobResult; error?: string }): void {
    if (record.final) return;
    record.final = { ...outcome, finishedAt: Date.now() };
    // Inputs are no longer needed once the run has ended, whatever the outcome.
    void Promise.all(record.inputDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {})));
    record.inputDirs = [];
    record.inputBytes = 0;
    if (outcome.status !== "done") this.dropResults(record);
    record.expiresAt = record.final.finishedAt + jobTtlMs();
    record.timer = setTimeout(() => this.reap(record.id), jobTtlMs());
    record.timer.unref?.();
  }

  private dropResults(record: JobRecord): void {
    void Promise.all(record.resultDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {})));
    record.resultDirs = [];
    record.resultBytes = 0;
  }

  /** Remove a record and its scratch right now. */
  reap(id: string): void {
    const record = this.jobs.get(id);
    if (!record) return;
    if (record.timer) clearTimeout(record.timer);
    this.dropResults(record);
    void Promise.all(record.inputDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {})));
    this.jobs.delete(id);
  }

  /** Belt and braces next to the per-job timers (a timer can be lost across dev HMR). */
  sweep(): void {
    const now = Date.now();
    for (const record of [...this.jobs.values()]) {
      if (record.expiresAt !== undefined && record.expiresAt <= now) this.reap(record.id);
    }
  }

  /** Owner-scoped lookup: another account's job is indistinguishable from a missing one. */
  get(id: string, owner: string): JobRecord | undefined {
    this.sweep();
    const record = this.jobs.get(id);
    return record && record.owner === owner ? record : undefined;
  }

  view(record: JobRecord): JobView {
    const status: JobStatus = record.final?.status ?? (record.handle.state() === "queued" ? "queued" : "running");
    const view: JobView = {
      jobId: record.id,
      status,
      queuedMs: record.handle.waitMs(),
      runMs: record.handle.runMs(),
    };
    const position = record.handle.position();
    if (status === "queued" && position !== null) view.position = position;
    if (record.final?.error) view.error = record.final.error;
    const result = record.final?.result;
    if (result?.kind === "json") view.result = { kind: "json", data: result.data, ms: result.ms };
    else if (result?.kind === "file") {
      view.result = {
        kind: "file",
        filename: result.filename,
        mime: result.mime,
        bytes: result.bytes,
        url: `/api/jobs/${record.id}/file`,
        data: result.data,
      };
    } else if (result?.kind === "error") view.result = { kind: "error", error: result.error, logs: result.logs };
    return view;
  }

  /** Cancel a queued/running job and wait until its process is really gone; a finished job is deleted outright. */
  async cancelOrDelete(record: JobRecord): Promise<JobStatus> {
    if (record.final) {
      const status = record.final.status;
      this.reap(record.id);
      return status;
    }
    record.handle.cancel("Cancelled by the user.");
    await record.handle.promise.catch(() => {});
    // `finish` runs from the promise handlers; give them a tick to land.
    await new Promise((resolve) => setImmediate(resolve));
    return this.finalStatus(record) ?? "cancelled"; // `finish` set it meanwhile
  }

  private finalStatus(record: JobRecord): JobStatus | undefined {
    return record.final?.status;
  }

  stats(): { live: number; byStatus: Record<string, number>; bytes: number; maxBytes: number; ttlSec: number } {
    this.sweep();
    const byStatus: Record<string, number> = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
    for (const record of this.jobs.values()) {
      const status = record.final?.status ?? (record.handle.state() === "queued" ? "queued" : "running");
      byStatus[status]++;
    }
    return { live: this.jobs.size, byStatus, bytes: this.usedBytes(), maxBytes: mbFromEnv("KNIFE_JOBS_MAX_MB", 2048), ttlSec: jobTtlMs() / 1000 };
  }
}

/** One store per process, on globalThis (route bundles and dev HMR each get their own module copy). */
export function jobStore(): JobStore {
  const holder = globalThis as unknown as Record<symbol, JobStore | undefined>;
  holder[GLOBAL_KEY] ??= new JobStore();
  return holder[GLOBAL_KEY];
}

export type { JobStore };
export const jobResultMaxBytes = (): number => mbFromEnv("KNIFE_JOB_RESULT_MAX_MB", 512);
