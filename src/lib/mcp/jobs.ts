import { randomBytes } from "node:crypto";
import { msgf } from "@/lib/i18n/msg";

/**
 * Background MCP calls (docs/MCP.md "Long calls"). MCP clients give up on a tool call after about 60 s ("Request timed
 * out", -32001), while a screenshot, an audit or a preview verification can take longer. So every MCP tool call answers
 * within `answerWithinMs` (25 s by default): with its result when it is done by then, else with
 * `{status:"running", jobId, pollWith:"knife_job_status"}` while the work goes on here; knife_job_status waits a little
 * (up to 25 s) and returns the progress or the very content the call would have returned.
 *
 * Kept in the server's MEMORY only (like the screenshot images, src/lib/vision/images.ts): never written to the data dir,
 * gone after `ttlMs` or a restart. Bounded: `maxRunningPerAccount` calls may run in the background at once (a further
 * call is refused up front, never cut off mid-way), finished jobs per account (`maxFinishedPerAccount`) and the bytes of
 * all stored results server-wide (`maxTotalBytes`; oldest finished first). A running job is aborted after
 * `maxRunMs`. A job is only ever looked up with the account that started it, so another account's id answers "unknown
 * job". Ids are `job_` + 24 hex. In the server's memory per process: fine for the one-process service (docs/DEPLOY.md).
 */

export type McpJobState = "running" | "done" | "failed";

/** What the call returns to an MCP client (text and image blocks), stored as is. */
// A type alias, not an interface: the MCP SDK's result type has an index signature.
export type McpCallContent = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
};

export interface McpJobView {
  jobId: string;
  tool: string;
  state: McpJobState;
  elapsedSec: number;
  progress: string;
}

interface McpJob {
  id: string;
  accountId: string;
  tool: string;
  /** The tool changes nothing (a read-only key may read only these jobs). */
  readOnly: boolean;
  state: McpJobState;
  progress: string;
  startedAt: number;
  finishedAt: number;
  result: McpCallContent | null;
  bytes: number;
  controller: AbortController;
  /** Settles when the job finishes (never rejects). */
  settled: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface McpJobLimits {
  answerWithinMs: number;
  ttlMs: number;
  maxRunMs: number;
  maxRunningPerAccount: number;
  maxFinishedPerAccount: number;
  maxTotalBytes: number;
}

export const JOB_ID = /^job_[0-9a-f]{24}$/;
/** knife_job_status waits at most this long (an MCP client's ~60 s cap, with room to spare). */
export const MAX_POLL_WAIT_SEC = 25;

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = Number(env[name]);
  return Number.isFinite(raw) && env[name]?.trim() ? Math.max(min, Math.min(max, Math.round(raw))) : fallback;
}

/** Limits from the environment (`KNIFE_MCP_ANSWER_WITHIN_MS`, `KNIFE_MCP_JOB_TTL_SEC`, `KNIFE_MCP_JOBS_PER_ACCOUNT`). */
export function mcpJobLimits(env: NodeJS.ProcessEnv = process.env): McpJobLimits {
  return {
    answerWithinMs: intEnv(env, "KNIFE_MCP_ANSWER_WITHIN_MS", 25_000, 200, 50_000),
    ttlMs: intEnv(env, "KNIFE_MCP_JOB_TTL_SEC", 15 * 60, 60, 24 * 3600) * 1000,
    maxRunMs: 15 * 60_000,
    maxRunningPerAccount: intEnv(env, "KNIFE_MCP_JOBS_PER_ACCOUNT", 4, 1, 50),
    maxFinishedPerAccount: 16,
    maxTotalBytes: 96 * 1024 * 1024,
  };
}

const KEY = Symbol.for("samurai-knife.mcp-jobs.v1");

function store(): Map<string, McpJob> {
  const g = globalThis as unknown as Record<symbol, Map<string, McpJob> | undefined>;
  return (g[KEY] ??= new Map());
}

export class McpJobLimitError extends Error {
  readonly code = "MCP_JOBS_FULL";
  constructor(running: number) {
    super(msgf("You already have {running} tool calls running in the background: wait for them with knife_job_status, then call again.", { running }));
    this.name = "McpJobLimitError";
  }
}

function contentBytes(result: McpCallContent): number {
  let n = 0;
  for (const block of result.content) n += block.type === "text" ? Buffer.byteLength(block.text) : block.data.length;
  return n;
}

function sweep(limits: McpJobLimits, now: number): void {
  const map = store();
  for (const [id, job] of map) if (job.state !== "running" && now - job.finishedAt > limits.ttlMs) map.delete(id);
  const perAccount = new Map<string, McpJob[]>();
  for (const job of map.values()) {
    if (job.state === "running") continue;
    const list = perAccount.get(job.accountId) ?? [];
    list.push(job);
    perAccount.set(job.accountId, list);
  }
  for (const list of perAccount.values()) {
    list.sort((a, b) => a.finishedAt - b.finishedAt);
    for (const old of list.slice(0, Math.max(0, list.length - limits.maxFinishedPerAccount))) map.delete(old.id);
  }
  let total = 0;
  for (const job of map.values()) total += job.bytes;
  const finished = [...map.values()].filter((job) => job.state !== "running").sort((a, b) => a.finishedAt - b.finishedAt);
  for (const job of finished) {
    if (total <= limits.maxTotalBytes) break;
    total -= job.bytes;
    map.delete(job.id);
  }
}

/** Background calls of this account still running. */
export function runningJobs(accountId: string): number {
  let n = 0;
  for (const job of store().values()) if (job.accountId === accountId && job.state === "running") n++;
  return n;
}

function view(job: McpJob, now: number): McpJobView {
  return {
    jobId: job.id,
    tool: job.tool,
    state: job.state,
    elapsedSec: Math.round(((job.state === "running" ? now : job.finishedAt) - job.startedAt) / 1000),
    progress: job.progress,
  };
}

export interface StartedCall {
  /** The call finished within the answer window: its content, as the client would have got it. */
  result?: McpCallContent;
  /** Still running: the job to poll. */
  job?: McpJobView;
}

export interface CallOptions {
  accountId: string;
  tool: string;
  readOnly: boolean;
  /** The request's own signal: until the call is moved to the background, cancelling the request cancels the work. */
  requestSignal?: AbortSignal;
  /** Called every few seconds while the caller still waits (MCP progress notifications). */
  onTick?: (job: McpJobView) => void;
  tickMs?: number;
  limits?: McpJobLimits;
}

/**
 * Run one call: `work` gets the job's own AbortSignal (cancel before the answer window ends, or the run-time cap) and a
 * `progress` setter. Resolves within `answerWithinMs` with the result, or with the job to poll. Throws McpJobLimitError
 * up front when the account already has `maxRunningPerAccount` background calls.
 */
export async function startCall(
  options: CallOptions,
  work: (signal: AbortSignal, progress: (message: string) => void) => Promise<McpCallContent>,
): Promise<StartedCall> {
  const limits = options.limits ?? mcpJobLimits();
  const now = Date.now();
  sweep(limits, now);
  const running = runningJobs(options.accountId);
  if (running >= limits.maxRunningPerAccount) throw new McpJobLimitError(running);

  const controller = new AbortController();
  const job: McpJob = {
    id: `job_${randomBytes(12).toString("hex")}`,
    accountId: options.accountId,
    tool: options.tool,
    readOnly: options.readOnly,
    state: "running",
    progress: "",
    startedAt: now,
    finishedAt: 0,
    result: null,
    bytes: 0,
    controller,
    settled: Promise.resolve(),
    timer: null,
  };
  const onRequestAbort = () => controller.abort(options.requestSignal?.reason);
  if (options.requestSignal?.aborted) onRequestAbort();
  options.requestSignal?.addEventListener("abort", onRequestAbort, { once: true });
  job.timer = setTimeout(() => controller.abort(new Error(msgf("The call ran longer than {minutes} minutes and was stopped.", { minutes: Math.round(limits.maxRunMs / 60_000) }))), limits.maxRunMs);
  job.timer.unref?.();

  job.settled = (async () => {
    let result: McpCallContent;
    try {
      result = await work(controller.signal, (message) => {
        job.progress = message.slice(0, 300);
      });
    } catch (error) {
      result = { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
    if (job.timer) clearTimeout(job.timer);
    job.timer = null;
    job.result = result;
    job.bytes = contentBytes(result);
    job.state = result.isError ? "failed" : "done";
    job.finishedAt = Date.now();
    sweep(limits, job.finishedAt);
  })();

  const finishedInTime = await waitFor(job, limits.answerWithinMs, options.onTick, options.tickMs);
  if (finishedInTime && job.result) {
    options.requestSignal?.removeEventListener("abort", onRequestAbort);
    if (job.timer) clearTimeout(job.timer);
    return { result: job.result };
  }
  // From here on the work belongs to the job, not to the request (which is about to be answered).
  options.requestSignal?.removeEventListener("abort", onRequestAbort);
  store().set(job.id, job);
  return { job: view(job, Date.now()) };
}

/** Waits until the job settles or `ms` pass, ticking every `tickMs`. True when it settled. */
async function waitFor(job: McpJob, ms: number, onTick?: (job: McpJobView) => void, tickMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (job.state !== "running") return true;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const step = Math.min(left, onTick ? tickMs : left);
    await Promise.race([job.settled, new Promise<void>((resolve) => { timer = setTimeout(resolve, step); })]);
    if (timer) clearTimeout(timer);
    if (job.state === "running" && onTick && Date.now() < deadline) {
      try {
        onTick(view(job, Date.now()));
      } catch {
        // a progress notification that cannot be sent is not the call's failure
      }
    }
  }
}

export interface JobStatus {
  view: McpJobView;
  /** Set when the job finished: the content the original call returns. */
  result: McpCallContent | null;
}

/**
 * The job of this account, after waiting up to `waitSeconds` for it to finish; null = unknown here (wrong account,
 * expired, or a read-only caller asking about a job of a tool that changes data).
 */
export async function jobStatus(accountId: string, id: string, options: { waitSeconds?: number; readOnly?: boolean; onTick?: (job: McpJobView) => void; tickMs?: number; limits?: McpJobLimits } = {}): Promise<JobStatus | null> {
  const limits = options.limits ?? mcpJobLimits();
  sweep(limits, Date.now());
  if (!JOB_ID.test(id)) return null;
  const job = store().get(id);
  if (!job || job.accountId !== accountId) return null;
  if (options.readOnly && !job.readOnly) return null;
  const wait = Math.max(0, Math.min(MAX_POLL_WAIT_SEC, options.waitSeconds ?? 20)) * 1000;
  if (job.state === "running" && wait > 0) await waitFor(job, wait, options.onTick, options.tickMs);
  return { view: view(job, Date.now()), result: job.state === "running" ? null : job.result };
}

/** Tests only. */
export function clearMcpJobs(): void {
  for (const job of store().values()) {
    if (job.timer) clearTimeout(job.timer);
    job.controller.abort();
  }
  store().clear();
}
