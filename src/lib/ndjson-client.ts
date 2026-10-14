import { WorkerPool } from "./workers/pool";
import type { NdjsonResult, NdjsonTasks } from "./ndjson";

let pool: WorkerPool<NdjsonTasks> | null = null;

/** Lazy: the worker only starts on the first call (from an effect), never during render/SSR. */
export function validateNdjsonInWorker(text: string, signal: AbortSignal): Promise<NdjsonResult> {
  pool ??= new WorkerPool<NdjsonTasks>({ size: 1, create: () => new Worker(new URL("./ndjson.worker.ts", import.meta.url)) });
  return pool.call("validate", text, { signal });
}
