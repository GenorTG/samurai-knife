import type { SerializedError } from "./protocol";

/** The task function itself threw inside the worker; `remoteName` is the original error class name. */
export class WorkerTaskError extends Error {
  remoteName: string;
  remoteStack: string | undefined;
  constructor(error: SerializedError) {
    super(error.message);
    this.name = "WorkerTaskError";
    this.remoteName = error.name;
    this.remoteStack = error.stack;
  }
}

/** The worker died (uncaught error, failed to load, out of memory). It has been terminated and respawns lazily. */
export class WorkerCrashError extends Error {
  constructor(message = "The background worker crashed.") {
    super(message);
    this.name = "WorkerCrashError";
  }
}

/** `timeoutMs` elapsed while the task was running; the worker was terminated. */
export class WorkerTimeoutError extends Error {
  timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`The background task did not finish within ${timeoutMs} ms and was stopped.`);
    this.name = "WorkerTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** Workers cannot be created here (SSR, or a browser without Worker support). */
export class WorkerUnavailableError extends Error {
  constructor(message = "Web Workers are not available in this environment.") {
    super(message);
    this.name = "WorkerUnavailableError";
  }
}

export function abortError(): Error {
  return new DOMException("The operation was cancelled.", "AbortError");
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
