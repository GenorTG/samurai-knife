/**
 * Starts workflow runs (docs/WORKFLOWS.md): one worker process per run (src/lib/workflows/worker/main.ts) under Node's
 * permission model, fed over IPC with what the run needs (workflow, the credentials its nodes name, input files), killed
 * at the wall-clock limit. Persists the run, keeps waiting runs in the trigger index, starts the error workflow of a
 * failed run, orchestrates sub-workflow calls (same account, depth-limited) and streams node progress to the editor.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isPublicMode } from "@/lib/accounts/mode";
import { activeProfileIdOf, getAccount, providerProfileConfig, providerProfilesOf, type Account } from "@/lib/accounts/store";
import { recordRound } from "@/lib/accounts/usage-ledger";
import { normalizeUsage } from "@/lib/usage";
import { childEnv } from "@/lib/child-env";
import { nodeMeta } from "../catalog/index";
import type { CredentialData } from "../engine/node-api";
import type { RunResult, WaitingState } from "../engine/run";
import type { HookResponse, Item, RunMode, Workflow } from "../types";
import { credentialKey, type BlobPayload, type FromWorker, type NodeProgress, type RunJob, type WorkerPolicy } from "../worker/protocol";
import { addWait, removeWait } from "./trigger-index";
import { getCredential, getStaticData, getWorkflow, newRunId, saveRun, setStaticData, updateCredentialData, type RunRecord } from "./store";

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(value) && value >= min ? Math.min(max, value) : fallback;
}

export const WORKFLOW_LIMITS = {
  workers: () => intEnv("KNIFE_WF_WORKERS", 4, 1, 64),
  perAccount: () => intEnv("KNIFE_WF_PER_ACCOUNT", 2, 1, 32),
  queue: () => intEnv("KNIFE_WF_QUEUE", 50, 0, 10_000),
  queuePerAccount: () => intEnv("KNIFE_WF_QUEUE_PER_ACCOUNT", 10, 0, 10_000),
  timeoutSec: () => intEnv("KNIFE_WF_TIMEOUT_SEC", 300, 5, 3600),
  heapMb: () => intEnv("KNIFE_WF_HEAP_MB", 512, 64, 8192),
  blobMb: () => intEnv("KNIFE_WF_BLOB_MB", 128, 1, 4096),
  maxDepth: 5,
};

export class RunRefusedError extends Error {
  readonly status: number;
  constructor(message: string, status = 503) {
    super(message);
    this.name = "RunRefusedError";
    this.status = status;
  }
}

/* ------------------------------------------------------------------------------------------------ concurrency gate */

interface Gate {
  running: number;
  perAccount: Map<string, number>;
  queue: { account: string; resolve: () => void }[];
}

const GATE_KEY = Symbol.for("samurai-knife.workflow-gate.v1");

function gate(): Gate {
  const holder = globalThis as unknown as Record<symbol, Gate | undefined>;
  return (holder[GATE_KEY] ??= { running: 0, perAccount: new Map(), queue: [] });
}

function tryTake(state: Gate, account: string): boolean {
  if (state.running >= WORKFLOW_LIMITS.workers() || (state.perAccount.get(account) ?? 0) >= WORKFLOW_LIMITS.perAccount()) return false;
  state.running += 1;
  state.perAccount.set(account, (state.perAccount.get(account) ?? 0) + 1);
  return true;
}

/** Waits for a worker slot; sub-workflow runs skip the per-account cap (their parent already holds a slot). */
async function acquire(account: string, nested: boolean): Promise<() => void> {
  const state = gate();
  const release = () => {
    state.running -= 1;
    state.perAccount.set(account, Math.max(0, (state.perAccount.get(account) ?? 1) - 1));
    for (let index = 0; index < state.queue.length; index += 1) {
      const waiter = state.queue[index];
      if (tryTake(state, waiter.account)) {
        state.queue.splice(index, 1);
        waiter.resolve();
        return;
      }
    }
  };
  if (nested) {
    state.running += 1;
    state.perAccount.set(account, (state.perAccount.get(account) ?? 0) + 1);
    return release;
  }
  if (tryTake(state, account)) return release;
  if (state.queue.length >= WORKFLOW_LIMITS.queue()) throw new RunRefusedError("Too many workflow runs are waiting; try again in a minute.");
  // One account cannot fill the instance's queue.
  if (state.queue.filter((waiter) => waiter.account === account).length >= WORKFLOW_LIMITS.queuePerAccount()) {
    throw new RunRefusedError("Too many of your workflow runs are waiting already; try again in a minute.", 429);
  }
  await new Promise<void>((resolve) => state.queue.push({ account, resolve }));
  return release;
}

export function workflowQueueStats() {
  const state = gate();
  return { running: state.running, queued: state.queue.length, workers: WORKFLOW_LIMITS.workers() };
}

/* ---------------------------------------------------------------------------------------------- live run progress */

export type RunEvent =
  | { type: "start"; runId: string; workflowId: string }
  | { type: "node-start"; node: string }
  | { type: "node-end"; node: string; run: NodeProgress }
  | { type: "done"; status: string; error?: RunResult["error"] };

const BUS_KEY = Symbol.for("samurai-knife.workflow-bus.v1");

interface LiveRun {
  account: string;
  workflowId: string;
  events: RunEvent[];
  emitter: EventEmitter;
  done: boolean;
  cancel: () => void;
}

function bus(): Map<string, LiveRun> {
  const holder = globalThis as unknown as Record<symbol, Map<string, LiveRun> | undefined>;
  return (holder[BUS_KEY] ??= new Map());
}

/** A run of this account still in memory (events so far + a listener), or null. */
export function liveRun(account: string, runId: string): LiveRun | null {
  const live = bus().get(runId);
  return live && live.account === account ? live : null;
}

export function cancelRun(account: string, runId: string): boolean {
  const live = liveRun(account, runId);
  if (!live || live.done) return false;
  live.cancel();
  return true;
}

/* ------------------------------------------------------------------------------------------------------- helpers */

export function appBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.KNIFE_PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  return `http://${env.KNIFE_HOST?.trim() || "127.0.0.1"}:${env.KNIFE_PORT?.trim() || "3210"}`;
}

/** Minutes east of UTC for a zone at a moment (the sandbox's DateTime uses one fixed offset per run). */
export function zoneOffsetMinutes(zone: string, at = Date.now()): number {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(new Date(at)).find((part) => part.type === "timeZoneName")?.value ?? "";
    const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
    if (!match) return 0;
    return (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] ?? 0));
  } catch {
    return 0;
  }
}

export function serverZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Same rule as provider calls (src/lib/net/outbound.ts): public mode refuses private addresses unless an admin opted in. */
export function workflowPolicy(account: Pick<Account, "role" | "privateNetwork">): WorkerPolicy {
  if (!isPublicMode()) return { allowPrivate: true, ports: null, httpsOnly: false };
  return { allowPrivate: account.role === "admin" && account.privateNetwork, ports: null, httpsOnly: false };
}

function workerEntry(): { entry: string; hooks: string; readRoots: string[] } {
  const root = process.env.KNIFE_APP_ROOT?.trim() || process.cwd();
  const entry = join(root, "src/lib/workflows/worker/main.ts");
  const hooks = join(root, "src/lib/workflows/worker/hooks.mjs");
  if (!existsSync(entry)) throw new RunRefusedError("The workflow worker is missing from this installation.", 500);
  const roots = new Set([root]);
  for (const candidate of [join(root, "node_modules"), join(root, "src")]) {
    try {
      roots.add(realpathSync(candidate));
    } catch {
      // absent: fine
    }
  }
  return { entry, hooks: pathToFileURL(hooks).href, readRoots: [...roots] };
}

/** Node flags of the worker process (tests/workflow_runner.test.mjs checks what they deny). */
export function workerExecArgv(readRoots: string[], hooks: string): string[] {
  return [
    "--permission",
    ...readRoots.map((dir) => `--allow-fs-read=${dir}`),
    "--allow-net",
    `--max-old-space-size=${WORKFLOW_LIMITS.heapMb()}`,
    "--disallow-code-generation-from-strings",
    "--disable-warning=ExperimentalWarning",
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
    "--import",
    hooks,
  ];
}

/** AI nodes set to a provider profile get it as their `provider` credential ("" = the account's active profile). */
function profileCredential(account: Account, wanted: unknown): CredentialData | null {
  const id = typeof wanted === "string" && wanted ? wanted : activeProfileIdOf(account);
  const config = id ? providerProfileConfig(account, id) : undefined;
  if (!config || !id) return null;
  const name = providerProfilesOf(account).find((profile) => profile.id === id)?.name ?? "profile";
  return { id: `profile:${id}`, type: "aiProvider", name, data: { baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model, extraHeaders: config.extraHeaders ?? {}, ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}) } };
}

function collectCredentials(accountId: string, workflow: Workflow): Record<string, CredentialData> {
  const out: Record<string, CredentialData> = {};
  const account = getAccount(accountId);
  for (const node of workflow.nodes) {
    if (node.disabled) continue;
    if (account && nodeMeta(node.type)?.group === "ai" && node.parameters.source !== "credential") {
      const profile = profileCredential(account, node.parameters.profile);
      if (profile) out[credentialKey(node.name, "provider")] = profile;
      continue;
    }
    for (const [slot, id] of Object.entries(node.credentials ?? {})) {
      const stored = id ? getCredential(accountId, id) : null;
      if (stored) out[credentialKey(node.name, slot)] = { id: stored.id, type: stored.type, name: stored.name, data: stored.data };
    }
  }
  return out;
}

function base64Blobs(list: BlobPayload[]): Record<string, string> {
  return Object.fromEntries(list.map(({ ref, bytes }) => [ref.id, JSON.stringify({ ref, data: Buffer.from(bytes).toString("base64") })]));
}

export function blobsFromRecord(record: RunRecord): BlobPayload[] {
  return Object.values(record.waitingBlobs ?? {}).map((text) => {
    const parsed = JSON.parse(text) as { ref: BlobPayload["ref"]; data: string };
    return { ref: parsed.ref, bytes: Buffer.from(parsed.data, "base64") };
  });
}

/* ----------------------------------------------------------------------------------------------------------- run */

export interface StartRunOptions {
  accountId: string;
  workflow: Workflow;
  mode: RunMode;
  startNode?: string;
  destinationNode?: string;
  triggerItems?: Item[];
  triggerBlobs?: BlobPayload[];
  resume?: { record: RunRecord; items?: Item[] };
  parent?: { workflowId: string; runId: string };
  depth?: number;
  /** Editor runs stream node progress. */
  progress?: boolean;
  onRespond?: (response: HookResponse) => void;
  /** Called with the run id as soon as it exists (before the worker starts). */
  onRunId?: (runId: string) => void;
}

export interface RunOutcome {
  runId: string;
  result: RunResult;
  blobs: BlobPayload[];
}

export async function startRun(options: StartRunOptions): Promise<RunOutcome> {
  const account = getAccount(options.accountId);
  if (!account) throw new RunRefusedError("Unknown account.", 404);
  // A disabled (or not yet verified) account's schedules, webhooks and waits do not run.
  if (account.status !== "active") throw new RunRefusedError("This account is not active.", 403);
  const depth = options.depth ?? 0;
  if (depth > WORKFLOW_LIMITS.maxDepth) throw new RunRefusedError(`Sub-workflows are nested more than ${WORKFLOW_LIMITS.maxDepth} deep.`, 400);
  const workflow = options.workflow;
  const runId = options.resume?.record.id ?? newRunId();
  const resumeToken = randomBytes(24).toString("base64url");
  const startedAt = options.resume?.record.startedAt ?? new Date().toISOString();
  const zone = workflow.settings.timezone || serverZone();
  const controller = new AbortController();
  const live: LiveRun = { account: account.id, workflowId: workflow.id, events: [], emitter: new EventEmitter(), done: false, cancel: () => controller.abort() };
  live.emitter.setMaxListeners(50);
  const emit = (event: RunEvent) => {
    if (live.events.length < 2000) live.events.push(event);
    live.emitter.emit("event", event);
  };
  bus().set(runId, live);
  options.onRunId?.(runId);
  emit({ type: "start", runId, workflowId: workflow.id });

  const release = await acquire(account.id, depth > 0);
  let child: ChildProcess | null = null;
  try {
    const { entry, hooks, readRoots } = workerEntry();
    const timeoutSec = Math.min(workflow.settings.timeoutSeconds ?? WORKFLOW_LIMITS.timeoutSec(), WORKFLOW_LIMITS.timeoutSec());
    const job: RunJob = {
      workflow,
      mode: options.mode,
      executionId: runId,
      startNode: options.startNode,
      destinationNode: options.destinationNode,
      triggerItems: options.triggerItems,
      resume: options.resume ? { state: options.resume.record.waiting as WaitingState, items: options.resume.items } : undefined,
      staticData: getStaticData(account.id, workflow.id),
      resumeUrl: `${appBaseUrl()}/api/hooks/resume/${resumeToken}`,
      timezone: zone,
      tzOffsetMinutes: zoneOffsetMinutes(zone),
      credentials: collectCredentials(account.id, workflow),
      blobs: [...(options.triggerBlobs ?? []), ...(options.resume ? blobsFromRecord(options.resume.record) : [])],
      policy: workflowPolicy(account),
      limits: { maxDepth: WORKFLOW_LIMITS.maxDepth },
      sandboxLimits: {},
      maxBlobBytes: WORKFLOW_LIMITS.blobMb() * 1024 * 1024,
      progress: Boolean(options.progress),
    };
    // spawn + an "ipc" stdio slot is what fork does; fork's path argument would be traced into the bundle by Next.
    const worker = spawn(process.execPath, [...workerExecArgv(readRoots, hooks), entry], {
      env: childEnv([], { KNIFE_SSRF_DENY_CIDRS: process.env.KNIFE_SSRF_DENY_CIDRS ?? "", NODE_ENV: process.env.NODE_ENV ?? "production", TZ: "UTC" }),
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    child = worker;
    let stderr = "";
    worker.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 8000) stderr += chunk.toString("utf8");
    });

    const outcome = await new Promise<{ result: RunResult; blobs: BlobPayload[] }>((resolve) => {
      let settled = false;
      const finish = (value: { result: RunResult; blobs: BlobPayload[] }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const failed = (message: string, status: RunResult["status"] = "error") => finish({ result: { status, error: { message }, runData: {}, customData: {}, staticData: job.staticData }, blobs: [] });
      const timer = setTimeout(() => {
        worker.kill("SIGKILL");
        failed(`The run took longer than ${timeoutSec} s and was stopped.`);
      }, timeoutSec * 1000);
      controller.signal.addEventListener("abort", () => {
        worker.send({ t: "cancel" });
        setTimeout(() => {
          worker.kill("SIGKILL");
          failed("The run was stopped.", "canceled");
        }, 3000).unref();
      }, { once: true });
      worker.on("message", (message: FromWorker) => {
        switch (message.t) {
          case "node-start":
            emit({ type: "node-start", node: message.node });
            break;
          case "node-end":
            emit({ type: "node-end", node: message.node, run: message.run });
            break;
          case "respond":
            options.onRespond?.(message.response);
            break;
          case "usage":
            recordRound(account.id, { model: message.model, usage: normalizeUsage(message.usage), ms: message.ms, failed: message.failed });
            break;
          case "credential-update":
            if (Object.values(job.credentials).some((credential) => credential.id === message.id)) updateCredentialData(account.id, message.id, message.data);
            break;
          case "call":
            void subWorkflow(account.id, workflow, runId, depth, message.call, message.blobs).then(
              (answer) => worker.connected && worker.send({ t: "call-result", id: message.id, items: answer.items, blobs: answer.blobs }),
              (error: unknown) => worker.connected && worker.send({ t: "call-result", id: message.id, error: error instanceof Error ? error.message : String(error) }),
            );
            break;
          case "done":
            finish({ result: message.result, blobs: message.blobs });
            break;
          case "fatal":
            failed(`The workflow engine failed: ${message.message}`);
            break;
        }
      });
      worker.on("exit", (code, signal) => {
        if (settled) return;
        if (stderr.trim()) console.error(`[workflows] worker for run ${runId} exited (${code ?? signal}): ${stderr.trim().slice(-2000)}`);
        failed(/heap out of memory|allocation failed/i.test(stderr) ? `The run used more than ${WORKFLOW_LIMITS.heapMb()} MB of memory.` : "The workflow worker stopped unexpectedly.");
      });
      worker.on("error", (error) => failed(`The workflow worker could not start: ${error.message}`));
      worker.send({ t: "run", job });
    });

    const { result, blobs } = outcome;
    persist(account.id, workflow, runId, startedAt, options, result, blobs, resumeToken);
    emit({ type: "done", status: result.status, ...(result.error ? { error: result.error } : {}) });
    if (result.status === "error" && options.mode !== "error" && workflow.settings.errorWorkflow) {
      void startErrorWorkflow(account.id, workflow, runId, options.mode, result).catch((error: unknown) => console.error(`[workflows] error workflow failed to start: ${error instanceof Error ? error.message : String(error)}`));
    }
    return { runId, result, blobs };
  } finally {
    release();
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    live.done = true;
    setTimeout(() => bus().delete(runId), 120_000).unref();
  }
}

function persist(accountId: string, workflow: Workflow, runId: string, startedAt: string, options: StartRunOptions, result: RunResult, blobs: BlobPayload[], resumeToken: string): void {
  if (JSON.stringify(result.staticData) !== JSON.stringify(getStaticData(accountId, workflow.id))) setStaticData(accountId, workflow.id, result.staticData);
  if (options.resume) removeWait(runId);
  const skip =
    (result.status === "success" && !workflow.settings.saveSuccessfulRuns && options.mode !== "manual") ||
    ((options.mode === "manual" || options.mode === "webhook-test") && !workflow.settings.saveManualRuns && result.status !== "waiting");
  if (skip) return;
  const waiting = result.status === "waiting" ? result.waiting : undefined;
  const resumeHash = waiting?.webhook ? createHash("sha256").update(resumeToken).digest("hex") : undefined;
  const record: RunRecord = {
    id: runId,
    workflowId: workflow.id,
    mode: options.resume?.record.mode ?? options.mode,
    status: result.status,
    startedAt,
    finishedAt: result.status === "waiting" ? null : new Date().toISOString(),
    ...(result.error ? { error: result.error } : {}),
    ...(result.lastNode ? { lastNode: result.lastNode } : {}),
    customData: result.customData,
    runData: result.runData,
    startNode: result.startNode,
    ...(waiting ? { waiting, waitingBlobs: base64Blobs(blobs), ...(waiting.until ? { waitUntil: waiting.until } : {}), ...(resumeHash ? { resumeHash } : {}) } : {}),
    ...(options.parent ? { parent: options.parent } : {}),
  };
  saveRun(accountId, record);
  if (waiting) addWait({ account: accountId, workflowId: workflow.id, runId, ...(waiting.until ? { until: waiting.until } : {}), ...(resumeHash ? { resumeHash } : {}) });
}

async function subWorkflow(accountId: string, parent: Workflow, parentRunId: string, depth: number, call: { workflowId: string; items: Item[]; wait: boolean }, blobs: BlobPayload[]): Promise<{ items: Item[]; blobs: BlobPayload[] }> {
  const target = getWorkflow(accountId, call.workflowId);
  if (!target) throw new Error(`The sub-workflow ${call.workflowId} does not exist in your account.`);
  if (target.settings.callableBy === "none") throw new Error(`"${target.name}" does not allow being called by other workflows.`);
  const trigger = target.nodes.find((node) => !node.disabled && nodeMeta(node.type)?.trigger === "subworkflow");
  if (!trigger) throw new Error(`"${target.name}" has no Execute Sub-workflow Trigger.`);
  const run = startRun({ accountId, workflow: target, mode: "subworkflow", startNode: trigger.name, triggerItems: call.items, triggerBlobs: blobs, parent: { workflowId: parent.id, runId: parentRunId }, depth: depth + 1 });
  if (!call.wait) {
    void run.catch(() => undefined);
    return { items: [], blobs: [] };
  }
  const { result, blobs: out } = await run;
  if (result.status === "error") throw new Error(`Sub-workflow "${target.name}" failed: ${result.error?.message ?? "error"}`);
  if (result.status === "waiting") return { items: [], blobs: [] };
  return { items: result.lastItems ?? [], blobs: out };
}

async function startErrorWorkflow(accountId: string, failed: Workflow, runId: string, mode: RunMode, result: RunResult): Promise<void> {
  const target = failed.settings.errorWorkflow ? getWorkflow(accountId, failed.settings.errorWorkflow) : null;
  if (!target) return;
  const trigger = target.nodes.find((node) => !node.disabled && nodeMeta(node.type)?.trigger === "error");
  if (!trigger) return;
  const item: Item = {
    json: {
      execution: { id: runId, url: `${appBaseUrl()}/tools/workflows?workflow=${failed.id}&run=${runId}`, mode, error: result.error ?? { message: "error" }, lastNodeExecuted: result.lastNode ?? null },
      workflow: { id: failed.id, name: failed.name },
    },
  };
  await startRun({ accountId, workflow: target, mode: "error", startNode: trigger.name, triggerItems: [item], parent: { workflowId: failed.id, runId } });
}
