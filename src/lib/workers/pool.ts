import { abortError, WorkerCrashError, WorkerTaskError, WorkerTimeoutError, WorkerUnavailableError } from "./errors";
import type { RequestMessage, ResponseMessage, TaskMap } from "./protocol";

/** The subset of `Worker` the pool needs, so tests can supply an in-process fake. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}

export interface CallOptions<Progress = unknown> {
  /** Abort = reject with AbortError; a running task's worker is terminated (and respawned lazily), a queued task is just dropped. */
  signal?: AbortSignal;
  onProgress?: (progress: Progress) => void;
  /** Transferable objects moved (not copied) to the worker, e.g. an ArrayBuffer. */
  transfer?: Transferable[];
  /** Counted from when the task starts running (queue wait and worker start-up excluded). Expiry rejects with WorkerTimeoutError and terminates the worker. */
  timeoutMs?: number;
}

export interface PoolOptions {
  /** Called lazily, only when a task is about to run: never during SSR or hydration. Must contain a literal `new Worker(new URL(...))`. */
  create: () => WorkerLike;
  /** Max concurrent workers. Default `defaultPoolSize()`. */
  size?: number;
}

export interface PoolStats {
  size: number;
  spawned: number;
  busy: number;
  queued: number;
}

/** max(1, hardwareConcurrency - 1), capped (default 3): leave a core for the main thread. */
export function defaultPoolSize(cap = 3): number {
  const cores = typeof navigator !== "undefined" && typeof navigator.hardwareConcurrency === "number" ? navigator.hardwareConcurrency : 2;
  return Math.max(1, Math.min(cap, cores - 1));
}

interface Job {
  id: number;
  task: string;
  payload: unknown;
  options: CallOptions;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
  detach: (() => void) | null;
  settled: boolean;
}

interface Slot {
  worker: WorkerLike | null;
  job: Job | null;
  /** The worker script has loaded (serveTasks sent "ready"); a task timeout only counts from then on. */
  ready: boolean;
}

/**
 * A bounded pool of identical workers with a FIFO queue. Workers are created on demand, not at construction.
 * `size: 1` doubles as a dedicated worker for stateful tasks (the SQLite engine), where a cancel loses the worker's state:
 * callers restore it by sending an init task after the rejection.
 */
export class WorkerPool<Tasks extends TaskMap> {
  private readonly create: () => WorkerLike;
  private readonly size: number;
  private readonly slots: Slot[] = [];
  private readonly queue: Job[] = [];
  private nextId = 1;
  private spawned = 0;

  constructor(options: PoolOptions) {
    this.create = options.create;
    this.size = Math.max(1, options.size ?? defaultPoolSize());
    for (let i = 0; i < this.size; i += 1) this.slots.push({ worker: null, job: null, ready: false });
  }

  call<K extends keyof Tasks & string>(
    task: K,
    payload: Tasks[K]["payload"],
    options: CallOptions<Tasks[K]["progress"]> = {},
  ): Promise<Tasks[K]["result"]> {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(abortError());
        return;
      }
      const job: Job = {
        id: this.nextId++,
        task,
        payload,
        options: options as CallOptions,
        resolve,
        reject,
        timer: null,
        detach: null,
        settled: false,
      };
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

  stats(): PoolStats {
    return {
      size: this.size,
      spawned: this.spawned,
      busy: this.slots.filter((s) => s.job).length,
      queued: this.queue.length,
    };
  }

  private pump(): void {
    for (const slot of this.slots) {
      if (this.queue.length === 0) return;
      if (slot.job) continue;
      const job = this.queue.shift() as Job;
      this.start(slot, job);
    }
  }

  private start(slot: Slot, job: Job): void {
    let worker = slot.worker;
    if (!worker) {
      try {
        worker = this.create();
      } catch (error) {
        this.settle(job, "reject", error instanceof ReferenceError ? new WorkerUnavailableError() : error);
        this.pump();
        return;
      }
      this.spawned += 1;
      slot.worker = worker;
      worker.onmessage = (event) => this.onMessage(slot, event.data as ResponseMessage);
      worker.onerror = (event) => {
        event.preventDefault?.(); // the pool reports the crash; do not also log it as an uncaught page error
        this.onCrash(slot, event.message);
      };
      worker.onmessageerror = () => this.onCrash(slot, "The worker sent a message that could not be decoded.");
    }
    slot.job = job;
    if (slot.ready) this.armTimeout(slot, job);
    const message: RequestMessage = { id: job.id, task: job.task, payload: job.payload };
    try {
      worker.postMessage(message, job.options.transfer ?? []);
    } catch (error) {
      this.kill(slot);
      this.settle(job, "reject", error);
      this.pump();
    }
  }

  /** Start the job's timeout clock (once). Called when the worker is ready and the job is running. */
  private armTimeout(slot: Slot, job: Job): void {
    const timeoutMs = job.options.timeoutMs;
    if (!timeoutMs || timeoutMs <= 0 || job.timer) return;
    job.timer = setTimeout(() => {
      if (slot.job !== job) return;
      this.kill(slot);
      this.settle(job, "reject", new WorkerTimeoutError(timeoutMs));
      this.pump();
    }, timeoutMs);
  }

  private onMessage(slot: Slot, message: ResponseMessage): void {
    if (message.type === "ready") {
      slot.ready = true;
      if (slot.job) this.armTimeout(slot, slot.job);
      return;
    }
    const job = slot.job;
    if (!job || message.id !== job.id) return; // late reply from a task that was already cancelled
    if (message.type === "progress") {
      try {
        job.options.onProgress?.(message.value);
      } catch {
        // a throwing progress listener must not kill the task
      }
      return;
    }
    slot.job = null;
    if (message.type === "result") this.settle(job, "resolve", message.value);
    else this.settle(job, "reject", new WorkerTaskError(message.error));
    this.pump();
  }

  private onCrash(slot: Slot, reason?: string): void {
    const job = slot.job;
    this.kill(slot);
    if (job) this.settle(job, "reject", new WorkerCrashError(reason ? `The background worker crashed: ${reason}` : undefined));
    this.pump();
  }

  private abortJob(job: Job): void {
    if (job.settled) return;
    const queued = this.queue.indexOf(job);
    if (queued >= 0) this.queue.splice(queued, 1);
    const slot = this.slots.find((s) => s.job === job);
    if (slot) this.kill(slot);
    this.settle(job, "reject", abortError());
    this.pump();
  }

  /** Terminate the slot's worker and free the slot. It respawns lazily on the next job. */
  private kill(slot: Slot): void {
    const worker = slot.worker;
    slot.worker = null;
    slot.job = null;
    slot.ready = false;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    }
  }

  private settle(job: Job, how: "resolve" | "reject", value: unknown): void {
    if (job.settled) return;
    job.settled = true;
    if (job.timer) clearTimeout(job.timer);
    job.detach?.();
    if (how === "resolve") job.resolve(value);
    else job.reject(value);
  }
}
