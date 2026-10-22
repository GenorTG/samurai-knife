// Started by tests/workflow_runner.test.mjs with the workflow worker's own Node flags (workerExecArgv): reports which
// host powers it still has. Every one of them must be denied.
import { readFileSync, writeFileSync } from "node:fs";
const result = {};
const attempt = async (name, fn) => {
  try {
    await fn();
    result[name] = "allowed";
  } catch (error) {
    result[name] = error?.code ?? error?.name ?? String(error);
  }
};
await attempt("writeTmp", () => writeFileSync("/tmp/knife-worker-probe.txt", "x"));
await attempt("readOutside", () => readFileSync("/etc/hostname"));
await attempt("childProcess", async () => (await import("node:child_process")).execSync("id"));
await attempt("workerThread", async () => {
  const { Worker } = await import("node:worker_threads");
  new Worker("process.exit(0)", { eval: true });
});
await attempt("eval", () => new Function("return 1")());
await attempt("readInside", () => readFileSync(new URL("../package.json", import.meta.url)));
process.stdout.write(JSON.stringify(result));
