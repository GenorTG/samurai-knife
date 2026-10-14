// Deterministic OpenResponses fixture for real-browser tests of Samurai Knife's OpenClaw continuation mode.
// Usage: node tests/mock_responses_provider.mjs [port=3298]
//
// Mirrors the gateway contract (docs/gateway/openresponses-http-api.md + openresponses-http source):
//   * `user` selects a session; previous_response_id must be one this fixture issued for the SAME `user`,
//     otherwise 400 invalid_request_error "Cannot resolve previous_response_id. ..." (also when stream: true);
//   * stream: true answers with SSE (response.created ... response.output_text.delta ... response.completed, [DONE]).
// Prompts (the newest user message): `CALL:name:{json}` -> one function call; `LOOP:name:{json}` -> a function
// call after EVERY result until a request arrives without tools (the budget wrap-up); `SLOW:text` -> streams the
// echo in 4 chunks 400 ms apart. Control: GET/DELETE /__log, POST /__expire (next chained request gets the 400),
// POST /__fail400 (next request gets an unrelated 400).
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 3298);
const KEY = "mock-key";
let calls = 0;
const log = [];
const owners = new Map(); // response id -> user
const sessions = new Map(); // user -> input items received so far
const looping = new Map(); // user -> [name, args] while a LOOP: prompt is active
let expireNext = false;
let fail400Next = false;

function send(res, status, value) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function stream(res, response, text, slow) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  const event = (value) => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
  event({ type: "response.created", response: { ...response, status: "in_progress", output: [] } });
  event({ type: "response.output_item.added", output_index: 0, item: { id: `msg_${calls}`, type: "message", role: "assistant", content: [] } });
  const chunks = slow ? [0, 1, 2, 3].map((i) => text.slice(Math.floor((i * text.length) / 4), Math.floor(((i + 1) * text.length) / 4))) : [text];
  for (const delta of chunks) {
    if (delta) event({ type: "response.output_text.delta", item_id: `msg_${calls}`, output_index: 0, content_index: 0, delta });
    if (slow) await sleep(400);
  }
  response.output.forEach((item, index) => {
    if (item.type === "function_call") event({ type: "response.output_item.added", output_index: index, item });
  });
  event({ type: "response.completed", response });
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/v1/models") {
    return req.headers.authorization === `Bearer ${KEY}`
      ? send(res, 200, { data: [{ id: "openclaw/mock" }] })
      : send(res, 401, { error: { message: "bad key" } });
  }
  if (url.pathname === "/__log" && req.method === "GET") return send(res, 200, log);
  if (url.pathname === "/__log" && req.method === "DELETE") { log.length = 0; return send(res, 200, { ok: true }); }
  if (url.pathname === "/__expire" && req.method === "POST") { expireNext = true; return send(res, 200, { ok: true }); }
  if (url.pathname === "/__fail400" && req.method === "POST") { fail400Next = true; return send(res, 200, { ok: true }); }
  if (req.method !== "POST" || url.pathname !== "/v1/responses") return send(res, 404, { error: { message: "not found" } });
  if (req.headers.authorization !== `Bearer ${KEY}`) return send(res, 401, { error: { message: "bad key" } });
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { return send(res, 400, { error: { message: "invalid json", type: "invalid_request_error" } }); }
    const items = Array.isArray(body.input) ? body.input : [];
    const validItem = (item) => item && (
      (item.type === "message" && ["system", "developer", "user", "assistant"].includes(item.role)) ||
      (item.type === "function_call" && typeof item.name === "string" && typeof item.arguments === "string") ||
      (item.type === "function_call_output" && typeof item.call_id === "string" && typeof item.output === "string")
    );
    if (!items.length || !items.every(validItem)) return send(res, 400, { error: { message: "input: Invalid input", type: "invalid_request_error" } });
    if (fail400Next) {
      fail400Next = false;
      return send(res, 400, { error: { message: "max_output_tokens: Number must be less than or equal to 4096", type: "invalid_request_error" } });
    }
    const user = typeof body.user === "string" ? body.user : `stateless-${calls}`;
    const previous = body.previous_response_id ?? null;
    if (previous !== null && (expireNext || owners.get(previous) !== user)) {
      expireNext = false;
      return send(res, 400, { error: { message: "Cannot resolve previous_response_id. Retry with full input context and omit previous_response_id.", type: "invalid_request_error" } });
    }
    calls += 1;
    const id = `resp_${calls}`;
    owners.set(id, user);
    const before = sessions.get(user) ?? 0;
    sessions.set(user, before + items.length);
    const tail = items.at(-1);
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    log.push({
      id, previous_response_id: previous, instructions: body.instructions ?? "", input: items, user, stream: body.stream === true, hasTools,
      // The bug this fixture exists to catch: a full-history request appended to a session that already holds history.
      seedIntoUsedSession: previous === null && before > 0,
    });
    const text = typeof tail?.content === "string" ? tail.content : "";
    const call = /^(CALL|LOOP):([A-Za-z0-9_]+):(\{.*\})$/.exec(text);
    if (call?.[1] === "LOOP") looping.set(user, [call[2], call[3]]);
    if (!hasTools) looping.delete(user);
    const loop = looping.get(user);
    let output;
    let reply = "";
    if (tail?.type === "function_call_output" && loop) {
      output = [{ id: `fc_${calls}`, type: "function_call", call_id: `call_${calls}`, name: loop[0], arguments: loop[1], status: "completed" }];
    } else if (tail?.type === "function_call_output") {
      reply = `DONE: ${tail.output}`;
    } else if (call) {
      output = [{ id: `fc_${calls}`, type: "function_call", call_id: `call_${calls}`, name: call[2], arguments: call[3], status: "completed" }];
    } else {
      reply = !hasTools ? `SUMMARY after ${items.length} items` : `ECHO: ${text.replace(/^SLOW:/, "")}`;
    }
    output ??= [{ id: `msg_${calls}`, type: "message", role: "assistant", content: [{ type: "output_text", text: reply }] }];
    const response = { id, object: "response", status: "completed", output, usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } };
    if (body.stream === true) return void stream(res, response, reply, text.startsWith("SLOW:"));
    return send(res, 200, response);
  });
});

server.listen(port, "127.0.0.1", () => process.stdout.write(`mock-responses-provider listening on 127.0.0.1:${port}\n`));
