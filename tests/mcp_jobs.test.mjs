// Long MCP calls (docs/MCP.md "Long calls", src/lib/mcp/jobs.ts + tools-jobs.ts): a call answers within the answer
// window with its result, or with {status:"running", jobId} while the work goes on; knife_job_status waits and returns
// the very content the call would have returned (image blocks included). Jobs are per account (another account, or a
// read-only key asking about a write, gets "unknown job"), bounded per account, expire, and a cancel before the window
// ends still stops the work while one after it does not.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/mcp_jobs.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as z from "zod/v4";

const dataDir = mkdtempSync(join(tmpdir(), "knife-mcp-jobs-"));
process.env.KNIFE_DATA_DIR = dataDir;
process.env.KNIFE_MCP_ANSWER_WITHIN_MS = "200";
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const jobs = await import("../src/lib/mcp/jobs.ts");
const { JOB_KNIFE_TOOLS } = await import("../src/lib/mcp/tools-jobs.ts");
const { defineTool, KnifeRichResult } = await import("../src/lib/mcp/define.ts");
const { answerWithin, mcpToolsFor } = await import("../src/lib/mcp/server.ts");
const { KNIFE_TOOLS } = await import("../src/lib/mcp/tools.ts");

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
});
const limits = (over = {}) => ({ ...jobs.mcpJobLimits({}), answerWithinMs: 100, ...over });
const text = (blocks) => blocks.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
const jobStatus = JOB_KNIFE_TOOLS[0];

/** A fake tool of `ms` duration; `seen` records the signal it got. */
function slowTool(name, ms, { effect = "read", fail = false, image = false, seen = {} } = {}) {
  return defineTool({
    name, scope: "account", effect, description: "test", schema: z.object({}).strict(),
    async run(_input, ctx) {
      seen.signal = ctx?.signal;
      ctx?.progress?.("halfway there");
      await sleep(ms, ctx?.signal);
      if (fail) throw new Error("the page did not load");
      return image ? new KnifeRichResult({ ok: true }, [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]) : { ok: true, name };
    },
  });
}

test.beforeEach(() => jobs.clearMcpJobs());

test("a fast call answers with its result, no job", async () => {
  const started = await jobs.startCall({ accountId: "alice", tool: "t", readOnly: true, limits: limits() }, async () => ({ content: [{ type: "text", text: "done" }] }));
  assert.equal(started.job, undefined);
  assert.equal(text(started.result), "done");
  assert.equal(jobs.runningJobs("alice"), 0);
});

test("a slow call answers running within the window; knife_job_status returns the same content, image blocks included", async () => {
  const tool = slowTool("knife_slow_shot", 400, { image: true });
  const t0 = Date.now();
  const first = await answerWithin(tool, {}, { accountId: "alice", admin: false }, new AbortController().signal);
  assert.ok(Date.now() - t0 < 350, "answered within the window");
  const running = JSON.parse(text(first));
  assert.equal(running.status, "running");
  assert.equal(running.pollWith, "knife_job_status");
  assert.match(running.jobId, jobs.JOB_ID);
  assert.equal(running.progress, "halfway there");

  const polled = await jobStatus.execute({ jobId: running.jobId, waitSeconds: 5 }, { accountId: "alice", admin: false });
  assert.equal(polled.isError, false);
  assert.equal(JSON.parse(polled.content[0].text).status, "done");
  assert.deepEqual(JSON.parse(polled.content[1].text), { ok: true });
  assert.deepEqual(polled.content[2], { type: "image", data: "aGVsbG8=", mimeType: "image/png" });

  // Still there for a client that lost the answer; never for another account.
  assert.equal(JSON.parse((await jobStatus.execute({ jobId: running.jobId, waitSeconds: 0 }, { accountId: "alice", admin: false })).content[0].text).status, "done");
  await assert.rejects(jobStatus.execute({ jobId: running.jobId, waitSeconds: 0 }, { accountId: "bob", admin: false }), /Unknown or expired job/);
  await assert.rejects(jobStatus.execute({ jobId: "job_" + "0".repeat(24), waitSeconds: 0 }, { accountId: "alice", admin: false }), /Unknown or expired job/);
  await assert.rejects(jobStatus.execute({ jobId: "../etc", waitSeconds: 0 }, { accountId: "alice", admin: false }), /Unknown or expired job/);
});

test("a short poll of a running job says running with progress; a failure comes back as an error result", async () => {
  const tool = slowTool("knife_slow_fail", 300, { fail: true });
  const running = JSON.parse(text(await answerWithin(tool, {}, { accountId: "alice", admin: false }, new AbortController().signal)));
  const early = await jobStatus.execute({ jobId: running.jobId, waitSeconds: 0 }, { accountId: "alice", admin: false });
  assert.equal(early.status, "running");
  assert.equal(early.progress, "halfway there");
  const done = await jobStatus.execute({ jobId: running.jobId, waitSeconds: 5 }, { accountId: "alice", admin: false });
  assert.equal(done.isError, true);
  assert.equal(JSON.parse(done.content[0].text).status, "failed");
  assert.match(done.content[1].text, /did not load/);
});

test("a read-only key reads only jobs of tools that change nothing", async () => {
  const tool = slowTool("knife_slow_write", 300, { effect: "write" });
  const running = JSON.parse(text(await answerWithin(tool, {}, { accountId: "alice", admin: false }, new AbortController().signal)));
  await assert.rejects(jobStatus.execute({ jobId: running.jobId, waitSeconds: 0 }, { accountId: "alice", admin: false, readOnly: true }), /Unknown or expired job/);
  const done = await jobStatus.execute({ jobId: running.jobId, waitSeconds: 5 }, { accountId: "alice", admin: false });
  assert.equal(JSON.parse(done.content[0].text).status, "done");
});

test("bounded: a further background call is refused up front, other accounts are not affected", async () => {
  const l = limits({ maxRunningPerAccount: 2 });
  const work = (signal) => sleep(500, signal).then(() => ({ content: [{ type: "text", text: "ok" }] }));
  assert.ok((await jobs.startCall({ accountId: "alice", tool: "a", readOnly: true, limits: l }, work)).job);
  assert.ok((await jobs.startCall({ accountId: "alice", tool: "b", readOnly: true, limits: l }, work)).job);
  await assert.rejects(jobs.startCall({ accountId: "alice", tool: "c", readOnly: true, limits: l }, work), (e) => e instanceof jobs.McpJobLimitError);
  assert.ok((await jobs.startCall({ accountId: "bob", tool: "a", readOnly: true, limits: l }, work)).job);
});

test("cancel before the window stops the work; after it the work belongs to the job", async () => {
  const seenEarly = {};
  const early = new AbortController();
  setTimeout(() => early.abort(), 30);
  const cancelled = await answerWithin(slowTool("knife_slow_a", 2_000, { seen: seenEarly }), {}, { accountId: "alice", admin: false }, early.signal);
  assert.equal(seenEarly.signal.aborted, true);
  assert.equal(cancelled.isError, true);

  const seenLate = {};
  const late = new AbortController();
  const running = JSON.parse(text(await answerWithin(slowTool("knife_slow_b", 400, { seen: seenLate }), {}, { accountId: "alice", admin: false }, late.signal)));
  late.abort();
  assert.equal(seenLate.signal.aborted, false);
  const done = await jobStatus.execute({ jobId: running.jobId, waitSeconds: 5 }, { accountId: "alice", admin: false });
  assert.equal(JSON.parse(done.content[0].text).status, "done");
});

test("runs are capped and finished results expire", async () => {
  const l = limits({ maxRunMs: 150, ttlMs: 60_000 });
  const started = await jobs.startCall({ accountId: "alice", tool: "t", readOnly: true, limits: l }, (signal) => sleep(5_000, signal).then(() => ({ content: [{ type: "text", text: "never" }] })));
  const status = await jobs.jobStatus("alice", started.job.jobId, { waitSeconds: 3, limits: l });
  assert.equal(status.view.state, "failed");
  await sleep(5);
  assert.equal(await jobs.jobStatus("alice", started.job.jobId, { waitSeconds: 0, limits: { ...l, ttlMs: 0 } }), null);
});

test("progress ticks reach the caller while it waits (MCP progress notifications)", async () => {
  const ticks = [];
  const started = await jobs.startCall({ accountId: "alice", tool: "t", readOnly: true, limits: limits({ answerWithinMs: 250 }), onTick: (job) => ticks.push(job.progress), tickMs: 50 }, async (signal, progress) => {
    progress("Fetching /");
    await sleep(1_000, signal);
    return { content: [{ type: "text", text: "ok" }] };
  });
  assert.ok(started.job);
  assert.ok(ticks.length >= 2 && ticks.every((t) => t === "Fetching /"), JSON.stringify(ticks));
});

test("knife_job_status is MCP-only, read-only, offered to read-only keys; not a tool of the in-page assistant", () => {
  assert.equal(jobStatus.name, "knife_job_status");
  assert.equal(jobStatus.effect, "read");
  assert.ok(!KNIFE_TOOLS.some((t) => t.name === "knife_job_status"));
  assert.ok(mcpToolsFor({ accountId: "alice", admin: false, readOnly: true }).some((t) => t.name === "knife_job_status"));
});

test("limits from the environment are clamped", () => {
  assert.equal(jobs.mcpJobLimits({}).answerWithinMs, 25_000);
  assert.equal(jobs.mcpJobLimits({ KNIFE_MCP_ANSWER_WITHIN_MS: "999999" }).answerWithinMs, 50_000);
  assert.equal(jobs.mcpJobLimits({ KNIFE_MCP_ANSWER_WITHIN_MS: "abc" }).answerWithinMs, 25_000);
  assert.equal(jobs.mcpJobLimits({ KNIFE_MCP_JOBS_PER_ACCOUNT: "0" }).maxRunningPerAccount, 1);
});
