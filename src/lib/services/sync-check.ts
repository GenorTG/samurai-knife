import { sidecarBackend } from "./backend";
import { SIDECARS } from "./definitions";
import { checkSync, type SyncCheck } from "./manager";
import { readState } from "./state";

/**
 * "Sync needed" (docs/DEPLOY.md "Sidecars without the docker group"): with the root helper, a release that changes what a
 * sidecar's bundle renders (compose, secret, editor plugin, generated config) cannot start that sidecar until the owner
 * runs `sudo knife-sidecar sync <id>`. The running containers keep working, so without this the first sign was a failed
 * start after the next reboot. Checked once shortly after every server start (= after every release switch) and then
 * every CHECK_MS; the result is logged once per change and shown to admins (Sidecar services page, /account/admin).
 */

export interface SyncNotice extends SyncCheck {
  id: string;
  name: string;
}

const FIRST_CHECK_MS = 10_000;
export const CHECK_MS = 15 * 60_000;
const GLOBAL_KEY = Symbol.for("samurai-knife.sidecar-sync");

interface SyncRegistry {
  timer?: ReturnType<typeof setInterval>;
  results: Map<string, SyncNotice>;
  /** The reason last logged per sidecar, so a standing problem is logged once, not every pass. */
  logged: Map<string, string>;
}

function registry(): SyncRegistry {
  const holder = globalThis as unknown as Record<symbol, SyncRegistry | undefined>;
  holder[GLOBAL_KEY] ??= { results: new Map(), logged: new Map() };
  return holder[GLOBAL_KEY];
}

/** The log line for a sidecar that needs a sync (one line, the commands to run). Exported for tests. */
export function syncLogLine(id: string, message: string): string {
  return `[sidecars] sync needed: ${id}: ${message.replace(/^Sync needed: /, "")} Run as root: sudo knife-sidecar check ${id} (shows what differs), then sudo knife-sidecar sync ${id}.`;
}

/** Stores one check result and logs a change (needed now, or fixed since the last log). */
export function recordSync(id: string, name: string, check: SyncCheck | null): void {
  const reg = registry();
  if (!check) {
    reg.results.delete(id);
    reg.logged.delete(id);
    return;
  }
  reg.results.set(id, { ...check, id, name });
  if (check.needed) {
    const key = `${check.reason}:${check.message}`;
    if (reg.logged.get(id) !== key) {
      reg.logged.set(id, key);
      console.warn(syncLogLine(id, check.message ?? ""));
    }
  } else if (reg.logged.has(id)) {
    reg.logged.delete(id);
    console.log(`[sidecars] ${id}: the installed bundle matches this release again`);
  }
}

/** Sidecars that need `sudo knife-sidecar sync`, from the last checks (no I/O). */
export function syncNotices(): SyncNotice[] {
  return [...registry().results.values()].filter((notice) => notice.needed).sort((a, b) => a.id.localeCompare(b.id));
}

/** Checks every installed sidecar now (helper backend only) and returns the ones that need a sync. */
export async function refreshSyncChecks(): Promise<SyncNotice[]> {
  if (sidecarBackend().kind !== "helper") {
    registry().results.clear();
    return [];
  }
  for (const def of SIDECARS) {
    if (!readState(def.id)) {
      recordSync(def.id, def.name, null);
      continue;
    }
    try {
      recordSync(def.id, def.name, await checkSync(def.id));
    } catch (error) {
      console.error(`[sidecars] sync check for ${def.id} failed: ${error instanceof Error ? error.message : error}`);
    }
  }
  return syncNotices();
}

/** Called once per server start (src/instrumentation.ts). Idempotent; a no-op pass on the docker backend. */
export function startSyncChecks(): void {
  const reg = registry();
  if (reg.timer) return;
  const pass = () => void refreshSyncChecks().catch((error) => console.error(`[sidecars] sync check pass failed: ${error instanceof Error ? error.message : error}`));
  setTimeout(pass, FIRST_CHECK_MS).unref?.();
  reg.timer = setInterval(pass, CHECK_MS);
  reg.timer.unref?.();
}

/** Tests only. */
export function resetSyncChecks(): void {
  const reg = registry();
  if (reg.timer) clearInterval(reg.timer);
  reg.timer = undefined;
  reg.results.clear();
  reg.logged.clear();
}
