"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, errorText, getOp, getService, serviceAction, type OpView, type ServiceAction, type ServiceView } from "./client";

/**
 * One sidecar's status plus its running op. Polls the op every second while one runs (and the status every 15 s
 * otherwise), so the progress the server records is what the page shows, across reloads and tabs.
 */
export function useSidecar(id: string) {
  const [service, setService] = useState<ServiceView | null>(null);
  const [op, setOp] = useState<OpView | null>(null);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);

  const refresh = useCallback((memory = false): Promise<ServiceView | null> => {
    return (async () => {
      try {
        const next = await getService(id, memory);
        if (!alive.current) return null;
        setService(next);
        if (next.op) setOp(next.op);
        return next;
      } catch (err) {
        if (alive.current) setError({ message: errorText(err), hint: err instanceof ApiError ? err.hint : undefined });
        return null;
      } finally {
        if (alive.current) setLoading(false);
      }
    })();
  }, [id]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh]);

  const running = op?.status === "running";
  const opId = op?.opId;
  useEffect(() => {
    if (!opId || !running) {
      const timer = setInterval(() => void refresh(), 15_000);
      return () => clearInterval(timer);
    }
    const timer = setInterval(async () => {
      try {
        const next = await getOp(opId);
        if (!alive.current) return;
        setOp(next);
        if (next.status !== "running") {
          if (next.status === "failed") setError({ message: next.error ?? "Failed.", hint: next.hint });
          void refresh();
        }
      } catch (err) {
        if (alive.current) setError({ message: errorText(err) });
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [opId, running, refresh]);

  const act = useCallback(async (body: ServiceAction) => {
    setError(null);
    try {
      const started = await serviceAction(id, body);
      setOp(started);
      return started;
    } catch (err) {
      setError({ message: errorText(err), hint: err instanceof ApiError ? err.hint : undefined });
      return null;
    }
  }, [id]);

  /** Lets callers (lazy start) show an op they started through another endpoint. */
  const follow = useCallback((next: OpView) => setOp(next), []);

  return { service, op, running, error, loading, refresh, act, follow, setError };
}
