// The workflow engine (src/lib/workflows/engine/run.ts) with the core nodes, in-process with fake services (no network).
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/workflow_engine.test.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const { runWorkflow } = await import("../src/lib/workflows/engine/run.ts");
const { NODE_CATALOG, nodeMeta } = await import("../src/lib/workflows/catalog/index.ts");
const { NODE_IMPLS, nodeImpl } = await import("../src/lib/workflows/nodes/index.ts");
const { totpCode } = await import("../src/lib/workflows/nodes/transform.ts");

let ids = 0;
function node(name, type, parameters = {}, extra = {}) {
  ids += 1;
  return { id: `n${ids}`, type: `core.${type}`, typeVersion: 1, name, position: [ids * 200, extra.y ?? 0], parameters, ...extra };
}
const link = (from, to, output = 0, input = 0) => ({ from: { node: from, output }, to: { node: to, input } });
function wf(nodes, connections) {
  return { id: "wfabc12345", name: "Test", description: "", nodes, connections, settings: { timezone: null, errorWorkflow: null, timeoutSeconds: null, saveSuccessfulRuns: true, saveManualRuns: true, callableBy: "any" }, active: false, hookToken: "x".repeat(24), tags: [], createdAt: "", updatedAt: "", version: 1 };
}

function services(over = {}) {
  const blobs = new Map();
  let blobId = 0;
  return {
    now: () => over.now ?? Date.UTC(2026, 9, 22, 12, 0, 0),
    blobs: {
      put(bytes, meta) {
        blobId += 1;
        const id = `b${blobId}`;
        blobs.set(id, Buffer.from(bytes));
        return { id, mimeType: meta.mimeType ?? "application/octet-stream", fileName: meta.fileName, fileSize: bytes.byteLength };
      },
      get(ref) {
        const found = blobs.get(typeof ref === "string" ? ref : ref.id);
        if (!found) throw new Error("no blob");
        return found;
      },
    },
    http: over.http ?? (async () => { throw new Error("no network in tests"); }),
    credential: async (n, slot) => over.credentials?.[`${n.name}:${slot}`] ?? null,
    updateCredential: over.updateCredential,
    callWorkflow: over.callWorkflow,
    respond: over.respond,
    ...over.extra,
  };
}

const run = (workflow, extra = {}) => runWorkflow({ workflow, mode: "manual", executionId: "exec1", meta: nodeMeta, impl: nodeImpl, services: extra.services ?? services(), ...extra });
const out = (result, name, output = 0, runIndex = -1) => {
  const runs = result.runData[name];
  assert.ok(runs, `${name} did not run (${result.error?.message ?? ""})`);
  return runs.at(runIndex).outputs[output].map((item) => item.json);
};
const trigger = () => node("Start", "manual-trigger");

test("every catalog node has an implementation and vice versa", () => {
  assert.deepEqual(NODE_CATALOG.map((m) => m.type).sort(), NODE_IMPLS.map((i) => i.type).sort());
});

test("set -> if branches; expressions keep types, templates join text; successors run top first", async () => {
  const order = [];
  const result = await run(
    wf(
      [
        trigger(),
        node("Data", "code", { jsCode: "return [{ n: 1, name: 'a' }, { n: 5, name: 'b' }, { n: 9, name: 'c' }]" }),
        node("Set", "set", { assignments: [{ name: "double", type: "number", value: "={{ $json.n * 2 }}" }, { name: "label", type: "string", value: "=item {{ $json.name }} #{{ $itemIndex }}" }, { name: "meta.when", type: "string", value: "={{ $now.toFormat('yyyy-MM-dd') }}" }] }),
        node("If", "if", { conditions: { combinator: "and", conditions: [{ leftValue: "={{ $json.double }}", operator: "number:gt", rightValue: 4 }] } }),
        node("Big", "no-op", {}, { y: -100 }),
        node("Small", "no-op", {}, { y: 100 }),
      ],
      [link("Start", "Data"), link("Data", "Set"), link("Set", "If"), link("If", "Big", 0), link("If", "Small", 1)],
    ),
    { onNodeStart: (name) => order.push(name) },
  );
  assert.equal(result.status, "success", result.error?.message);
  assert.deepEqual(out(result, "Set")[0], { n: 1, name: "a", double: 2, label: "item a #0", meta: { when: "2026-10-22" } });
  assert.deepEqual(out(result, "Big").map((j) => j.n), [5, 9]);
  assert.deepEqual(out(result, "Small").map((j) => j.n), [1]);
  assert.deepEqual(order, ["Start", "Data", "Set", "If", "Big", "Small"]);
});

test("expressions read other nodes: $('Name').all(), .item, $node[...]", async () => {
  const result = await run(
    wf(
      [
        trigger(),
        node("Users", "code", { jsCode: "return [{ id: 1, name: 'Ada' }, { id: 2, name: 'Alan' }]" }),
        node("Count", "set", { include: "none", assignments: [{ name: "total", type: "number", value: "={{ $('Users').all().length }}" }, { name: "first", type: "string", value: "={{ $node[\"Users\"].json.name }}" }, { name: "same", type: "string", value: "={{ $('Users').item.json.name }}" }] }),
      ],
      [link("Start", "Users"), link("Users", "Count")],
    ),
  );
  assert.deepEqual(out(result, "Count"), [{ total: 2, first: "Ada", same: "Ada" }, { total: 2, first: "Alan", same: "Alan" }]);
});

test("code node: per item, console captured, errors carry the user's line, no host access", async () => {
  const each = await run(wf([trigger(), node("Data", "debug-helper", { count: 3 }), node("Each", "code", { mode: "runOnceForEachItem", jsCodeEach: "console.log('i', $itemIndex);\nif ($json.index === 1) return null;\nreturn { idx: $json.index, host: typeof process }" })], [link("Start", "Data"), link("Data", "Each")]));
  assert.deepEqual(out(each, "Each"), [{ idx: 0, host: "undefined" }, { idx: 2, host: "undefined" }]);
  assert.deepEqual(each.runData.Each[0].logs, ["i 0", "i 1", "i 2"]);
  const broken = await run(wf([trigger(), node("Bad", "code", { jsCode: "const a = 1;\nconst b = 2;\nnull.x;\nreturn []" })], [link("Start", "Bad")]));
  assert.equal(broken.status, "error");
  assert.match(broken.error.message, /\[line 3\]$/);
  assert.equal(broken.error.node, "Bad");
  const loop = await run(wf([trigger(), node("Spin", "code", { jsCode: "while (true) {}", timeoutSeconds: 1 })], [link("Start", "Spin")]));
  assert.match(loop.error.message, /longer than 1 s/);
});

test("merge waits for both inputs; joins by field; runs with one input when the other branch is empty", async () => {
  const both = await run(
    wf(
      [
        trigger(),
        node("A", "code", { jsCode: "return [{ id: 1, a: 'x' }, { id: 2, a: 'y' }]" }, { y: -50 }),
        node("B", "code", { jsCode: "return [{ id: 2, b: 'z' }, { id: 3, b: 'w' }]" }, { y: 50 }),
        node("Join", "merge", { mode: "combineByFields", fields: [{ field1: "id", field2: "id" }], joinMode: "keepEverything" }),
        node("Append", "merge", { mode: "append" }),
      ],
      [link("Start", "A"), link("Start", "B"), link("A", "Join", 0, 0), link("B", "Join", 0, 1), link("A", "Append", 0, 0), link("B", "Append", 0, 1)],
    ),
  );
  assert.equal(both.status, "success", both.error?.message);
  assert.equal(both.runData.Join.length, 1);
  assert.deepEqual(out(both, "Join"), [{ id: 1, a: "x" }, { id: 2, a: "y", b: "z" }, { id: 3, b: "w" }]);
  assert.equal(out(both, "Append").length, 4);
  const one = await run(
    wf(
      [trigger(), node("A", "code", { jsCode: "return [{ id: 1 }]" }), node("Never", "filter", { conditions: { conditions: [{ leftValue: 1, operator: "number:equals", rightValue: 2 }] } }), node("M", "merge", { mode: "append" })],
      [link("Start", "A"), link("Start", "Never"), link("A", "M", 0, 0), link("Never", "M", 0, 1)],
    ),
  );
  assert.deepEqual(out(one, "M"), [{ id: 1 }]);
});

test("loop over items: batches through the body, done gets every result", async () => {
  const result = await run(
    wf(
      [trigger(), node("Data", "debug-helper", { count: 5 }), node("Loop", "loop", { batchSize: 2 }), node("Body", "set", { include: "none", assignments: [{ name: "i", type: "number", value: "={{ $json.index }}" }, { name: "batch", type: "number", value: "={{ $runIndex }}" }] }), node("After", "no-op")],
      [link("Start", "Data"), link("Data", "Loop"), link("Loop", "Body", 1), link("Body", "Loop"), link("Loop", "After", 0)],
    ),
  );
  assert.equal(result.status, "success", result.error?.message);
  assert.equal(result.runData.Body.length, 3);
  assert.deepEqual(out(result, "After"), [{ i: 0, batch: 0 }, { i: 1, batch: 0 }, { i: 2, batch: 1 }, { i: 3, batch: 1 }, { i: 4, batch: 2 }]);
});

test("switch: rules with fallback, all-matching, expression mode", async () => {
  const rule = (op, value) => ({ conditions: { conditions: [{ leftValue: "={{ $json.score }}", operator: op, rightValue: value }] } });
  const result = await run(
    wf(
      [trigger(), node("Data", "code", { jsCode: "return [{ score: 10 }, { score: 50 }, { score: 90 }]" }), node("S", "switch", { rules: [rule("number:lt", 30), rule("number:gt", 80)], options: { fallbackOutput: "extra" } }), node("E", "switch", { mode: "expression", numberOutputs: 2, output: "={{ $json.score > 40 ? 1 : 0 }}" })],
      [link("Start", "Data"), link("Data", "S"), link("Data", "E")],
    ),
  );
  assert.deepEqual([0, 1, 2].map((o) => out(result, "S", o).map((j) => j.score)), [[10], [90], [50]]);
  assert.deepEqual([0, 1].map((o) => out(result, "E", o).map((j) => j.score)), [[10], [50, 90]]);
});

test("wait suspends with resumable state; resume continues after the wait node", async () => {
  const workflow = wf([trigger(), node("Data", "debug-helper", { count: 2 }), node("Wait", "wait", { resume: "webhook" }), node("After", "set", { assignments: [{ name: "resumed", type: "boolean", value: "true" }] })], [link("Start", "Data"), link("Data", "Wait"), link("Wait", "After")]);
  const first = await run(workflow);
  assert.equal(first.status, "waiting");
  assert.equal(first.waiting.webhook, true);
  assert.equal(first.runData.After, undefined);
  const state = JSON.parse(JSON.stringify(first.waiting));
  const second = await run(workflow, { mode: "resume", resume: { state, items: [{ json: { approved: true } }] } });
  assert.equal(second.status, "success", second.error?.message);
  assert.deepEqual(out(second, "After"), [{ approved: true, resumed: true }]);
  const timed = await run(wf([trigger(), node("W", "wait", { resume: "timeInterval", amount: 2, unit: "minutes" })], [link("Start", "W")]));
  assert.equal(timed.waiting.until, Date.UTC(2026, 9, 22, 12, 2, 0));
});

test("errors: stop fails the run, continue passes error items, error output, retries", async () => {
  const failing = (extra) => node("Fail", "stop-and-error", { errorMessage: "boom" }, extra);
  const stop = await run(wf([trigger(), failing()], [link("Start", "Fail")]));
  assert.equal(stop.status, "error");
  assert.deepEqual(stop.error, { message: "boom", node: "Fail" });
  const cont = await run(wf([trigger(), failing({ onError: "continue" }), node("Next", "no-op")], [link("Start", "Fail"), link("Fail", "Next")]));
  assert.equal(cont.status, "success");
  assert.equal(out(cont, "Next")[0].error, "boom");
  const branch = await run(wf([trigger(), node("Http", "http-request", { url: "https://example.test/x" }, { onError: "errorOutput" }), node("Err", "no-op")], [link("Start", "Http"), link("Http", "Err", 1)]));
  assert.equal(branch.status, "success");
  assert.match(out(branch, "Err")[0].error, /no network in tests/);
  let calls = 0;
  const flaky = services({ http: async () => { calls += 1; if (calls < 3) throw new Error("flaky"); return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from('{"ok":true}'), url: "https://example.test/x" }; } });
  const retried = await run(wf([trigger(), node("Http", "http-request", { url: "https://example.test/x" }, { retryOnFail: true, maxTries: 3, waitBetweenTries: 0 })], [link("Start", "Http")]), { services: flaky });
  assert.equal(retried.status, "success", retried.error?.message);
  assert.equal(calls, 3);
});

test("limits: an endless cycle stops at maxNodeRuns; huge outputs refused", async () => {
  const cycle = await run(wf([trigger(), node("A", "no-op"), node("B", "no-op")], [link("Start", "A"), link("A", "B"), link("B", "A")]), { limits: { maxNodeRuns: 50 } });
  assert.equal(cycle.status, "error");
  assert.match(cycle.error.message, /more than 50 nodes/);
  const big = await run(wf([trigger(), node("Many", "code", { jsCode: "return Array.from({ length: 101 }, (_, i) => ({ i }))" })], [link("Start", "Many")]), { limits: { maxItemsPerOutput: 100 } });
  assert.match(big.error.message, /101 items/);
});

test("http request: query, headers, credential, JSON list split, errors, OAuth2 refresh on 401", async () => {
  const seen = [];
  let token = "old";
  const http = async (request) => {
    seen.push(request);
    if (request.url.startsWith("https://auth.test/token")) {
      token = "new";
      return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ access_token: "new", expires_in: 3600 })), url: request.url };
    }
    if (request.url.includes("/oauth")) {
      return request.headers.authorization === `Bearer ${token}` && token === "new"
        ? { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from('{"me":1}'), url: request.url }
        : { status: 401, headers: {}, body: Buffer.from("{}"), url: request.url };
    }
    if (request.url.includes("/missing")) return { status: 404, headers: { "content-type": "application/json" }, body: Buffer.from('{"message":"nope"}'), url: request.url };
    return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from('[{"a":1},{"a":2}]'), url: request.url };
  };
  const updates = [];
  const creds = {
    "Get:auth": { id: "c1", type: "httpHeaderAuth", name: "Key", data: { name: "X-Api-Key", value: "secret" } },
    "OAuth:auth": { id: "c2", type: "oAuth2Api", name: "Google", data: { accessToken: "old", refreshToken: "r1", tokenUrl: "https://auth.test/token", clientId: "id", clientSecret: "sec" } },
  };
  const svc = services({ http, credentials: creds, updateCredential: async (id, data) => updates.push([id, data]) });
  const result = await run(
    wf(
      [
        trigger(),
        node("Get", "http-request", { url: "https://api.test/items", authentication: "credential", sendQuery: true, query: [{ name: "q", value: "={{ 1 + 1 }}" }], sendHeaders: true, headers: [{ name: "X-Trace", value: "t" }] }),
        node("OAuth", "http-request", { url: "https://api.test/oauth/me", authentication: "credential" }),
      ],
      [link("Start", "Get"), link("Get", "OAuth")],
    ),
    { services: svc },
  );
  assert.equal(result.status, "success", result.error?.message);
  assert.deepEqual(out(result, "Get"), [{ a: 1 }, { a: 2 }]);
  assert.equal(seen[0].url, "https://api.test/items?q=2");
  assert.equal(seen[0].headers["X-Api-Key"], "secret");
  assert.equal(seen[0].headers["X-Trace"], "t");
  assert.equal(result.runData.OAuth[0].outputs[0].length, 2, "one request per input item");
  assert.deepEqual(updates[0], ["c2", { accessToken: "new", tokenType: "Bearer", expiresAt: Date.UTC(2026, 9, 22, 13, 0, 0) }]);
  const failed = await run(wf([trigger(), node("Get", "http-request", { url: "https://api.test/missing" })], [link("Start", "Get")]), { services: services({ http }) });
  assert.equal(failed.error.message, "The service answered HTTP 404.");
  assert.equal(failed.error.description, "nope");
  assert.equal(failed.error.httpCode, 404);
  const header = await run(wf([trigger(), node("Get", "http-request", { url: "https://api.test/x", sendHeaders: true, headers: [{ name: "Host", value: "evil" }] })], [link("Start", "Get")]), { services: services({ http }) });
  assert.match(header.error.message, /set by the transport/);
});

test("data nodes: split out, aggregate, summarize, sort, limit, rename, dedupe (in input and across runs), compare", async () => {
  const data = node("Data", "code", { jsCode: "return [{ c: 'pl', v: 2, tags: ['a', 'b'] }, { c: 'de', v: 5, tags: ['c'] }, { c: 'pl', v: 3, tags: [] }, { c: 'pl', v: 2, tags: ['a', 'b'] }]" });
  const result = await run(
    wf(
      [
        trigger(),
        data,
        node("Split", "split-out", { fieldToSplitOut: "tags", include: "selectedOtherFields", fieldsToInclude: "c", destinationFieldName: "tag" }),
        node("Agg", "aggregate", { fieldsToAggregate: [{ field: "v", outputField: "values" }] }),
        node("Sum", "summarize", { fieldsToSummarize: [{ aggregation: "sum", field: "v" }, { aggregation: "count", field: "" }], splitBy: "c" }),
        node("Sort", "sort", { fields: [{ field: "v", order: "descending" }] }),
        node("Top", "limit", { maxItems: 2 }),
        node("Rename", "rename-keys", { keys: [{ currentKey: "c", newKey: "country.code" }] }),
        node("Dedupe", "remove-duplicates", {}),
      ],
      [link("Start", "Data"), link("Data", "Split"), link("Data", "Agg"), link("Data", "Sum"), link("Data", "Sort"), link("Sort", "Top"), link("Data", "Rename"), link("Data", "Dedupe")],
    ),
  );
  assert.equal(result.status, "success", result.error?.message);
  assert.deepEqual(out(result, "Split"), [{ c: "pl", tag: "a" }, { c: "pl", tag: "b" }, { c: "de", tag: "c" }, { c: "pl", tag: "a" }, { c: "pl", tag: "b" }]);
  assert.deepEqual(out(result, "Agg"), [{ values: [2, 5, 3, 2] }]);
  assert.deepEqual(out(result, "Sum"), [{ c: "pl", sum_v: 7, count_items: 3 }, { c: "de", sum_v: 5, count_items: 1 }]);
  assert.deepEqual(out(result, "Top").map((j) => j.v), [5, 3]);
  assert.deepEqual(out(result, "Rename")[0], { country: { code: "pl" }, v: 2, tags: ["a", "b"] });
  assert.equal(out(result, "Dedupe").length, 3);

  const across = wf([trigger(), node("Data", "code", { jsCode: "return [{ id: 1 }, { id: 2 }]" }), node("New", "remove-duplicates", { operation: "acrossRuns", dedupeValue: "={{ $json.id }}" })], [link("Start", "Data"), link("Data", "New")]);
  const r1 = await run(across);
  assert.equal(out(r1, "New").length, 2);
  const r2 = await run(across, { staticData: r1.staticData });
  assert.equal(r2.runData.New[0].outputs[0].length, 0);

  const cmp = await run(
    wf(
      [trigger(), node("A", "code", { jsCode: "return [{ id: 1, n: 'a' }, { id: 2, n: 'b' }, { id: 3, n: 'c' }]" }), node("B", "code", { jsCode: "return [{ id: 2, n: 'b' }, { id: 3, n: 'C' }, { id: 4, n: 'd' }]" }), node("Cmp", "compare-datasets", { fields: [{ fieldA: "id", fieldB: "id" }] })],
      [link("Start", "A"), link("Start", "B"), link("A", "Cmp", 0, 0), link("B", "Cmp", 0, 1)],
    ),
  );
  assert.deepEqual([0, 1, 3].map((o) => out(cmp, "Cmp", o).map((j) => j.id)), [[1], [2], [4]]);
  assert.deepEqual(out(cmp, "Cmp", 2)[0].different, { n: { inputA: "c", inputB: "C" } });
});

test("date & time, crypto, JWT round trip, TOTP RFC 6238 vector, markdown", async () => {
  const result = await run(
    wf(
      [
        trigger(),
        node("D", "date-time", { operation: "addToDate", date: "2026-01-31T10:00:00Z", amount: 1, unit: "months", outputField: "next" }),
        node("F", "date-time", { operation: "formatDate", date: "2026-03-05T07:08:09Z", format: "EEE d MMM yyyy 'at' HH:mm" }),
        node("Between", "date-time", { operation: "getTimeBetweenDates", date: "2026-01-01T00:00:00Z", endDate: "2026-01-03T12:00:00Z", unit: "days", outputField: "days" }),
        node("H", "crypto", { action: "hash", type: "SHA256", value: "abc", dataPropertyName: "h" }),
        node("Sign", "jwt", { operation: "sign", claims: '{"sub":"42"}', expiresIn: 60 }),
        node("Verify", "jwt", { operation: "verify", token: "={{ $json.token }}", outputField: "claims" }),
        node("Md", "markdown", { markdown: "# Hi **there**" }),
      ],
      [link("Start", "D"), link("Start", "F"), link("Start", "Between"), link("Start", "H"), link("Start", "Sign"), link("Sign", "Verify"), link("Start", "Md")],
    ),
    { services: services({ credentials: { "Sign:jwt": { id: "j", type: "jwtAuth", name: "k", data: { algorithm: "HS256", secret: "s3cret" } }, "Verify:jwt": { id: "j", type: "jwtAuth", name: "k", data: { algorithm: "HS256", secret: "s3cret" } } } }) },
  );
  assert.equal(result.status, "success", result.error?.message);
  assert.equal(out(result, "D")[0].next, "2026-03-03T10:00:00.000Z");
  assert.equal(out(result, "F")[0].date, "Thu 5 Mar 2026 at 07:08");
  assert.equal(out(result, "Between")[0].days, 2.5);
  assert.equal(out(result, "H")[0].h, createHash("sha256").update("abc").digest("hex"));
  assert.equal(out(result, "Verify")[0].claims.sub, "42");
  assert.match(out(result, "Md")[0].html, /<h1>Hi <strong>there<\/strong><\/h1>/);
  assert.equal(totpCode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59_000, 8).token, "94287082");
  const wrong = await run(
    wf([trigger(), node("Verify", "jwt", { operation: "verify", token: "eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0." })], [link("Start", "Verify")]),
    { services: services({ credentials: { "Verify:jwt": { id: "j", type: "jwtAuth", name: "k", data: { algorithm: "HS256", secret: "s" } } } }) },
  );
  assert.match(wrong.error.message, /signed with none/);
});

test("files: items -> CSV file -> items; gzip round trip; respond to webhook", async () => {
  const responses = [];
  const result = await run(
    wf(
      [
        trigger(),
        node("Data", "code", { jsCode: "return [{ a: 1, b: 'x,y' }, { a: 2, b: 'q\"uote' }]" }),
        node("Csv", "convert-to-file", { operation: "csv" }),
        node("Zip", "compression", { operation: "compress" }),
        node("Unzip", "compression", { operation: "decompress" }),
        node("Read", "extract-from-file", { operation: "csv" }),
        node("Reply", "respond-to-webhook", { respondWith: "allIncomingItems", responseCode: 201, headers: [{ name: "X-Done", value: "1" }] }),
      ],
      [link("Start", "Data"), link("Data", "Csv"), link("Csv", "Zip"), link("Zip", "Unzip"), link("Unzip", "Read"), link("Read", "Reply")],
    ),
    { services: services({ respond: (r) => responses.push(r) }) },
  );
  assert.equal(result.status, "success", result.error?.message);
  assert.deepEqual(out(result, "Read"), [{ a: "1", b: "x,y" }, { a: "2", b: 'q"uote' }]);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].status, 201);
  assert.equal(responses[0].headers["x-done"], "1");
  assert.deepEqual(JSON.parse(responses[0].body), [{ a: "1", b: "x,y" }, { a: "2", b: 'q"uote' }]);
});

test("partial run up to a node; disabled nodes pass items through; sub-workflow call", async () => {
  const workflow = wf([trigger(), node("A", "debug-helper", { count: 2 }), node("Off", "stop-and-error", {}, { disabled: true }), node("B", "no-op"), node("C", "no-op")], [link("Start", "A"), link("A", "Off"), link("Off", "B"), link("B", "C")]);
  const partial = await run(workflow, { destinationNode: "B" });
  assert.equal(partial.status, "success", partial.error?.message);
  assert.equal(partial.runData.C, undefined);
  assert.equal(out(partial, "B").length, 2);
  const calls = [];
  const sub = await run(
    wf([trigger(), node("Data", "debug-helper", { count: 2 }), node("Call", "execute-workflow", { workflowId: "otherwf123", mode: "each" })], [link("Start", "Data"), link("Data", "Call")]),
    { services: services({ callWorkflow: async (call) => { calls.push(call); return [{ json: { done: call.items[0].json.index } }]; } }) },
  );
  assert.deepEqual(out(sub, "Call"), [{ done: 0 }, { done: 1 }]);
  assert.equal(calls.length, 2);
});
