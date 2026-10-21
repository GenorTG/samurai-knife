import { createLogWriter, logRoot, SOURCE_ID, type LogWriter } from "./core.mjs";

/**
 * Log writers the Next server owns (src/lib/logs/core.mjs has the format, rotation and retention): one per sidecar,
 * `<log root>/sidecars/<id>/ops-<day>.log`. Kept on globalThis so route modules share them; the shape is checked so an
 * older object kept by a long-running dev server is replaced instead of crashing it (AGENTS.md "State kept on globalThis").
 */

const KEY = Symbol.for("samurai-knife.log-writers.v1");

function writers(): Map<string, LogWriter> {
  const holder = globalThis as unknown as Record<symbol, unknown>;
  if (!(holder[KEY] instanceof Map)) holder[KEY] = new Map<string, LogWriter>();
  return holder[KEY] as Map<string, LogWriter>;
}

/** The op log of one sidecar, or null when file logging is off or the id is not a plain folder name. */
export function sidecarLog(serviceId: string): LogWriter | null {
  if (!SOURCE_ID.test(serviceId)) return null;
  const root = logRoot();
  if (!root) return null;
  const key = `${root}\u0000${serviceId}`;
  let writer = writers().get(key);
  if (!writer) {
    writer = createLogWriter({ root, source: `sidecars/${serviceId}`, prefix: "ops" });
    writers().set(key, writer);
  }
  return writer;
}
