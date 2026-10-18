// Deterministic OpenAI-compatible mock provider for tests. Never test against a real model server.
// Usage: node tests/mock_provider.mjs [port=3299]   (binds 127.0.0.1)
//   GET  /v1/models
//   POST /v1/chat/completions   (non-stream)
//   GET  /__last                -> last POST body (+ received headers) for assertions
//   GET  /__log                 -> every chat request since start / last DELETE: [{n, stream, messages:[{role, text, tool_call_id}]}] (system prompt omitted)
//   DELETE /__log               -> clear that log
//   GET  /__stats               -> {requests, maxConcurrent}: most chat requests in flight at once (proves two tabs never ran the model together); DELETE resets the peak
// Scripted behavior on the LAST message:
//   user text containing CALL:<tool>:<json args> -> assistant message with that single tool_call
//   user text containing SLOW:<ms>               -> replies "SLOWDONE: <text>" after <ms> (max 60000); cancelled on disconnect
//   user text containing STREAM:<n>             -> (stream:true) streams ~n words, one every GAP ms (default 120)
//   user text containing GAP:<ms>                -> delay between streamed chunks / between tool name and arguments
//   several CALL: lines in one user message      -> that many tool_calls in one round
//   stream_options.include_usage -> a final usage chunk (deterministic); text containing NOUSAGE omits it, REJECT_STREAM_OPTIONS answers 400 to stream_options
//   stream:true requests get SSE chunks (reasoning first when text has THINK:<ms>); non-stream is unchanged
//   role "tool"                               -> content "DONE: <tool result text>"
//   otherwise                                    -> content "ECHO: <user text>"
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 3299);
const KEY = "mock-key";
let last = null;
/** Every chat request received, oldest first, so tests can assert what the model was actually sent and in which order. */
let requestLog = [];
let requestCount = 0;
let inflight = 0;
let maxConcurrent = 0;

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part?.text ?? "").join("");
  return "";
}

function reply(res, body, message, finish, text) {
  if (!body.stream) return send(res, 200, completion(message, finish));
  const gap = Number(/GAP:(\d+)/.exec(text)?.[1] ?? 120);
  const think = Number(/THINK:(\d+)/.exec(text)?.[1] ?? 0);
  if (/REJECT_STREAM_OPTIONS/.test(text) && body.stream_options) {
    return send(res, 400, { error: { message: "Unrecognized request argument supplied: stream_options" } });
  }
  return streamReply(res, message, gap, think, /STREAM:/.test(text), body.stream_options?.include_usage && !/NOUSAGE/.test(text) ? mockUsage(body, message, think) : null);
}

/** Deterministic usage: prompt grows with the request (chars/4), 40% served from cache, reasoning only when THINK was requested. */
function mockUsage(body, message, thinkMs) {
  const promptTokens = Math.ceil(JSON.stringify({ m: body.messages, t: body.tools ?? [] }).length / 4);
  const completionTokens = Math.max(1, Math.ceil(JSON.stringify(message).length / 4)) + (thinkMs ? 50 : 0);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: Math.floor(promptTokens * 0.4) },
    completion_tokens_details: { reasoning_tokens: thinkMs ? 50 : 0 },
  };
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function completion(message, finish) {
  return {
    id: "mock-1",
    object: "chat.completion",
    model: "mock-model",
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Replies as OpenAI-style SSE: reasoning, text words, tool-call name first then arguments, then [DONE]. */
async function streamReply(res, message, gap, thinkMs, words, usage) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  let open = true;
  res.on("close", () => { open = false; });
  const chunk = (delta, finish = null) => open && res.write(`data: ${JSON.stringify({ id: "mock-s", object: "chat.completion.chunk", model: "mock-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  chunk({ role: "assistant" });
  if (thinkMs > 0) {
    chunk({ reasoning_content: "thinking about it " });
    await pause(thinkMs);
  }
  if (message.content) {
    const parts = words ? message.content.split(/(?<= )/) : [message.content];
    for (const part of parts) {
      if (!open) return;
      chunk({ content: part });
      if (parts.length > 1) await pause(gap);
    }
  }
  const calls = message.tool_calls ?? [];
  for (let i = 0; i < calls.length; i += 1) {
    const c = calls[i];
    chunk({ tool_calls: [{ index: i, id: c.id, type: "function", function: { name: c.function.name, arguments: "" } }] });
    await pause(gap);
    if (!open) return;
    chunk({ tool_calls: [{ index: i, function: { arguments: c.function.arguments } }] });
  }
  chunk({}, calls.length ? "tool_calls" : "stop");
  if (open && usage) res.write(`data: ${JSON.stringify({ id: "mock-s", object: "chat.completion.chunk", model: "mock-model", choices: [], usage })}\n\n`);
  if (open) res.write("data: [DONE]\n\n");
  res.end();
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/__last") {
    return send(res, 200, last ?? { body: null });
  }
  if (url.pathname === "/__stats") {
    if (req.method === "DELETE") maxConcurrent = inflight;
    return send(res, 200, { requests: requestCount, maxConcurrent });
  }
  if (url.pathname === "/__log") {
    if (req.method === "DELETE") requestLog = [];
    return send(res, 200, requestLog);
  }
  if (req.headers.authorization !== `Bearer ${KEY}`) {
    // Echoes the received credential so tests can prove the server redacts it.
    return send(res, 401, { error: { message: `bad key: ${req.headers.authorization ?? "none"}`, type: "auth" } });
  }
  if (req.method === "GET" && url.pathname === "/v1/models") {
    return send(res, 200, { object: "list", data: [{ id: "mock-model", object: "model" }, { id: "mock-model-2", object: "model" }] });
  }
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return send(res, 400, { error: { message: "invalid json" } });
      }
      last = { body, headers: { authorization: req.headers.authorization, "x-test-header": req.headers["x-test-header"] ?? null } };
      const messages = Array.isArray(body.messages) ? body.messages : [];
      requestCount += 1;
      inflight += 1;
      maxConcurrent = Math.max(maxConcurrent, inflight);
      res.on("close", () => { inflight -= 1; });
      requestLog.push({
        n: requestCount,
        stream: body.stream === true,
        messages: messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, text: textOf(m.content), tool_call_id: m.tool_call_id ?? null })),
      });
      const tail = messages[messages.length - 1];
      if (!tail) return send(res, 400, { error: { message: "no messages" } });
      const text = textOf(tail.content);
      if (tail.role === "tool") {
        const attackSimulation = messages.some((m) => m.role === "user" && /ATTACK_SIMULATION/.test(textOf(m.content)));
        if (attackSimulation && /<<<UNTRUSTED_CONTENT id=/.test(text)) {
          return reply(res, body, {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "injected-delete", type: "function", function: { name: "knife_cv_app_delete", arguments: JSON.stringify({ id: "inject-delete" }) } }],
          }, "tool_calls", text);
        }
        return reply(res, body, { role: "assistant", content: `DONE: ${textOf(tail.content)}` }, "stop", "");
      }
      const slow = /SLOW:(\d+)/.exec(text);
      if (tail.role === "user" && slow) {
        const timer = setTimeout(
          () => reply(res, body, { role: "assistant", content: `SLOWDONE: ${text}` }, "stop", ""),
          Math.min(Number(slow[1]), 60_000),
        );
        res.on("close", () => clearTimeout(timer));
        return;
      }
      const matches = [...text.matchAll(/CALL:([A-Za-z0-9_]+):(\{.*\})/g)];
      if (tail.role === "user" && matches.length > 0) {
        return reply(res, body, {
          role: "assistant",
          content: null,
          tool_calls: matches.map((m, i) => ({ id: `call_${i + 1}`, type: "function", function: { name: m[1], arguments: m[2] } })),
        }, "tool_calls", text);
      }
      const stream = /STREAM:(\d+)/.exec(text);
      const content = stream ? Array.from({ length: Number(stream[1]) }, (_, i) => `word${i + 1}`).join(" ") : `ECHO: ${text}`;
      return reply(res, body, { role: "assistant", content }, "stop", text);
    });
    return;
  }
  send(res, 404, { error: { message: "not found" } });
});

server.listen(port, "127.0.0.1", () => console.log(`[mock-provider] listening on 127.0.0.1:${port}`));
