import { estimateUsage, normalizeUsage, type Usage } from "@/lib/usage";
import * as z from "zod/v4";
import type { ProviderConfig } from "@/lib/accounts/store";
import { openClawUser, providerConversationId } from "@/lib/agent-client/conversation-store";

export const CHAT_TIMEOUT_MS = 120_000;
export const TEST_TIMEOUT_MS = 10_000;
const MAX_UPSTREAM_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_DETAIL_CHARS = 500;

const FORBIDDEN_HEADERS = new Set([
  "authorization",
  "content-type",
  "content-length",
  "host",
  "cookie",
  "connection",
  "transfer-encoding",
]);
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;

/** http(s) only, no credentials/query/hash, trailing slash stripped. */
export function normalizeBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return url.toString().replace(/\/+$/, "");
}

export function validateExtraHeaders(headers: Record<string, string>): string | null {
  const names = Object.keys(headers);
  if (names.length > 16) return "At most 16 extra headers are allowed.";
  for (const name of names) {
    if (!HEADER_NAME.test(name)) return `Invalid header name: ${name}`;
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) return `Header ${name} is managed by the server.`;
    const value = headers[name];
    if (value.length > 1_024 || /[\r\n\0]/.test(value)) return `Invalid value for header ${name}.`;
  }
  return null;
}

function upstreamHeaders(provider: ProviderConfig): Record<string, string> {
  const headers: Record<string, string> = {
    ...(provider.extraHeaders ?? {}),
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  return headers;
}

/** Remove the key (and any extra-header secret) from text that may be echoed to the browser. */
export function redact(text: string, provider: ProviderConfig): string {
  let out = text;
  const secrets = [provider.apiKey, ...Object.values(provider.extraHeaders ?? {})].filter((s) => s.length >= 4);
  for (const secret of secrets) out = out.split(secret).join("[redacted]");
  return out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer [redacted]");
}

class UpstreamFailure extends Error {
  constructor(readonly kind: "timeout" | "network" | "too_large") {
    super(kind);
  }
}

async function upstreamFetch(
  provider: ProviderConfig,
  path: string,
  init: { method: "GET" | "POST"; body?: string },
  timeoutMs: number,
): Promise<{ status: number; text: string }> {
  try {
    const response = await fetch(`${provider.baseUrl}${path}`, {
      method: init.method,
      headers: upstreamHeaders(provider),
      body: init.body,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (text.length > MAX_UPSTREAM_BYTES) throw new UpstreamFailure("too_large");
    return { status: response.status, text };
  } catch (error) {
    if (error instanceof UpstreamFailure) throw error;
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new UpstreamFailure("timeout");
    }
    throw new UpstreamFailure("network");
  }
}

function failureMessage(failure: UpstreamFailure): string {
  if (failure.kind === "timeout") return "The provider did not answer in time.";
  if (failure.kind === "too_large") return "The provider response was too large.";
  return "Could not reach the provider.";
}

function errorDetail(text: string, provider: ProviderConfig): string {
  let detail = text;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    const inner = parsed.error;
    if (typeof inner === "string") detail = inner;
    else if (inner && typeof inner === "object" && "message" in inner && typeof inner.message === "string") {
      detail = inner.message;
    }
  } catch {
    // keep raw text
  }
  return redact(detail, provider).slice(0, MAX_ERROR_DETAIL_CHARS);
}

export interface ProviderTestResult {
  ok: boolean;
  status: number | null;
  modelCount?: number;
  error?: string;
}

const modelListSchema = z.object({ data: z.array(z.unknown()) }).passthrough();

export async function testProvider(provider: ProviderConfig): Promise<ProviderTestResult> {
  try {
    const { status, text } = await upstreamFetch(provider, "/models", { method: "GET" }, TEST_TIMEOUT_MS);
    if (status < 200 || status >= 300) {
      return { ok: false, status, error: `Provider returned HTTP ${status}: ${errorDetail(text, provider)}` };
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text) as unknown;
    } catch {
      return { ok: false, status, error: "Provider /models did not return JSON." };
    }
    const models = modelListSchema.safeParse(parsedJson);
    return models.success
      ? { ok: true, status, modelCount: models.data.data.length }
      : { ok: true, status };
  } catch (error) {
    if (error instanceof UpstreamFailure) return { ok: false, status: null, error: failureMessage(error) };
    return { ok: false, status: null, error: "Provider test failed." };
  }
}

const upstreamCompletionSchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      content: z.union([z.string(), z.null()]).optional(),
      tool_calls: z.array(z.unknown()).optional(),
    }).passthrough(),
    finish_reason: z.union([z.string(), z.null()]).optional(),
  }).passthrough()).min(1),
  usage: z.unknown().optional(),
}).passthrough();

export interface ChatSuccess {
  message: { role: "assistant"; content: string; tool_calls?: unknown[] };
  finishReason: string | null;
  /** Normalised token usage when the provider reports it. */
  usage?: Usage;
  responseId?: string;
}

export type ChatOutcome =
  | { ok: true; result: ChatSuccess }
  | { ok: false; status: number; error: string };

export interface ChatInput {
  model: string;
  messages: unknown[];
  tools?: unknown[];
  temperature?: number;
  maxTokens?: number;
  previousResponseId?: string | null;
}

/* ------------------------------------------------------------- OpenClaw Responses (/v1/responses) */

const responsesSchema = z.object({
  id: z.string().min(1),
  output: z.array(z.record(z.string(), z.unknown())),
  usage: z.unknown().optional(),
  status: z.string().optional(),
}).passthrough();

/** The browser must resend the full history (`/api/agent/chat` answers 409 with this code). */
export const CONTINUATION_LOST = "continuation_lost";

/** How a Responses round ended, for the continuation state and the usage ledger. */
export type ResponsesSettlement =
  | { ok: true; responseId: string; pendingCallIds: string[]; usage: Usage | null; ms: number }
  | { ok: false; aborted: boolean; ms: number };

interface ParsedResponse {
  result: ChatSuccess & { responseId: string };
  pendingCallIds: string[];
}

/** Chat-completions shaped input -> OpenResponses request body. */
function responsesBody(provider: ProviderConfig, accountId: string, sessionId: string, input: ChatInput, stream: boolean): string {
  const instructions = input.messages
    .filter((message) => typeof message === "object" && message !== null && (message as { role?: unknown }).role === "system")
    .map((message) => (message as { content?: unknown }).content)
    .filter((content): content is string => typeof content === "string")
    .join("\n\n");
  const items: Record<string, unknown>[] = [];
  for (const value of input.messages) {
    if (typeof value !== "object" || value === null) continue;
    const message = value as Record<string, unknown>;
    if (message.role === "system") continue;
    if (message.role === "user" && typeof message.content === "string") {
      items.push({ type: "message", role: "user", content: message.content });
    } else if (message.role === "assistant") {
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          if (typeof call !== "object" || call === null) continue;
          const item = call as Record<string, unknown>;
          const fn = typeof item.function === "object" && item.function !== null ? item.function as Record<string, unknown> : {};
          if (typeof fn.name === "string") items.push({ type: "function_call", call_id: item.id, name: fn.name, arguments: fn.arguments });
        }
      } else if (typeof message.content === "string" && message.content) {
        items.push({ type: "message", role: "assistant", content: message.content });
      }
    } else if (message.role === "tool") {
      items.push({ type: "function_call_output", call_id: message.tool_call_id, output: message.content });
    }
  }
  const tools = (input.tools ?? []).flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const tool = value as Record<string, unknown>;
    const fn = typeof tool.function === "object" && tool.function !== null ? tool.function as Record<string, unknown> : null;
    if (tool.type !== "function" || !fn || typeof fn.name !== "string") return [];
    return [{ type: "function", name: fn.name, description: fn.description, parameters: fn.parameters }];
  });
  const body: Record<string, unknown> = { model: provider.model, instructions, input: items, stream };
  if (tools.length) body.tools = tools;
  if (input.temperature !== undefined) body.temperature = input.temperature;
  if (input.maxTokens !== undefined) body.max_output_tokens = input.maxTokens;
  if (input.previousResponseId) body.previous_response_id = input.previousResponseId;
  body.user = openClawUser(accountId, providerConversationId(provider.baseUrl, provider.model), sessionId);
  return JSON.stringify(body);
}

/** A finished OpenResponses resource -> the chat-completions shaped reply the browser loop consumes. */
function parseResponse(raw: unknown): ParsedResponse | null {
  const parsed = responsesSchema.safeParse(raw);
  if (!parsed.success) return null;
  let content = "";
  const toolCalls: ToolCallOut[] = [];
  for (const output of parsed.data.output) {
    if (output.type === "function_call" && typeof output.call_id === "string" && typeof output.name === "string") {
      toolCalls.push({ id: output.call_id, type: "function", function: { name: output.name, arguments: typeof output.arguments === "string" ? output.arguments : "{}" } });
    }
    if (output.type === "message" && Array.isArray(output.content)) {
      for (const part of output.content) {
        if (typeof part === "object" && part !== null && (part as Record<string, unknown>).type === "output_text") {
          const textPart = (part as Record<string, unknown>).text;
          if (typeof textPart === "string") content += textPart;
        }
      }
    }
  }
  const usage = normalizeUsage(parsed.data.usage);
  return {
    result: {
      message: { role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      finishReason: parsed.data.status ?? "completed",
      ...(usage ? { usage } : {}),
      responseId: parsed.data.id,
    },
    pendingCallIds: toolCalls.map((call) => call.id),
  };
}

interface ToolCallOut {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * A non-2xx answer from /v1/responses. The gateway's documented reply to an unknown, expired, evicted or
 * out-of-scope previous_response_id is a 400 invalid_request_error whose message names the field
 * ("Cannot resolve previous_response_id. Retry with full input context ..."). Only that becomes
 * CONTINUATION_LOST (409); every other 400 is an ordinary upstream error, so it is shown, not replayed.
 */
function responsesFailure(status: number, text: string, provider: ProviderConfig): { ok: false; status: number; error: string } {
  const detail = errorDetail(text, provider);
  if (status === 400 && /previous_response_id/i.test(detail)) return { ok: false, status: 409, error: CONTINUATION_LOST };
  return { ok: false, status: status === 429 ? 429 : 502, error: `Provider returned HTTP ${status}: ${detail}` };
}

/** One non-streamed Responses round (`stream: false` callers, e.g. the budget wrap-up). */
export async function forwardResponses(
  provider: ProviderConfig,
  accountId: string,
  sessionId: string,
  input: ChatInput,
  clientSignal: AbortSignal,
  onSettled: (settlement: ResponsesSettlement) => void,
): Promise<ChatOutcome> {
  const started = Date.now();
  const fail = (outcome: { ok: false; status: number; error: string }, aborted = false): ChatOutcome => {
    onSettled({ ok: false, aborted, ms: Date.now() - started });
    return outcome;
  };
  try {
    const response = await fetch(`${provider.baseUrl}/responses`, {
      method: "POST",
      headers: upstreamHeaders(provider),
      body: responsesBody(provider, accountId, sessionId, input, false),
      redirect: "error",
      signal: AbortSignal.any([AbortSignal.timeout(CHAT_TIMEOUT_MS), clientSignal]),
    });
    const text = await response.text();
    if (text.length > MAX_UPSTREAM_BYTES) return fail({ ok: false, status: 502, error: "The provider response was too large." });
    if (response.status < 200 || response.status >= 300) return fail(responsesFailure(response.status, text, provider));
    let raw: unknown;
    try { raw = JSON.parse(text) as unknown; } catch { return fail({ ok: false, status: 502, error: "Provider returned a non-JSON Responses reply." }); }
    const parsed = parseResponse(raw);
    if (!parsed) return fail({ ok: false, status: 502, error: "Provider response was not an OpenResponses response." });
    onSettled({ ok: true, responseId: parsed.result.responseId, pendingCallIds: parsed.pendingCallIds, usage: parsed.result.usage ?? null, ms: Date.now() - started });
    return { ok: true, result: parsed.result };
  } catch (error) {
    if (clientSignal.aborted) return fail({ ok: false, status: 499, error: "aborted" }, true);
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return fail({ ok: false, status: 504, error: "The provider did not answer in time." });
    return fail({ ok: false, status: 502, error: "Could not reach the provider." });
  }
}

/**
 * One streamed Responses round. The gateway's SSE (`response.output_text.delta`, `response.output_item.added`,
 * terminal `response.completed|incomplete|failed`) is translated into the same normalized StreamEvents as
 * chat completions, so the browser has one streaming path; `done` also carries the new responseId.
 * Resolves to a failure (incl. CONTINUATION_LOST) before any byte is sent, or to the event stream.
 */
export async function forwardResponsesStream(
  provider: ProviderConfig,
  accountId: string,
  sessionId: string,
  input: ChatInput,
  clientSignal: AbortSignal,
  onSettled: (settlement: ResponsesSettlement) => void,
): Promise<{ ok: false; status: number; error: string } | { ok: true; response: Response }> {
  const started = Date.now();
  let settled = false;
  const settle = (settlement: ResponsesSettlement): void => {
    if (settled) return;
    settled = true;
    onSettled(settlement);
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
  const onClientAbort = (): void => controller.abort();
  clientSignal.addEventListener("abort", onClientAbort);
  const cleanup = (): void => {
    clearTimeout(timer);
    clientSignal.removeEventListener("abort", onClientAbort);
  };
  const failEarly = (outcome: { ok: false; status: number; error: string }) => {
    cleanup();
    settle({ ok: false, aborted: clientSignal.aborted, ms: Date.now() - started });
    return outcome;
  };

  let upstream: Response;
  try {
    upstream = await fetch(`${provider.baseUrl}/responses`, {
      method: "POST",
      headers: { ...upstreamHeaders(provider), Accept: "text/event-stream" },
      body: responsesBody(provider, accountId, sessionId, input, true),
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    return failEarly(controller.signal.aborted && !clientSignal.aborted
      ? { ok: false, status: 504, error: "The provider did not answer in time." }
      : { ok: false, status: 502, error: "Could not reach the provider." });
  }
  if (upstream.status < 200 || upstream.status >= 300 || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return failEarly(responsesFailure(upstream.status, text, provider));
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(out) {
      const send = (event: StreamEvent): void => {
        out.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      // Asserted (not annotated) so TS keeps the union: it is assigned inside handleLine, which flow analysis cannot see.
      let terminal = null as { ok: true; parsed: ParsedResponse } | { ok: false; error: string } | null;
      let buffer = "";
      let total = 0;
      const handleLine = (line: string): void => {
        if (terminal || !line.startsWith("data:")) return; // `event:` lines repeat the JSON `type`
        const payload = line.slice(5).trim();
        if (payload === "" || payload === "[DONE]") return;
        let event: Record<string, unknown>;
        try {
          const value: unknown = JSON.parse(payload);
          if (typeof value !== "object" || value === null) return;
          event = value as Record<string, unknown>;
        } catch {
          return;
        }
        const type = event.type;
        if (type === "response.output_text.delta" && typeof event.delta === "string" && event.delta) {
          send({ t: "text", d: event.delta });
        } else if (type === "response.output_item.added" && typeof event.item === "object" && event.item !== null) {
          const item = event.item as Record<string, unknown>;
          if (item.type === "function_call" && typeof item.name === "string") {
            send({ t: "tool", index: typeof event.output_index === "number" ? event.output_index : 0, id: typeof item.call_id === "string" ? item.call_id : "", name: item.name });
          }
        } else if (type === "response.completed" || type === "response.incomplete") {
          const parsed = parseResponse(event.response);
          terminal = parsed ? { ok: true, parsed } : { ok: false, error: "Provider response was not an OpenResponses response." };
        } else if (type === "response.failed") {
          const failed = typeof event.response === "object" && event.response !== null ? (event.response as Record<string, unknown>).error : null;
          const message = typeof failed === "object" && failed !== null && typeof (failed as Record<string, unknown>).message === "string"
            ? (failed as Record<string, unknown>).message as string
            : "The provider run failed.";
          terminal = { ok: false, error: redact(message, provider).slice(0, MAX_ERROR_DETAIL_CHARS) };
        }
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_UPSTREAM_BYTES) throw new UpstreamFailure("too_large");
          buffer += decoder.decode(value, { stream: true });
          let nl = buffer.indexOf("\n");
          while (nl >= 0) {
            handleLine(buffer.slice(0, nl).replace(/\r$/, ""));
            buffer = buffer.slice(nl + 1);
            nl = buffer.indexOf("\n");
          }
        }
        if (buffer) handleLine(buffer);
        const ms = Date.now() - started;
        const end = terminal;
        if (end?.ok) {
          const { result, pendingCallIds } = end.parsed;
          settle({ ok: true, responseId: result.responseId, pendingCallIds, usage: result.usage ?? null, ms });
          send({ t: "done", message: result.message, finishReason: result.finishReason, usage: result.usage ?? null, ms, responseId: result.responseId });
        } else {
          settle({ ok: false, aborted: false, ms });
          send({ t: "error", error: end ? end.error : "The provider stream ended without a reply." });
        }
      } catch (error) {
        settle({ ok: false, aborted: clientSignal.aborted, ms: Date.now() - started });
        send({
          t: "error",
          error: error instanceof UpstreamFailure
            ? failureMessage(error)
            : controller.signal.aborted && !clientSignal.aborted ? "The provider did not answer in time." : "The provider stream failed.",
        });
      } finally {
        cleanup();
        reader.cancel().catch(() => undefined);
        out.close();
      }
    },
    cancel() {
      controller.abort();
      cleanup();
      settle({ ok: false, aborted: true, ms: Date.now() - started });
    },
  });
  return {
    ok: true,
    response: new Response(stream, {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", "x-accel-buffering": "no" },
    }),
  };
}

function chatBody(provider: ProviderConfig, input: ChatInput, tokenField: string, stream = false, withUsage = true): string {
  const body: Record<string, unknown> = {
    model: provider.model,
    messages: input.messages,
    stream,
  };
  // Streams only report token usage when asked (OpenAI-compatible final chunk with empty choices).
  if (stream && withUsage) body.stream_options = { include_usage: true };
  if (provider.reasoningEffort) body.reasoning_effort = provider.reasoningEffort;
  if (input.tools && input.tools.length > 0) body.tools = input.tools;
  if (input.temperature !== undefined) body.temperature = input.temperature;
  if (input.maxTokens !== undefined) body[tokenField] = input.maxTokens;
  return JSON.stringify(body);
}

export async function forwardChat(provider: ProviderConfig, input: ChatInput): Promise<ChatOutcome> {
  try {
    let response = await upstreamFetch(
      provider,
      "/chat/completions",
      { method: "POST", body: chatBody(provider, input, "max_tokens") },
      CHAT_TIMEOUT_MS,
    );
    // Newer OpenAI reasoning models reject max_tokens; retry once with the new field.
    if (
      response.status === 400 &&
      input.maxTokens !== undefined &&
      response.text.includes("max_completion_tokens")
    ) {
      response = await upstreamFetch(
        provider,
        "/chat/completions",
        { method: "POST", body: chatBody(provider, input, "max_completion_tokens") },
        CHAT_TIMEOUT_MS,
      );
    }
    if (response.status < 200 || response.status >= 300) {
      const status = response.status === 429 ? 429 : 502;
      return {
        ok: false,
        status,
        error: `Provider returned HTTP ${response.status}: ${errorDetail(response.text, provider)}`,
      };
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(response.text) as unknown;
    } catch {
      return { ok: false, status: 502, error: "Provider returned a non-JSON response." };
    }
    const completion = upstreamCompletionSchema.safeParse(parsedJson);
    if (!completion.success) {
      return { ok: false, status: 502, error: "Provider response was not an OpenAI chat completion." };
    }
    const choice = completion.data.choices[0];
    const toolCalls = choice.message.tool_calls;
    return {
      ok: true,
      result: {
        message: {
          role: "assistant",
          content: choice.message.content ?? "",
          ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finishReason: choice.finish_reason ?? null,
        ...(normalizeUsage(completion.data.usage) ? { usage: normalizeUsage(completion.data.usage) as Usage } : {}),
      },
    };
  } catch (error) {
    if (error instanceof UpstreamFailure) {
      return { ok: false, status: error.kind === "timeout" ? 504 : 502, error: failureMessage(error) };
    }
    return { ok: false, status: 502, error: "Provider request failed." };
  }
}

/** Normalized events the browser receives (one JSON object per SSE `data:` line). */
export type StreamEvent =
  | { t: "text"; d: string }
  | { t: "reasoning"; d: string }
  | { t: "tool"; index: number; id: string; name: string }
  | { t: "done"; message: ChatSuccess["message"]; finishReason: string | null; usage: Usage | null; ms: number; responseId?: string }
  | { t: "error"; error: string };

const streamChunkSchema = z.object({
  usage: z.unknown().optional(),
  choices: z.array(z.object({
    delta: z.object({
      content: z.union([z.string(), z.null()]).optional(),
      reasoning_content: z.union([z.string(), z.null()]).optional(),
      reasoning: z.union([z.string(), z.null()]).optional(),
      tool_calls: z.array(z.object({
        index: z.number().optional(),
        id: z.string().optional(),
        function: z.object({
          name: z.string().optional(),
          arguments: z.string().optional(),
        }).passthrough().optional(),
      }).passthrough()).optional(),
    }).passthrough().optional(),
    finish_reason: z.union([z.string(), z.null()]).optional(),
  }).passthrough()).optional(),
}).passthrough();

/**
 * Streams one chat round. Resolves to a failure before any byte is sent, or to a
 * `text/event-stream` Response carrying normalized StreamEvents ending in `done`.
 */
/** One finished (or failed) model round, for the usage ledger. */
export interface RoundReport {
  usage: Usage | null;
  ms: number;
  failed: boolean;
}

export async function forwardChatStream(
  provider: ProviderConfig,
  input: ChatInput,
  clientSignal: AbortSignal,
  onRound?: (report: RoundReport) => void,
): Promise<{ ok: false; status: number; error: string } | { ok: true; response: Response }> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
  const onClientAbort = (): void => controller.abort();
  clientSignal.addEventListener("abort", onClientAbort);
  const cleanup = (): void => {
    clearTimeout(timer);
    clientSignal.removeEventListener("abort", onClientAbort);
  };
  let upstream: Response;
  try {
    const open = (field: string, withUsage: boolean): Promise<Response> =>
      fetch(`${provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { ...upstreamHeaders(provider), Accept: "text/event-stream" },
        body: chatBody(provider, input, field, true, withUsage),
        redirect: "error",
        signal: controller.signal,
      });
    let tokenField = "max_tokens";
    let withUsage = true;
    upstream = await open(tokenField, withUsage);
    // Providers differ: some reject stream_options, newer OpenAI models reject max_tokens. Adapt up to twice.
    for (let attempt = 0; attempt < 2 && upstream.status === 400; attempt++) {
      const text = await upstream.text();
      if (withUsage && /stream_options|include_usage/i.test(text)) withUsage = false;
      else if (input.maxTokens !== undefined && tokenField === "max_tokens" && text.includes("max_completion_tokens")) tokenField = "max_completion_tokens";
      else {
        cleanup();
        onRound?.({ usage: null, ms: Date.now() - started, failed: true });
        return { ok: false, status: 502, error: `Provider returned HTTP 400: ${errorDetail(text, provider)}` };
      }
      upstream = await open(tokenField, withUsage);
    }
  } catch {
    cleanup();
    onRound?.({ usage: null, ms: Date.now() - started, failed: true });
    return { ok: false, status: 502, error: "Could not reach the provider." };
  }
  if (upstream.status < 200 || upstream.status >= 300 || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    cleanup();
    onRound?.({ usage: null, ms: Date.now() - started, failed: true });
    return {
      ok: false,
      status: upstream.status === 429 ? 429 : 502,
      error: `Provider returned HTTP ${upstream.status}: ${errorDetail(text, provider)}`,
    };
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(out) {
      const send = (event: StreamEvent): void => {
        out.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      let content = "";
      let finishReason: string | null = null;
      let rawUsage: unknown;
      let reasoningChars = 0;
      const calls = new Map<number, { id: string; name: string; args: string; announced: boolean }>();
      let buffer = "";
      let total = 0;
      const handleLine = (line: string): void => {
        if (!line.startsWith("data:")) return;
        const payload = line.slice(5).trim();
        if (payload === "" || payload === "[DONE]") return;
        let json: unknown;
        try {
          json = JSON.parse(payload);
        } catch {
          return;
        }
        const chunk = streamChunkSchema.safeParse(json);
        if (!chunk.success) return;
        if (chunk.data.usage) rawUsage = chunk.data.usage;
        for (const choice of chunk.data.choices ?? []) {
          if (choice.finish_reason) finishReason = choice.finish_reason;
          const delta = choice.delta;
          if (!delta) continue;
          if (delta.content) {
            content += delta.content;
            send({ t: "text", d: delta.content });
          }
          const reasoning = delta.reasoning_content ?? delta.reasoning;
          if (reasoning) {
            reasoningChars += reasoning.length;
            send({ t: "reasoning", d: reasoning });
          }
          for (const part of delta.tool_calls ?? []) {
            const index = part.index ?? 0;
            const call = calls.get(index) ?? { id: "", name: "", args: "", announced: false };
            if (part.id) call.id = part.id;
            if (part.function?.name) call.name += part.function.name;
            if (part.function?.arguments) call.args += part.function.arguments;
            calls.set(index, call);
            if (!call.announced && call.name) {
              call.announced = true;
              send({ t: "tool", index, id: call.id, name: call.name });
            }
          }
        }
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_UPSTREAM_BYTES) throw new UpstreamFailure("too_large");
          buffer += decoder.decode(value, { stream: true });
          let nl = buffer.indexOf("\n");
          while (nl >= 0) {
            handleLine(buffer.slice(0, nl).replace(/\r$/, ""));
            buffer = buffer.slice(nl + 1);
            nl = buffer.indexOf("\n");
          }
        }
        if (buffer) handleLine(buffer);
        const tool_calls = [...calls.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([index, c]) => ({
            id: c.id || `call_${index}`,
            type: "function" as const,
            function: { name: c.name, arguments: c.args || "{}" },
          }));
        const ms = Date.now() - started;
        // Providers that ignore stream_options report nothing: estimate (flagged) so the ledger and the widget are never blank.
        const usage = normalizeUsage(rawUsage)
          ?? estimateUsage(JSON.stringify(input.messages).length + JSON.stringify(input.tools ?? []).length, content.length + reasoningChars + JSON.stringify(tool_calls).length);
        onRound?.({ usage, ms, failed: false });
        send({
          t: "done",
          message: { role: "assistant", content, ...(tool_calls.length > 0 ? { tool_calls } : {}) },
          finishReason,
          usage,
          ms,
        });
      } catch (error) {
        onRound?.({ usage: null, ms: Date.now() - started, failed: !clientSignal.aborted });
        const aborted = controller.signal.aborted;
        send({
          t: "error",
          error: error instanceof UpstreamFailure
            ? failureMessage(error)
            : aborted && !clientSignal.aborted ? "The provider did not answer in time." : "The provider stream failed.",
        });
      } finally {
        cleanup();
        reader.cancel().catch(() => undefined);
        out.close();
      }
    },
    cancel() {
      controller.abort();
      cleanup();
    },
  });
  return {
    ok: true,
    response: new Response(stream, {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", "x-accel-buffering": "no" },
    }),
  };
}
