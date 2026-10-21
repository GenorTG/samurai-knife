import { sidecarBackend } from "./backend";
import { SIDECARS } from "./definitions";
import { containerInfo, ensureReaper, type ContainerState } from "./manager";
import { getOp, runningOp, startOp } from "./ops";
import { readLock, readState, type SidecarState } from "./state";

/**
 * Autostart (docs/SIDECARS.md "Autostart"): a sidecar whose state has `autostart` is started when the app boots and
 * started again within a minute whenever it is not running (crash, docker restart, host reboot), unless an
 * administrator stopped it (`heldStopped`, cleared by the next start). It runs as the ordinary start op, so the
 * Sidecars page shows its progress. A failed start waits RETRY_MS before the next try, so a broken install (a helper
 * bundle that needs `sudo knife-sidecar sync`, a missing image) does not loop. The containers keep `restart: "no"`:
 * the app owns their lifecycle, and the app itself is started at boot by systemd.
 */

export const RETRY_MS = 10 * 60_000;
const FIRST_PASS_MS = 15_000;
const INTERVAL_MS = 60_000;
const GLOBAL_KEY = Symbol.for("samurai-knife.sidecar-autostart");

interface AutostartRegistry {
  timer?: ReturnType<typeof setInterval>;
  /** The last start op this loop began, per service, until its outcome is read. */
  lastOp: Map<string, string>;
  /** When a start begun by this loop last failed, per service. */
  failedAt: Map<string, number>;
}

function registry(): AutostartRegistry {
  const holder = globalThis as unknown as Record<symbol, AutostartRegistry | undefined>;
  holder[GLOBAL_KEY] ??= { lastOp: new Map(), failedAt: new Map() };
  return holder[GLOBAL_KEY];
}

/** Whether the loop should start this sidecar now. Pure; exported for tests. */
export function autostartDue(
  state: SidecarState | null,
  container: ContainerState,
  context: { busy: boolean; lastFailureAt?: number; now: number },
): boolean {
  if (!state?.autostart || state.heldStopped || context.busy) return false;
  if (container === "running" || container === "restarting") return false;
  return context.lastFailureAt === undefined || context.now - context.lastFailureAt >= RETRY_MS;
}

/** Reads the outcome of the start op this loop began last time, if it has finished. */
function settle(id: string, now: number): void {
  const reg = registry();
  const opId = reg.lastOp.get(id);
  if (!opId) return;
  const op = getOp(opId);
  if (op?.status === "running") return;
  reg.lastOp.delete(id);
  if (op?.status === "failed") reg.failedAt.set(id, Date.parse(op.finishedAt ?? "") || now);
  else if (op) reg.failedAt.delete(id);
}

/** One autostart pass; exported for tests and the CLI. Returns the ids it began starting. */
export async function autostartPass(now = Date.now()): Promise<string[]> {
  const started: string[] = [];
  const backend = sidecarBackend();
  if (!(await backend.detect()).ok) return started;
  for (const def of SIDECARS) {
    const state = readState(def.id);
    if (!state?.autostart) continue;
    settle(def.id, now);
    const busy = Boolean(readLock(def.id) || runningOp(def.id));
    if (busy || state.heldStopped) continue;
    const info = await containerInfo(backend, def);
    if (!autostartDue(state, info.state, { busy, lastFailureAt: registry().failedAt.get(def.id), now })) continue;
    try {
      const op = startOp(def.id, { kind: "start" });
      registry().lastOp.set(def.id, op.opId);
      started.push(def.id);
      console.log(`[sidecars] autostart: starting ${def.id} (container ${info.state})`);
    } catch {
      /* another op won the race: next pass */
    }
  }
  return started;
}

/** Called once per server start (src/instrumentation.ts): the idle reaper plus the autostart loop. Idempotent. */
export function startSidecarAutostart(): void {
  ensureReaper();
  const reg = registry();
  if (reg.timer) return;
  const pass = () => void autostartPass().catch((error) => console.error(`[sidecars] autostart pass failed: ${error instanceof Error ? error.message : error}`));
  setTimeout(pass, FIRST_PASS_MS).unref?.();
  reg.timer = setInterval(pass, INTERVAL_MS);
  reg.timer.unref?.();
}
