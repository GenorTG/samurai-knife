import assert from "node:assert/strict";
import { test } from "node:test";

// Node strips the TypeScript types natively; tests/ts-resolve.mjs resolves the extensionless relative imports.
const { WorkerPool, defaultPoolSize } = await import("../src/lib/workers/pool.ts");
const { serveTasks, withTransfer } = await import("../src/lib/workers/runtime.ts");
const errors = await import("../src/lib/workers/errors.ts");

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** In-process stand-in for a Worker: runs serveTasks() in the same thread, replies asynchronously. */
function makeFactory(handlers, { startDelay = 0 } = {}) {
  const log = { created: 0, terminated: 0, posted: [], running: 0, maxRunning: 0, workers: [] };
  const create = () => {
    log.created += 1;
    const w = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      dead: false,
      postMessage(message, transfer) {
        log.posted.push({ message, transfer });
        // a real worker queues requests until its script has loaded
        if (startDelay) setTimeout(() => this.scope.onmessage({ data: message }), startDelay);
        else this.scope.onmessage({ data: message });
      },
      terminate() {
        this.dead = true;
        log.terminated += 1;
      },
    };
    w.scope = {
      onmessage: null,
      postMessage: (message) => setTimeout(() => { if (!w.dead) w.onmessage?.({ data: message }); }, 0),
    };
    const wrapped = Object.fromEntries(
      Object.entries(handlers).map(([name, fn]) => [
        name,
        async (payload, ctx) => {
          log.running += 1;
          log.maxRunning = Math.max(log.maxRunning, log.running);
          try {
            return await fn(payload, ctx, w);
          } finally {
            log.running -= 1;
          }
        },
      ]),
    );
    if (startDelay) {
      const post = w.scope.postMessage;
      // the "ready" handshake only arrives once the script has loaded
      w.scope.postMessage = (message) => (message.type === "ready" ? setTimeout(() => post(message), startDelay) : post(message));
    }
    serveTasks(wrapped, w.scope);
    log.workers.push(w);
    return w;
  };
  return { create, log };
}

const handlers = {
  echo: (p) => p,
  add: (p) => p.a + p.b,
  boom: () => { throw new TypeError("kaput"); },
  slow: async (p) => { await tick(p.ms); return p.ms; },
  never: () => new Promise(() => {}),
  steps: async (p, ctx) => { for (let i = 1; i <= p.n; i += 1) { ctx.progress(i); await tick(1); } return "done"; },
  buf: (p) => withTransfer({ size: p.byteLength }, []),
  crash: (_p, _c, w) => { setTimeout(() => w.onerror?.({ message: "oom", preventDefault() {} }), 0); return new Promise(() => {}); },
};

test("creates no worker until the first call (SSR/hydration safe)", async () => {
  const { create, log } = makeFactory(handlers);
  const pool = new WorkerPool({ create, size: 2 });
  assert.equal(log.created, 0);
  assert.equal(await pool.call("add", { a: 2, b: 3 }), 5);
  assert.equal(log.created, 1);
});

test("progress callbacks arrive before the result", async () => {
  const { create } = makeFactory(handlers);
  const pool = new WorkerPool({ create, size: 1 });
  const seen = [];
  const result = await pool.call("steps", { n: 3 }, { onProgress: (v) => seen.push(v) });
  assert.equal(result, "done");
  assert.deepEqual(seen, [1, 2, 3]);
});

test("a throwing task maps to WorkerTaskError and the worker stays usable", async () => {
  const { create, log } = makeFactory(handlers);
  const pool = new WorkerPool({ create, size: 1 });
  await assert.rejects(pool.call("boom", null), (e) => e instanceof errors.WorkerTaskError && e.remoteName === "TypeError" && e.message === "kaput");
  assert.equal(await pool.call("echo", "still alive"), "still alive");
  assert.equal(log.created, 1);
});

test("unknown task is a WorkerTaskError", async () => {
  const { create } = makeFactory(handlers);
  const pool = new WorkerPool({ create, size: 1 });
  await assert.rejects(pool.call("nope", null), (e) => e instanceof errors.WorkerTaskError && /Unknown worker task/.test(e.message));
});

test("concurrency is bounded and the queue is FIFO", async () => {
  const { create, log } = makeFactory(handlers);
  const pool = new WorkerPool({ create, size: 2 });
  const order = [];
  const jobs = [60, 10, 10, 10, 10].map((ms, i) => pool.call("slow", { ms }).then(() => order.push(i)));
  await tick(5);
  assert.deepEqual({ busy: pool.stats().busy, queued: pool.stats().queued }, { busy: 2, queued: 3 });
  await Promise.all(jobs);
  assert.equal(log.maxRunning, 2);
  assert.equal(log.created, 2);
  assert.equal(order[order.length - 1], 0, "the 60 ms job finishes last");
  assert.deepEqual(order.slice(0, 4), [1, 2, 3, 4]);
});

test("aborting a running task rejects AbortError, terminates its worker and respawns lazily", async () => {
  const { create, log } = makeFactory(handlers);
  const pool = new WorkerPool({ create, size: 1 });
  const ac = new AbortController();
  const p = pool.call("never", null, { signal: ac.signal });
  await tick(5);
  ac.abort();
  await assert.rejects(p, (e) => errors.isAbortError(e));
  assert.equal(log.terminated, 1);
  assert.equal(log.created, 1, "no eager respawn");
  assert.equal(await pool.call("add", { a: 1, b: 1 }), 2);
  assert.equal(log.created, 2);
});

test("aborting a queued task drops it without touching the running one", async () => {
  const { create, log } = makeFactory(handlers);
  const pool = new WorkerPool({ create, size: 1 });
  const ac = new AbortController();
  const first = pool.call("slow", { ms: 30 });
  const queued = pool.call("echo", "x", { signal: ac.signal });
  const third = pool.call("echo", "y");
  ac.abort();
  await assert.rejects(queued, (e) => errors.isAbortError(e));
  assert.equal(await first, 30);
  assert.equal(await third, "y");
  assert.equal(log.terminated, 0);
});

test("an already-aborted signal rejects without spawning", async () => {
  const { create, log } = makeFactory(handlers);
  const pool = new WorkerPool({ create, size: 1 });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(pool.call("echo", 1, { signal: ac.signal }), (e) => errors.isAbortError(e));
  assert.equal(log.created, 0);
});

test("timeoutMs rejects WorkerTimeoutError, terminates, and the next call works", async () => {
  const { create, log } = makeFactory(handlers);
  const pool = new WorkerPool({ create, size: 1 });
  await assert.rejects(pool.call("never", null, { timeoutMs: 25 }), (e) => e instanceof errors.WorkerTimeoutError && e.timeoutMs === 25);
  assert.equal(log.terminated, 1);
  assert.equal(await pool.call("echo", "ok"), "ok");
});

test("the timeout clock starts when the task runs, not while queued", async () => {
  const { create } = makeFactory(handlers);
  const pool = new WorkerPool({ create, size: 1 });
  const a = pool.call("slow", { ms: 60 });
  const b = pool.call("slow", { ms: 10 }, { timeoutMs: 40 });
  assert.equal(await a, 60);
  assert.equal(await b, 10);
});

test("the timeout clock does not run while the worker script is still starting", async () => {
  const { create } = makeFactory(handlers, { startDelay: 120 });
  const pool = new WorkerPool({ create, size: 1 });
  // 20 ms of work under a 60 ms budget, but the worker needs 120 ms to boot: must not time out
  assert.equal(await pool.call("slow", { ms: 20 }, { timeoutMs: 60 }), 20);
  // a second call on the now-ready worker is timed normally
  await assert.rejects(pool.call("never", null, { timeoutMs: 30 }), (e) => e instanceof errors.WorkerTimeoutError);
});

test("a worker crash rejects WorkerCrashError and the pool recovers", async () => {
  const { create, log } = makeFactory(handlers);
  const pool = new WorkerPool({ create, size: 1 });
  await assert.rejects(pool.call("crash", null), (e) => e instanceof errors.WorkerCrashError && /oom/.test(e.message));
  assert.equal(log.terminated, 1);
  assert.equal(await pool.call("echo", "back"), "back");
  assert.equal(log.created, 2);
});

test("a crash while jobs are queued starts the next job on a fresh worker", async () => {
  const { create } = makeFactory(handlers);
  const pool = new WorkerPool({ create, size: 1 });
  const crashed = pool.call("crash", null);
  const after = pool.call("echo", "next");
  await assert.rejects(crashed, (e) => e instanceof errors.WorkerCrashError);
  assert.equal(await after, "next");
});

test("transfer list is passed to postMessage", async () => {
  const { create, log } = makeFactory(handlers);
  const pool = new WorkerPool({ create, size: 1 });
  const buffer = new ArrayBuffer(16);
  assert.deepEqual(await pool.call("buf", buffer, { transfer: [buffer] }), { size: 16 });
  assert.deepEqual(log.posted[0].transfer, [buffer]);
});

test("a factory that throws a ReferenceError (no Worker global) maps to WorkerUnavailableError", async () => {
  const pool = new WorkerPool({ create: () => new Worker("x"), size: 1 });
  await assert.rejects(pool.call("echo", 1), (e) => e instanceof errors.WorkerUnavailableError);
});

test("terminateAll rejects pending work and respawns lazily", async () => {
  const { create, log } = makeFactory(handlers);
  const pool = new WorkerPool({ create, size: 1 });
  const running = pool.call("never", null);
  const queued = pool.call("echo", 1);
  await tick(5);
  pool.terminateAll();
  await assert.rejects(running, (e) => errors.isAbortError(e));
  await assert.rejects(queued, (e) => errors.isAbortError(e));
  assert.equal(await pool.call("echo", 2), 2);
  assert.equal(log.created, 2);
});

test("defaultPoolSize is max(1, cores-1) capped at 3", () => {
  const size = defaultPoolSize();
  assert.ok(size >= 1 && size <= 3, `size ${size}`);
  assert.equal(defaultPoolSize(1), 1);
});
