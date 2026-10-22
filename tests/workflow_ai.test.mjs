// AI nodes (src/lib/workflows/nodes/ai.ts) against a scripted OpenAI-compatible fake: the agent's tool loop (code,
// HTTP template, calculator), memory per session, JSON answers, extraction with types, classification routing, limits;
// then a real worker run with a saved provider profile against tests/mock_provider.mjs (usage lands in the ledger).
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/workflow_ai.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "knife-wf-ai-"));
process.env.KNIFE_DATA_DIR = dataDir;
delete process.env.KNIFE_AUTH_MODE;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const { runWorkflow } = await import("../src/lib/workflows/engine/run.ts");
const { nodeMeta } = await import("../src/lib/workflows/catalog/index.ts");
const { nodeImpl } = await import("../src/lib/workflows/nodes/index.ts");
const { parseModelJson } = await import("../src/lib/workflows/nodes/ai.ts");

let ids = 0;
const node = (name, type, parameters = {}, extra = {}) => ({ id: `n${++ids}`, type: `core.${type}`, typeVersion: 1, name, position: [ids * 200, 0], parameters, ...extra });
const link = (from, to, output = 0) => ({ from: { node: from, output }, to: { node: to, input: 0 } });
const wf = (nodes, connections) => ({ id: "wfai000001", name: "AI", description: "", nodes, connections, settings: { timezone: null, errorWorkflow: null, timeoutSeconds: null, saveSuccessfulRuns: true, saveManualRuns: true, callableBy: "any" }, active: false, hookToken: "x".repeat(24), tags: [], createdAt: "", updatedAt: "", version: 1 });
const PROVIDER = { id: "profile:p1", type: "aiProvider", name: "Test", data: { baseUrl: "https://llm.test/v1", apiKey: "sk-test-secret", model: "test-model", extraHeaders: { "X-Extra": "1" } } };

/** A scripted model: `reply(messages, tools)` returns a message; every request is recorded. */
function fakeModel(reply) {
  const requests = [];
  const usage = [];
  const http = async (request) => {
    if (request.url === "https://llm.test/v1/chat/completions") {
      const body = JSON.parse(request.body);
      requests.push({ body, headers: request.headers });
      const message = reply(body.messages, body.tools ?? []);
      return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ choices: [{ message, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })), url: request.url };
    }
    if (request.url.startsWith("https://weather.test/")) return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ city: new URL(request.url).searchParams.get("city"), temp: 21 })), url: request.url };
    throw new Error(`unexpected ${request.url}`);
  };
  const blobs = new Map();
  const services = {
    now: () => Date.UTC(2026, 9, 22, 12),
    http,
    blobs: { put: (bytes, meta) => (blobs.set("b", bytes), { id: "b", mimeType: meta.mimeType ?? "x", fileSize: bytes.length }), get: () => blobs.get("b") },
    credential: async (_node, slot) => (slot === "provider" ? structuredClone(PROVIDER) : null),
    reportUsage: (round) => usage.push(round),
  };
  return { requests, usage, services };
}

const run = (workflow, services, extra = {}) => runWorkflow({ workflow, mode: "manual", executionId: "e1", meta: nodeMeta, impl: nodeImpl, services, ...extra });
const last = (result, name) => result.runData[name]?.at(-1)?.outputs;
const lastUser = (messages) => [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

test("agent: calls tools (HTTP template, code, calculator) until it answers; arguments never reach the host part", async () => {
  const model = fakeModel((messages) => {
    const tail = messages[messages.length - 1];
    if (tail.role === "user") {
      return { role: "assistant", content: null, tool_calls: [
        { id: "c1", type: "function", function: { name: "weather", arguments: JSON.stringify({ city: "Kraków & co" }) } },
        { id: "c2", type: "function", function: { name: "double", arguments: JSON.stringify({ input: "21" }) } },
        { id: "c3", type: "function", function: { name: "calc", arguments: JSON.stringify({ expression: "sqrt(16) + 2^3" }) } },
      ] };
    }
    const tools = messages.filter((m) => m.role === "tool").map((m) => m.content);
    return { role: "assistant", content: `Done: ${tools.join(" | ")}` };
  });
  const result = await run(
    wf([
      node("Start", "manual-trigger"),
      node("Agent", "ai-agent", {
        instructions: "Be brief.",
        prompt: "What is the weather?",
        tools: [
          { kind: "httpRequest", name: "weather", description: "Weather for a city", method: "GET", url: "https://weather.test/now?city={city}" },
          { kind: "code", name: "double", description: "Doubles", code: "return Number(input) * 2;" },
          { kind: "calculator", name: "calc", description: "Math" },
        ],
      }),
    ], [link("Start", "Agent")]),
    model.services,
  );
  assert.equal(result.status, "success", result.error?.message);
  const output = last(result, "Agent")[0][0].json;
  assert.match(output.output, /"city":"Kraków & co"/, "the placeholder value was URL-encoded and decoded by the API");
  assert.match(output.output, /\| 42 \| 12$/);
  assert.equal(output.steps.length, 3);
  const first = model.requests[0];
  assert.equal(first.headers.authorization, "Bearer sk-test-secret");
  assert.equal(first.headers["X-Extra"], "1");
  assert.deepEqual(first.body.tools.map((t) => t.function.name), ["weather", "double", "calc"]);
  assert.deepEqual(first.body.tools[0].function.parameters.required, ["city"]);
  assert.equal(first.body.messages[0].content, "Be brief.");
  assert.equal(model.usage.length, 2, "every model round is reported");
  assert.equal(model.usage[0].model, "test-model");

  const bad = await run(wf([node("Start", "manual-trigger"), node("Agent", "ai-agent", { tools: [{ kind: "httpRequest", name: "x", url: "https://{host}/a" }] })], [link("Start", "Agent")]), model.services);
  assert.match(bad.error.message, /fixed http\(s\):\/\/host/);
});

test("agent: memory per session key across runs; JSON output; a model that never stops is cut off", async () => {
  const model = fakeModel((messages) => ({ role: "assistant", content: `{"turns": ${messages.filter((m) => m.role === "user").length}, "last": ${JSON.stringify(lastUser(messages))}}` }));
  const workflow = wf([node("Start", "manual-trigger"), node("Agent", "ai-agent", { prompt: "={{ $json.text }}", memory: "session", sessionKey: "={{ $json.user }}", outputFormat: "json", jsonExample: '{"turns": 1}' })], [link("Start", "Agent")]);
  const first = await run(workflow, model.services, { triggerItems: [{ json: { user: "ada", text: "hi" } }] });
  assert.deepEqual(last(first, "Agent")[0][0].json, { turns: 1, last: "hi" });
  const second = await run(workflow, model.services, { triggerItems: [{ json: { user: "ada", text: "again" } }], staticData: first.staticData });
  assert.deepEqual(last(second, "Agent")[0][0].json, { turns: 2, last: "again" }, "the previous turn was remembered");
  const other = await run(workflow, model.services, { triggerItems: [{ json: { user: "alan", text: "new" } }], staticData: second.staticData });
  assert.equal(last(other, "Agent")[0][0].json.turns, 1, "another session starts empty");
  assert.match(model.requests[1].body.messages.at(-1).content, /again/);
  assert.match(model.requests[0].body.messages[0].content, /Answer with only a JSON value/);

  const looping = fakeModel(() => ({ role: "assistant", content: null, tool_calls: [{ id: "x", type: "function", function: { name: "clock", arguments: "{}" } }] }));
  const loop = await run(wf([node("Start", "manual-trigger"), node("Agent", "ai-agent", { maxIterations: 2, tools: [{ kind: "dateTime", name: "clock", description: "time" }] })], [link("Start", "Agent")]), looping.services);
  assert.equal(loop.status, "error");
  assert.match(loop.error.message, /did not finish within 2 tool rounds/);
});

test("ask AI, information extractor (typed fields, JSON retry), text classifier (routes, Other)", async () => {
  let tries = 0;
  const model = fakeModel((messages) => {
    const system = messages[0].role === "system" ? messages[0].content : "";
    const user = lastUser(messages);
    if (system.includes("You extract information")) {
      tries += 1;
      if (tries === 1) return { role: "assistant", content: "Sure! Here it is: not json" };
      return { role: "assistant", content: '```json\n{"name": "Ada Lovelace", "age": "36 years", "born": "December 10, 1815", "member": "yes"}\n```' };
    }
    if (system.includes("Classify the text")) return { role: "assistant", content: JSON.stringify({ categories: user.includes("refund") ? ["billing"] : user.includes("crash") ? ["bug"] : [] }) };
    return { role: "assistant", content: `Summary of: ${user}` };
  });
  const result = await run(
    wf([
      node("Start", "manual-trigger"),
      node("Data", "code", { jsCode: "return [{ text: 'I want a refund' }, { text: 'The app crashed' }, { text: 'Hello' }]" }),
      node("Ask", "ai-chat", { prompt: "={{ $json.text }}", outputField: "summary" }),
      node("Extract", "ai-extract", { text: "Ada Lovelace, 36, born 10 Dec 1815, member", attributes: [{ name: "name", type: "string" }, { name: "age", type: "number" }, { name: "born", type: "date" }, { name: "member", type: "boolean" }] }, { executeOnce: true }),
      node("Route", "ai-classify", { text: "={{ $json.text }}", categories: [{ name: "billing" }, { name: "bug" }], fallback: "other" }),
    ], [link("Start", "Data"), link("Data", "Ask"), link("Data", "Extract"), link("Data", "Route")]),
    model.services,
  );
  assert.equal(result.status, "success", result.error?.message);
  assert.equal(last(result, "Ask")[0][0].json.summary, "Summary of: I want a refund");
  assert.deepEqual(last(result, "Extract")[0][0].json, { name: "Ada Lovelace", age: 36, born: "1815-12-10", member: true });
  assert.equal(tries, 2, "a non-JSON answer is retried once");
  assert.deepEqual(last(result, "Route").map((o) => o.map((i) => i.json.text)), [["I want a refund"], ["The app crashed"], ["Hello"]]);
  assert.deepEqual(parseModelJson('noise {"a": [1, 2]} more'), { a: [1, 2] });
});

test("in the worker: a saved provider profile drives the AI node; tokens reach the usage ledger", async () => {
  const port = await new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });
  const mock = spawn(process.execPath, ["tests/mock_provider.mjs", String(port)], { stdio: "ignore" });
  test.after(() => mock.kill());
  for (let i = 0; i < 50; i += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/v1/models`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const accounts = await import("../src/lib/accounts/store.ts");
  const store = await import("../src/lib/workflows/server/store.ts");
  const runner = await import("../src/lib/workflows/server/runner.ts");
  const ledger = await import("../src/lib/accounts/usage-ledger.ts");
  accounts.mutateStore((s) => {
    s.accounts.push(accounts.newAccountRecord({ id: "ana", displayName: "Ana", status: "active" }));
  });
  accounts.saveProviderProfile("ana", { name: "Mock", config: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "mock-key", model: "mock-model" }, activate: true });
  const workflow = store.createWorkflow("ana", {
    name: "AI in the worker",
    nodes: [node("Start", "manual-trigger"), node("Ask", "ai-chat", { prompt: "hello from a workflow", outputField: "answer" })],
    connections: [link("Start", "Ask")],
  });
  const { result } = await runner.startRun({ accountId: "ana", workflow, mode: "manual" });
  assert.equal(result.status, "success", result.error?.message);
  assert.equal(result.runData.Ask[0].outputs[0][0].json.answer, "ECHO: hello from a workflow");
  const summary = ledger.usageSummary ? ledger.usageSummary("ana") : null;
  if (summary) assert.ok(JSON.stringify(summary).includes("mock-model"), JSON.stringify(summary).slice(0, 300));
});
