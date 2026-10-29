import { parseUsage, type UsageSummary } from "@/lib/usage";
import type { KnifeToolEffectInfo } from "@/lib/mcp/define";
import { UNTRUSTED_HEADER } from "./server-tool-policy";
import type {
  AccountChoice,
  AccountInfo,
  ApiFailure,
  ApiResult,
  AssistantMessage,
  ChatReply,
  FunctionToolDef,
  ProviderInfo,
  ProviderInput,
  ProviderModelDetails,
  ProviderTestResult,
  ToolCall,
  ToolRunResult,
  WireMessage,
  ProviderProfileInfo,
  VisionProbeResult,
} from "./types";
import { resolveTurnLimits, type TurnLimits } from "./turn-limits";
import type { ConversationContent, DurableConversation } from "./conversation-store";

/**
 * Typed wrappers around the account/agent routes. Every function resolves to an
 * ApiResult and never throws, so callers only deal with values.
 */

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function parseChoices(value: unknown): AccountChoice[] {
  if (!Array.isArray(value)) return [];
  const out: AccountChoice[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = str(item.id);
    if (id === null) continue;
    out.push({ id, displayName: str(item.displayName) ?? id });
  }
  return out;
}

function failureFrom(res: Response, body: unknown): ApiFailure {
  const code = isRecord(body) ? str(body.error) : null;
  if (res.status === 401 && code === "login_required") {
    return { kind: "login_required", accounts: parseChoices(isRecord(body) ? body.accounts : null) };
  }
  if (res.status === 409 && code === "provider_not_configured") {
    return { kind: "provider_not_configured" };
  }
  return { kind: "error", status: res.status, message: code ?? `HTTP ${res.status}` };
}

async function call(
  path: string,
  init?: { method?: string; body?: unknown; signal?: AbortSignal },
): Promise<{ res: Response; body: unknown } | { failure: ApiFailure }> {
  try {
    const res = await fetch(path, {
      method: init?.method ?? "GET",
      headers: init?.body === undefined ? undefined : { "content-type": "application/json" },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init?.signal,
      cache: "no-store",
    });
    return { res, body: await readJson(res) };
  } catch (exc) {
    if (init?.signal?.aborted) return { failure: { kind: "error", status: 0, message: "aborted" } };
    const message = exc instanceof Error ? exc.message : "network error";
    return { failure: { kind: "error", status: 0, message } };
  }
}

function parseProvider(value: unknown): ProviderInfo | null {
  if (!isRecord(value)) return null;
  const baseUrl = str(value.baseUrl);
  const model = str(value.model);
  if (baseUrl === null || model === null) return null;
  return {
    baseUrl,
    model,
    hasKey: value.hasKey === true,
    keyHint: str(value.keyHint),
    extraHeaderNames: Array.isArray(value.extraHeaderNames)
      ? value.extraHeaderNames.filter((n): n is string => typeof n === "string")
      : [],
    reasoningEffort:
      value.reasoningEffort === "low" || value.reasoningEffort === "medium" || value.reasoningEffort === "high"
        ? value.reasoningEffort
        : null,
    vision: value.vision === "native" ? "native" : "none",
    visionHelper: str(value.visionHelper),
  };
}

export async function fetchAccount(): Promise<ApiResult<AccountInfo>> {
  const r = await call("/api/account");
  if ("failure" in r) return { ok: false, failure: r.failure };
  const { res, body } = r;
  if (!res.ok || !isRecord(body)) return { ok: false, failure: failureFrom(res, body) };
  const id = str(body.id);
  if (id === null) return { ok: false, failure: { kind: "error", status: res.status, message: "bad account response" } };
  return {
    ok: true,
    value: {
      id,
      displayName: str(body.displayName) ?? id,
      requiresPassword: body.requiresPassword === true,
      provider: parseProvider(body.provider),
      providerProfiles: parseProfiles(body.providerProfiles),
      assistant: parseAssistant(body.assistant),
    },
  };
}

function parseAssistant(value: unknown): AccountInfo["assistant"] {
  return { ...resolveTurnLimits(isRecord(value) ? { maxRounds: value.maxRounds, maxToolCalls: value.maxToolCalls } : null), custom: isRecord(value) && value.custom === true };
}

/** PUT /api/account/assistant: the per-turn budget (null = back to the defaults). */
export async function saveTurnLimits(limits: TurnLimits | null): Promise<ApiResult<null>> {
  const r = await call("/api/account/assistant", { method: "PUT", body: limits ?? { reset: true } });
  if ("failure" in r) return { ok: false, failure: r.failure };
  if (!r.res.ok) return { ok: false, failure: failureFrom(r.res, r.body) };
  return { ok: true, value: null };
}

function parseProfiles(value: unknown): ProviderProfileInfo[] {
  if (!Array.isArray(value)) return [];
  const out: ProviderProfileInfo[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const provider = parseProvider(entry);
    const id = str(entry.id);
    const name = str(entry.name);
    if (provider && id && name) out.push({ ...provider, id, name, active: entry.active === true });
  }
  return out;
}

type ProfileAction =
  | { action: "create"; name: string; provider: ProviderInput; activate?: boolean; from?: string }
  | { action: "update"; id: string; name: string; provider: ProviderInput }
  | { action: "duplicate"; id: string; name: string }
  | { action: "activate"; id: string }
  | { action: "delete"; id: string };

/** POST /api/account/provider-profiles: saved provider profiles (create, update, duplicate, activate, delete). */
export async function changeProfile(body: ProfileAction): Promise<ApiResult<null>> {
  const r = await call("/api/account/provider-profiles", { method: "POST", body });
  if ("failure" in r) return { ok: false, failure: r.failure };
  if (!r.res.ok) return { ok: false, failure: failureFrom(r.res, r.body) };
  return { ok: true, value: null };
}

export async function saveProvider(input: ProviderInput): Promise<ApiResult<null>> {
  const r = await call("/api/account/provider", { method: "PUT", body: input });
  if ("failure" in r) return { ok: false, failure: r.failure };
  if (!r.res.ok) return { ok: false, failure: failureFrom(r.res, r.body) };
  return { ok: true, value: null };
}

function parseModelDetails(value: unknown): ProviderModelDetails[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ProviderModelDetails[] = [];
  for (const entry of value.slice(0, 400)) {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length > 200) continue;
    const features = Array.isArray(entry.features)
      ? entry.features.filter((feature): feature is string => typeof feature === "string").slice(0, 20)
      : [];
    out.push({
      id: entry.id,
      contextLength: typeof entry.contextLength === "number" && Number.isSafeInteger(entry.contextLength) ? entry.contextLength : null,
      vision: typeof entry.vision === "boolean" ? entry.vision : null,
      visionSource: entry.visionSource === "advertised" || entry.visionSource === "detected" ? entry.visionSource : null,
      ...(typeof entry.visionCheckedAt === "string" ? { visionCheckedAt: entry.visionCheckedAt } : {}),
      features,
      ...(typeof entry.displayName === "string" && entry.displayName.length <= 120 ? { displayName: entry.displayName } : {}),
      ...(typeof entry.createdAt === "string" && entry.createdAt.length <= 40 ? { createdAt: entry.createdAt } : {}),
    });
  }
  return out;
}

function testResult(res: Response, body: unknown): ApiResult<ProviderTestResult> {
  if (!isRecord(body)) return { ok: false, failure: failureFrom(res, body) };
  if (!res.ok && body.ok === undefined) return { ok: false, failure: failureFrom(res, body) };
  return {
    ok: true,
    value: {
      ok: body.ok === true,
      status: typeof body.status === "number" ? body.status : undefined,
      modelCount: typeof body.modelCount === "number" ? body.modelCount : undefined,
      models: Array.isArray(body.models) ? body.models.filter((m): m is string => typeof m === "string") : undefined,
      modelDetails: parseModelDetails(body.modelDetails),
      error: str(body.error) ?? undefined,
    },
  };
}

export async function testProvider(profileId?: string): Promise<ApiResult<ProviderTestResult>> {
  const r = await call("/api/account/provider/test", { method: "POST", body: profileId ? { profileId } : {} });
  if ("failure" in r) return { ok: false, failure: r.failure };
  return testResult(r.res, r.body);
}

/** The models a provider lists for the fields as typed (not saved); the stored key only for the stored address. */
export async function listModels(input: { baseUrl: string; apiKey?: string; extraHeaders?: Record<string, string> }): Promise<ApiResult<ProviderTestResult>> {
  const r = await call("/api/account/provider/models", { method: "POST", body: input });
  if ("failure" in r) return { ok: false, failure: r.failure };
  return testResult(r.res, r.body);
}

export async function login(id: string, password: string): Promise<ApiResult<null>> {
  const r = await call("/api/account/login", { method: "POST", body: { id, password } });
  if ("failure" in r) return { ok: false, failure: r.failure };
  if (!r.res.ok) return { ok: false, failure: failureFrom(r.res, r.body) };
  return { ok: true, value: null };
}

export async function logout(): Promise<ApiResult<null>> {
  const r = await call("/api/account/logout", { method: "POST", body: {} });
  if ("failure" in r) return { ok: false, failure: r.failure };
  if (!r.res.ok) return { ok: false, failure: failureFrom(r.res, r.body) };
  return { ok: true, value: null };
}

export async function fetchConversation(chatId = "default"): Promise<ApiResult<DurableConversation>> {
  const r = await call(`/api/agent/conversation?chat=${encodeURIComponent(chatId)}`);
  if ("failure" in r) return { ok: false, failure: r.failure };
  if (!r.res.ok || !isRecord(r.body) || !Array.isArray(r.body.messages) || !Array.isArray(r.body.actions)) {
    return { ok: false, failure: failureFrom(r.res, r.body) };
  }
  return { ok: true, value: {
    version: 1,
    messages: r.body.messages as DurableConversation["messages"],
    actions: r.body.actions.filter((item): item is string => typeof item === "string"),
  } };
}

/** Saves the browser-owned part only; the taint flag is the server's (/api/agent/chat). */
export async function saveConversation(content: ConversationContent, chatId = "default"): Promise<ApiResult<null>> {
  const r = await call(`/api/agent/conversation?chat=${encodeURIComponent(chatId)}`, { method: "PUT", body: content });
  if ("failure" in r) return { ok: false, failure: r.failure };
  return r.res.ok ? { ok: true, value: null } : { ok: false, failure: failureFrom(r.res, r.body) };
}

export async function resetConversation(chatId = "default"): Promise<ApiResult<null>> {
  const r = await call(`/api/agent/conversation?chat=${encodeURIComponent(chatId)}`, { method: "DELETE" });
  if ("failure" in r) return { ok: false, failure: r.failure };
  return r.res.ok ? { ok: true, value: null } : { ok: false, failure: failureFrom(r.res, r.body) };
}

function parseToolCalls(value: unknown): ToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ToolCall[] = [];
  value.forEach((item, index) => {
    if (!isRecord(item) || !isRecord(item.function)) return;
    const name = str(item.function.name);
    if (!name) return;
    const args = item.function.arguments;
    out.push({
      id: str(item.id) || `call_${Date.now().toString(36)}_${index}`,
      type: "function",
      function: {
        name,
        arguments: typeof args === "string" ? args : args === undefined ? "{}" : JSON.stringify(args),
      },
    });
  });
  return out.length > 0 ? out : undefined;
}

/** /api/agent/chat marks a conversation that holds third-party text (conversation-store.ts `untrusted`). */
function untrustedHeader(res: Response): boolean {
  return res.headers.get(UNTRUSTED_HEADER) === "1";
}

export interface ChatRequest {
  chatId?: string;
  messages: (WireMessage | { role: "system"; content: string })[];
  tools?: FunctionToolDef[];
  temperature?: number;
  maxTokens?: number;
}

export async function chat(request: ChatRequest, signal?: AbortSignal): Promise<ApiResult<ChatReply>> {
  const r = await call("/api/agent/chat", { method: "POST", body: request, signal });
  if ("failure" in r) return { ok: false, failure: r.failure };
  const { res, body } = r;
  if (!res.ok || !isRecord(body) || !isRecord(body.message)) {
    const failure = failureFrom(res, body);
    if (failure.kind === "error" && isRecord(body) && typeof body.detail === "string") {
      failure.message = `${failure.message}: ${body.detail}`;
    }
    return { ok: false, failure };
  }
  const message: AssistantMessage = {
    role: "assistant",
    content: typeof body.message.content === "string" ? body.message.content : null,
    tool_calls: parseToolCalls(body.message.tool_calls),
  };
  return {
    ok: true,
    value: {
      message,
      finishReason: str(body.finishReason),
      usage: parseUsage(body.usage),
      ...(untrustedHeader(res) ? { untrusted: true } : {}),
    },
  };
}

export interface ServerToolCatalog {
  defs: FunctionToolDef[];
  /** Declared effect per tool (src/lib/mcp/define.ts) for the approval policy; never sent to the model. */
  effects: Record<string, KnifeToolEffectInfo>;
}

const EFFECTS = new Set(["read", "write", "destructive", "outbound"]);

function parseEffects(value: unknown): Record<string, KnifeToolEffectInfo> {
  const out: Record<string, KnifeToolEffectInfo> = {};
  if (!isRecord(value)) return out;
  for (const [name, info] of Object.entries(value)) {
    if (!isRecord(info) || typeof info.effect !== "string" || !EFFECTS.has(info.effect)) continue;
    const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    const when = Array.isArray(info.destructiveWhen)
      ? info.destructiveWhen.flatMap((d) => (isRecord(d) && typeof d.arg === "string" && (d.when === "true" || d.when === "nonEmpty") ? [{ arg: d.arg, when: d.when as "true" | "nonEmpty" }] : []))
      : [];
    out[name] = { effect: info.effect as KnifeToolEffectInfo["effect"], urlArgs: strings(info.urlArgs), destructiveWhen: when, untrustedOutput: info.untrustedOutput === true, publishes: info.publishes === true };
  }
  return out;
}

export async function fetchServerTools(): Promise<FunctionToolDef[]> {
  return (await fetchServerToolCatalog()).defs;
}

export async function fetchServerToolCatalog(): Promise<ServerToolCatalog> {
  const r = await call("/api/agent/tools");
  if ("failure" in r || !r.res.ok) return { defs: [], effects: {} };
  const raw = isRecord(r.body) && Array.isArray(r.body.tools) ? r.body.tools : r.body;
  const effects = isRecord(r.body) ? parseEffects(r.body.effects) : {};
  if (!Array.isArray(raw)) return { defs: [], effects };
  const out: FunctionToolDef[] = [];
  for (const item of raw) {
    if (!isRecord(item) || !isRecord(item.function)) continue;
    const name = str(item.function.name);
    if (!name) continue;
    out.push({
      type: "function",
      function: {
        name,
        description: str(item.function.description) ?? "",
        parameters: isRecord(item.function.parameters) ? item.function.parameters : { type: "object", properties: {} },
      },
    });
  }
  return { defs: out, effects };
}

export async function runServerTool(
  name: string,
  args: unknown,
  signal?: AbortSignal,
): Promise<ToolRunResult> {
  const r = await call("/api/agent/tool", { method: "POST", body: { name, args }, signal });
  if ("failure" in r) return { ok: false, content: `Tool request failed: ${r.failure.kind === "error" ? r.failure.message : r.failure.kind}` };
  const { res, body } = r;
  if (isRecord(body) && body.ok === true) {
    const content = body.content;
    return { ok: true, content: typeof content === "string" ? content : JSON.stringify(content ?? null) };
  }
  const error = isRecord(body) ? (str(body.error) ?? str(body.content)) : null;
  return { ok: false, content: error ?? `Tool failed (HTTP ${res.status}).` };
}

export interface StreamHandlers {
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  /** Fired as soon as the model names a tool, before its arguments finish. */
  onToolStart?: (info: { index: number; id: string; name: string }) => void;
}

function parseStreamEvent(line: string): Json | null {
  if (!line.startsWith("data:")) return null;
  try {
    const value: unknown = JSON.parse(line.slice(5).trim());
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** Streaming variant of `chat`: resolves to the same ChatReply once the round ends. */
export async function chatStream(
  request: ChatRequest,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<ApiResult<ChatReply>> {
  let res: Response;
  try {
    res = await fetch("/api/agent/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, stream: true }),
      signal,
      cache: "no-store",
    });
  } catch (exc) {
    if (signal?.aborted) return { ok: false, failure: { kind: "error", status: 0, message: "aborted" } };
    return { ok: false, failure: { kind: "error", status: 0, message: exc instanceof Error ? exc.message : "network error" } };
  }
  if (!res.ok || !res.body) return { ok: false, failure: failureFrom(res, await readJson(res)) };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reply: ChatReply | null = null;
  let streamError: string | null = null;
  const handle = (line: string): void => {
    const event = parseStreamEvent(line);
    if (!event) return;
    const kind = str(event.t);
    if (kind === "text") handlers.onText?.(str(event.d) ?? "");
    else if (kind === "reasoning") handlers.onReasoning?.(str(event.d) ?? "");
    else if (kind === "tool") {
      handlers.onToolStart?.({
        index: typeof event.index === "number" ? event.index : 0,
        id: str(event.id) ?? "",
        name: str(event.name) ?? "",
      });
    } else if (kind === "error") streamError = str(event.error) ?? "stream failed";
    else if (kind === "done" && isRecord(event.message)) {
      reply = {
        message: {
          role: "assistant",
          content: typeof event.message.content === "string" && event.message.content !== "" ? event.message.content : null,
          tool_calls: parseToolCalls(event.message.tool_calls),
        },
        finishReason: str(event.finishReason),
        usage: parseUsage(event.usage),
        ...(typeof event.ms === "number" ? { ms: event.ms } : {}),
      };
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        handle(buffer.slice(0, nl).trim());
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
    }
    if (buffer.trim()) handle(buffer.trim());
  } catch {
    if (signal?.aborted) return { ok: false, failure: { kind: "error", status: 0, message: "aborted" } };
    return { ok: false, failure: { kind: "error", status: 0, message: "stream interrupted" } };
  }
  if (streamError !== null) return { ok: false, failure: { kind: "error", status: 502, message: streamError } };
  if (reply === null) return { ok: false, failure: { kind: "error", status: 502, message: "stream ended without a reply" } };
  return { ok: true, value: untrustedHeader(res) ? { ...(reply as ChatReply), untrusted: true } : reply };
}

/** This account's token counters from the server-side ledger (today, 7 days, total, per model). */
export async function fetchUsage(): Promise<UsageSummary | null> {
  const r = await call("/api/account/usage");
  if ("failure" in r || !r.res.ok || !isRecord(r.body)) return null;
  return r.body as unknown as UsageSummary;
}

const PROBE_REASONS = new Set<VisionProbeResult["reason"]>(["saw", "rejected", "no_image", "unclear", "error", "cached", "rate_limited"]);

/**
 * POST /api/account/provider/vision-probe: ask up to 6 models whether they see images (one tiny request each, answers
 * remembered on the server). Same fields as listModels: the stored key only for the stored address.
 */
export async function probeVisionModels(input: { baseUrl: string; apiKey?: string; extraHeaders?: Record<string, string>; models: string[]; force?: boolean }): Promise<ApiResult<VisionProbeResult[]>> {
  const r = await call("/api/account/provider/vision-probe", { method: "POST", body: input });
  if ("failure" in r) return { ok: false, failure: r.failure };
  if (!r.res.ok || !isRecord(r.body) || !Array.isArray(r.body.results)) return { ok: false, failure: failureFrom(r.res, r.body) };
  const out: VisionProbeResult[] = [];
  for (const entry of r.body.results) {
    if (!isRecord(entry) || typeof entry.model !== "string") continue;
    const reason = typeof entry.reason === "string" && PROBE_REASONS.has(entry.reason as VisionProbeResult["reason"]) ? (entry.reason as VisionProbeResult["reason"]) : "error";
    out.push({
      model: entry.model,
      vision: typeof entry.vision === "boolean" ? entry.vision : null,
      source: entry.source === "detected" ? "detected" : null,
      reason,
      status: typeof entry.status === "number" ? entry.status : null,
      ...(typeof entry.checkedAt === "string" ? { checkedAt: entry.checkedAt } : {}),
    });
  }
  return { ok: true, value: out };
}
