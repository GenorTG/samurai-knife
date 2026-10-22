// Workflow runs through the real worker process (src/lib/workflows/server/runner.ts -> worker/main.ts under Node's
// permission model): result, persisted run, static data, sub-workflows, waiting + resume, timeouts, no host access.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/workflow_runner.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "knife-wf-"));
process.env.KNIFE_DATA_DIR = dataDir;
delete process.env.KNIFE_AUTH_MODE;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const accounts = await import("../src/lib/accounts/store.ts");
const store = await import("../src/lib/workflows/server/store.ts");
const runner = await import("../src/lib/workflows/server/runner.ts");
const index = await import("../src/lib/workflows/server/trigger-index.ts");

accounts.mutateStore((s) => {
  s.accounts.push(accounts.newAccountRecord({ id: "ana", displayName: "Ana", status: "active" }));
});

let ids = 0;
const node = (name, type, parameters = {}, extra = {}) => ({ id: `n${++ids}`, type: `core.${type}`, name, position: [ids * 200, 0], parameters, ...extra });
const link = (from, to, output = 0, input = 0) => ({ from: { node: from, output }, to: { node: to, input } });

test("a run in the worker process: result, stored run (trimmed), static data, no host access from code", async () => {
  const wf = store.createWorkflow("ana", {
    name: "Basics",
    nodes: [
      node("Start", "manual-trigger"),
      node("Probe", "code", { jsCode: "return [{ host: [typeof process, typeof require, typeof fetch].join(), many: Array.from({ length: 80 }, (_, i) => i) }]" }),
      node("Spread", "split-out", { fieldToSplitOut: "many", destinationFieldName: "n" }),
      node("Seen", "remove-duplicates", { operation: "acrossRuns", dedupeValue: "={{ $json.n }}" }),
    ],
    connections: [link("Start", "Probe"), link("Probe", "Spread"), link("Spread", "Seen")],
  });
  const events = [];
  const first = await runner.startRun({ accountId: "ana", workflow: wf, mode: "manual", progress: true, onRunId: (id) => runner.liveRun("ana", id).emitter.on("event", (e) => events.push(e.type)) });
  assert.equal(first.result.status, "success", first.result.error?.message);
  assert.equal(first.result.runData.Probe[0].outputs[0][0].json.host, "undefined,undefined,undefined");
  assert.equal(first.result.runData.Seen[0].outputs[0].length, 80);
  assert.ok(events.includes("node-end") && events.at(-1) === "done", events.join());
  const stored = store.getRun("ana", wf.id, first.runId);
  assert.equal(stored.status, "success");
  assert.equal(stored.runData.Seen[0].outputs[0].length, 50, "stored runs keep the first 50 items");
  assert.deepEqual(stored.runData.Seen[0].outputCounts, [80]);
  assert.equal(store.listRuns("ana", wf.id)[0].id, first.runId);
  const second = await runner.startRun({ accountId: "ana", workflow: wf, mode: "manual" });
  assert.equal(second.result.runData.Seen[0].outputs[0].length, 0, "static data persisted between runs");
  // Sealed at rest: no plaintext of the run in the data dir.
  const raw = readFileSync(join(dataDir, "workflows", "ana", "runs", wf.id, `${first.runId}.json`));
  assert.ok(!raw.includes("undefined,undefined"), "run file is sealed");
});

test("sub-workflow call, error workflow, credentials reach only their node", async () => {
  const credential = store.saveCredential("ana", { name: "Key", type: "httpHeaderAuth", data: { name: "X-Key", value: "s3cr3t-value" } });
  assert.deepEqual(credential.fields, { name: "X-Key", value: true });
  const child = store.createWorkflow("ana", {
    name: "Child",
    nodes: [node("In", "execute-workflow-trigger"), node("Double", "set", { assignments: [{ name: "twice", type: "number", value: "={{ $json.v * 2 }}" }] })],
    connections: [link("In", "Double")],
  });
  const onError = store.createWorkflow("ana", { name: "On error", nodes: [node("Err", "error-trigger"), node("Note", "no-op")], connections: [link("Err", "Note")] });
  const parent = store.createWorkflow("ana", {
    name: "Parent",
    nodes: [
      node("Start", "manual-trigger"),
      node("Data", "code", { jsCode: "return [{ v: 2 }, { v: 5 }]" }),
      node("Call", "execute-workflow", { workflowId: child.id }),
      node("Leak", "code", { jsCode: "return [{ seen: JSON.stringify($input.all()).includes('s3cr3t') }]" }),
      node("Fail", "stop-and-error", { errorMessage: "planned failure" }),
    ],
    connections: [link("Start", "Data"), link("Data", "Call"), link("Call", "Leak"), link("Leak", "Fail")],
  });
  const withSettings = store.saveWorkflow("ana", parent.id, parent.version, { settings: { ...parent.settings, errorWorkflow: onError.id } });
  const outcome = await runner.startRun({ accountId: "ana", workflow: withSettings, mode: "manual" });
  assert.equal(outcome.result.status, "error");
  assert.equal(outcome.result.error.message, "planned failure");
  assert.deepEqual(outcome.result.runData.Call[0].outputs[0].map((i) => i.json.twice), [4, 10]);
  assert.equal(outcome.result.runData.Leak[0].outputs[0][0].json.seen, false);
  for (let i = 0; i < 50 && !store.listRuns("ana", onError.id).length; i += 1) await new Promise((r) => setTimeout(r, 100));
  const errorRun = store.getRun("ana", onError.id, store.listRuns("ana", onError.id)[0].id);
  assert.equal(errorRun.runData.Note[0].outputs[0][0].json.execution.error.message, "planned failure");
  assert.equal(store.listRuns("ana", child.id)[0].mode, "subworkflow");
});

test("waiting runs are indexed and resume; a busy loop past the time limit is killed", async () => {
  const wf = store.createWorkflow("ana", {
    name: "Waits",
    nodes: [node("Start", "manual-trigger"), node("Wait", "wait", { resume: "webhook" }), node("After", "set", { assignments: [{ name: "ok", type: "boolean", value: "true" }] })],
    connections: [link("Start", "Wait"), link("Wait", "After")],
  });
  const first = await runner.startRun({ accountId: "ana", workflow: wf, mode: "manual" });
  assert.equal(first.result.status, "waiting");
  const record = store.getRun("ana", wf.id, first.runId);
  assert.ok(record.resumeHash);
  assert.equal(index.findWaitByResumeHash(record.resumeHash).runId, first.runId);
  const resumed = await runner.startRun({ accountId: "ana", workflow: wf, mode: "resume", resume: { record, items: [{ json: { approved: true } }] } });
  assert.equal(resumed.result.status, "success", resumed.result.error?.message);
  assert.deepEqual(resumed.result.runData.After[0].outputs[0][0].json, { approved: true, ok: true });
  assert.equal(index.findWaitByResumeHash(record.resumeHash), null);
  assert.equal(store.getRun("ana", wf.id, first.runId).status, "success");

  const slow = store.createWorkflow("ana", { name: "Slow", nodes: [node("Start", "manual-trigger"), node("Spin", "code", { jsCode: "while (true) {}", timeoutSeconds: 60 })], connections: [link("Start", "Spin")] });
  const timed = store.saveWorkflow("ana", slow.id, slow.version, { settings: { ...slow.settings, timeoutSeconds: 2 } });
  const started = Date.now();
  const killed = await runner.startRun({ accountId: "ana", workflow: timed, mode: "manual" });
  assert.equal(killed.result.status, "error");
  assert.match(killed.result.error.message, /longer than 2 s/);
  assert.ok(Date.now() - started < 8000);
});

test("the worker's Node flags deny writes, reads outside the app, child processes, workers and eval", async () => {
  const { spawnSync } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const root = process.cwd();
  const flags = runner.workerExecArgv([root], pathToFileURL(join(root, "src/lib/workflows/worker/hooks.mjs")).href);
  const probe = spawnSync(process.execPath, [...flags, join(root, "tests/workflow_worker_probe.mjs")], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  const report = JSON.parse(probe.stdout || "{}");
  assert.equal(report.writeTmp, "ERR_ACCESS_DENIED", probe.stderr);
  assert.equal(report.readOutside, "ERR_ACCESS_DENIED");
  assert.equal(report.childProcess, "ERR_ACCESS_DENIED");
  assert.equal(report.workerThread, "ERR_ACCESS_DENIED");
  assert.equal(report.eval, "EvalError");
  assert.equal(report.readInside, "allowed", "the app's own files stay readable");
});

test("webhooks: token + path routing, node auth, pages downgraded for non-admins in public mode, no cookies either way", async () => {
  const hooks = await import("../src/lib/workflows/server/hooks.ts");
  const cred = store.saveCredential("ana", { name: "Hook key", type: "httpHeaderAuth", data: { name: "X-Hook-Key", value: "letmein" } });
  const draft = store.createWorkflow("ana", {
    name: "Page",
    nodes: [
      node("Hook", "webhook", { httpMethod: "POST", path: "page/:id", responseMode: "responseNode", authentication: "header" }, { credentials: { headerAuth: cred.id } }),
      node("Reply", "respond-to-webhook", { respondWith: "text", responseText: "=<h1>{{ $json.params.id }}</h1>", headers: [{ name: "Content-Type", value: "text/html" }, { name: "Set-Cookie", value: "x=1" }] }),
    ],
    connections: [link("Hook", "Reply")],
  });
  const wf = store.saveWorkflow("ana", draft.id, draft.version, { active: true });
  const call = (path, headers = {}) => hooks.handleHook(new Request(`http://127.0.0.1/api/hooks/${wf.hookToken}/${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" }), wf.hookToken, path, false);
  assert.equal((await call("page/7")).status, 401, "header auth required");
  assert.equal((await call("nope", { "x-hook-key": "letmein" })).status, 404);
  assert.equal((await hooks.handleHook(new Request("http://127.0.0.1/x", { method: "POST", body: "{}" }), "x".repeat(24), "page/7", false)).status, 404, "unknown token");
  const own = await call("page/7", { "x-hook-key": "letmein", cookie: "sk_session=abc" });
  assert.equal(own.status, 200);
  assert.equal(own.headers.get("content-type"), "text/html", "private mode: pages allowed");
  assert.equal(own.headers.get("set-cookie"), null);
  assert.match(own.headers.get("content-security-policy"), /^sandbox/);
  assert.equal(await own.text(), "<h1>7</h1>");
  process.env.KNIFE_AUTH_MODE = "public";
  try {
    const pub = await call("page/8", { "x-hook-key": "letmein" });
    assert.equal(pub.headers.get("content-type"), "text/plain; charset=utf-8", "public mode, non-admin: no pages");
    assert.match(pub.headers.get("content-security-policy"), /form-action 'none'/);
  } finally {
    delete process.env.KNIFE_AUTH_MODE;
  }
  const latest = store.listRuns("ana", wf.id)[0];
  const record = store.getRun("ana", wf.id, latest.id);
  assert.ok(!JSON.stringify(record.runData).includes("sk_session"), "the caller's cookie never reaches the run");
});

test("a resume URL resumes once; a disabled account runs nothing; one account cannot fill the queue", async () => {
  const hooks = await import("../src/lib/workflows/server/hooks.ts");
  const wf = store.createWorkflow("ana", {
    name: "Resume once",
    nodes: [node("Start", "manual-trigger"), node("Wait", "wait", { resume: "webhook" }), node("Show", "code", { jsCode: "return [{ resumeUrl: $execution.resumeUrl }]" })],
    connections: [link("Start", "Show"), link("Show", "Wait")],
  });
  const first = await runner.startRun({ accountId: "ana", workflow: wf, mode: "manual" });
  const url = first.result.runData.Show[0].outputs[0][0].json.resumeUrl;
  const token = url.split("/").pop();
  const [a, b] = await Promise.all([hooks.handleResume(new Request(url, { method: "POST" }), token), hooks.handleResume(new Request(url, { method: "POST" }), token)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 404]);
  const runId = first.runId;
  for (let i = 0; i < 100 && store.getRun("ana", wf.id, runId)?.status === "waiting"; i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.equal(store.getRun("ana", wf.id, runId).status, "success", "resumed once, to the end");

  accounts.mutateStore((s) => {
    s.accounts.push({ ...accounts.newAccountRecord({ id: "bob", displayName: "Bob" }), status: "disabled" });
  });
  const bobs = store.createWorkflow("bob", { name: "Bob's", nodes: [node("Start", "manual-trigger")], connections: [] });
  await assert.rejects(runner.startRun({ accountId: "bob", workflow: bobs, mode: "trigger" }), /not active/);

  process.env.KNIFE_WF_PER_ACCOUNT = "1";
  process.env.KNIFE_WF_QUEUE_PER_ACCOUNT = "1";
  try {
    const slow = store.createWorkflow("ana", { name: "Busy", nodes: [node("Start", "manual-trigger"), node("Spin", "code", { jsCode: "let x = 0; for (let i = 0; i < 3e7; i++) x += i; return [{ x }]" })], connections: [link("Start", "Spin")] });
    const running = runner.startRun({ accountId: "ana", workflow: slow, mode: "manual" });
    const queued = runner.startRun({ accountId: "ana", workflow: slow, mode: "manual" });
    await new Promise((r) => setTimeout(r, 50));
    await assert.rejects(runner.startRun({ accountId: "ana", workflow: slow, mode: "manual" }), /Too many of your workflow runs/);
    await Promise.all([running, queued]);
  } finally {
    delete process.env.KNIFE_WF_PER_ACCOUNT;
    delete process.env.KNIFE_WF_QUEUE_PER_ACCOUNT;
  }
});
