import { isAbortError, WorkerTimeoutError } from "./workers/errors";
import { WorkerPool } from "./workers/pool";
import type { RegexRunInput, RegexRunOutput, RegexTasks } from "./regex-run";

/** A regex that takes longer than this on the subject is treated as catastrophic backtracking and stopped. */
export const REGEX_TIMEOUT_MS = 1000;
export const REGEX_TOO_SLOW = "Pattern too slow (possible catastrophic backtracking). It was stopped after 1 second; simplify the pattern or shorten the subject.";

export type RegexOutcome =
  | { status: "ok"; output: RegexRunOutput }
  | { status: "timeout"; message: string }
  | { status: "cancelled" }
  | { status: "error"; message: string };

/** One dedicated worker for the regex lab; a stuck regex is stopped by terminating it, which the next run respawns. */
export class RegexRunner {
  private readonly pool = new WorkerPool<RegexTasks>({
    size: 1,
    create: () => new Worker(new URL("./regex.worker.ts", import.meta.url)),
  });

  dispose(): void {
    this.pool.terminateAll();
  }

  async run(input: RegexRunInput, signal?: AbortSignal): Promise<RegexOutcome> {
    try {
      return { status: "ok", output: await this.pool.call("run", input, { signal, timeoutMs: REGEX_TIMEOUT_MS }) };
    } catch (error) {
      if (isAbortError(error)) return { status: "cancelled" };
      if (error instanceof WorkerTimeoutError) return { status: "timeout", message: REGEX_TOO_SLOW };
      return { status: "error", message: error instanceof Error ? error.message : "Matching failed." };
    }
  }
}
