/**
 * A bounded pool of Node `worker_threads` for CPU work on untrusted input (the server-side twin of `src/lib/workers/pool.ts`).
 *
 * Threat model: a request whose input makes a parser or a regex run for minutes (ReDoS, quadratic scans) or allocate
 * gigabytes must not stop the event loop or take the process down. Every task runs off the main thread under a hard
 * wall-clock timeout (the worker is terminated, V8 interrupts even a backtracking regex) and a V8 heap cap; the queue is
 * bounded and sheds load with QueueFullError (503 + Retry-After, `queue-http.ts`), one owner's share is capped (429).
 * A worker shares the process: this bounds CPU time and memory, it is not a boundary against memory-corruption exploits.
 *
 * Self-contained (node builtins + sibling modules only, no `@/` imports) so `node --test` loads it with a fake worker.
 */
import { QueueFullError } from "../work-queue";
import type { RequestMessage, ResponseMessage, SerializedError, TaskMap } from "../workers/protocol";
import { msg } from "@/lib/i18n/msg";

/** The part of `worker_threads.Worker` the pool uses, so tests can pass an in-process fake. */
export interface IsolateWorker {
  postMessage(message: unknown): void;
  terminate(): unknown;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  removeAllListeners(): unknown;
  ref?(): void;
  unref?(): void;
}

export interface IsolatePoolOptions {
  /** Shown in stats and in QueueFullError (`lane`). */
  name: string;
  /** Called lazily when a task is about to run, never at import time. */
  create: () => IsolateWorker;
  /** Workers that may run at once. */
  size: number;
  /** Tasks that may wait for a worker (not counting running ones). Beyond it: QueueFullError (503). */
  maxQueue: number;
  /** Tasks (running + queued) one owner may have; beyond it: QueueFullError scope "owner" (429). Unset = no cap. */
  perOwner?: number;
  /** A worker that has not reported ready within this time is treated as crashed. Default 30 s (first compile in `next dev`). */
  startupTimeoutMs?: number;
  /** Retry-After hint on a full queue. Default 2 s. */
  retryAfterSec?: number;
  now?: () => number;
}

export interface IsolateCallOptions {
  /** Run-time limit, counted from when the worker starts the task (queue wait and worker start-up excluded). Required. */
  timeoutMs: number;
  /** Abort = reject with AbortError; a running task's worker is terminated (and respawned lazily). */
  signal?: AbortSignal;
  /** Account id: per-owner cap. */
  owner?: string;
}

export interface IsolateStats {
  name: string;
  size: number;
  maxQueue: number;
  perOwner: number | null;
  spawned: number;
  live: number;
  busy: number;
  queued: number;
  completed: number;
  /** The task threw a (user-facing) error inside the worker. */
  failed: number;
  timedOut: number;
  /** The worker died: out of heap, failed to load, uncaught error. */
  crashed: number;
  cancelled: number;
  /** Refused because the queue (or the owner's share) was full. */
  rejected: number;
  waitMs: { n: number; p50: number; p95: number };
  runMs: { n: number; p50: number; p95: number };
}

// Code checks instead of instanceof: a bundler can hold two copies of this module (one per route graph).
const hasCode = (error: unknown, code: string): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;

/** `timeoutMs` elapsed while the task ran; its worker was terminated. */
export class IsolateTimeoutError extends Error {
  readonly code = "ISOLATE_TIMEOUT";
  readonly timeoutMs: number;
  constructor(timeoutMs: number, what = "The computation") {
    super(`${what} did not finish within ${timeoutMs} ms and was stopped. Simplify the input and try again.`);
    this.name = "IsolateTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** The worker died (heap cap, load failure, uncaught error). It has been terminated and respawns lazily. */
export class IsolateCrashError extends Error {
  readonly code = "ISOLATE_CRASH";
  constructor(message = "The computation ran out of resources and was stopped.") {
    super(message);
    this.name = "IsolateCrashError";
  }
}

/** The task itself threw inside the worker; the message is the task's own (user-facing) error text. */
export class IsolateTaskError extends Error {
  readonly code = "ISOLATE_TASK";
  readonly remoteName: string;
  constructor(error: SerializedError) {
    super(error.message);
    this.name = "IsolateTaskError";
    this.remoteName = error.name;
  }
}

export const isIsolateTimeout = (error: unknown): error is IsolateTimeoutError => hasCode(error, "ISOLATE_TIMEOUT");
export const isIsolateCrash = (error: unknown): error is IsolateCrashError => hasCode(error, "ISOLATE_CRASH");
export const isIsolateTaskError = (error: unknown): error is IsolateTaskError => hasCode(error, "ISOLATE_TASK");

function abortError(): Error {
  return new DOMException("The operation was cancelled.", "AbortError");
}

const SAMPLES = 256;
function percentiles(samples: number[]): { n: number; p50: number; p95: number } {
  if (samples.length === 0) return { n: 0, p50: 0, p95: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { n: samples.length, p50: at(0.5), p95: at(0.95) };
}
function pushSample(samples: number[], value: number): void {
  samples.push(value);
  if (samples.length > SAMPLES) samples.shift();
}

interface Job {
  id: number;
  task: string;
  payload: unknown;
  options: IsolateCallOptions;
  owner: string;
  enqueuedAt: number;
  startedAt: number | null;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
  detach: (() => void) | null;
  settled: boolean;
}

interface Slot {
  worker: IsolateWorker | null;
  job: Job | null;
  ready: boolean;
  startupTimer: ReturnType<typeof setTimeout> | null;
}

export class IsolatePool<Tasks extends TaskMap> {
  private readonly options: Required<Omit<IsolatePoolOptions, "perOwner">> & { perOwner: number | null };
  private readonly slots: Slot[] = [];
  private readonly queue: Job[] = [];
  private readonly perOwnerCount = new Map<string, number>();
  private nextId = 1;
  private counters = { spawned: 0, completed: 0, failed: 0, timedOut: 0, crashed: 0, cancelled: 0, rejected: 0 };
  private readonly waits: number[] = [];
  private readonly runs: number[] = [];

  constructor(options: IsolatePoolOptions) {
    this.options = {
      name: options.name,
      create: options.create,
      size: Math.max(1, Math.floor(options.size)),
      maxQueue: Math.max(0, Math.floor(options.maxQueue)),
      perOwner: options.perOwner && options.perOwner > 0 ? Math.floor(options.perOwner) : null,
      startupTimeoutMs: options.startupTimeoutMs ?? 30_000,
      retryAfterSec: options.retryAfterSec ?? 2,
      now: options.now ?? Date.now,
    };
    for (let i = 0; i < this.options.size; i += 1) this.slots.push({ worker: null, job: null, ready: false, startupTimer: null });
  }

  call<K extends keyof Tasks & string>(task: K, payload: Tasks[K]["payload"], options: IsolateCallOptions): Promise<Tasks[K]["result"]> {
    if (options.signal?.aborted) return Promise.reject(abortError());
    const owner = options.owner ?? "";
    // Cheap checks first: a full pool refuses before anything is copied to a worker.
    if (this.options.perOwner !== null && owner && (this.perOwnerCount.get(owner) ?? 0) >= this.options.perOwner) {
      this.counters.rejected += 1;
      return Promise.reject(new QueueFullError(this.options.name, this.options.perOwner, this.options.retryAfterSec, "owner"));
    }
    const idle = this.slots.some((slot) => !slot.job);
    if (!idle && this.queue.length >= this.options.maxQueue) {
      this.counters.rejected += 1;
      return Promise.reject(new QueueFullError(this.options.name, this.queue.length, this.options.retryAfterSec, "lane"));
    }
    return new Promise((resolve, reject) => {
      const job: Job = {
        id: this.nextId++,
        task,
        payload,
        options,
        owner,
        enqueuedAt: this.options.now(),
        startedAt: null,
        resolve,
        reject,
        timer: null,
        detach: null,
        settled: false,
      };
      if (owner) this.perOwnerCount.set(owner, (this.perOwnerCount.get(owner) ?? 0) + 1);
      const signal = options.signal;
      if (signal) {
        const onAbort = () => this.abortJob(job);
        signal.addEventListener("abort", onAbort, { once: true });
        job.detach = () => signal.removeEventListener("abort", onAbort);
      }
      this.queue.push(job);
      this.pump();
    });
  }

  /** Reject everything pending with AbortError and terminate all workers (they respawn on the next call). */
  terminateAll(): void {
    for (const job of this.queue.splice(0)) this.settle(job, "reject", abortError());
    for (const slot of this.slots) {
      const job = slot.job;
      this.kill(slot);
      if (job) this.settle(job, "reject", abortError());
    }
  }

  stats(): IsolateStats {
    return {
      name: this.options.name,
      size: this.options.size,
      maxQueue: this.options.maxQueue,
      perOwner: this.options.perOwner,
      ...this.counters,
      live: this.slots.filter((s) => s.worker).length,
      busy: this.slots.filter((s) => s.job).length,
      queued: this.queue.length,
      waitMs: percentiles(this.waits),
      runMs: percentiles(this.runs),
    };
  }

  private pump(): void {
    for (const slot of this.slots) {
      if (this.queue.length === 0) return;
      if (slot.job) continue;
      this.start(slot, this.queue.shift() as Job);
    }
  }

  private spawn(slot: Slot): IsolateWorker | null {
    let worker: IsolateWorker;
    try {
      worker = this.options.create();
    } catch (error) {
      console.error(`[isolate:${this.options.name}] cannot start a worker:`, error instanceof Error ? error.message : error);
      return null;
    }
    this.counters.spawned += 1;
    slot.worker = worker;
    slot.ready = false;
    worker.on("message", (message) => {
      if (slot.worker === worker) this.onMessage(slot, message as ResponseMessage);
    });
    worker.on("error", (error) => {
      if (slot.worker === worker) this.onCrash(slot, error);
    });
    worker.on("exit", () => {
      if (slot.worker === worker) this.onCrash(slot, null);
    });
    // After the listeners (attaching a "message" listener re-refs a worker_threads Worker): an idle pool never keeps the
    // process alive; `start` refs the worker while it has a task.
    worker.unref?.();
    slot.startupTimer = setTimeout(() => {
      slot.startupTimer = null;
      if (slot.worker === worker && !slot.ready) this.onCrash(slot, new Error("worker start-up timed out"));
    }, this.options.startupTimeoutMs);
    slot.startupTimer.unref?.();
    return worker;
  }

  private start(slot: Slot, job: Job): void {
    const worker = slot.worker ?? this.spawn(slot);
    if (!worker) {
      this.counters.crashed += 1;
      this.settle(job, "reject", new IsolateCrashError(msg("The background worker could not be started.")));
      this.pump();
      return;
    }
    slot.job = job;
    worker.ref?.();
    job.startedAt = this.options.now();
    pushSample(this.waits, job.startedAt - job.enqueuedAt);
    if (slot.ready) this.armTimeout(slot, job);
    const message: RequestMessage = { id: job.id, task: job.task, payload: job.payload };
    try {
      worker.postMessage(message);
    } catch (error) {
      // Not structured-cloneable: the caller's fault, not the worker's. The worker is fine.
      slot.job = null;
      worker.unref?.();
      this.counters.failed += 1;
      this.settle(job, "reject", error);
      this.pump();
    }
  }

  private armTimeout(slot: Slot, job: Job): void {
    if (job.timer) return;
    const timeoutMs = Math.max(1, job.options.timeoutMs);
    job.timer = setTimeout(() => {
      if (slot.job !== job) return;
      this.counters.timedOut += 1;
      this.kill(slot);
      this.settle(job, "reject", new IsolateTimeoutError(timeoutMs));
      this.pump();
    }, timeoutMs);
  }

  private onMessage(slot: Slot, message: ResponseMessage): void {
    if (message.type === "ready") {
      slot.ready = true;
      if (slot.startupTimer) clearTimeout(slot.startupTimer);
      slot.startupTimer = null;
      if (slot.job) this.armTimeout(slot, slot.job);
      return;
    }
    const job = slot.job;
    if (!job || message.id !== job.id || message.type === "progress") return;
    slot.job = null;
    slot.worker?.unref?.();
    if (message.type === "result") {
      this.counters.completed += 1;
      this.settle(job, "resolve", message.value);
    } else {
      this.counters.failed += 1;
      this.settle(job, "reject", new IsolateTaskError(message.error));
    }
    this.pump();
  }

  private onCrash(slot: Slot, error: Error | null): void {
    const job = slot.job;
    this.kill(slot);
    if (job) {
      this.counters.crashed += 1;
      const oom = error && /ERR_WORKER_OUT_OF_MEMORY|out of memory|heap/i.test(`${(error as { code?: string }).code ?? ""} ${error.message}`);
      // Not the input's fault (a worker that cannot load, an uncaught error): leave a trace for the operator.
      if (error && !oom) console.error(`[isolate:${this.options.name}] worker failed during a task:`, error.message);
      this.settle(job, "reject", new IsolateCrashError(oom ? "The computation needed more memory than allowed and was stopped." : undefined));
    } else if (error) {
      console.error(`[isolate:${this.options.name}] idle worker died:`, error.message);
    }
    this.pump();
  }

  private abortJob(job: Job): void {
    if (job.settled) return;
    const queued = this.queue.indexOf(job);
    if (queued >= 0) this.queue.splice(queued, 1);
    const slot = this.slots.find((s) => s.job === job);
    if (slot) this.kill(slot);
    this.counters.cancelled += 1;
    this.settle(job, "reject", abortError());
    this.pump();
  }

  /** Terminate the slot's worker and free the slot. It respawns lazily on the next job. */
  private kill(slot: Slot): void {
    const worker = slot.worker;
    slot.worker = null;
    slot.job = null;
    slot.ready = false;
    if (slot.startupTimer) clearTimeout(slot.startupTimer);
    slot.startupTimer = null;
    if (worker) {
      worker.removeAllListeners();
      worker.on("error", () => {}); // a late error from a terminating worker must not become an uncaught exception
      try {
        void Promise.resolve(worker.terminate()).catch(() => {});
      } catch {
        // already gone
      }
    }
  }

  private settle(job: Job, how: "resolve" | "reject", value: unknown): void {
    if (job.settled) return;
    job.settled = true;
    if (job.timer) clearTimeout(job.timer);
    job.detach?.();
    if (job.startedAt !== null) pushSample(this.runs, this.options.now() - job.startedAt);
    if (job.owner) {
      const left = (this.perOwnerCount.get(job.owner) ?? 1) - 1;
      if (left > 0) this.perOwnerCount.set(job.owner, left);
      else this.perOwnerCount.delete(job.owner);
    }
    if (how === "resolve") job.resolve(value);
    else job.reject(value);
  }
}
