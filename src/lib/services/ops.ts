import { randomBytes } from "node:crypto";
import type { PullProgress } from "./pull-progress";
import { ensureReaper, install, remove, SidecarError, start, stop, update, type InstallOptions, type OpKind, type OpReporter } from "./manager";

/**
 * Server-side op store: long sidecar ops run in the background and the browser polls `GET /api/services/ops/<id>`
 * (same shape idea as the PDF jobs in src/lib/jobs.ts: in-memory, global across route modules, reaped after a TTL).
 * One running op per service; the lock file in state.ts also keeps the CLI out.
 */

export type OpStatus = "running" | "done" | "failed";

export interface OpView {
  opId: string;
  serviceId: string;
  kind: OpKind;
  status: OpStatus;
  phase: string;
  percent?: number;
  pull?: PullProgress;
  log: string[];
  error?: string;
  hint?: string;
  startedAt: string;
  finishedAt?: string;
  elapsedMs: number;
}

interface OpRecord extends Omit<OpView, "elapsedMs"> {
  t0: number;
  t1?: number;
}

const MAX_LOG = 200;
const TTL_MS = 30 * 60_000;
const GLOBAL_KEY = Symbol.for("samurai-knife.sidecar-ops");

function store(): Map<string, OpRecord> {
  const holder = globalThis as unknown as Record<symbol, Map<string, OpRecord> | undefined>;
  holder[GLOBAL_KEY] ??= new Map();
  return holder[GLOBAL_KEY];
}

function sweep(): void {
  for (const [id, op] of store()) if (op.t1 && Date.now() - op.t1 > TTL_MS) store().delete(id);
}

export function view(op: OpRecord): OpView {
  const { t0, t1, ...rest } = op;
  return { ...rest, log: [...op.log], elapsedMs: (t1 ?? Date.now()) - t0 };
}

export function getOp(opId: string): OpView | null {
  sweep();
  const op = store().get(opId);
  return op ? view(op) : null;
}

/** The running op of a service, if any (so a second click joins it instead of failing). */
export function runningOp(serviceId: string): OpView | null {
  for (const op of store().values()) if (op.serviceId === serviceId && op.status === "running") return view(op);
  return null;
}

export type OpRequest =
  | { kind: "install"; options: InstallOptions }
  | { kind: "start" }
  | { kind: "stop" }
  | { kind: "update" }
  | { kind: "remove"; purge?: boolean; removeImage?: boolean };

/** Starts the op in the background and returns at once; joins an already running op of the same kind. */
export function startOp(serviceId: string, request: OpRequest): OpView {
  ensureReaper();
  sweep();
  const existing = runningOp(serviceId);
  if (existing) {
    if (existing.kind === request.kind) return existing;
    throw new SidecarError(`${existing.kind} is still running on ${serviceId}`, 409);
  }
  const op: OpRecord = {
    opId: `op_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`,
    serviceId,
    kind: request.kind,
    status: "running",
    phase: "Queued",
    log: [],
    startedAt: new Date().toISOString(),
    t0: Date.now(),
  };
  store().set(op.opId, op);
  const reporter: OpReporter = {
    phase(text, percent) {
      op.phase = text;
      if (percent !== undefined) op.percent = percent;
    },
    log(line) {
      op.log.push(line.length > 400 ? `${line.slice(0, 400)}…` : line);
      if (op.log.length > MAX_LOG) op.log.splice(0, op.log.length - MAX_LOG);
    },
    pull(progress) {
      op.pull = progress;
    },
  };
  const work = (): Promise<unknown> => {
    switch (request.kind) {
      case "install":
        return install(serviceId, request.options, reporter);
      case "start":
        return start(serviceId, reporter);
      case "stop":
        return stop(serviceId, reporter);
      case "update":
        return update(serviceId, reporter);
      case "remove":
        return remove(serviceId, { purge: request.purge, removeImage: request.removeImage }, reporter);
    }
  };
  void Promise.resolve().then(work).then(
    () => {
      op.status = "done";
      op.percent = 100;
    },
    (error: unknown) => {
      op.status = "failed";
      op.error = error instanceof Error ? error.message : String(error);
      if (error instanceof SidecarError && error.hint) op.hint = error.hint;
    },
  ).finally(() => {
    op.t1 = Date.now();
    op.finishedAt = new Date().toISOString();
  });
  return view(op);
}
