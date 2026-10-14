import { WorkerPool } from "./workers/pool";
import type { DiagramResult, DiagramTasks } from "./json-diagram";

let pool: WorkerPool<DiagramTasks> | null = null;

/** Lazy: the worker only starts on the first call (from an effect), never during render/SSR. */
export function diagramJsonInWorker(text: string, signal: AbortSignal): Promise<DiagramResult> {
  pool ??= new WorkerPool<DiagramTasks>({ size: 1, create: () => new Worker(new URL("./json-diagram.worker.ts", import.meta.url)) });
  return pool.call("diagram", text, { signal });
}
