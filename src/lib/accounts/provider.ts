import { estimateUsage, normalizeUsage, type Usage } from "@/lib/usage";
import * as z from "zod/v4";
import type { ProviderConfig } from "@/lib/accounts/store";
import { checkUrl, OutboundError, readTextCapped, resolveAllowed, safeFetch, type OutboundPolicy } from "@/lib/net/safe-fetch";

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
/**
 * Extra headers a non-admin may not set in public mode: hop-by-hop and framing headers, proxy and client-address headers
 * (impersonating a trusted proxy towards the upstream), credentials other than the managed Authorization, method
 * overrides, and the OpenClaw gateway's own routing headers.
 */
const USER_FORBIDDEN_HEADERS = new Set([
  "keep-alive", "te", "trailer", "upgrade", "via", "expect", "proxy-authorization", "proxy-connection", "forwarded",
  "x-real-ip", "x-client-ip", "client-ip", "true-client-ip", "cf-connecting-ip", "fastly-client-ip", "x-cluster-client-ip",
  "x-http-method-override", "x-http-method", "x-method-override", "set-cookie", "origin", "referer",
]);
const USER_FORBIDDEN_PREFIXES = ["x-forwarded-", "x-original-", "x-rewrite-", "proxy-", "x-openclaw-", "x-envoy-", "x-amzn-", "sec-"];
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;

/** How one account's provider requests may go out (`src/lib/net/outbound.ts` builds it). */
export interface ProviderNet {
  policy: OutboundPolicy;
  /** Show raw upstream error text (private mode, admins); otherwise only a provider-shaped JSON error message. */
  echoUpstream: boolean;
}

/** Private mode / tests: any address, raw errors (the behaviour before public mode existed). */
export const OPEN_NET: ProviderNet = { policy: { allowPrivate: true, ports: null, httpsOnly: false }, echoUpstream: true };

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

/** `strict`: the public-mode user rules on top (USER_FORBIDDEN_*). */
export function validateExtraHeaders(headers: Record<string, string>, strict = false): string | null {
  const names = Object.keys(headers);
  if (names.length > 16) return "At most 16 extra headers are allowed.";
  for (const name of names) {
    if (!HEADER_NAME.test(name)) return `Invalid header name: ${name}`;
    const lower = name.toLowerCase();
    if (FORBIDDEN_HEADERS.has(lower)) return `Header ${name} is managed by the server.`;
    if (strict && (USER_FORBIDDEN_HEADERS.has(lower) || USER_FORBIDDEN_PREFIXES.some((prefix) => lower.startsWith(prefix)))) {
      return `Header ${name} is not allowed.`;
    }
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
  readonly kind: "timeout" | "network" | "too_large" | "refused";
  readonly detail: string;
  constructor(kind: UpstreamFailure["kind"], detail = "") {
    super(kind);
    this.kind = kind;
    this.detail = detail;
  }
}

/** Static + DNS check of a base URL under `policy`; null = allowed. Used when the provider is saved (and per request). */
export async function baseUrlProblem(baseUrl: string, policy: OutboundPolicy): Promise<string | null> {
  try {
    const url = new URL(`${baseUrl}/models`);
    checkUrl(url, policy);
    await resolveAllowed(url, policy);
    return null;
  } catch (error) {
    if (error instanceof OutboundError) return error.message;
    return "baseUrl is not a valid URL.";
  }
}

/** Every provider request: through the SSRF-safe transport (resolve, check, pin; redirects are errors). */
function providerFetch(provider: ProviderConfig, net: ProviderNet, path: string, init: { method: "GET" | "POST"; body?: string; accept?: string; signal: AbortSignal }): Promise<Response> {
  return safeFetch(`${provider.baseUrl}${path}`, {
    method: init.method,
    headers: { ...upstreamHeaders(provider), ...(init.accept ? { Accept: init.accept } : {}) },
    body: init.body,
    signal: init.signal,
    policy: net.policy,
  });
}

/** A failed providerFetch -> UpstreamFailure (timeouts and aborts by name, refusals with their reason). */
function asUpstreamFailure(error: unknown): UpstreamFailure {
  if (error instanceof UpstreamFailure) return error;
  if (error instanceof OutboundError) return new UpstreamFailure(error.kind === "refused" || error.kind === "resolve" ? "refused" : "network", error.message);
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return new UpstreamFailure("timeout");
  return new UpstreamFailure("network");
}

async function upstreamFetch(
  provider: ProviderConfig,
  net: ProviderNet,
  path: string,
  init: { method: "GET" | "POST"; body?: string },
  timeoutMs: number,
): Promise<{ status: number; text: string }> {
  try {
    const response = await providerFetch(provider, net, path, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await readTextCapped(response, MAX_UPSTREAM_BYTES);
    if (text === null) throw new UpstreamFailure("too_large");
    return { status: response.status, text };
  } catch (error) {
    throw asUpstreamFailure(error);
  }
}

function failureMessage(failure: UpstreamFailure): string {
  if (failure.kind === "timeout") return "The provider did not answer in time.";
  if (failure.kind === "too_large") return "The provider response was too large.";
  if (failure.kind === "refused") return `The provider address is not allowed: ${failure.detail}`;
  return "Could not reach the provider.";
}

/**
 * The part of an upstream error answer shown to the user. A provider-shaped JSON error (`{error: "..."}` or
 * `{error: {message}}`) always; anything else (an HTML page, a body from some other service) only with `echo`.
 */
function errorDetail(text: string, provider: ProviderConfig, echo: boolean): string {
  let detail: string | null = echo ? text : null;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    const inner = parsed.error;
    if (typeof inner === "string") detail = inner;
    else if (inner && typeof inner === "object" && "message" in inner && typeof inner.message === "string") {
      detail = inner.message;
    }
  } catch {
    // keep raw text (echo) or nothing
  }
  if (detail === null) return "(response body not shown)";
  return redact(detail, provider).slice(0, MAX_ERROR_DETAIL_CHARS);
}

export interface ProviderTestResult {
  ok: boolean;
  status: number | null;
  modelCount?: number;
  error?: string;
}

const modelListSchema = z.object({ data: z.array(z.unknown()) }).passthrough();

export async function testProvider(provider: ProviderConfig, net: ProviderNet): Promise<ProviderTestResult> {
  try {
    const { status, text } = await upstreamFetch(provider, net, "/models", { method: "GET" }, TEST_TIMEOUT_MS);
    if (status < 200 || status >= 300) {
      return { ok: false, status, error: `Provider returned HTTP ${status}: ${errorDetail(text, provider, net.echoUpstream)}` };
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

export async function forwardChat(provider: ProviderConfig, input: ChatInput, net: ProviderNet): Promise<ChatOutcome> {
  try {
    let response = await upstreamFetch(
      provider,
      net,
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
        net,
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
        error: `Provider returned HTTP ${response.status}: ${errorDetail(response.text, provider, net.echoUpstream)}`,
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
  | { t: "done"; message: ChatSuccess["message"]; finishReason: string | null; usage: Usage | null; ms: number }
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
  onRound: ((report: RoundReport) => void) | undefined,
  net: ProviderNet,
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
      providerFetch(provider, net, "/chat/completions", {
        method: "POST",
        accept: "text/event-stream",
        body: chatBody(provider, input, field, true, withUsage),
        signal: controller.signal,
      });
    let tokenField = "max_tokens";
    let withUsage = true;
    upstream = await open(tokenField, withUsage);
    // Providers differ: some reject stream_options, newer OpenAI models reject max_tokens. Adapt up to twice.
    for (let attempt = 0; attempt < 2 && upstream.status === 400; attempt++) {
      const text = (await readTextCapped(upstream, MAX_UPSTREAM_BYTES)) ?? "";
      if (withUsage && /stream_options|include_usage/i.test(text)) withUsage = false;
      else if (input.maxTokens !== undefined && tokenField === "max_tokens" && text.includes("max_completion_tokens")) tokenField = "max_completion_tokens";
      else {
        cleanup();
        onRound?.({ usage: null, ms: Date.now() - started, failed: true });
        return { ok: false, status: 502, error: `Provider returned HTTP 400: ${errorDetail(text, provider, net.echoUpstream)}` };
      }
      upstream = await open(tokenField, withUsage);
    }
  } catch (error) {
    cleanup();
    onRound?.({ usage: null, ms: Date.now() - started, failed: true });
    const failure = asUpstreamFailure(error);
    return { ok: false, status: 502, error: failureMessage(failure.kind === "timeout" ? new UpstreamFailure("network") : failure) };
  }
  if (upstream.status < 200 || upstream.status >= 300 || !upstream.body) {
    const text = (await readTextCapped(upstream, MAX_UPSTREAM_BYTES).catch(() => "")) ?? "";
    cleanup();
    onRound?.({ usage: null, ms: Date.now() - started, failed: true });
    return {
      ok: false,
      status: upstream.status === 429 ? 429 : 502,
      error: `Provider returned HTTP ${upstream.status}: ${errorDetail(text, provider, net.echoUpstream)}`,
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
