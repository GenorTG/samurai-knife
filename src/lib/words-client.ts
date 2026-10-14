import { WorkerPool } from "./workers/pool";
import type { WordsInput, WordsOutput, WordsTasks } from "./words";

let pool: WorkerPool<WordsTasks> | null = null;

/** Lazy: the worker only starts on the first call (from an effect), never during render/SSR. */
export function countWordsInWorker(input: WordsInput, signal: AbortSignal): Promise<WordsOutput> {
  pool ??= new WorkerPool<WordsTasks>({ size: 1, create: () => new Worker(new URL("./words.worker.ts", import.meta.url)) });
  return pool.call("words", input, { signal });
}
