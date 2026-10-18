// The server isolate pool (src/lib/isolate/server.ts) with REAL worker threads: user-supplied regex work and parsers run
// off the main thread, under a timeout that terminates the worker. Regression for the JSON Schema ReDoS (audit inj #2 /
// abuse #1): `pattern: "^(a+)+$"` against "a"x40 + "!" used to block the event loop for hours.
import assert from "node:assert/strict";
import test from "node:test";
import { IsolatePool } from "../src/lib/isolate/pool.ts";
import { isIsolateStopped, isolatePool, runIsolated } from "../src/lib/isolate/server.ts";
import { buildDocument } from "../src/lib/office/templates.ts";

const REDOS = { schema: JSON.stringify({ type: "string", pattern: "^(a+)+$" }), value: JSON.stringify(`${"a".repeat(40)}!`) };

test.after(() => isolatePool().terminateAll());

test("JSON Schema validation runs in a worker and returns issues", async () => {
  const ok = await runIsolated("validateJsonSchema", { schema: '{"type":"string","pattern":"^a+$"}', value: '"aaa"' });
  assert.deepEqual(ok, { valid: true, issues: [] });
  const bad = await runIsolated("validateJsonSchema", { schema: '{"type":"object","required":["id"]}', value: "{}" });
  assert.equal(bad.valid, false);
  assert.equal(bad.issues[0].keyword, "required");
});

test("invalid JSON text keeps its own error message", async () => {
  await assert.rejects(runIsolated("validateJsonSchema", { schema: "{", value: "1" }), /Invalid JSON Schema text/);
});

test("ReDoS pattern: stopped within the timeout while the main thread stays responsive", async () => {
  let ticks = 0;
  const ticker = setInterval(() => (ticks += 1), 20);
  const start = performance.now();
  try {
    await assert.rejects(runIsolated("validateJsonSchema", REDOS, { timeoutMs: 1_000 }), (error) => {
      assert.ok(isIsolateStopped(error), String(error));
      assert.equal(error.reason, "timeout");
      assert.match(error.message, /did not finish within 1 s/);
      return true;
    });
  } finally {
    clearInterval(ticker);
  }
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 5_000, `took ${elapsed.toFixed(0)} ms`);
  assert.ok(ticks >= 20, `event loop ran only ${ticks} ticks during the attack`);
  // The pool recovered: the next call gets a fresh worker.
  assert.deepEqual(await runIsolated("validateJsonSchema", { schema: '{"type":"number"}', value: "1" }), { valid: true, issues: [] });
});

test("regex generation runs in the worker", async () => {
  const generation = await runIsolated("generateRegex", { positiveExamples: "ab-12\ncd-345", negativeExamples: "xx", anchorMode: "line" });
  assert.ok(generation && generation.clean, JSON.stringify(generation));
});

test("office text extraction runs in the worker, bounded", async () => {
  const bytes = buildDocument("docx", { paragraphs: ["one", "two"] });
  assert.deepEqual(await runIsolated("extractOfficeText", { format: "docx", bytes, maxChars: 100 }), { text: "one\ntwo", truncated: false });
  assert.deepEqual(await runIsolated("extractOfficeText", { format: "docx", bytes, maxChars: 4 }), { text: "one\n", truncated: true });
});

test("a full pool refuses at once (QueueFullError), a per-account share is capped", async () => {
  // A private pool with one worker and no queue: the second concurrent call is refused while the ReDoS runs.
  const { Worker } = await import("node:worker_threads");
  const pool = new IsolatePool({
    name: "test",
    size: 1,
    maxQueue: 0,
    perOwner: 1,
    create: () => new Worker(new URL("../src/lib/isolate/worker.ts", import.meta.url)),
  });
  try {
    const running = runIsolated("validateJsonSchema", REDOS, { timeoutMs: 800, owner: "a" }, pool);
    await assert.rejects(runIsolated("validateJsonSchema", REDOS, { owner: "a" }, pool), (e) => e.code === "QUEUE_FULL" && e.scope === "owner");
    await assert.rejects(runIsolated("validateJsonSchema", REDOS, { owner: "b" }, pool), (e) => e.code === "QUEUE_FULL" && e.scope === "lane");
    await assert.rejects(running, (e) => isIsolateStopped(e));
  } finally {
    pool.terminateAll();
  }
});

test("an idle pool never keeps the process alive; a pending task does", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "knife-isolate-exit-"));
  const script = join(dir, "run.mjs");
  writeFileSync(script, `const { runIsolated } = await import(${JSON.stringify(new URL("../src/lib/isolate/server.ts", import.meta.url).href)});
process.stdout.write(JSON.stringify(await runIsolated("validateJsonSchema", { schema: "{}", value: "1" })));
`);
  try {
    const args = [...process.execArgv.filter((a) => !a.startsWith("--test")), script];
    const child = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 20_000 });
    assert.equal(child.signal, null, "the child had to be killed: the pool kept it alive");
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, '{"valid":true,"issues":[]}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
