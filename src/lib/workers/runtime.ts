import { serializeError, type RequestMessage, type ResponseMessage, type TaskMap } from "./protocol";

/** Context handed to a task handler inside the worker. */
export interface TaskContext<Progress = unknown> {
  /** Report progress (structured-cloneable) to the caller's `onProgress`. */
  progress(value: Progress): void;
}

/** A handler may return a plain value, or `{ value, transfer }` to move buffers back without copying. */
export interface TransferResult<T> {
  value: T;
  transfer: Transferable[];
}
export function withTransfer<T>(value: T, transfer: Transferable[]): TransferResult<T> {
  return { value, transfer };
}
const isTransferResult = (v: unknown): v is TransferResult<unknown> =>
  typeof v === "object" && v !== null && "transfer" in v && "value" in v && Array.isArray((v as TransferResult<unknown>).transfer);

type ProgressOf<Spec> = Spec extends { progress: infer P } ? P : never;
type Out<R> = R | TransferResult<R>;
/** One handler per task of the contract `Tasks`, fully typed (a missing or mistyped handler fails tsc). */
export type HandlersFor<Tasks extends TaskMap> = {
  [K in keyof Tasks]: (
    payload: Tasks[K]["payload"],
    context: TaskContext<ProgressOf<Tasks[K]>>,
  ) => Out<Tasks[K]["result"]> | Promise<Out<Tasks[K]["result"]>>;
};

interface WorkerScope {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

/**
 * Worker-side half: route `{id, task, payload}` messages to handlers. Handlers run one at a time per worker (the pool
 * never sends a second request before the first settles), so a synchronous handler blocks only this worker.
 * `scope` defaults to the worker's global; tests pass an in-process stand-in.
 */
export function serveTasks<Tasks extends TaskMap>(handlers: HandlersFor<Tasks>, scope: WorkerScope = self as unknown as WorkerScope): void {
  const ready: ResponseMessage = { id: 0, type: "ready" };
  scope.onmessage = (event) => {
    const { id, task, payload } = event.data as RequestMessage;
    const reply = (message: ResponseMessage, transfer: Transferable[] = []) => scope.postMessage(message, transfer);
    const handler = (handlers as Record<string, ((payload: unknown, context: TaskContext) => unknown) | undefined>)[task];
    if (!handler) {
      reply({ id, type: "error", error: { name: "Error", message: `Unknown worker task "${task}".` } });
      return;
    }
    const context: TaskContext = { progress: (value) => reply({ id, type: "progress", value }) };
    Promise.resolve()
      .then(() => handler(payload, context))
      .then(
        (out) => {
          if (isTransferResult(out)) reply({ id, type: "result", value: out.value }, out.transfer);
          else reply({ id, type: "result", value: out });
        },
        (error: unknown) => reply({ id, type: "error", error: serializeError(error) }),
      );
  };
  scope.postMessage(ready);
}
