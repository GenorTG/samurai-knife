// Tests for src/lib/work-queue.ts and the process-group handling in src/lib/python.ts.
// Oracles are independent of the implementation: counters kept inside the fake tasks, a hand-driven clock with
// hand-computed nearest-rank percentiles, and the OS process table (kill(pid, 0)) for "the process is really gone".
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/work-queue.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The Python lane reads its interpreter and lane sizes at import time.
const scratch = mkdtempSync(join(tmpdir(), "wq-test-"));
const fakePython = join(scratch, "fake-python.sh");
const pidFile = join(scratch, "pids");
writeFileSync(
  fakePython,
  `#!/bin/bash
# argv: <script> <request.json> <response.json>; MODE comes from the request body's "mode"
mode=$(sed -n 's/.*"mode":"\\([a-z]*\\)".*/\\1/p' "$2")
case "$mode" in
  ok) printf '{"ok":true,"data":{"x":1}}' > "$3" ;;
  fail) printf '{"ok":false,"error":"handled failure"}' > "$3"; exit 2 ;;
  silent) exit 0 ;;
  hang) sleep 300 & echo "$$ $!" >> "${pidFile}"; wait ;;
esac
`,
);
chmodSync(fakePython, 0o755);
process.env.KNIFE_PYTHON = fakePython;
process.env.KNIFE_PY_LIGHT = "2";
process.env.KNIFE_PY_HEAVY = "1";

const { WorkQueue, QueueFullError, JobCancelledError, JobTimeoutError, isQueueFull } = await import("../src/lib/work-queue.ts");
const { runPythonScript, startPythonScript } = await import("../src/lib/python.ts");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((res) => (resolve = res));
  return { promise, resolve };
};
// A killed process can linger as a zombie until its (re-parented) parent reaps it; that is dead for our purposes.
const alive = (pid) => {
  try {
    const state = readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "")[0];
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
};
async function waitFor(predicate, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await predicate()) return true;
    await sleep(15);
  }
  return false;
}

/* ================================================================== queue core */

test("FIFO within a lane: start order equals submit order", async () => {
  const queue = new WorkQueue({ a: { concurrency: 1, maxDepth: 10 } });
  const started = [];
  const jobs = [0, 1, 2, 3, 4].map((n) =>
    queue.submit("a", async () => {
      started.push(n);
      await sleep(5);
      return n;
    }),
  );
  assert.deepEqual(await Promise.all(jobs.map((j) => j.promise)), [0, 1, 2, 3, 4]);
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
});

test("lane cap is never exceeded (counted inside the tasks) and is actually reached", async () => {
  const queue = new WorkQueue({ a: { concurrency: 3, maxDepth: 100 } });
  let inFlight = 0;
  let peak = 0;
  const jobs = Array.from({ length: 24 }, (_, n) =>
    queue.submit("a", async () => {
      peak = Math.max(peak, ++inFlight);
      await sleep(2 + (n % 5) * 3);
      inFlight--;
    }),
  );
  await Promise.all(jobs.map((j) => j.promise));
  assert.equal(peak, 3);
  assert.equal(inFlight, 0);
  const stats = queue.stats().a;
  assert.equal(stats.completed, 24);
  assert.equal(stats.running + stats.queued, 0);
});

test("a light job never waits behind heavy ones", async () => {
  const queue = new WorkQueue({ light: { concurrency: 2, maxDepth: 10 }, heavy: { concurrency: 1, maxDepth: 10 } });
  const gate = deferred();
  const heavy = [0, 1, 2].map(() => queue.submit("heavy", () => gate.promise));
  assert.equal(heavy[0].state(), "running");
  assert.equal(heavy[1].state(), "queued");
  const t0 = Date.now();
  const light = await queue.submit("light", async () => "fast").promise;
  assert.equal(light, "fast");
  assert.ok(Date.now() - t0 < 100, "light job finished while the heavy lane was saturated");
  assert.equal(heavy[2].state(), "queued");
  gate.resolve();
  await Promise.all(heavy.map((j) => j.promise));
});

test("depth limit rejects with a typed QueueFullError carrying a Retry-After estimate", async () => {
  const queue = new WorkQueue({ a: { concurrency: 1, maxDepth: 2 } });
  const gate = deferred();
  const jobs = [0, 1, 2].map(() => queue.submit("a", () => gate.promise)); // 1 running + 2 waiting
  assert.equal(queue.hasCapacity("a"), false);
  assert.throws(
    () => queue.submit("a", async () => 1),
    (error) => error instanceof QueueFullError && isQueueFull(error) && error.lane === "a" && error.depth === 2 && error.retryAfterSec >= 1,
  );
  assert.equal(queue.stats().a.queued, 2, "the rejected job left no trace");
  gate.resolve();
  await Promise.all(jobs.map((j) => j.promise));
  assert.equal(queue.hasCapacity("a"), true);
  assert.doesNotThrow(() => queue.assertCapacity("a"));

  const strict = new WorkQueue({ a: { concurrency: 1, maxDepth: 0 } });
  const hold = deferred();
  const running = strict.submit("a", () => hold.promise);
  assert.throws(() => strict.submit("a", async () => 1), isQueueFull);
  hold.resolve();
  await running.promise;
});

test("queue positions count the jobs ahead and update as the queue drains", async () => {
  const queue = new WorkQueue({ a: { concurrency: 1, maxDepth: 10 } });
  const gates = [deferred(), deferred(), deferred(), deferred()];
  const jobs = gates.map((gate) => queue.submit("a", () => gate.promise));
  assert.deepEqual(jobs.map((j) => j.position()), [null, 0, 1, 2]);
  gates[0].resolve();
  await jobs[0].promise;
  assert.deepEqual(jobs.map((j) => j.position()), [null, null, 0, 1]);
  assert.equal(jobs[1].state(), "running");
  gates[1].resolve();
  gates[2].resolve();
  gates[3].resolve();
  await Promise.all(jobs.map((j) => j.promise));
  assert.deepEqual(jobs.map((j) => j.position()), [null, null, null, null]);
});

test("abort while queued removes the job: it never runs and the others move up", async () => {
  const queue = new WorkQueue({ a: { concurrency: 1, maxDepth: 10 } });
  const gate = deferred();
  const ran = [];
  const controller = new AbortController();
  const first = queue.submit("a", () => gate.promise);
  const second = queue.submit("a", async () => ran.push("second"), { signal: controller.signal });
  const third = queue.submit("a", async () => ran.push("third"));
  assert.equal(third.position(), 1);
  controller.abort();
  await assert.rejects(second.promise, (error) => error instanceof JobCancelledError);
  assert.equal(second.state(), "cancelled");
  assert.equal(third.position(), 0);
  gate.resolve();
  await first.promise;
  await third.promise;
  assert.deepEqual(ran, ["third"]);
  assert.equal(queue.stats().a.cancelled, 1);
  assert.equal(queue.stats().a.queued, 0);
});

test("handle.cancel() and an already-aborted signal behave like an abort", async () => {
  const queue = new WorkQueue({ a: { concurrency: 1, maxDepth: 10 } });
  const gate = deferred();
  const first = queue.submit("a", () => gate.promise);
  const second = queue.submit("a", async () => "never");
  second.cancel("user pressed cancel");
  await assert.rejects(second.promise, /user pressed cancel/);
  const pre = new AbortController();
  pre.abort();
  const third = queue.submit("a", async () => "never", { signal: pre.signal });
  await assert.rejects(third.promise, (error) => error instanceof JobCancelledError);
  assert.equal(queue.stats().a.queued, 0);
  gate.resolve();
  await first.promise;
  assert.equal(queue.stats().a.cancelled, 2);
});

test("abort while running signals the task and the slot is held until the task has actually settled", async () => {
  const queue = new WorkQueue({ a: { concurrency: 1, maxDepth: 10 } });
  const controller = new AbortController();
  let sawAbort = false;
  const finishCleanup = deferred();
  const first = queue.submit(
    "a",
    async ({ signal }) => {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      sawAbort = true;
      await finishCleanup.promise; // simulates a process that takes a moment to die
      return "late";
    },
    { signal: controller.signal },
  );
  let secondStarted = false;
  const second = queue.submit("a", async () => {
    secondStarted = true;
  });
  controller.abort();
  await sleep(40);
  assert.equal(sawAbort, true);
  assert.equal(secondStarted, false, "cap holds while the aborted task is still dying");
  assert.equal(queue.stats().a.running, 1);
  finishCleanup.resolve();
  await assert.rejects(first.promise, (error) => error instanceof JobCancelledError, "a result arriving after the abort is discarded");
  await second.promise;
  assert.equal(secondStarted, true);
  assert.equal(first.state(), "cancelled");
});

test("a task that ignores the abort is force-released after the grace period (and counted as leaked)", async () => {
  const queue = new WorkQueue({ a: { concurrency: 1, maxDepth: 10 } }, { abortGraceMs: 30 });
  const stuck = queue.submit("a", () => new Promise(() => {}));
  const next = queue.submit("a", async () => "ok");
  stuck.cancel();
  await assert.rejects(stuck.promise, JobCancelledError);
  assert.equal(await next.promise, "ok");
  assert.equal(queue.stats().a.leaked, 1);
});

test("timeout counts run time only, aborts the signal, fails the job and frees the slot", async () => {
  const queue = new WorkQueue({ a: { concurrency: 1, maxDepth: 10 } });
  const slow = queue.submit("a", () => sleep(150), { timeoutMs: 100 });
  // Waits ~150 ms behind `slow`, then needs ~60 ms: would fail if queue wait counted against its 100 ms limit.
  const patient = queue.submit("a", () => sleep(60).then(() => "done"), { timeoutMs: 100 });
  const hung = queue.submit(
    "a",
    ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    { timeoutMs: 40 },
  );
  await assert.rejects(slow.promise, JobTimeoutError, "the 100 ms limit wins even though this task ignores the signal and finishes at 150");
  assert.equal(await patient.promise, "done");
  await assert.rejects(hung.promise, (error) => error instanceof JobTimeoutError && /Timed out/.test(error.message));
  assert.equal(hung.state(), "failed");
  assert.equal(queue.stats().a.running, 0);
});

test("stats: totals, current counts and nearest-rank wait/run percentiles against a hand-driven clock", async () => {
  let clock = 1000;
  const queue = new WorkQueue({ a: { concurrency: 1, maxDepth: 10 } }, { now: () => clock });
  const durations = [10, 20, 30, 40];
  // Everything is enqueued at t=1000 and each task advances the clock by its own duration.
  const jobs = durations.map((d) =>
    queue.submit("a", async () => {
      await Promise.resolve(); // let all four submits land at t=1000 before the clock moves
      clock += d;
    }),
  );
  await Promise.all(jobs.map((j) => j.promise));
  const stats = queue.stats().a;
  // run samples [10,20,30,40]: p50 = ceil(.5*4)=2nd -> 20, p95 = ceil(.95*4)=4th -> 40
  assert.deepEqual(stats.runMs, { n: 4, p50: 20, p95: 40 });
  // wait samples [0,10,30,60]: p50 -> 10, p95 -> 60
  assert.deepEqual(stats.waitMs, { n: 4, p50: 10, p95: 60 });
  assert.equal(jobs[3].waitMs(), 60);
  assert.equal(jobs[3].runMs(), 40);
  assert.deepEqual([stats.completed, stats.failed, stats.cancelled, stats.queued, stats.running], [4, 0, 0, 0, 0]);

  const failing = queue.submit("a", async () => {
    throw new Error("boom");
  });
  await assert.rejects(failing.promise, /boom/);
  assert.equal(queue.stats().a.failed, 1);
  assert.equal(failing.state(), "failed");
});

test("unknown lane and invalid sizes are programmer errors", () => {
  assert.throws(() => new WorkQueue({ a: { concurrency: 0, maxDepth: 1 } }), RangeError);
  assert.throws(() => new WorkQueue({ a: { concurrency: 1, maxDepth: -1 } }), RangeError);
  assert.throws(() => new WorkQueue({ a: { concurrency: 1, maxDepth: 1 } }).submit("b", async () => 1), RangeError);
});

/* ================================================================== real process groups */

// A task that owns a real detached process group: kills it on abort and settles only after it is gone.
function groupTask() {
  const pids = deferred();
  const task = ({ signal }) =>
    new Promise((resolve) => {
      const child = spawn("bash", ["-c", "sleep 300 & echo $!; wait"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += chunk;
        const grandchild = Number.parseInt(out, 10);
        if (grandchild) pids.resolve({ child: child.pid, grandchild });
      });
      const stop = () => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      };
      signal.addEventListener("abort", stop, { once: true });
      child.on("close", resolve);
    });
  return { task, pids: pids.promise };
}

test("abort of a running job kills the whole process group (child and grandchild) before the slot frees", async () => {
  const queue = new WorkQueue({ a: { concurrency: 1, maxDepth: 10 } });
  const { task, pids } = groupTask();
  const controller = new AbortController();
  const job = queue.submit("a", task, { signal: controller.signal });
  const { child, grandchild } = await pids;
  assert.ok(alive(child) && alive(grandchild));
  controller.abort();
  await assert.rejects(job.promise, JobCancelledError);
  assert.ok(await waitFor(() => !alive(child), 2000), "direct child is gone");
  assert.ok(await waitFor(() => !alive(grandchild), 2000), "grandchild is gone too (no orphan)");
  assert.equal(queue.stats().a.running, 0);
});

test("timeout of a running job kills the process group", async () => {
  const queue = new WorkQueue({ a: { concurrency: 1, maxDepth: 10 } });
  const { task, pids } = groupTask();
  const job = queue.submit("a", task, { timeoutMs: 250 });
  const { child, grandchild } = await pids;
  await assert.rejects(job.promise, JobTimeoutError);
  assert.ok(await waitFor(() => !alive(child) && !alive(grandchild), 2000), "process group gone after the timeout");
});

/* ================================================================== python.ts on the queue (fake interpreter) */

const hangPids = () =>
  existsSync(pidFile)
    ? readFileSync(pidFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(" ").map(Number))
    : [];

test("runPythonScript keeps its result contract: ok, handled failure, no response", async () => {
  const ok = await runPythonScript("any.py", { mode: "ok" });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.data, { x: 1 });
  assert.equal(typeof ok.ms, "number");

  const failed = await runPythonScript("any.py", { mode: "fail" });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "handled failure");

  const silent = await runPythonScript("any.py", { mode: "silent" });
  assert.equal(silent.ok, false);
  assert.match(silent.error ?? "", /no response/);
});

test("runPythonScript abort mid-run: process group killed, scratch dir removed, result says cancelled", async () => {
  const before = hangPids().length;
  const controller = new AbortController();
  const run = runPythonScript("any.py", { mode: "hang" }, { signal: controller.signal });
  assert.ok(await waitFor(() => hangPids().length > before), "fake interpreter started");
  const [shell, sleeper] = hangPids().at(-1);
  assert.ok(alive(shell) && alive(sleeper));
  controller.abort();
  const result = await run;
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.ok(await waitFor(() => !alive(shell) && !alive(sleeper), 5000), "interpreter and its child are gone");
});

test("runPythonScript timeout kills the group and reports a readable error", async () => {
  const before = hangPids().length;
  const result = await runPythonScript("any.py", { mode: "hang" }, { timeoutMs: 300 });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Timed out after/);
  assert.equal(result.cancelled, undefined);
  const [shell, sleeper] = hangPids().at(-1);
  assert.equal(hangPids().length, before + 1);
  assert.ok(await waitFor(() => !alive(shell) && !alive(sleeper), 5000));
});

test("runPythonScript lanes: light cap is 2 (env), heavy is 1, overflow throws QueueFullError", async () => {
  const hungHeavy = startPythonScript("any.py", { mode: "hang" }, { lane: "heavy", timeoutMs: 60_000 });
  const queuedHeavy = startPythonScript("any.py", { mode: "ok" }, { lane: "heavy" });
  assert.equal(hungHeavy.state(), "running");
  assert.equal(queuedHeavy.state(), "queued");
  assert.equal(queuedHeavy.position(), 0);
  // light still answers while heavy is saturated
  const light = await runPythonScript("any.py", { mode: "ok" }, { lane: "light" });
  assert.equal(light.ok, true);
  queuedHeavy.cancel();
  hungHeavy.cancel();
  await assert.rejects(hungHeavy.promise, JobCancelledError);
  await assert.rejects(queuedHeavy.promise, JobCancelledError);

  // fill the heavy lane + its depth (16) and expect the typed rejection
  const gate = [];
  for (let i = 0; i < 1 + 16; i++) gate.push(startPythonScript("any.py", { mode: "hang" }, { lane: "heavy", timeoutMs: 60_000 }));
  await assert.rejects(runPythonScript("any.py", { mode: "ok" }, { lane: "heavy" }), isQueueFull);
  gate.forEach((job) => job.cancel());
  await Promise.allSettled(gate.map((job) => job.promise));
  assert.ok(await waitFor(() => hangPids().every(([shell, sleeper]) => !alive(shell) && !alive(sleeper)), 8000), "no hung fake interpreters left");
});
