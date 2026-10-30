import type { RunUsage, Usage } from "@/lib/usage";
import type { TurnLimits } from "@/lib/agent-client/turn-limits";

/**
 * Shared types for the browser-side agent. The wire shapes follow the OpenAI
 * chat-completions format because /api/agent/chat forwards them verbatim.
 */

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
}

export interface ToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

export type WireMessage = UserMessage | AssistantMessage | ToolMessage;

/** Local-only transcript entry (errors, limits). Never sent to the model. */
export interface NoticeMessage {
  role: "notice";
  /** "usage" is the quiet per-turn token footer; `usage` carries the numbers, `content` the same as text. */
  level: "error" | "info" | "usage";
  content: string;
  usage?: RunUsage;
}

/**
 * Stored summary of messages that fell off the capped transcript (context.ts): always first, shown as "Older messages
 * summarised", sent to the model inside the system prompt. `summarised` = how many earlier turns it stands for.
 */
export interface SummaryNotice {
  role: "notice";
  level: "summary";
  content: string;
  summarised?: number;
}

export type TranscriptMessage = WireMessage | NoticeMessage | SummaryNotice;

export interface FunctionToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type ReasoningEffort = "low" | "medium" | "high";

export interface ProviderInfo {
  baseUrl: string;
  model: string;
  hasKey: boolean;
  keyHint: string | null;
  extraHeaderNames: string[];
  reasoningEffort: ReasoningEffort | null;
  /** `native` = the model sees images; `none` = text-only (src/lib/vision/config.ts). */
  vision: "native" | "none";
  /** Profile id of the vision helper (describes images for a text-only model), or null. */
  visionHelper: string | null;
}

/** A saved provider profile (hints only, never the key); `active` = the assistant's provider. */
export interface ProviderProfileInfo extends ProviderInfo {
  id: string;
  name: string;
  active: boolean;
}

export interface AccountInfo {
  id: string;
  displayName: string;
  requiresPassword: boolean;
  provider: ProviderInfo | null;
  providerProfiles: ProviderProfileInfo[];
  /** The assistant's per-turn budget (src/lib/agent-client/turn-limits.ts); `custom` = the user changed the defaults. */
  assistant: TurnLimits & { custom: boolean };
}

export interface AccountChoice {
  id: string;
  displayName: string;
}

export interface ProviderInput {
  baseUrl: string;
  model: string;
  apiKey?: string;
  extraHeaders?: Record<string, string>;
  reasoningEffort?: ReasoningEffort | "";
  vision?: "native" | "none" | "";
  visionHelper?: string;
}

export interface ProviderTestResult {
  ok: boolean;
  status?: number;
  modelCount?: number;
  /** Model ids the provider lists (GET /models), sorted. */
  models?: string[];
  modelDetails?: ProviderModelDetails[];
  error?: string;
}

export interface ProviderModelDetails {
  id: string;
  contextLength: number | null;
  vision: boolean | null;
  /** `advertised` = the provider's /models says so; `detected` = the vision probe learned it; null = unknown. */
  visionSource: "advertised" | "detected" | null;
  visionCheckedAt?: string;
  features: string[];
  /** Provider's human-readable name (Anthropic `display_name`). */
  displayName?: string;
  createdAt?: string;
}

/** One model's answer from POST /api/account/provider/vision-probe. */
export interface VisionProbeResult {
  model: string;
  vision: boolean | null;
  source: "detected" | null;
  reason: "saw" | "rejected" | "no_image" | "unclear" | "error" | "cached" | "rate_limited";
  status: number | null;
  checkedAt?: string;
}

export interface ChatReply {
  message: AssistantMessage;
  finishReason: string | null;
  /** Tokens this round cost (provider-reported, or flagged estimated); null when unknown. */
  usage?: Usage | null;
  /** Server-side wall time of the round in ms. */
  ms?: number;
  /** The server's sticky flag: third-party text has entered this conversation (header `x-knife-untrusted: 1`). */
  untrusted?: boolean;
}

export type ApiFailure =
  | { kind: "login_required"; accounts: AccountChoice[] }
  | { kind: "provider_not_configured" }
  | { kind: "error"; message: string; status: number };

export type ApiResult<T> = { ok: true; value: T } | { ok: false; failure: ApiFailure };

export interface ToolRunResult {
  ok: boolean;
  /** Text handed back to the model (JSON string for UI tools). */
  content: string;
}
