"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isAbortError } from "./errors";

export type OffloadStatus = "idle" | "running" | "done" | "cancelled" | "error";

export interface Offloaded<O> {
  status: OffloadStatus;
  /** Latest finished result; kept while the next run is in flight so the page never blanks. */
  value: O | null;
  error: string | null;
  /** Milliseconds the current run has been going (ticks while running), 0 otherwise. */
  elapsedMs: number;
  /** Stop the current run (terminates the worker behind it). Editing the input runs again. */
  cancel: () => void;
}

interface Options {
  enabled?: boolean;
  /** Wait this long after the last input change before starting (typing does not queue a run per key). */
  debounceMs?: number;
}

type State<O> = { status: OffloadStatus; value: O | null; error: string | null; startedAt: number };

/**
 * Run `task(input)` off the main thread whenever `input` changes (compare by reference: memoize it). A newer input aborts the
 * older run. State is only set from timers/promises, never synchronously in an effect, so it is safe during hydration.
 * `task` is read through a ref; pass a module-level function (it normally calls a worker client singleton).
 */
export function useOffloaded<I, O>(task: (input: I, signal: AbortSignal) => Promise<O>, input: I, { enabled = true, debounceMs = 150 }: Options = {}): Offloaded<O> {
  const [state, setState] = useState<State<O>>({ status: "idle", value: null, error: null, startedAt: 0 });
  const [now, setNow] = useState(0);
  const taskRef = useRef(task);
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => {
    taskRef.current = task;
  });

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let superseded = false;
    const timer = setTimeout(() => {
      controllerRef.current = controller;
      const startedAt = performance.now();
      setState((s) => ({ ...s, status: "running", error: null, startedAt }));
      setNow(startedAt);
      taskRef.current(input, controller.signal).then(
        (value) => {
          if (superseded) return;
          controllerRef.current = null;
          setState({ status: "done", value, error: null, startedAt });
        },
        (error: unknown) => {
          if (superseded) return;
          controllerRef.current = null;
          setState((s) => (isAbortError(error) ? { ...s, status: "cancelled", startedAt } : { ...s, status: "error", error: error instanceof Error ? error.message : String(error), startedAt }));
        },
      );
    }, debounceMs);
    return () => {
      superseded = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [debounceMs, enabled, input]);

  const running = state.status === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(performance.now()), 250);
    return () => clearInterval(timer);
  }, [running]);

  const cancel = useCallback(() => controllerRef.current?.abort(), []);

  if (!enabled) return { status: "idle", value: null, error: null, elapsedMs: 0, cancel };
  return { status: state.status, value: state.value, error: state.error, elapsedMs: running ? Math.max(0, now - state.startedAt) : 0, cancel };
}

/**
 * Small inputs compute inline (no worker round trip, results on the same render, SSR/test friendly); large ones go to the worker.
 * `compute` and `task` must be the same function body: the worker module imports the same pure `compute`.
 */
export function useAdaptive<I, O>(
  compute: (input: I) => O,
  task: (input: I, signal: AbortSignal) => Promise<O>,
  input: I,
  small: boolean,
  options: Options = {},
): Offloaded<O> {
  const inline = useMemo(() => (small ? compute(input) : null), [compute, input, small]);
  const offloaded = useOffloaded(task, input, { ...options, enabled: !small && options.enabled !== false });
  const noop = useCallback(() => undefined, []);
  if (small) return { status: "done", value: inline, error: null, elapsedMs: 0, cancel: noop };
  return offloaded;
}
