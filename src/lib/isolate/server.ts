/**
 * The app's isolate pool: one bounded set of `worker_threads` for every server path that runs a user-supplied regex or
 * parses an uploaded file (`tasks.ts`). Rule: such work never runs on the main thread (docs/ARCHITECTURE.md gotchas).
 *
 * Threat model: one request crafted to backtrack (a JSON Schema `pattern` like `^(a+)+$`) or to make a parser crawl must
 * not freeze the event loop for every user. Each call has a hard timeout (the worker is terminated, which interrupts a
 * running regex), the worker heap is capped, the queue is bounded (503 + Retry-After) and one account's share too (429):
 * map QueueFullError with `queueFullOrNull` (`queue-http.ts`) in routes; tools surface its message.
 */
import { msgf } from "@/lib/i18n/msg";
import { Worker } from "node:worker_threads";
import { IsolatePool, isIsolateCrash, isIsolateTimeout, type IsolateStats } from "./pool";
import type { IsolateTasks } from "./tasks";
import { recordSecurityEvent } from "../security/events";

function intFromEnv(name: string, fallback: number, min: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(parsed) && parsed >= min ? parsed : fallback;
}

/** Run-time limits per task (queue wait and worker start-up excluded). */
export const ISOLATE_TIMEOUT_MS = {
  validateJsonSchema: 2_000,
  generateRegex: 2_000,
  extractOfficeText: 10_000,
} as const satisfies Record<keyof IsolateTasks & string, number>;

// Versioned: a long-running dev server keeps globalThis across HMR, so a changed pool shape needs a new key.
const GLOBAL_KEY = Symbol.for("samurai-knife.isolate-pool.v1");

/** Lazily created, shared by every route bundle (Next gives each route its own module graph). Sizes read once. */
export function isolatePool(): IsolatePool<IsolateTasks> {
  const holder = globalThis as unknown as Record<symbol, IsolatePool<IsolateTasks> | undefined>;
  const existing = holder[GLOBAL_KEY];
  if (existing && typeof existing.call === "function" && typeof existing.stats === "function") return existing;
  const heapMb = intFromEnv("KNIFE_ISOLATE_HEAP_MB", 256, 32);
  const pool = new IsolatePool<IsolateTasks>({
    name: "isolate",
    size: intFromEnv("KNIFE_ISOLATE_WORKERS", 2, 1),
    maxQueue: intFromEnv("KNIFE_ISOLATE_QUEUE", 16, 0),
    perOwner: intFromEnv("KNIFE_ISOLATE_PER_ACCOUNT", 4, 1),
    create: () => new Worker(new URL("./worker.ts", import.meta.url), {
      resourceLimits: { maxOldGenerationSizeMb: heapMb, maxYoungGenerationSizeMb: Math.min(64, Math.max(8, heapMb / 8)) },
    }),
  });
  holder[GLOBAL_KEY] = pool;
  return pool;
}

export interface RunIsolatedOptions {
  /** Account id: per-account share of the pool. */
  owner?: string;
  signal?: AbortSignal;
  /** Override the task's default limit (tests). */
  timeoutMs?: number;
}

/**
 * Run one task off the main thread. Rejects with the task's own error (message kept), QueueFullError when the pool is
 * full, or an Error saying what was stopped (timeout, out of memory) with `cause` set to the pool's error.
 */
export async function runIsolated<K extends keyof IsolateTasks & keyof typeof ISOLATE_TIMEOUT_MS>(
  task: K,
  payload: IsolateTasks[K]["payload"],
  options: RunIsolatedOptions = {},
  pool: IsolatePool<IsolateTasks> = isolatePool(),
): Promise<IsolateTasks[K]["result"]> {
  const timeoutMs = options.timeoutMs ?? ISOLATE_TIMEOUT_MS[task];
  try {
    return await pool.call(task, payload, { timeoutMs, owner: options.owner, signal: options.signal });
  } catch (error) {
    // A task killed by its limit: input built to backtrack or crawl. Recorded here (pool.ts stays self-contained).
    if (isIsolateTimeout(error)) recordSecurityEvent({ kind: "tool_timeout", account: options.owner, detail: { task, timeoutMs } });
    if (isIsolateTimeout(error) || isIsolateCrash(error)) throw new IsolateStoppedError(task, error);
    throw error;
  }
}

const WHAT: Record<keyof typeof ISOLATE_TIMEOUT_MS, string> = {
  validateJsonSchema: "JSON Schema validation",
  generateRegex: "Regex generation",
  extractOfficeText: "Reading the document's text",
};

/** A task was stopped by the pool's limits. The message names the task and the limit, never input data. */
export class IsolateStoppedError extends Error {
  readonly code = "ISOLATE_STOPPED";
  readonly reason: "timeout" | "resources";
  constructor(task: keyof typeof ISOLATE_TIMEOUT_MS, cause: unknown) {
    const timeout = isIsolateTimeout(cause);
    const hint = task === "validateJsonSchema" ? " A `pattern` with nested quantifiers such as (a+)+ can backtrack for hours; simplify it." : "";
    super(
      timeout
        ? msgf("{value} did not finish within {value2} s and was stopped.{hint}", { value: WHAT[task], value2: (cause as { timeoutMs: number }).timeoutMs / 1000, hint })
        : msgf("{value} was stopped: its background worker ran out of memory or failed.", { value: WHAT[task] }),
      { cause },
    );
    this.name = "IsolateStoppedError";
    this.reason = timeout ? "timeout" : "resources";
  }
}

export const isIsolateStopped = (error: unknown): error is IsolateStoppedError =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ISOLATE_STOPPED";

export function isolateStats(): IsolateStats {
  return isolatePool().stats();
}
