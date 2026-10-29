// Deterministic OpenAI-compatible mock provider for tests. Never test against a real model server.
// Usage: node tests/mock_provider.mjs [port=3299]   (binds 127.0.0.1)
//   Base URL .../vision/v1 is the same provider whose /models also lists mock-vision, mock-text and mock-blind (vision
//   detection tests; the plain /v1 list stays two models). The three behave by model name on either path:
//     mock-vision  reads a probe picture (two solid halves) and names the colours, e.g. "red blue"
//     mock-text    answers HTTP 400 "does not support image input" to any request carrying an image part
//     mock-blind   accepts the request but answers NO_IMAGE (a provider that drops images)
//     mock-thinker-<N>  a reasoning vision model that needs N completion tokens: with a smaller max_tokens /
//                  max_completion_tokens it answers empty content + finish_reason "length" (all spent reasoning),
//                  otherwise like mock-vision (probe colours) or the generic VISION: answer
//   Base URL .../anthropic/v1 behaves like api.anthropic.com (the server treats it so when KNIFE_ANTHROPIC_TEST_BASE names
//   it): every request needs `anthropic-version` (else 400 "anthropic-version: header is required") and GET /models needs
//   `x-api-key: mock-key` (else 401), all errors in Anthropic's {type:"error", error:{type, message}} shape; GET /models
//   is the native shape (display_name, created_at, max_input_tokens, capabilities.image_input) paged two at a time
//   (has_more / last_id / after_id); chat completions answer 400 to any temperature below 1 (Claude 4.7+), else as /v1.
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
//   user text containing LOOP:<tool>:<json args> -> calls that tool again after every tool result of this turn (turn limit tests)
//   user text containing GAP:<ms>                -> delay between streamed chunks / between tool name and arguments
//   several CALL: lines in one user message      -> that many tool_calls in one round
//   stream_options.include_usage -> a final usage chunk (deterministic); text containing NOUSAGE omits it, REJECT_STREAM_OPTIONS answers 400 to stream_options
//   stream:true requests get SSE chunks (reasoning first when text has THINK:<ms>); non-stream is unchanged
//   last message with image_url parts           -> content "VISION: saw <n> image(s) [<mime>, ...]: <its text>" (vision tests)
//   role "tool"                               -> content "DONE: <tool result text>"
//   otherwise                                    -> content "ECHO: <user text>"
import { createServer } from "node:http";
import { inflateSync } from "node:zlib";

const port = Number(process.argv[2] ?? 3299);
const PROBE_COLOURS = { red: [220, 30, 30], green: [30, 170, 60], blue: [30, 70, 220], yellow: [240, 210, 20], black: [0, 0, 0], white: [255, 255, 255] };

/** The two halves' colours of an RGB PNG data URL (the vision probe's picture), or null. */
function probeColours(url) {
  const match = /^data:image\/png;base64,(.+)$/.exec(url);
  if (!match) return null;
  const png = Buffer.from(match[1], "base64");
  let at = 8;
  let width = 0;
  const idat = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") width = data.readUInt32BE(0);
    if (type === "IDAT") idat.push(data);
    at += 12 + length;
  }
  const rows = inflateSync(Buffer.concat(idat));
  const pixel = (x) => [rows[1 + x * 3], rows[2 + x * 3], rows[3 + x * 3]];
  const nearest = ([r, g, b]) => Object.entries(PROBE_COLOURS).sort(([, a], [, c]) => Math.hypot(a[0] - r, a[1] - g, a[2] - b) - Math.hypot(c[0] - r, c[1] - g, c[2] - b))[0][0];
  return [nearest(pixel(2)), nearest(pixel(width - 3))];
}
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

/** Image parts of a message (`image_url` with a data URL): their MIME types, for vision tests. */
function imagesOf(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((part) => part?.type === "image_url" && typeof part.image_url?.url === "string")
    .map((part) => /^data:([^;,]+)[;,]/.exec(part.image_url.url)?.[1] ?? "url");
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
  const visionModels = url.pathname.startsWith("/vision/v1/");
  if (visionModels) url.pathname = url.pathname.slice("/vision".length);
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
  const anthropic = url.pathname.startsWith("/anthropic/v1/");
  if (anthropic) {
    url.pathname = url.pathname.slice("/anthropic".length);
    const anthropicError = (status, type, message) => send(res, status, { type: "error", error: { type, message } });
    if (!req.headers["anthropic-version"]) return anthropicError(400, "invalid_request_error", "anthropic-version: header is required");
    if (req.method === "GET" && url.pathname === "/v1/models") {
      if (req.headers["x-api-key"] !== KEY) return anthropicError(401, "authentication_error", "invalid x-api-key");
      const all = [
        { type: "model", id: "claude-opus-mock", display_name: "Claude Opus Mock", created_at: "2026-09-21T00:00:00Z", max_input_tokens: 1000000, max_tokens: 128000, capabilities: { image_input: { supported: true }, thinking: { supported: true }, structured_outputs: { supported: true }, pdf_input: { supported: true } } },
        { type: "model", id: "claude-sonnet-mock", display_name: "Claude Sonnet Mock", created_at: "2026-09-01T00:00:00Z", max_input_tokens: 200000, capabilities: { image_input: { supported: true } } },
        { type: "model", id: "claude-text-mock", display_name: "Claude Text Mock", created_at: "2024-01-01T00:00:00Z", capabilities: { image_input: { supported: false } } },
      ];
      const after = url.searchParams.get("after_id");
      const start = after ? all.findIndex((m) => m.id === after) + 1 : 0;
      const page = all.slice(start, start + 2);
      const more = start + 2 < all.length;
      return send(res, 200, { data: page, has_more: more, first_id: page[0]?.id ?? null, last_id: page.at(-1)?.id ?? null });
    }
  }
  if (req.headers.authorization !== `Bearer ${KEY}`) {
    // Echoes the received credential so tests can prove the server redacts it.
    return send(res, 401, { error: { message: `bad key: ${req.headers.authorization ?? "none"}`, type: "auth" } });
  }
  if (req.method === "GET" && url.pathname === "/v1/models") {
    const extra = visionModels ? ["mock-vision", "mock-text", "mock-blind"].map((id) => ({ id, object: "model" })) : [];
    return send(res, 200, { object: "list", data: [{ id: "mock-model", object: "model" }, { id: "mock-model-2", object: "model" }, ...extra] });
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
      last = { body, headers: { authorization: req.headers.authorization, "x-test-header": req.headers["x-test-header"] ?? null, "anthropic-version": req.headers["anthropic-version"] ?? null, "x-api-key": req.headers["x-api-key"] ? "present" : null } };
      if (anthropic && typeof body.temperature === "number" && body.temperature < 1) {
        return send(res, 400, { type: "error", error: { type: "invalid_request_error", message: "temperature: values below 1 are not supported for this model" } });
      }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      requestCount += 1;
      inflight += 1;
      maxConcurrent = Math.max(maxConcurrent, inflight);
      res.on("close", () => { inflight -= 1; });
      requestLog.push({
        n: requestCount,
        stream: body.stream === true,
        messages: messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, text: textOf(m.content), tool_call_id: m.tool_call_id ?? null, images: imagesOf(m.content) })),
      });
      const tail = messages[messages.length - 1];
      if (!tail) return send(res, 400, { error: { message: "no messages" } });
      const text = textOf(tail.content);
      const seen = imagesOf(tail.content);
      const anyImage = messages.some((m) => imagesOf(m.content).length > 0);
      if (body.model === "mock-text" && anyImage) {
        return send(res, 400, { error: { message: "Model mock-text does not support image input (image_url content parts).", type: "invalid_request_error" } });
      }
      if (body.model === "mock-blind" && seen.length) {
        return reply(res, body, { role: "assistant", content: "NO_IMAGE" }, "stop", "");
      }
      const thinker = /^mock-thinker-(\d+)$/.exec(String(body.model ?? ""));
      if (thinker && seen.length) {
        const budget = Number(body.max_tokens ?? body.max_completion_tokens ?? Number.POSITIVE_INFINITY);
        if (budget < Number(thinker[1])) {
          return send(res, 200, { ...completion({ role: "assistant", content: "" }, "length"), usage: { prompt_tokens: 10, completion_tokens: budget, total_tokens: budget + 10, completion_tokens_details: { reasoning_tokens: budget } } });
        }
        if (/left half/.test(text)) {
          const colours = probeColours(tail.content.find((p) => p?.type === "image_url").image_url.url);
          return reply(res, body, { role: "assistant", content: colours ? colours.join(" ") : "unreadable" }, "stop", "");
        }
      }
      if (body.model === "mock-vision" && seen.length && /left half/.test(text)) {
        const part = tail.content.find((p) => p?.type === "image_url");
        const colours = probeColours(part.image_url.url);
        return reply(res, body, { role: "assistant", content: colours ? colours.join(" ") : "unreadable" }, "stop", "");
      }
      if (seen.length) {
        return reply(res, body, { role: "assistant", content: `VISION: saw ${seen.length} image(s) [${seen.join(", ")}]: ${text.slice(0, 80)}` }, "stop", "");
      }
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const loop = lastUser ? /LOOP:([A-Za-z0-9_]+):(\{.*\})/.exec(textOf(lastUser.content)) : null;
      if (tail.role === "tool" && loop && Array.isArray(body.tools) && body.tools.length > 0) {
        return reply(res, body, {
          role: "assistant",
          content: null,
          tool_calls: [{ id: `loop_${requestCount}`, type: "function", function: { name: loop[1], arguments: loop[2] } }],
        }, "tool_calls", "");
      }
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
      const matches = [...text.matchAll(/(?:CALL|LOOP):([A-Za-z0-9_]+):(\{.*\})/g)];
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
