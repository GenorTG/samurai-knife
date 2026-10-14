import { WorkerPool } from "./workers/pool";
import type { JsonToolInput, JsonToolOutput, JsonToolTasks } from "./json-tool";

let pool: WorkerPool<JsonToolTasks> | null = null;

/** Lazy: the worker only starts on the first call (from an effect), never during render/SSR. */
export function runJsonToolInWorker(input: JsonToolInput, signal: AbortSignal): Promise<JsonToolOutput> {
  pool ??= new WorkerPool<JsonToolTasks>({ size: 1, create: () => new Worker(new URL("./json-tool.worker.ts", import.meta.url)) });
  return pool.call("json", input, { signal });
}
