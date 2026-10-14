import type { RunUsage, Usage } from "@/lib/usage";

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

export type TranscriptMessage = WireMessage | NoticeMessage;

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
  openClawResponses: boolean;
}

export interface AccountInfo {
  id: string;
  displayName: string;
  requiresPassword: boolean;
  provider: ProviderInfo | null;
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
  openClawResponses?: boolean;
}

export interface ProviderTestResult {
  ok: boolean;
  status?: number;
  modelCount?: number;
  error?: string;
}

export interface ChatReply {
  message: AssistantMessage;
  finishReason: string | null;
  /** Tokens this round cost (provider-reported, or flagged estimated); null when unknown. */
  usage?: Usage | null;
  /** Server-side wall time of the round in ms. */
  ms?: number;
  /** OpenResponses continuation identifier (OpenClaw provider mode only). */
  responseId?: string;
}

export type ApiFailure =
  | { kind: "login_required"; accounts: AccountChoice[] }
  | { kind: "provider_not_configured" }
  /** OpenClaw Responses mode: the server dropped the continuation chain; resend the full history without a response id. */
  | { kind: "continuation_lost" }
  | { kind: "error"; message: string; status: number };

export type ApiResult<T> = { ok: true; value: T } | { ok: false; failure: ApiFailure };

export interface ToolRunResult {
  ok: boolean;
  /** Text handed back to the model (JSON string for UI tools). */
  content: string;
}
