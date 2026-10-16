/**
 * Bounded, abortable, observable work queue with named lanes.
 *
 * Self-contained on purpose (node builtins only, no `@/` imports) so `node --test` can load it directly.
 * The queue does not spawn anything itself: a task receives an AbortSignal and must stop (and clean up after)
 * itself when it fires. The slot is held until the task has actually settled, so a lane cap is a cap on live
 * work, not on promises. A task that ignores the signal is force-released after `abortGraceMs`.
 *
 * Lanes are independent (separate slots, separate queues): a job in one lane never waits behind another lane.
 *
 * Fairness between accounts: a job may carry an `owner`. A lane can cap one owner's jobs (`perOwner`, running + queued),
 * and a free slot goes to the queued job whose owner has the fewest jobs running in that lane (FIFO among equals), so one
 * account submitting many jobs never makes another account's single job wait behind all of them.
 */

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface LaneConfig {
  /** Jobs that may run at once. */
  concurrency: number;
  /** Jobs that may wait (not counting running ones). 0 = reject whenever all slots are busy. */
  maxDepth: number;
  /** Jobs (running + queued) one owner may have in this lane; unset = no per-owner cap. */
  perOwner?: number;
}

export interface TaskContext {
  /** Fires on cancel, caller abort or timeout; `signal.reason` is the typed error. */
  signal: AbortSignal;
}

export type Task<T> = (context: TaskContext) => Promise<T>;

export interface SubmitOptions {
  /** Caller abort: removes a queued job, kills a running one. */
  signal?: AbortSignal;
  /** Run-time limit in ms (queue wait does not count). Aborts the task's signal with a JobTimeoutError. */
  timeoutMs?: number;
  label?: string;
  /** Who submitted it (account id): per-owner cap and fair slot hand-out. Unset = one shared group, no per-owner cap. */
  owner?: string;
}

export class QueueFullError extends Error {
  readonly code = "QUEUE_FULL";
  readonly lane: string;
  readonly depth: number;
  readonly retryAfterSec: number;
  /** `owner`: the caller's own jobs fill its share of the lane; `lane`: the lane itself is full. */
  readonly scope: "lane" | "owner";
  constructor(lane: string, depth: number, retryAfterSec: number, scope: "lane" | "owner" = "lane") {
    super(scope === "owner"
      ? `You already have ${depth} jobs in the ${lane} work queue. Wait for one to finish, then try again.`
      : `The ${lane} work queue is full (${depth} waiting). Try again shortly.`);
    this.name = "QueueFullError";
    this.lane = lane;
    this.depth = depth;
    this.retryAfterSec = retryAfterSec;
    this.scope = scope;
  }
}

export class JobCancelledError extends Error {
  readonly code = "JOB_CANCELLED";
  constructor(message = "Job cancelled.") {
    super(message);
    this.name = "JobCancelledError";
  }
}

export class JobTimeoutError extends Error {
  readonly code = "JOB_TIMEOUT";
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`Timed out after ${Math.round(timeoutMs / 1000)}s.`);
    this.name = "JobTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

// Code checks instead of instanceof: a bundler can hold two copies of this module (one per route graph).
const hasCode = (error: unknown, code: string): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
export const isQueueFull = (error: unknown): error is QueueFullError => hasCode(error, "QUEUE_FULL");
export const isJobCancelled = (error: unknown): error is JobCancelledError => hasCode(error, "JOB_CANCELLED");
export const isJobTimeout = (error: unknown): error is JobTimeoutError => hasCode(error, "JOB_TIMEOUT");

export interface JobHandle<T> {
  readonly id: string;
  readonly lane: string;
  readonly label?: string;
  /** Settles when the task has settled (or a queued job was removed). Rejects with the typed errors above. */
  readonly promise: Promise<T>;
  state(): JobState;
  /** Queued jobs ahead of this one (0 = next to run); null unless queued. */
  position(): number | null;
  waitMs(): number;
  runMs(): number;
  cancel(reason?: string): void;
}

export interface Percentiles {
  n: number;
  p50: number;
  p95: number;
}

export interface LaneStats extends LaneConfig {
  queued: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  /** Task ignored the abort signal and was force-released. */
  leaked: number;
  waitMs: Percentiles;
  runMs: Percentiles;
}

interface Entry<T> {
  id: string;
  lane: string;
  owner: string;
  label?: string;
  task: Task<T>;
  timeoutMs?: number;
  state: JobState;
  enqueuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  controller: AbortController;
  abortReason?: Error;
  timer?: ReturnType<typeof setTimeout>;
  graceTimer?: ReturnType<typeof setTimeout>;
  detachSignal?: () => void;
  settled: boolean;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface LaneRuntime {
  config: LaneConfig;
  queue: Entry<unknown>[];
  running: Set<Entry<unknown>>;
  completed: number;
  failed: number;
  cancelled: number;
  leaked: number;
  waits: number[];
  runs: number[];
  /** Start sequence number of each owner's most recent job (round-robin among owners). */
  lastStart: Map<string, number>;
  starts: number;
}

const SAMPLE_WINDOW = 256;

function percentiles(samples: readonly number[]): Percentiles {
  if (samples.length === 0) return { n: 0, p50: 0, p95: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
  return { n: sorted.length, p50: rank(0.5), p95: rank(0.95) };
}

function pushSample(samples: number[], value: number): void {
  samples.push(Math.max(0, Math.round(value)));
  if (samples.length > SAMPLE_WINDOW) samples.shift();
}

let idCounter = 0;

export interface WorkQueueOptions {
  /** After an abort, how long to wait for the task to settle before releasing its slot anyway. */
  abortGraceMs?: number;
  now?: () => number;
}

export class WorkQueue<L extends string = string> {
  private readonly lanes = new Map<string, LaneRuntime>();
  private readonly abortGraceMs: number;
  private readonly now: () => number;

  constructor(lanes: Record<L, LaneConfig>, options: WorkQueueOptions = {}) {
    this.abortGraceMs = options.abortGraceMs ?? 10_000;
    this.now = options.now ?? Date.now;
    for (const [name, config] of Object.entries<LaneConfig>(lanes)) {
      if (!Number.isInteger(config.concurrency) || config.concurrency < 1) {
        throw new RangeError(`Lane ${name}: concurrency must be an integer >= 1.`);
      }
      if (!Number.isInteger(config.maxDepth) || config.maxDepth < 0) {
        throw new RangeError(`Lane ${name}: maxDepth must be an integer >= 0.`);
      }
      this.lanes.set(name, {
        config: { ...config },
        queue: [],
        running: new Set(),
        completed: 0,
        failed: 0,
        cancelled: 0,
        leaked: 0,
        waits: [],
        runs: [],
        lastStart: new Map(),
        starts: 0,
      });
    }
  }

  private lane(name: string): LaneRuntime {
    const lane = this.lanes.get(name);
    if (!lane) throw new RangeError(`Unknown lane: ${name}`);
    return lane;
  }

  /** True when a submit to this lane would be accepted right now (lets a route refuse before buffering an upload). */
  hasCapacity(laneName: string, owner?: string): boolean {
    const lane = this.lane(laneName);
    if (owner !== undefined && lane.config.perOwner !== undefined && this.ownerJobs(lane, owner) >= lane.config.perOwner) return false;
    return lane.running.size < lane.config.concurrency || lane.queue.length < lane.config.maxDepth;
  }

  /** Throws QueueFullError when the lane (or the owner's share of it) cannot take another job. */
  assertCapacity(laneName: string, owner?: string): void {
    const lane = this.lane(laneName);
    if (owner !== undefined && lane.config.perOwner !== undefined && this.ownerJobs(lane, owner) >= lane.config.perOwner) {
      throw this.fullError(laneName, "owner");
    }
    if (!this.hasCapacity(laneName)) throw this.fullError(laneName);
  }

  /** Running + queued jobs of one owner in a lane. */
  private ownerJobs(lane: LaneRuntime, owner: string): number {
    let count = 0;
    for (const entry of lane.running) if (entry.owner === owner) count += 1;
    for (const entry of lane.queue) if (entry.owner === owner) count += 1;
    return count;
  }

  private fullError(laneName: string, scope: "lane" | "owner" = "lane"): QueueFullError {
    const lane = this.lane(laneName);
    const typical = percentiles(lane.runs).p50 || 2_000;
    const backlog = lane.queue.length + lane.running.size;
    const seconds = Math.ceil((typical * backlog) / lane.config.concurrency / 1000);
    const depth = scope === "owner" ? lane.config.perOwner ?? 0 : lane.queue.length;
    return new QueueFullError(laneName, depth, Math.min(60, Math.max(1, seconds)), scope);
  }

  submit<T>(laneName: string, task: Task<T>, options: SubmitOptions = {}): JobHandle<T> {
    const lane = this.lane(laneName);
    // Jobs without an owner share one fairness group but are not capped per owner.
    const owner = options.owner ?? "";
    this.assertCapacity(laneName, options.owner);

    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.catch(() => {}); // callers that only watch the handle must not trigger unhandled rejections

    const entry: Entry<T> = {
      id: `q${++idCounter}`,
      lane: laneName,
      owner,
      label: options.label,
      task,
      timeoutMs: options.timeoutMs,
      state: "queued",
      enqueuedAt: this.now(),
      controller: new AbortController(),
      settled: false,
      resolve,
      reject,
    };

    const handle: JobHandle<T> = {
      id: entry.id,
      lane: laneName,
      label: options.label,
      promise,
      state: () => entry.state,
      position: () => {
        if (entry.state !== "queued") return null;
        return lane.queue.indexOf(entry as Entry<unknown>);
      },
      waitMs: () => (entry.startedAt ?? entry.finishedAt ?? this.now()) - entry.enqueuedAt,
      runMs: () => (entry.startedAt === undefined ? 0 : (entry.finishedAt ?? this.now()) - entry.startedAt),
      cancel: (reason) => this.cancel(entry as Entry<unknown>, new JobCancelledError(reason ?? "Job cancelled.")),
    };

    const caller = options.signal;
    if (caller) {
      if (caller.aborted) {
        entry.state = "cancelled";
        entry.finishedAt = entry.enqueuedAt;
        entry.settled = true;
        lane.cancelled++;
        reject(new JobCancelledError("Aborted before it was queued."));
        return handle;
      }
      const onAbort = () => this.cancel(entry as Entry<unknown>, new JobCancelledError("Aborted by the caller."));
      caller.addEventListener("abort", onAbort, { once: true });
      entry.detachSignal = () => caller.removeEventListener("abort", onAbort);
    }

    lane.queue.push(entry as Entry<unknown>);
    this.pump(lane);
    return handle;
  }

  private pump(lane: LaneRuntime): void {
    while (lane.running.size < lane.config.concurrency && lane.queue.length > 0) {
      const entry = lane.queue.splice(this.nextIndex(lane), 1)[0];
      this.start(lane, entry);
    }
  }

  /**
   * The queued job whose owner has the fewest jobs running in the lane; among those, the owner served longest ago
   * (round-robin); the oldest job of that owner.
   */
  private nextIndex(lane: LaneRuntime): number {
    const running = new Map<string, number>();
    for (const entry of lane.running) running.set(entry.owner, (running.get(entry.owner) ?? 0) + 1);
    let best = 0;
    let bestRunning = Infinity;
    let bestServed = Infinity;
    for (let index = 0; index < lane.queue.length; index += 1) {
      const owner = lane.queue[index].owner;
      const count = running.get(owner) ?? 0;
      const served = lane.lastStart.get(owner) ?? -1;
      if (count < bestRunning || (count === bestRunning && served < bestServed)) {
        best = index;
        bestRunning = count;
        bestServed = served;
      }
    }
    return best;
  }

  private start(lane: LaneRuntime, entry: Entry<unknown>): void {
    entry.state = "running";
    entry.startedAt = this.now();
    lane.lastStart.set(entry.owner, lane.starts++);
    if (lane.lastStart.size > 10_000) lane.lastStart.clear(); // bounded: forgetting only resets the round-robin order
    pushSample(lane.waits, entry.startedAt - entry.enqueuedAt);
    lane.running.add(entry);

    if (entry.timeoutMs !== undefined && entry.timeoutMs > 0) {
      entry.timer = setTimeout(() => this.cancel(entry, new JobTimeoutError(entry.timeoutMs!)), entry.timeoutMs);
    }

    let running: Promise<unknown>;
    try {
      running = Promise.resolve(entry.task({ signal: entry.controller.signal }));
    } catch (error) {
      running = Promise.reject(error);
    }
    running.then(
      (value) => this.finish(lane, entry, { value }),
      (error: unknown) => this.finish(lane, entry, { error }),
    );
  }

  private cancel(entry: Entry<unknown>, reason: Error): void {
    if (entry.settled || entry.abortReason) return;
    const lane = this.lane(entry.lane);

    if (entry.state === "queued") {
      const index = lane.queue.indexOf(entry);
      if (index >= 0) lane.queue.splice(index, 1);
      entry.state = "cancelled";
      entry.finishedAt = this.now();
      entry.settled = true;
      entry.detachSignal?.();
      lane.cancelled++;
      entry.reject(reason);
      return;
    }

    // Running: tell the task to stop; its slot is released when it settles (or after the grace period).
    entry.abortReason = reason;
    entry.controller.abort(reason);
    entry.graceTimer = setTimeout(() => {
      lane.leaked++;
      this.finish(lane, entry, { error: reason });
    }, this.abortGraceMs);
  }

  private finish(lane: LaneRuntime, entry: Entry<unknown>, outcome: { value?: unknown; error?: unknown }): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.finishedAt = this.now();
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.graceTimer) clearTimeout(entry.graceTimer);
    entry.detachSignal?.();
    lane.running.delete(entry);
    pushSample(lane.runs, entry.finishedAt - (entry.startedAt ?? entry.finishedAt));

    if (entry.abortReason) {
      // Cancelled by the caller counts as cancelled; a timeout is a failure of the job itself.
      if (isJobTimeout(entry.abortReason)) {
        entry.state = "failed";
        lane.failed++;
      } else {
        entry.state = "cancelled";
        lane.cancelled++;
      }
      entry.reject(entry.abortReason);
    } else if ("error" in outcome) {
      entry.state = "failed";
      lane.failed++;
      entry.reject(outcome.error);
    } else {
      entry.state = "done";
      lane.completed++;
      entry.resolve(outcome.value);
    }
    this.pump(lane);
  }

  stats(): Record<L, LaneStats> {
    const out: Record<string, LaneStats> = {};
    for (const [name, lane] of this.lanes) {
      out[name] = {
        ...lane.config,
        queued: lane.queue.length,
        running: lane.running.size,
        completed: lane.completed,
        failed: lane.failed,
        cancelled: lane.cancelled,
        leaked: lane.leaked,
        waitMs: percentiles(lane.waits),
        runMs: percentiles(lane.runs),
      };
    }
    return out as Record<L, LaneStats>;
  }
}

/* ------------------------------------------------------------------ app singleton */

export type PyLane = "light" | "heavy";

function intFromEnv(name: string, fallback: number, min: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(parsed) && parsed >= min ? parsed : fallback;
}

const GLOBAL_KEY = Symbol.for("samurai-knife.work-queue");

/**
 * The Python lane's queue. Held on globalThis: Next bundles every route into its own module graph (and dev HMR
 * re-evaluates modules), so a plain module-level variable would give each route its own, uncoordinated queue.
 * Lane sizes are read once, when the first caller creates it.
 */
export function pythonQueue(): WorkQueue<PyLane> {
  const holder = globalThis as unknown as Record<symbol, WorkQueue<PyLane> | undefined>;
  holder[GLOBAL_KEY] ??= new WorkQueue<PyLane>({
    light: {
      concurrency: intFromEnv("KNIFE_PY_LIGHT", 4, 1),
      maxDepth: intFromEnv("KNIFE_PY_LIGHT_DEPTH", 64, 0),
      perOwner: intFromEnv("KNIFE_PY_LIGHT_PER_ACCOUNT", 8, 1),
    },
    heavy: {
      concurrency: intFromEnv("KNIFE_PY_HEAVY", 1, 1),
      maxDepth: intFromEnv("KNIFE_PY_HEAVY_DEPTH", 16, 0),
      perOwner: intFromEnv("KNIFE_PY_HEAVY_PER_ACCOUNT", 3, 1),
    },
  });
  return holder[GLOBAL_KEY];
}
