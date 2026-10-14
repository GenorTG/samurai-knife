import { WorkerPool } from "./workers/pool";
import type { TextKitInput, TextKitOutput, TextKitTasks } from "./textkit";

let pool: WorkerPool<TextKitTasks> | null = null;

/** Lazy: the worker only starts on the first call (from an effect), never during render/SSR. */
export function runTextKitInWorker(input: TextKitInput, signal: AbortSignal): Promise<TextKitOutput> {
  pool ??= new WorkerPool<TextKitTasks>({ size: 1, create: () => new Worker(new URL("./textkit.worker.ts", import.meta.url)) });
  return pool.call("transform", input, { signal });
}
