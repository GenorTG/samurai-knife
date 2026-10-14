import { WorkerPool } from "./workers/pool";
import type { GradeResult, PunctuationResult, SentencesResult, WritingTasks } from "./writing";

let pool: WorkerPool<WritingTasks> | null = null;

/** Lazy: the worker only starts on the first call (from an effect), never during render/SSR. One worker serves all three tabs. */
function writingPool(): WorkerPool<WritingTasks> {
  pool ??= new WorkerPool<WritingTasks>({ size: 1, create: () => new Worker(new URL("./writing.worker.ts", import.meta.url)) });
  return pool;
}

export const gradeInWorker = (text: string, signal: AbortSignal): Promise<GradeResult | null> => writingPool().call("grade", text, { signal });
export const sentencesInWorker = (text: string, signal: AbortSignal): Promise<SentencesResult> => writingPool().call("sentences", text, { signal });
export const punctuationInWorker = (text: string, signal: AbortSignal): Promise<PunctuationResult> => writingPool().call("punctuation", text, { signal });
