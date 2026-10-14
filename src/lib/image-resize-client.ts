import { WorkerPool } from "./workers/pool";
import type { ResizeInput, ResizeTasks } from "./image-resize";

let pool: WorkerPool<ResizeTasks> | null = null;

/** Lazy single worker; aborting terminates it (the next resize respawns it). Call from effects/handlers only. */
export function resizeInWorker(input: ResizeInput, signal: AbortSignal): Promise<Blob> {
  pool ??= new WorkerPool<ResizeTasks>({ size: 1, create: () => new Worker(new URL("./image-resize.worker.ts", import.meta.url)) });
  return pool.call("resize", input, { signal });
}
