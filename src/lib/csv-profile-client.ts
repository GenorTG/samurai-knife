import { WorkerPool } from "./workers/pool";
import type { CsvProfileInput, CsvProfileOutput, CsvProfileTasks } from "./csv-profile";

let pool: WorkerPool<CsvProfileTasks> | null = null;

/** Lazy: the worker only starts on the first call (from an effect), never during render/SSR. */
export function profileCsvInWorker(input: CsvProfileInput, signal: AbortSignal): Promise<CsvProfileOutput> {
  pool ??= new WorkerPool<CsvProfileTasks>({ size: 1, create: () => new Worker(new URL("./csv-profile.worker.ts", import.meta.url)) });
  return pool.call("profile", input, { signal });
}
