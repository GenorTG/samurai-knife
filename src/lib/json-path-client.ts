import { WorkerPool } from "./workers/pool";
import type { JsonPathInput, JsonPathResult, JsonPathTasks } from "./json-path";

let pool: WorkerPool<JsonPathTasks> | null = null;

/** Lazy: the worker only starts on the first call (from an effect), never during render/SSR. */
export function evaluateJsonPathInWorker(input: JsonPathInput, signal: AbortSignal): Promise<JsonPathResult> {
  pool ??= new WorkerPool<JsonPathTasks>({ size: 1, create: () => new Worker(new URL("./json-path.worker.ts", import.meta.url)) });
  return pool.call("query", input, { signal });
}
