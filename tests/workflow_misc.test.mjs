// Workflow helpers: webhook paths, schedule rules (zones, cron, intervals), the n8n importer, editor renames.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/workflow_misc.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

const { matchHookPath, normalizeHookPath, structuralProblems, activationProblems } = await import("../src/lib/workflows/validate.ts");
const { ruleDue, ruleSchedule, zonedDate } = await import("../src/lib/workflows/server/scheduler.ts");
const { fromN8n } = await import("../src/lib/workflows/import.ts");
const { renameNode, uniqueName, addConnection } = await import("../src/lib/workflows/editor-model.ts");

test("webhook paths: normalised, :params captured, lengths must match", () => {
  assert.equal(normalizeHookPath("/orders//new/"), "orders/new");
  assert.deepEqual(matchHookPath("orders/:id", "orders/42"), { id: "42" });
  assert.deepEqual(matchHookPath("orders/:id", "orders/a%20b"), { id: "a b" });
  assert.equal(matchHookPath("orders/:id", "orders/42/x"), null);
  assert.equal(matchHookPath("orders", "other"), null);
  assert.deepEqual(matchHookPath("", ""), {});
  assert.equal(matchHookPath("a/:x", "a/%E0%A4%A"), null, "a broken escape is no match, not a crash");
});

test("schedule rules: intervals, cron in the workflow's zone, no fire right after activation", () => {
  const zone = "Europe/Warsaw";
  const at = (iso) => Date.parse(iso);
  assert.equal(zonedDate(at("2026-10-22T07:00:00Z"), zone).getHours(), 9, "UTC+2 in October");
  assert.equal(zonedDate(at("2026-12-22T08:00:00Z"), zone).getHours(), 9, "UTC+1 in December");
  assert.deepEqual(ruleSchedule({ every: "seconds", amount: 5 }), { intervalMs: 30_000 }, "30 s minimum");
  assert.equal(ruleDue({ every: "minutes", amount: 15 }, undefined, Date.now(), zone), false);
  assert.equal(ruleDue({ every: "minutes", amount: 15 }, at("2026-10-22T07:00:00Z"), at("2026-10-22T07:14:00Z"), zone), false);
  assert.equal(ruleDue({ every: "minutes", amount: 15 }, at("2026-10-22T07:00:00Z"), at("2026-10-22T07:15:00Z"), zone), true);
  const daily = { every: "days", amount: 1, atHour: 9, atMinute: 0 };
  assert.equal(ruleDue(daily, at("2026-10-22T06:59:30Z"), at("2026-10-22T07:00:10Z"), zone), true, "09:00 Warsaw");
  assert.equal(ruleDue(daily, at("2026-10-22T07:00:10Z"), at("2026-10-22T07:00:25Z"), zone), false, "once per minute");
  assert.equal(ruleDue({ every: "cron", cron: "30 8 * * 1-5" }, at("2026-10-24T06:29:50Z"), at("2026-10-24T06:30:05Z"), zone), false, "Saturday");
  assert.equal(ruleDue({ every: "cron", cron: "30 8 * * 1-5" }, at("2026-10-23T06:29:50Z"), at("2026-10-23T06:30:05Z"), zone), true, "Friday 08:30");
  assert.equal(ruleSchedule({ every: "cron", cron: "nope" }), null);
});

test("validation: duplicate names, dangling connections, inputs into triggers, activation needs an automatic trigger", () => {
  const n = (name, type) => ({ id: name, type, name, position: [0, 0], parameters: {}, typeVersion: 1 });
  const problems = structuralProblems({
    nodes: [n("A", "core.manual-trigger"), n("B", "core.no-op"), { ...n("B", "core.no-op"), id: "B2" }],
    connections: [{ from: { node: "B", output: 0 }, to: { node: "A", input: 0 } }, { from: { node: "A", output: 0 }, to: { node: "Z", input: 0 } }],
  });
  const text = problems.map((p) => p.message).join(" | ");
  assert.match(text, /2 nodes are named "B"/);
  assert.match(text, /missing node \(Z\)/);
  assert.match(text, /"A" is a trigger/);
  assert.match(activationProblems({ nodes: [n("A", "core.manual-trigger")], connections: [] })[0].message, /Schedule Trigger or a Webhook/);
});

test("n8n import: types and parameters translated, connections kept, unknown nodes become notes", () => {
  const exported = {
    name: "From n8n",
    nodes: [
      { id: "1", name: "When clicking", type: "n8n-nodes-base.manualTrigger", position: [0, 0], parameters: {} },
      { id: "2", name: "Get", type: "n8n-nodes-base.httpRequest", position: [200, 0], parameters: { method: "POST", url: "https://api.example.com", sendHeaders: true, headerParameters: { parameters: [{ name: "X-A", value: "1" }] }, sendBody: true, contentType: "json", specifyBody: "json", jsonBody: "{\"a\":1}" } },
      { id: "3", name: "Check", type: "n8n-nodes-base.if", position: [400, 0], parameters: { conditions: { combinator: "and", conditions: [{ leftValue: "={{ $json.a }}", rightValue: 1, operator: { type: "number", operation: "equals" } }] } } },
      { id: "4", name: "Tell Slack", type: "n8n-nodes-base.slack", position: [600, 0], parameters: { text: "hi" } },
    ],
    connections: { "When clicking": { main: [[{ node: "Get", type: "main", index: 0 }]] }, Get: { main: [[{ node: "Check", type: "main", index: 0 }]] }, Check: { main: [[{ node: "Tell Slack", type: "main", index: 0 }], []] } },
  };
  const result = fromN8n(exported);
  assert.deepEqual(result.nodes.map((node) => node.type), ["core.manual-trigger", "core.http-request", "core.if", "core.no-op"]);
  assert.deepEqual(result.nodes[1].parameters.headers, [{ name: "X-A", value: "1" }]);
  assert.equal(result.nodes[1].parameters.bodyMode, "json");
  assert.equal(result.nodes[2].parameters.conditions.conditions[0].operator, "number:equals");
  assert.equal(result.connections.length, 3);
  assert.deepEqual(result.skipped, ["Tell Slack (slack)"]);
  assert.match(result.nodes[3].notes, /n8n-nodes-base\.slack/);
  assert.equal(structuralProblems(result).length, 0);
  assert.equal(fromN8n({ hello: 1 }), null);
});

test("editor model: unique names, renames rewrite expression references, no connection into a trigger", () => {
  assert.equal(uniqueName("Code", ["Code", "Code1"]), "Code2");
  const nodes = [
    { id: "a", type: "core.code", name: "Data", position: [0, 0], parameters: {}, typeVersion: 1 },
    { id: "b", type: "core.set", name: "Use", position: [0, 0], parameters: { assignments: [{ name: "x", value: "={{ $('Data').item.json.x + $node[\"Data\"].json.y }}" }] }, typeVersion: 1 },
  ];
  const renamed = renameNode(nodes, [{ from: { node: "Data", output: 0 }, to: { node: "Use", input: 0 } }], "Data", "Source");
  assert.equal(renamed.nodes[1].parameters.assignments[0].value, "={{ $('Source').item.json.x + $node[\"Source\"].json.y }}");
  assert.equal(renamed.connections[0].from.node, "Source");
  const trigger = { id: "t", type: "core.manual-trigger", name: "Start", position: [0, 0], parameters: {}, typeVersion: 1 };
  assert.equal(addConnection([...nodes, trigger], [], { from: { node: "Use", output: 0 }, to: { node: "Start", input: 0 } }).length, 0);
});
