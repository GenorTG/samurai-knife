// The knife_workflow_* tools (src/lib/mcp/tools-workflows.ts) as an assistant / MCP client uses them: catalog, create
// from agent-style nodes (no ids, no positions), granular edits (renames rewrite expressions), a real run through the
// worker, run details wrapped as untrusted, credentials without secrets, destructive tools flagged, the UI deep link.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/workflow_tools.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "knife-wf-tools-"));
process.env.KNIFE_DATA_DIR = dataDir;
delete process.env.KNIFE_AUTH_MODE;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const accounts = await import("../src/lib/accounts/store.ts");
const { KNIFE_TOOLS } = await import("../src/lib/mcp/tools.ts");
const { annotationsFor } = await import("../src/lib/mcp/server.ts");
const { showPath } = await import("../src/lib/ui-bridge/path.ts");
const store = await import("../src/lib/workflows/server/store.ts");
const { groupOf } = await import("../src/lib/agent-client/tool-groups.ts");

accounts.mutateStore((s) => {
  s.accounts.push(accounts.newAccountRecord({ id: "ana", displayName: "Ana", status: "active" }));
  s.accounts.push(accounts.newAccountRecord({ id: "bob", displayName: "Bob", status: "active" }));
});
const tool = (name) => {
  const found = KNIFE_TOOLS.find((t) => t.name === name);
  assert.ok(found, name);
  return found;
};
const ana = { accountId: "ana", admin: false };
const call = (name, input, ctx = ana) => tool(name).execute(input, ctx);

test("catalog: list and one node's parameters", async () => {
  const list = await call("knife_workflow_nodes", {});
  assert.ok(list.nodes.some((n) => n.type === "core.http-request" && n.label === "HTTP Request"));
  const http = await call("knife_workflow_nodes", { type: "http-request" });
  assert.ok(http.parameters.some((p) => p.name === "url"));
  assert.deepEqual(http.credentials[0].slot, "auth");
  const search = await call("knife_workflow_nodes", { query: "dedupe" });
  assert.deepEqual(search.nodes.map((n) => n.type), ["core.remove-duplicates"]);
});

test("create, edit, run, read results; renames rewrite expressions; versions guard edits", async () => {
  const created = await call("knife_workflow_create", {
    name: "Agent built",
    nodes: [
      { name: "Start", type: "manual-trigger" },
      { name: "People", type: "code", parameters: { jsCode: "return [{ name: 'Ada', age: 36 }, { name: 'Alan', age: 41 }]", colour: "red" } },
    ],
    connections: [{ from: "Start", to: "People" }],
  });
  assert.match(created.warnings[0], /"colour" is not a parameter of Code/);
  assert.ok(created.notActivatableYet.length, "a manual-only workflow is not activatable");
  const wf = store.requireWorkflow("ana", created.id);
  assert.ok(wf.nodes.every((n) => Number.isFinite(n.position[0])), "positions filled in");
  assert.ok(wf.nodes[1].position[0] > wf.nodes[0].position[0], "the second node sits right of the trigger");

  const edited = await call("knife_workflow_edit", {
    id: created.id,
    version: created.version,
    ops: [
      { op: "add", node: { name: "Older", type: "filter", parameters: { conditions: { combinator: "and", conditions: [{ leftValue: "={{ $json.age }}", operator: "number:gt", rightValue: 40 }] } } }, after: "People" },
      { op: "add", node: { name: "Label", type: "set", parameters: { assignments: [{ name: "from", type: "string", value: "={{ $('People').all().length }} people" }] } }, after: "Older" },
      { op: "set", node: "People", rename: "Everyone" },
    ],
  });
  const after = store.requireWorkflow("ana", created.id);
  assert.equal(after.nodes.find((n) => n.name === "Label").parameters.assignments[0].value, "={{ $('Everyone').all().length }} people");
  await assert.rejects(call("knife_workflow_edit", { id: created.id, version: created.version, ops: [] }), /version/);
  await assert.rejects(call("knife_workflow_edit", { id: created.id, ops: [{ op: "connect", from: "Nope", to: "Label" }] }), /No node named "Nope"/);

  const run = await call("knife_workflow_run", { id: created.id });
  assert.equal(run.status, "success", JSON.stringify(run.error));
  assert.deepEqual(run.nodes.map((n) => [n.name, n.items]), [["Start", [1]], ["Everyone", [2]], ["Older", [1, 0]], ["Label", [1]]]);
  assert.equal(run.output.length, 1);
  assert.match(JSON.stringify(run.output), /UNTRUSTED_CONTENT/, "run data is marked as third-party content");
  assert.match(JSON.stringify(run.output), /2 people/);
  const runs = await call("knife_workflow_runs", { id: created.id });
  const detail = await call("knife_workflow_run_get", { id: created.id, runId: runs.runs[0].id, node: "Older" });
  assert.match(JSON.stringify(detail.detail.outputs[0]), /Alan/);
  assert.equal(edited.version, created.version + 1);

  const read = await call("knife_workflow_get", { id: created.id });
  assert.ok(read.nodes.every((n) => !("id" in n)), "agents see names, not ids");
  assert.deepEqual(read.connections[0], { from: "Start", output: 0, to: "Everyone", input: 0 });

  await assert.rejects(call("knife_workflow_get", { id: created.id }, { accountId: "bob", admin: false }), /Unknown workflow/, "another account sees nothing");
});

test("credentials by id and name only; destructive tools and the run are flagged; the UI link opens the editor", async () => {
  store.saveCredential("ana", { name: "Key", type: "httpBearerAuth", data: { token: "super-secret-token" } });
  const listed = await call("knife_workflow_credentials", {});
  assert.equal(listed.credentials[0].name, "Key");
  assert.ok(!JSON.stringify(listed).includes("super-secret"));
  for (const name of ["knife_workflow_delete", "knife_workflow_remove_nodes"]) assert.equal(annotationsFor(tool(name)).destructiveHint, true, name);
  assert.equal(annotationsFor(tool("knife_workflow_run")).openWorldHint, true, "a run can reach outside the account");
  assert.equal(annotationsFor(tool("knife_workflow_nodes")).readOnlyHint, true);
  assert.equal(groupOf("knife_workflow_run").id, "workflows");
  assert.equal(showPath("workflows", "editor", { workflow: "abc12345" }), "/tools/workflows?tab=editor&workflow=abc12345");
  const { workflows } = await call("knife_workflow_list", {});
  const removed = await call("knife_workflow_remove_nodes", { id: workflows[0].id, nodes: ["Label"] });
  assert.equal(store.requireWorkflow("ana", workflows[0].id).nodes.some((n) => n.name === "Label"), false);
  assert.equal(removed.id, workflows[0].id);
  assert.deepEqual(await call("knife_workflow_delete", { id: workflows[0].id }), { deleted: true, name: "Agent built" });
});
