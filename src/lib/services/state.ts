import * as z from "zod/v4";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { ensureDataDir, writePrivateFile } from "@/lib/accounts/store";
import { parseSecrets, renderSecrets, SECRETS_FILE } from "./compose";
import { SIDECAR_ID_PATTERN, type SidecarDefinition } from "./definitions";

/**
 * Per-sidecar state under `$KNIFE_DATA_DIR/services/<id>/` (dir 700, files 600):
 *   state.json   choices made at install (port, bind host, URLs, idle stop) + timestamps
 *   compose.yaml generated from the definition (src/lib/services/compose.ts)
 *   secrets.env  generated once at install (JWT secret…); kept across remove unless the data is purged
 *   op.lock      held while an install/start/stop/remove/update runs (server or CLI), {pid, op, startedAt}
 * Container data lives in named compose volumes (`samurai-knife-<id>_<name>`): the container writes it as root, which a
 * bind mount under the data dir would leave undeletable without sudo.
 */

const stateSchema = z.object({
  id: z.string(),
  image: z.string(),
  bindHost: z.string(),
  hostPort: z.number().int().min(1).max(65535),
  /** URL the container uses to reach this app (file downloads, save callbacks). Unset = derived, see urls.ts. */
  appUrl: z.string().optional(),
  /** URL the browser uses to reach the sidecar. Unset = http://<bindHost>:<hostPort>. */
  publicUrl: z.string().optional(),
  idleStopMinutes: z.number().int().min(0).max(24 * 60),
  installedAt: z.string(),
  updatedAt: z.string(),
  lastUsedAt: z.string().optional(),
  lastStartedAt: z.string().optional(),
  /** Measured "up -d -> healthy" of the latest start, ms. */
  lastStartMs: z.number().optional(),
  /** Container id the definition's `prepare` step last ran in. */
  preparedContainer: z.string().optional(),
  /** sha256 of the compose.yaml the running container was created from; a lazy start recreates it when it differs. */
  composeHash: z.string().optional(),
});

export type SidecarState = z.infer<typeof stateSchema>;

export function servicesRoot(): string {
  const dir = join(ensureDataDir(), "services");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function serviceDir(id: string): string {
  if (!SIDECAR_ID_PATTERN.test(id)) throw new Error(`invalid service id ${id}`);
  const dir = join(servicesRoot(), id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function composeFile(id: string): string {
  return join(serviceDir(id), "compose.yaml");
}

export function readState(id: string): SidecarState | null {
  const file = join(serviceDir(id), "state.json");
  if (!existsSync(file)) return null;
  try {
    return stateSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

export function writeState(state: SidecarState): SidecarState {
  const next = { ...state, updatedAt: new Date().toISOString() };
  writePrivateFile(join(serviceDir(state.id), "state.json"), `${JSON.stringify(stateSchema.parse(next), null, 2)}\n`);
  return next;
}

export function patchState(id: string, patch: Partial<Omit<SidecarState, "id">>): SidecarState | null {
  const current = readState(id);
  if (!current) return null;
  return writeState({ ...current, ...patch });
}

export function removeState(id: string, purge: boolean): void {
  const dir = serviceDir(id);
  if (purge) {
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  // Keep secrets.env: reinstalling reuses the JWT secret, so open editor sessions/tokens stay valid.
  for (const name of ["state.json", "compose.yaml"]) rmSync(join(dir, name), { force: true });
}

/** Existing secrets, plus any the definition needs that are missing (generated now). */
export function ensureSecrets(def: SidecarDefinition): Record<string, string> {
  const file = join(serviceDir(def.id), SECRETS_FILE);
  const current = existsSync(file) ? parseSecrets(readFileSync(file, "utf8")) : {};
  let changed = false;
  for (const secret of def.secrets) {
    if (!current[secret.name]) {
      current[secret.name] = randomBytes(secret.bytes).toString("hex");
      changed = true;
    }
  }
  if (changed || !existsSync(file)) writePrivateFile(file, renderSecrets(current));
  return current;
}

export function readSecret(id: string, name: string): string | null {
  const file = join(serviceDir(id), SECRETS_FILE);
  if (!existsSync(file)) return null;
  return parseSecrets(readFileSync(file, "utf8"))[name] ?? null;
}

/* ------------------------------------------------------------------ op lock (server and CLI share it) */

export interface OpLock {
  pid: number;
  op: string;
  startedAt: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readLock(id: string): OpLock | null {
  const file = join(serviceDir(id), "op.lock");
  if (!existsSync(file)) return null;
  try {
    const lock = JSON.parse(readFileSync(file, "utf8")) as OpLock;
    if (typeof lock.pid === "number" && pidAlive(lock.pid)) return lock;
  } catch {
    /* unreadable = stale */
  }
  rmSync(file, { force: true });
  return null;
}

/** Exclusive create; returns null when another live process holds it. */
export function acquireLock(id: string, op: string): OpLock | null {
  const file = join(serviceDir(id), "op.lock");
  readLock(id); // clears a stale lock
  const lock: OpLock = { pid: process.pid, op, startedAt: new Date().toISOString() };
  try {
    writeFileSync(file, JSON.stringify(lock), { flag: "wx", mode: 0o600 });
    return lock;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
}

export function releaseLock(id: string): void {
  try {
    unlinkSync(join(serviceDir(id), "op.lock"));
  } catch {
    /* already gone (purge removed the dir) */
  }
}
