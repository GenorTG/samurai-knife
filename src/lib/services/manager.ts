import { composeProject, findSidecar, SIDECARS, type SidecarDefinition } from "./definitions";
import { createHash } from "node:crypto";
import { connect } from "node:net";
import { onlyofficeFilterEnv, renderCompose } from "./compose";
import { syncAssets } from "./assets";
import { PullTracker, type PullProgress } from "./pull-progress";
import { detectRuntime, run, type RunResult, type RuntimeInfo, type RuntimeKind } from "./runtime";
import {
  acquireLock,
  composeFile,
  ensureSecrets,
  patchState,
  readLock,
  readState,
  releaseLock,
  removeState,
  serviceDir,
  writeState,
  type OpLock,
  type SidecarState,
} from "./state";
import { appHost, appPort, appUrl, internalUrl, officeProxyUrl, pickPort, portFree, publicUrl, validateHttpUrl, type AppUrlChoice } from "./urls";
import { writePrivateFile } from "@/lib/accounts/store";
import { isIpAddress } from "@/lib/net/address-policy";

/**
 * Sidecar lifecycle shared by the HTTP API (src/app/api/services) and the CLI (scripts/services.ts): install, start,
 * stop, remove, update, status. Every op holds the per-service lock file (state.ts) so the server and the CLI never run two
 * ops on one service at once; progress goes to an OpReporter (the server keeps it in the op store, the CLI prints it).
 */

export type OpKind = "install" | "start" | "stop" | "remove" | "update" | "idle-stop" | "configure";

export interface OpReporter {
  phase(text: string, percent?: number): void;
  log(line: string): void;
  pull?(progress: PullProgress): void;
}

// No TypeScript parameter properties here: the CLI runs this file through Node's type stripping, which rejects them.
export class SidecarError extends Error {
  readonly status: number;
  readonly hint?: string;
  constructor(message: string, status = 400, hint?: string) {
    super(message);
    this.status = status;
    this.hint = hint;
  }
}

export class SidecarBusyError extends SidecarError {
  readonly lock: OpLock;
  constructor(lock: OpLock) {
    super(`another operation is running on this service (${lock.op}, pid ${lock.pid}, since ${lock.startedAt})`, 409);
    this.lock = lock;
  }
}

function definition(id: string): SidecarDefinition {
  const def = findSidecar(id);
  if (!def) throw new SidecarError(`unknown service ${id}`, 404);
  return def;
}

async function requireRuntime(fresh = false): Promise<RuntimeKind> {
  const info = await detectRuntime(fresh);
  if (!info.ok) throw new SidecarError(info.message, 503, info.hint);
  return info.kind;
}

function compose(kind: RuntimeKind, id: string, args: string[], options: Parameters<typeof run>[2] = {}): Promise<RunResult> {
  return run(kind, ["compose", "-p", composeProject(id), "-f", composeFile(id), ...args], { cwd: serviceDir(id), ...options });
}

function failed(what: string, result: RunResult): SidecarError {
  const tail = (result.stderr || result.stdout).trim().split("\n").slice(-6).join("\n");
  return new SidecarError(`${what} failed (exit ${result.code ?? "signal"}): ${tail}`, 502);
}

/* -------------------------------------------------------------------------------------------- container status */

export type ContainerState = "running" | "exited" | "created" | "restarting" | "paused" | "dead" | "absent";

export interface ContainerInfo {
  state: ContainerState;
  id?: string;
  name?: string;
  health?: string;
  status?: string;
}

interface PsRow {
  ID?: string;
  Name?: string;
  State?: string;
  Health?: string;
  Status?: string;
  Service?: string;
}

/** `compose ps --format json` prints one object per line (v2.21+) or one array (older); accept both. */
export function parsePs(stdout: string): PsRow[] {
  const text = stdout.trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      return JSON.parse(text) as PsRow[];
    } catch {
      return [];
    }
  }
  const rows: PsRow[] = [];
  for (const line of text.split("\n")) {
    try {
      rows.push(JSON.parse(line) as PsRow);
    } catch {
      /* skip */
    }
  }
  return rows;
}

async function containerInfo(kind: RuntimeKind, def: SidecarDefinition): Promise<ContainerInfo> {
  const result = await compose(kind, def.id, ["ps", "-a", "--format", "json"], { timeoutMs: 20_000 });
  if (result.code !== 0) return { state: "absent" };
  const row = parsePs(result.stdout).find((r) => r.Service === def.serviceName);
  if (!row) return { state: "absent" };
  const state = (row.State ?? "").toLowerCase();
  const known: ContainerState[] = ["running", "exited", "created", "restarting", "paused", "dead"];
  return {
    state: known.includes(state as ContainerState) ? (state as ContainerState) : "exited",
    id: row.ID,
    name: row.Name,
    health: row.Health || undefined,
    status: row.Status,
  };
}

/** Postgres wire check: an SSLRequest is answered with one byte ("S" or "N") by a server that accepts connections. */
function probePostgres(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("error", () => done(false));
    socket.once("close", () => done(false));
    socket.once("data", (chunk: Buffer) => done(chunk.length >= 1 && (chunk[0] === 0x53 || chunk[0] === 0x4e)));
    // Int32 length 8, Int32 SSLRequest code 80877103.
    socket.once("connect", () => socket.write(Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f])));
  });
}

export function healthTarget(def: SidecarDefinition, state: SidecarState): string {
  return def.health.kind === "http" ? `GET ${internalUrl(state)}${def.health.path}` : `Postgres on ${state.bindHost}:${state.hostPort}`;
}

export async function probeHealth(def: SidecarDefinition, state: SidecarState, timeoutMs = 3000): Promise<boolean> {
  const health = def.health;
  if (health.kind === "postgres") return probePostgres(state.bindHost, state.hostPort, timeoutMs);
  try {
    const response = await fetch(`${internalUrl(state)}${health.path}`, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
    if (!response.ok) return false;
    return health.body ? health.body.test(await response.text()) : true;
  } catch {
    return false;
  }
}

async function waitHealthy(kind: RuntimeKind, def: SidecarDefinition, state: SidecarState, reporter: OpReporter): Promise<number> {
  const started = Date.now();
  const deadline = started + def.startTimeoutSec * 1000;
  let lastNote = 0;
  while (Date.now() < deadline) {
    if (await probeHealth(def, state)) return Date.now() - started;
    if (Date.now() - lastNote > 10_000) {
      lastNote = Date.now();
      const info = await containerInfo(kind, def);
      if (info.state === "exited" || info.state === "dead") {
        const logs = await compose(kind, def.id, ["logs", "--tail", "30", def.serviceName], { timeoutMs: 20_000 });
        throw new SidecarError(`the container exited while starting: ${(logs.stdout + logs.stderr).trim().split("\n").slice(-8).join("\n")}`, 502);
      }
      reporter.phase(`Waiting for ${def.name} to answer (${healthTarget(def, state)}, ${Math.round((Date.now() - started) / 1000)} s)`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new SidecarError(`not healthy after ${def.startTimeoutSec} s (${healthTarget(def, state)})`, 504);
}

/** Can the container call back into this app? (Non-fatal: reported as a warning.) */
async function checkAppReachable(kind: RuntimeKind, def: SidecarDefinition, choice: AppUrlChoice): Promise<string | null> {
  const target = `${choice.url}/api/services/ping`;
  const result = await compose(kind, def.id, ["exec", "-T", def.serviceName, "sh", "-c", `curl -s -m 5 "${target}" || wget -q -T 5 -O - "${target}"`], { timeoutMs: 20_000 });
  if (result.code === 0 && /"ok"\s*:\s*true/.test(result.stdout)) return null;
  return `The container cannot reach this app at ${choice.url} (GET /api/services/ping failed). Documents will not open or save until the app URL is reachable from the container.`;
}

/* ------------------------------------------------------------------------------------------------- ops */

async function withLock<T>(id: string, op: OpKind, fn: () => Promise<T>): Promise<T> {
  const lock = acquireLock(id, op);
  if (!lock) {
    const holder = readLock(id);
    throw new SidecarBusyError(holder ?? { pid: 0, op: "unknown", startedAt: "" });
  }
  try {
    return await fn();
  } finally {
    releaseLock(id);
  }
}

/** Address a definition's port is published on: KNIFE_HOST, or loopback for app-only services (`publish: "loopback"`). */
export function bindHostFor(def: SidecarDefinition): string {
  return loopbackOnly(def) ? "127.0.0.1" : appHost();
}

/** Only this app connects: a `publish: "loopback"` definition, or the office editor while the app proxies it. */
function loopbackOnly(def: SidecarDefinition): boolean {
  return def.publish === "loopback" || (def.id === "office" && officeProxyUrl() !== null);
}

/**
 * The request filter's allow list: KNIFE_SIDECAR_ALLOW_IPS only (empty by default). The app's own address is NOT added:
 * the Document Server trusts URLs inside the JWT-signed editor config and command requests (document download, save
 * callback), so those reach the app with the filter on, while a URL a user types into the editor ("image from URL")
 * stays filtered. Allowing the app's IP would open every port on that address to such URLs (the list is per IP).
 * Verified against the 9.3.5 image: docs/SIDECARS.md "Request filter".
 */
export function filterAllowIps(): string[] {
  return (process.env.KNIFE_SIDECAR_ALLOW_IPS ?? "").split(/[\s,]+/).filter((entry) => entry && isIpAddress(entry));
}

function composeText(def: SidecarDefinition, state: SidecarState): string {
  const extraEnv = def.requestFilter === "onlyoffice" ? onlyofficeFilterEnv(filterAllowIps()) : undefined;
  return renderCompose(def, { bindHost: state.bindHost, hostPort: state.hostPort, image: state.image, extraEnv });
}

export function composeHashOf(def: SidecarDefinition, state: SidecarState): string {
  return createHash("sha256").update(composeText(def, state)).digest("hex");
}

/** compose.yaml + the definition's assets (the editor plugin): written before every `up`. */
function writeCompose(def: SidecarDefinition, state: SidecarState, reporter?: OpReporter): void {
  // A secret added to the definition later (SECURE_LINK_SECRET) is generated for existing installs too.
  ensureSecrets(def);
  writePrivateFile(composeFile(def.id), composeText(def, state));
  const assets = syncAssets(def);
  if (assets?.changed) reporter?.log(`${def.assets?.label ?? "assets"} updated: ${assets.folders.join(", ")}`);
}

/**
 * The running container was created from an older compose file (e.g. before the app shipped a plugin mount): the next
 * lazy start recreates it once. Never while documents are open in it.
 */
export function needsRecreate(def: SidecarDefinition, state: SidecarState): boolean {
  return state.composeHash !== composeHashOf(def, state) && sessions(def.id).size === 0;
}

async function pull(kind: RuntimeKind, def: SidecarDefinition, reporter: OpReporter): Promise<void> {
  reporter.phase(`Pulling ${def.image}`, 0);
  const tracker = new PullTracker();
  let lastEmit = 0;
  // `--progress` is a global compose flag (before the subcommand).
  const result = await run(kind, ["compose", "--progress", "json", "-p", composeProject(def.id), "-f", composeFile(def.id), "pull"], {
    cwd: serviceDir(def.id),
    onLine: (line) => {
      if (tracker.feed(line)) {
        if (Date.now() - lastEmit > 400) {
          lastEmit = Date.now();
          const snap = tracker.snapshot();
          reporter.pull?.(snap);
          reporter.phase(`Pulling ${def.image}`, snap.percent);
        }
      } else reporter.log(line);
    },
  });
  if (result.code !== 0) throw failed("pull", result);
  const snap = tracker.snapshot();
  reporter.pull?.({ ...snap, percent: 100, phase: "done" });
  reporter.phase(`Pulled ${def.image}`, 100);
}

async function upAndWait(kind: RuntimeKind, def: SidecarDefinition, state: SidecarState, reporter: OpReporter): Promise<SidecarState> {
  if (!(await probeHealth(def, state, 1000))) {
    const info = await containerInfo(kind, def);
    if (info.state !== "running" && !(await portFree(state.bindHost, state.hostPort))) {
      throw new SidecarError(`port ${state.bindHost}:${state.hostPort} is taken by another program; pick another port (configure) and start again`, 409);
    }
  }
  reporter.phase("Starting the container");
  const t0 = Date.now();
  const up = await compose(kind, def.id, ["up", "-d", "--remove-orphans"], { onLine: (line) => reporter.log(line), timeoutMs: 300_000 });
  if (up.code !== 0) throw failed("compose up", up);
  reporter.phase("Waiting for the service to become healthy");
  await waitHealthy(kind, def, state, reporter);
  reporter.log(`healthy ${Math.round((Date.now() - t0) / 100) / 10} s after compose up`);
  let prepared: string | undefined;
  if (def.prepare) {
    const info = await containerInfo(kind, def);
    if (info.id && info.id !== readState(def.id)?.preparedContainer) {
      reporter.phase(def.prepare.label);
      const t1 = Date.now();
      const result = await compose(kind, def.id, ["exec", "-T", def.serviceName, ...def.prepare.command], { onLine: (line) => reporter.log(line), timeoutMs: def.prepare.timeoutSec * 1000 });
      if (result.code !== 0) throw failed(def.prepare.label, result);
      reporter.log(`${def.prepare.label}: ${Math.round((Date.now() - t1) / 100) / 10} s`);
      await waitHealthy(kind, def, state, reporter);
      prepared = info.id;
    }
  }
  const lastStartMs = Date.now() - t0;
  const next = patchState(def.id, {
    lastStartedAt: new Date().toISOString(),
    lastStartMs,
    lastUsedAt: new Date().toISOString(),
    ...(prepared ? { preparedContainer: prepared } : {}),
    composeHash: composeHashOf(def, state),
  }) ?? state;
  const warning = def.callsBack ? await checkAppReachable(kind, def, appUrl(next)) : null;
  if (warning) reporter.log(`WARNING: ${warning}`);
  return next;
}

export interface InstallOptions {
  port?: number;
  appUrl?: string;
  publicUrl?: string;
  idleStopMinutes?: number;
}

function checkUrls(options: { appUrl?: string; publicUrl?: string }): void {
  for (const key of ["appUrl", "publicUrl"] as const) {
    const value = options[key];
    if (value === undefined || value === "") continue;
    const problem = validateHttpUrl(value);
    if (problem) throw new SidecarError(`${key}: ${problem}`);
  }
}

function claimedPorts(except: string): Set<number> {
  const ports = new Set<number>([appPort()]);
  for (const other of SIDECARS) {
    if (other.id === except) continue;
    const state = readState(other.id);
    if (state) ports.add(state.hostPort);
  }
  return ports;
}

export function install(id: string, options: InstallOptions, reporter: OpReporter): Promise<SidecarState> {
  const def = definition(id);
  checkUrls(options);
  return withLock(id, "install", async () => {
    reporter.phase("Checking the container runtime");
    const kind = await requireRuntime(true);
    const previous = readState(id);
    const bindHost = bindHostFor(def);
    let hostPort = options.port ?? previous?.hostPort;
    if (hostPort === undefined) {
      hostPort = await pickPort(bindHost, appPort(), claimedPorts(id));
    } else if (!(await portFree(bindHost, hostPort))) {
      // Busy because our own container (a reinstall over a running one) holds it is fine.
      const ours = previous?.hostPort === hostPort && (await containerInfo(kind, def)).state === "running";
      if (!ours) {
        if (options.port !== undefined) throw new SidecarError(`port ${bindHost}:${options.port} is not free`, 409);
        hostPort = await pickPort(bindHost, appPort(), claimedPorts(id));
      }
    }
    const now = new Date().toISOString();
    ensureSecrets(def);
    const state = writeState({
      id,
      image: def.image,
      bindHost,
      hostPort,
      appUrl: options.appUrl || previous?.appUrl || undefined,
      publicUrl: options.publicUrl || previous?.publicUrl || undefined,
      idleStopMinutes: options.idleStopMinutes ?? previous?.idleStopMinutes ?? def.idleStopMinutes,
      installedAt: previous?.installedAt ?? now,
      updatedAt: now,
    });
    writeCompose(def, state, reporter);
    reporter.log(`compose project ${composeProject(id)}, published on ${state.bindHost}:${state.hostPort}`);
    await pull(kind, def, reporter);
    const ready = await upAndWait(kind, def, state, reporter);
    reporter.phase("Installed and running", 100);
    return ready;
  });
}

function requireState(id: string): SidecarState {
  const state = readState(id);
  if (!state) throw new SidecarError(`${id} is not installed`, 409);
  return state;
}

/** An install from before `publish: "loopback"` (or the office proxy) keeps its old bind address until the next start/update moves it. */
function movedToBindHost(def: SidecarDefinition, state: SidecarState, reporter?: OpReporter): SidecarState {
  const wanted = bindHostFor(def);
  if (!loopbackOnly(def) || state.bindHost === wanted) return state;
  reporter?.log(`publishing on ${wanted} instead of ${state.bindHost} (only this app connects)`);
  return writeState({ ...state, bindHost: wanted });
}

export function start(id: string, reporter: OpReporter): Promise<SidecarState> {
  const def = definition(id);
  return withLock(id, "start", async () => {
    const kind = await requireRuntime();
    const state = movedToBindHost(def, requireState(id), reporter);
    writeCompose(def, state, reporter);
    const ready = await upAndWait(kind, def, state, reporter);
    reporter.phase("Running", 100);
    return ready;
  });
}

export function stop(id: string, reporter: OpReporter, kindOfOp: "stop" | "idle-stop" = "stop"): Promise<void> {
  const def = definition(id);
  return withLock(id, kindOfOp, async () => {
    const kind = await requireRuntime();
    requireState(id);
    reporter.phase("Stopping the container");
    const result = await compose(kind, def.id, ["stop"], { onLine: (line) => reporter.log(line), timeoutMs: 120_000 });
    if (result.code !== 0) throw failed("compose stop", result);
    sessions(id).clear();
    reporter.phase("Stopped", 100);
  });
}

export function remove(id: string, options: { purge?: boolean; removeImage?: boolean }, reporter: OpReporter): Promise<void> {
  const def = definition(id);
  return withLock(id, "remove", async () => {
    const kind = await requireRuntime();
    const state = readState(id);
    if (!state && !options.purge) throw new SidecarError(`${id} is not installed`, 409);
    if (state) writeCompose(def, state);
    reporter.phase(options.purge ? "Removing the container and its data volumes" : "Removing the container (data volumes kept)");
    const args = ["down", "--remove-orphans"];
    if (options.purge) args.push("--volumes");
    if (options.removeImage) args.push("--rmi", "all");
    const result = await compose(kind, def.id, args, { onLine: (line) => reporter.log(line), timeoutMs: 180_000 });
    if (result.code !== 0 && state) throw failed("compose down", result);
    removeState(id, Boolean(options.purge));
    sessions(id).clear();
    reporter.phase("Removed", 100);
  });
}

async function imageId(kind: RuntimeKind, image: string): Promise<string | null> {
  const result = await run(kind, ["image", "inspect", "--format", "{{.Id}}", image], { timeoutMs: 20_000 });
  return result.code === 0 ? result.stdout.trim() : null;
}

export function update(id: string, reporter: OpReporter): Promise<SidecarState & { imageChanged: boolean }> {
  const def = definition(id);
  return withLock(id, "update", async () => {
    const kind = await requireRuntime(true);
    const previous = movedToBindHost(def, requireState(id), reporter);
    const before = await imageId(kind, previous.image);
    const state = writeState({ ...previous, image: def.image });
    writeCompose(def, state, reporter);
    await pull(kind, def, reporter);
    const after = await imageId(kind, def.image);
    const imageChanged = before !== after;
    reporter.log(imageChanged ? `image changed: ${before ?? "none"} -> ${after}` : "image unchanged");
    const ready = await upAndWait(kind, def, state, reporter);
    reporter.phase(imageChanged ? "Updated and running" : "Already up to date; running", 100);
    return { ...ready, imageChanged };
  });
}

export interface ConfigureOptions {
  port?: number;
  appUrl?: string | null;
  publicUrl?: string | null;
  idleStopMinutes?: number;
}

/** Changes stored choices; a port change needs a restart to take effect (`restartNeeded`). */
export async function configure(id: string, options: ConfigureOptions): Promise<{ state: SidecarState; restartNeeded: boolean }> {
  const def = definition(id);
  checkUrls({ appUrl: options.appUrl ?? undefined, publicUrl: options.publicUrl ?? undefined });
  return withLock(id, "configure", async () => {
    const state = requireState(id);
    const next: SidecarState = { ...state };
    let restartNeeded = false;
    if (options.port !== undefined && options.port !== state.hostPort) {
      if (claimedPorts(id).has(options.port) || !(await portFree(state.bindHost, options.port))) {
        throw new SidecarError(`port ${state.bindHost}:${options.port} is not free`, 409);
      }
      next.hostPort = options.port;
      restartNeeded = true;
    }
    if (options.appUrl !== undefined) next.appUrl = options.appUrl || undefined;
    if (options.publicUrl !== undefined) next.publicUrl = options.publicUrl || undefined;
    if (options.idleStopMinutes !== undefined) next.idleStopMinutes = options.idleStopMinutes;
    const saved = writeState(next);
    writeCompose(def, saved);
    return { state: saved, restartNeeded };
  });
}

/* ------------------------------------------------------------------------------------------------- status */

export interface SidecarStatus {
  id: string;
  name: string;
  shortName: string;
  /** The container calls back into the app (so the app URL matters). */
  callsBack: boolean;
  description: string;
  image: string;
  license: string;
  homepage: string;
  requirements: SidecarDefinition["requirements"];
  usedBy: string[];
  runtime: RuntimeInfo;
  installed: boolean;
  container: ContainerInfo;
  /** Health endpoint answered. */
  ready: boolean;
  state: SidecarState | null;
  publicUrl: string | null;
  appUrl: AppUrlChoice;
  /** Image pin changed since install: `update` applies it. */
  updateAvailable: boolean;
  busy: OpLock | null;
  openSessions: number;
  memory?: { usedBytes: number; text: string } | null;
  warnings: string[];
}

function parseBytes(text: string): number {
  const match = /^([\d.]+)\s*([KMGT]?i?B)$/i.exec(text.trim());
  if (!match) return 0;
  const unit = match[2].toUpperCase();
  const scale: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4 };
  return Math.round(Number.parseFloat(match[1]) * (scale[unit] ?? 1));
}

export async function containerMemory(kind: RuntimeKind, name: string): Promise<{ usedBytes: number; text: string } | null> {
  const result = await run(kind, ["stats", "--no-stream", "--format", "{{.MemUsage}}", name], { timeoutMs: 20_000 });
  if (result.code !== 0) return null;
  const text = result.stdout.trim();
  return { usedBytes: parseBytes(text.split("/")[0] ?? ""), text };
}

export async function status(id: string, options: { memory?: boolean } = {}): Promise<SidecarStatus> {
  const def = definition(id);
  const runtime = await detectRuntime();
  const state = readState(id);
  const warnings: string[] = [];
  let container: ContainerInfo = { state: "absent" };
  let ready = false;
  let memory: SidecarStatus["memory"];
  if (runtime.ok && state) {
    container = await containerInfo(runtime.kind, def);
    ready = container.state === "running" && (await probeHealth(def, state, 1500));
    if (options.memory && container.name && container.state === "running") memory = await containerMemory(runtime.kind, container.name);
  }
  const app = appUrl(state);
  if (app.warning && def.callsBack) warnings.push(app.warning);
  if (state && container.state === "running" && state.composeHash !== composeHashOf(def, state)) {
    warnings.push("The running container was created with older settings (for example without the assistant's editor plugin); it is recreated at the next start when no document is open, or restart it now.");
  }
  if (!runtime.ok) warnings.push(`${runtime.message} ${runtime.hint}`);
  return {
    id,
    name: def.name,
    shortName: def.shortName,
    callsBack: def.callsBack,
    description: def.description,
    image: def.image,
    license: def.license,
    homepage: def.homepage,
    requirements: def.requirements,
    usedBy: def.usedBy,
    runtime,
    installed: Boolean(state),
    container,
    ready,
    state,
    publicUrl: state ? publicUrl(state) : null,
    appUrl: app,
    updateAvailable: Boolean(state && state.image !== def.image),
    busy: readLock(id),
    openSessions: sessions(id).size,
    memory,
    warnings,
  };
}

/* ------------------------------------------------------------------------------------- usage and idle stop */

const GLOBAL_KEY = Symbol.for("samurai-knife.sidecar-usage");

interface UsageRegistry {
  sessions: Map<string, Map<string, number>>;
  lastTouchWrite: Map<string, number>;
  reaper?: ReturnType<typeof setInterval>;
}

function usage(): UsageRegistry {
  const holder = globalThis as unknown as Record<symbol, UsageRegistry | undefined>;
  holder[GLOBAL_KEY] ??= { sessions: new Map(), lastTouchWrite: new Map() };
  return holder[GLOBAL_KEY];
}

/** Open editing sessions per service: key -> last event time. Stale entries (12 h) are dropped on read. */
function sessions(id: string): Map<string, number> {
  const registry = usage();
  let map = registry.sessions.get(id);
  if (!map) {
    map = new Map();
    registry.sessions.set(id, map);
  }
  for (const [key, at] of map) if (Date.now() - at > 12 * 3600_000) map.delete(key);
  return map;
}

export function markSession(id: string, key: string, open: boolean): void {
  if (open) sessions(id).set(key, Date.now());
  else sessions(id).delete(key);
  touch(id);
}

/** Records use (editor heartbeat, callbacks); written at most every 30 s. */
export function touch(id: string): void {
  const registry = usage();
  const last = registry.lastTouchWrite.get(id) ?? 0;
  if (Date.now() - last < 30_000) return;
  registry.lastTouchWrite.set(id, Date.now());
  patchState(id, { lastUsedAt: new Date().toISOString() });
}

const silent: OpReporter = { phase: () => {}, log: () => {} };

/** One pass of the idle reaper; exported for tests and the CLI. Returns the ids it stopped. */
export async function reapIdle(now = Date.now()): Promise<string[]> {
  const stopped: string[] = [];
  const runtime = await detectRuntime();
  if (!runtime.ok) return stopped;
  for (const def of SIDECARS) {
    const state = readState(def.id);
    if (!state || state.idleStopMinutes <= 0 || readLock(def.id)) continue;
    if (sessions(def.id).size > 0) continue;
    const last = Date.parse(state.lastUsedAt ?? state.lastStartedAt ?? state.updatedAt);
    if (Number.isFinite(last) && now - last < state.idleStopMinutes * 60_000) continue;
    const info = await containerInfo(runtime.kind, def);
    if (info.state !== "running") continue;
    try {
      await stop(def.id, silent, "idle-stop");
      stopped.push(def.id);
    } catch {
      /* busy or failed: next pass */
    }
  }
  return stopped;
}

/** Starts the once-a-minute idle reaper in this server process (idempotent). */
export function ensureReaper(): void {
  const registry = usage();
  if (registry.reaper) return;
  registry.reaper = setInterval(() => {
    void reapIdle().catch(() => {});
  }, 60_000);
  registry.reaper.unref?.();
}
