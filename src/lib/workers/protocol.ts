/**
 * Wire protocol shared by the pool (main thread) and `serveTasks` (worker side). Plain structured-clone data only,
 * so it also works with an in-process fake in node tests. Browser-first: no secure-context APIs (no crypto.subtle).
 */

/** What a task looks like to the type system: payload in, result out, optional progress payloads while running. */
export interface TaskSpec {
  payload: unknown;
  result: unknown;
  progress?: unknown;
}
export type TaskMap = Record<string, TaskSpec>;

export interface RequestMessage {
  id: number;
  task: string;
  payload: unknown;
}

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

export type ResponseMessage =
  /** Sent once by serveTasks when the worker script has loaded and can take requests. */
  | { id: 0; type: "ready" }
  | { id: number; type: "result"; value: unknown }
  | { id: number; type: "progress"; value: unknown }
  | { id: number; type: "error"; error: SerializedError };

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };
  return { name: "Error", message: typeof error === "string" ? error : "Unknown worker error" };
}
