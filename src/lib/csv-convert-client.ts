import { WorkerPool } from "./workers/pool";
import type { CsvConvertInput, CsvConvertOutput, CsvConvertTasks } from "./csv-convert";

let pool: WorkerPool<CsvConvertTasks> | null = null;

/** Lazy: the worker only starts on the first call (from an effect), never during render/SSR. */
export function convertCsvInWorker(input: CsvConvertInput, signal: AbortSignal): Promise<CsvConvertOutput> {
  pool ??= new WorkerPool<CsvConvertTasks>({ size: 1, create: () => new Worker(new URL("./csv-convert.worker.ts", import.meta.url)) });
  return pool.call("convert", input, { signal });
}
