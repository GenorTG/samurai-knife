import { WorkerPool } from "./workers/pool";
import type { DiffViewInput, DiffViewResult, DiffViewTasks } from "./diff-view";

let pool: WorkerPool<DiffViewTasks> | null = null;

/** Lazy: the worker only starts on the first call (from an effect), never during render/SSR. */
export function diffInWorker(input: DiffViewInput, signal: AbortSignal): Promise<DiffViewResult> {
  pool ??= new WorkerPool<DiffViewTasks>({ size: 1, create: () => new Worker(new URL("./diff-view.worker.ts", import.meta.url)) });
  return pool.call("diff", input, { signal });
}
