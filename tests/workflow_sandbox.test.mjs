// The workflow JS sandbox (src/lib/workflows/sandbox/quickjs.ts): QuickJS-WASM with no host access, limits that stop
// busy loops / memory / recursion, async code, JSON in and out, capped console.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/workflow_sandbox.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

const { openSandbox, SandboxError } = await import("../src/lib/workflows/sandbox/quickjs.ts");

async function run(source, limits) {
  const box = await openSandbox(limits);
  try {
    return box.run(source);
  } finally {
    box.dispose();
  }
}
const fails = async (source, kind, limits) => {
  await assert.rejects(run(source, limits), (error) => error instanceof SandboxError && error.kind === kind, `${kind}: ${source}`);
};

test("plain data in and out, async code settles", async () => {
  const box = await openSandbox();
  box.setJson("$input", [{ json: { a: 1 } }, { json: { a: 2 } }]);
  assert.deepEqual(box.run("$input.map((i) => ({ json: { b: i.json.a * 2 } }))"), [{ json: { b: 2 } }, { json: { b: 4 } }]);
  assert.equal(box.run("(async () => { const x = await Promise.resolve(41); return x + 1; })()"), 42);
  assert.equal(box.run("undefined"), undefined);
  assert.deepEqual(box.run("({ d: new Date(0) })"), { d: "1970-01-01T00:00:00.000Z" });
  box.dispose();
});

test("no host objects: require, process, fetch, timers, WebAssembly, Function escape", async () => {
  assert.equal(await run("[typeof require, typeof process, typeof fetch, typeof setTimeout, typeof WebAssembly, typeof module, typeof globalThis.std, typeof globalThis.os].join()"),
    "undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined");
  assert.equal(await run("(function(){ return this })().constructor.constructor('return typeof process')()"), "undefined");
  assert.equal(await run("Object.getOwnPropertyNames(globalThis).filter((n) => /^(require|process|Buffer|fetch|import)/.test(n)).length"), 0);
  await fails("import('fs')", "code");
});

test("limits: busy loop, memory, recursion, pending promise, huge output; the next session still works", async () => {
  await fails("while (true) {}", "timeout", { timeoutMs: 300 });
  await fails("const a = []; while (true) a.push(new Array(100000).fill(1))", "memory", { memoryBytes: 16 * 1024 * 1024, timeoutMs: 20_000 });
  await fails("function f() { return f() + 1 } f()", "stack");
  await fails("new Promise(() => {})", "code");
  await fails("'x'.repeat(2000000)", "output", { maxOutputBytes: 1_000_000 });
  assert.equal(await run("1 + 1"), 2);
});

test("errors carry the user's message and line; console is captured and capped", async () => {
  await assert.rejects(run("const x = 1;\nthrow new TypeError('bad ' + x)"), (e) => e.kind === "code" && e.message === "TypeError: bad 1" && e.line === 2);
  const box = await openSandbox({ maxLogLines: 3 });
  box.run("console.log('a', { b: 1 }); console.warn(2); console.log(3); console.log(4)");
  assert.deepEqual(box.logs, ["a {\"b\":1}", "2", "… (more log lines dropped)"]);
  box.dispose();
});
