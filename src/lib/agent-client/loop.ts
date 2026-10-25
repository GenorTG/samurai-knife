import { chat, chatStream, fetchServerToolCatalog, runServerTool, type ChatRequest, type StreamHandlers } from "./api";
import type { KnifeToolEffectInfo } from "@/lib/mcp/define";
import { assessServerCall, carriesUntrusted, type TurnContext } from "./server-tool-policy";
import { installArtifactCapture } from "./artifacts";
import { EMPTY_USAGE, addUsage, describeRunUsage, type RunUsage, type Usage } from "@/lib/usage";
import { buildSystemPrompt } from "./system-prompt";
import type {
  ApiResult,
  AssistantMessage,
  ChatReply,
  FunctionToolDef,
  ToolCall,
  ToolMessage,
  ToolRunResult,
  TranscriptMessage,
  WireMessage,
} from "./types";
import { describeCall } from "@/components/agent/summarize";
import {
  addReasoning,
  appendDraft,
  clearSteps,
  roundStarted,
  runEnded,
  runStarted,
  setPhase,
  stepFinished,
  stepStarted,
} from "./feedback";
import { runtime } from "./runtime-store";
import { UI_TOOL_DEFS, isUiTool, runUiTool, type UiToolContext } from "./ui-tools";
import { liveToolAvailable } from "./office-live-tools";
import { assessCall } from "./approval-policy";
import { LOAD_TOOLS_NAME, initialGroups, loadToolsDef, runLoadTools, visibleTools } from "./tool-groups";
import { getTrustMode, isRunAllowed, requestApproval, resetRunTrust } from "./interaction";

/**
 * Client-driven agent loop: model call -> run requested tools (UI tools here,
 * knife_* on the server) -> feed results back, until the model answers.
 * Never throws; every outcome is reported through the callbacks and return value.
 */

export const MAX_ROUNDS = 24;
export const MAX_TOOL_CALLS = 40;
export const MAX_STORED_MESSAGES = 200;

const TOOL_RESULT_LIMIT = 12000;
/** Per-round completion cap (reasoning included). Normal rounds are <500 tokens; a runaway round (copying base64, looping reasoning) otherwise burns minutes. */
const ROUND_MAX_TOKENS = 8000;
const CONTEXT_MESSAGES = 80;
const CONTEXT_CHARS = 120_000;
const OMITTED_SNAPSHOT = JSON.stringify({
  ok: true,
  omitted: "Older page snapshot dropped to save context. Call page_snapshot for the current page.",
});

export type LoopOutcome = "done" | "aborted" | "error" | "limit" | "login_required" | "provider_missing";

export interface LoopOptions {
  /** Conversation so far, ending with the new user message. */
  history: TranscriptMessage[];
  accountName: string;
  recentActions?: string[];
  onAction?: (action: string) => void;
  signal: AbortSignal;
  navigate: UiToolContext["navigate"];
  onMessage: (message: TranscriptMessage) => void;
  /**
   * Inbox read at every model-round boundary: texts the user chose to "send now" while the run is going.
   * Each one is appended to the turn as a user message before the next model call. Returns [] when empty.
   */
  takeSteering?: () => string[];
}

/* ---------------------------------------------------------- history hygiene */

const interruptedResult = (id: string): ToolMessage => ({
  role: "tool",
  tool_call_id: id,
  content: JSON.stringify({ ok: false, error: "No result recorded (the run was interrupted)." }),
});

/** Make tool_calls / tool results pair up exactly, as providers require. */
export function repairTranscript(messages: TranscriptMessage[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m.role === "tool") continue; // orphan: real ones are consumed below
    out.push(m);
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    const results = new Map<string, ToolMessage>();
    let j = i + 1;
    while (j < messages.length) {
      const next = messages[j];
      if (next.role !== "tool") break;
      results.set(next.tool_call_id, next);
      j += 1;
    }
    for (const call of m.tool_calls) out.push(results.get(call.id) ?? interruptedResult(call.id));
    i = j - 1;
  }
  return out;
}

/** Cap stored history; start on a user message so no tool result is orphaned. */
export function capTranscript(messages: TranscriptMessage[], max = MAX_STORED_MESSAGES): TranscriptMessage[] {
  if (messages.length <= max) return messages;
  const sliced = messages.slice(-max);
  const firstUser = sliced.findIndex((m) => m.role === "user");
  return firstUser === -1 ? [] : sliced.slice(firstUser);
}

function callNames(messages: WireMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant") for (const c of m.tool_calls ?? []) names.set(c.id, c.function.name);
  }
  return names;
}

function charSize(m: WireMessage): number {
  const base = m.content?.length ?? 0;
  return m.role === "assistant" ? base + JSON.stringify(m.tool_calls ?? []).length : base;
}

/** Wire messages for the model: no notices, paired tool calls, stale snapshots dropped, bounded size. */
export function toWire(transcript: TranscriptMessage[]): WireMessage[] {
  const wire = repairTranscript(transcript).filter((m): m is WireMessage => m.role !== "notice");
  const names = callNames(wire);
  const carriesSnapshot = (m: WireMessage): boolean =>
    m.role === "tool" &&
    (names.get(m.tool_call_id) === "page_snapshot" || (names.get(m.tool_call_id) === "open_tool" && m.content.includes('"snapshot":')));
  let lastSnapshot = -1;
  wire.forEach((m, i) => {
    if (carriesSnapshot(m)) lastSnapshot = i;
  });
  const slim = wire.map((m, i): WireMessage => {
    if (m.role !== "tool" || !carriesSnapshot(m) || i === lastSnapshot) return m;
    if (names.get(m.tool_call_id) === "page_snapshot") return { ...m, content: OMITTED_SNAPSHOT };
    try {
      const body = JSON.parse(m.content) as Record<string, unknown>;
      body.snapshot = "omitted (older page snapshot)";
      return { ...m, content: JSON.stringify(body) };
    } catch {
      return m;
    }
  });

  let start = slim.length;
  let chars = 0;
  while (start > 0 && slim.length - start < CONTEXT_MESSAGES && chars + charSize(slim[start - 1]) <= CONTEXT_CHARS) {
    start -= 1;
    chars += charSize(slim[start]);
  }
  while (start < slim.length && slim[start].role !== "user") start += 1;
  if (start >= slim.length) {
    const lastUser = slim.map((m) => m.role).lastIndexOf("user");
    start = Math.max(0, lastUser);
  }
  return slim.slice(start);
}

/* --------------------------------------------------------------- tool calls */

let idCounter = 0;

/**
 * Tool-call ids pair calls with results, so they must be unique across the whole
 * conversation. Some providers (and test mocks) reuse ids like "call_1" every turn;
 * rewrite any id that is already taken.
 */
export function uniqueCallIds(calls: ToolCall[], taken: ReadonlySet<string>): ToolCall[] {
  const seen = new Set(taken);
  return calls.map((call) => {
    let id = call.id;
    while (seen.has(id)) {
      idCounter += 1;
      id = `${call.id}_${Date.now().toString(36)}${idCounter.toString(36)}`;
    }
    seen.add(id);
    return id === call.id ? call : { ...call, id };
  });
}

function takenIds(messages: TranscriptMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) if (m.role === "assistant") for (const c of m.tool_calls ?? []) ids.add(c.id);
  return ids;
}

function parseArgs(raw: string): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const text = raw.trim();
  if (!text) return { ok: true, args: {} };
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return { ok: true, args: value as Record<string, unknown> };
    }
    return { ok: false, error: "Tool arguments must be a JSON object." };
  } catch {
    return { ok: false, error: "Tool arguments were not valid JSON." };
  }
}

function clipResult(content: string): string {
  return content.length > TOOL_RESULT_LIMIT
    ? `${content.slice(0, TOOL_RESULT_LIMIT)}\n…[truncated, ${content.length} chars total]`
    : content;
}

/** The durable journal records changes, never user field values or file names. */
function journalAction(name: string, label: string): string {
  if (name === "open_tool") return label;
  if (name === "fill_field") return "Filled a page field";
  if (name === "upload_file") return "Attached a file to the page";
  if (name === "click") return "Clicked a page control";
  if (name === "page_snapshot" || name === "read_text") return "Read page content";
  if (name.startsWith("knife_")) return `Used ${name.slice(6).replace(/_/g, " ")}`;
  return name.replace(/_/g, " ");
}

const DENIED = JSON.stringify({
  ok: false,
  error: "The user declined this action. Do not retry it; tell them what you wanted to do and ask how they would like to proceed.",
});

/**
 * What the approval policy knows (see server-tool-policy.ts): the user's own texts of THIS turn (the message that started
 * the run and any steering, from `turnStart`), and whether third-party text entered the conversation at all: any stored
 * message, or the server's sticky flag for this conversation (`stickyUntrusted`, from /api/agent/chat), which also
 * covers what the browser no longer holds (the capped transcript).
 */
export function turnContext(conversation: readonly TranscriptMessage[], turnStart: number, effects: Record<string, KnifeToolEffectInfo>, stickyUntrusted = false): TurnContext {
  const userTexts = conversation.slice(turnStart).flatMap((m) => (m.role === "user" ? [typeof m.content === "string" ? m.content : ""] : []));
  return { userTexts, untrustedSeen: stickyUntrusted || carriesUntrusted(conversation, effects) };
}

/** Trust-mode gate (see approval-policy.ts). Returns a ready tool result when the user said no, null to proceed. */
async function gateCall(call: ToolCall, args: Record<string, unknown>, signal: AbortSignal, server?: { info: KnifeToolEffectInfo | undefined; turn: TurnContext }): Promise<ToolRunResult | null> {
  const verdict = server
    ? assessServerCall(call.function.name, server.info, args, getTrustMode(), server.turn)
    : assessCall(call.function.name, args, call.function.arguments, getTrustMode());
  if (!verdict.ask) return null;
  if (isRunAllowed() && !verdict.destructive) return null;
  const decision = await requestApproval({ title: verdict.title, detail: verdict.detail, destructive: verdict.destructive }, signal);
  return decision === "deny" ? { ok: false, content: DENIED } : null;
}

async function executeCall(
  call: ToolCall,
  toolNames: readonly string[],
  serverToolNames: ReadonlySet<string>,
  options: LoopOptions,
  server: { effects: Record<string, KnifeToolEffectInfo>; turn: () => TurnContext },
): Promise<ToolRunResult> {
  const parsed = parseArgs(call.function.arguments);
  if (!parsed.ok) return { ok: false, content: JSON.stringify({ ok: false, error: parsed.error }) };
  const name = call.function.name;
  if (isUiTool(name)) {
    const blocked = await gateCall(call, parsed.args, options.signal);
    if (blocked) return blocked;
    return runUiTool(name, parsed.args, { navigate: options.navigate, signal: options.signal });
  }
  if (serverToolNames.has(name)) {
    const blocked = await gateCall(call, parsed.args, options.signal, { info: server.effects[name], turn: server.turn() });
    if (blocked) return blocked;
    return runServerTool(name, parsed.args, options.signal);
  }
  return { ok: false, content: JSON.stringify({ ok: false, error: `Unknown tool "${name}". Available tools: ${toolNames.join(", ")}.` }) };
}

/* --------------------------------------------------------------------- loop */

export async function runAgentTurn(options: LoopOptions): Promise<LoopOutcome> {
  const { signal, onMessage } = options;
  const onActivity = runtime.setActivity;
  installArtifactCapture();
  const working: TranscriptMessage[] = [...options.history];
  /** This turn = the user's message that started the run and everything after it (steering included). */
  const turnStart = Math.max(0, working.length - 1);
  /** The server says this conversation already holds third-party text (sticky until Clear; see turnContext). */
  let stickyUntrusted = false;
  const append = (m: TranscriptMessage) => {
    working.push(m);
    onMessage(m);
  };
  const notice = (level: "error" | "info", content: string) => append({ role: "notice", level, content });
  /** Steering texts become user messages; call only where no tool result is owed (a round boundary). */
  const deliverSteering = (): boolean => {
    const texts = options.takeSteering?.() ?? [];
    for (const content of texts) append({ role: "user", content });
    return texts.length > 0;
  };
  /** One model call with the whole (slimmed) history. `extra` (the wrap-up note) is sent but not kept in the transcript. */
  const callModel = async (
    base: Omit<ChatRequest, "messages">,
    system: string,
    handlers: StreamHandlers | null,
    extra: WireMessage[] = [],
  ): Promise<ApiResult<ChatReply>> => {
    const request: ChatRequest = { ...base, messages: [{ role: "system", content: system }, ...toWire(working), ...extra] };
    const result = await (handlers ? chatStream(request, handlers, signal) : chat(request, signal));
    if (result.ok && result.value.untrusted) stickyUntrusted = true;
    return result;
  };

  // Token telemetry for this run: summed over every model round, shown as a quiet footer when the run ends.
  const runStartedAt = Date.now();
  let used: Usage = EMPTY_USAGE;
  let rounds = 0;
  const countRound = (usage: Usage | null | undefined): void => {
    rounds += 1;
    if (usage) used = addUsage(used, usage);
  };
  const usageFooter = (): void => {
    if (rounds === 0) return;
    const run: RunUsage = { ...used, rounds, ms: Date.now() - runStartedAt };
    append({ role: "notice", level: "usage", content: describeRunUsage(run), usage: run });
  };

  runStarted();
  resetRunTrust();
  try {
    onActivity("Preparing…");
    const { defs: serverDefs, effects } = await fetchServerToolCatalog();
    const serverGate = { effects, turn: () => turnContext(working, turnStart, effects, stickyUntrusted) };
    const uiNames = new Set(UI_TOOL_DEFS.map((d) => d.function.name));
    const serverTools = serverDefs.filter((d) => !uiNames.has(d.function.name));
    const serverToolNames = new Set(serverTools.map((d) => d.function.name));
    // Database tool groups load on demand (see tool-groups.ts); execution still knows every tool.
    const allTools: FunctionToolDef[] = [...UI_TOOL_DEFS, loadToolsDef(), ...serverTools];
    const toolNames = allTools.map((d) => d.function.name);
    const activeGroups = initialGroups(window.location.pathname, working);

    let toolCalls = 0;
    let limitHit = false;

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      if (signal.aborted) return "aborted";
      deliverSteering();
      onActivity("Thinking…");
      roundStarted();
      const result = await callModel(
        { tools: visibleTools(allTools, activeGroups, liveToolAvailable), temperature: 0.2, maxTokens: ROUND_MAX_TOKENS },
        buildSystemPrompt({ pathname: window.location.pathname, accountName: options.accountName, recentActions: options.recentActions }),
        {
          onText: appendDraft,
          onReasoning: addReasoning,
          onToolStart: ({ id, name }) => stepStarted(id || `idx_${name}`, name, describeCall(name, "{}")),
        },
      );
      clearSteps();
      if (signal.aborted) return "aborted";
      if (!result.ok) {
        const f = result.failure;
        if (f.kind === "login_required") {
          notice("error", "Your session ended. Log in again to continue.");
          return "login_required";
        }
        if (f.kind === "provider_not_configured") {
          notice("error", "No model provider is configured yet. Open settings to add one.");
          return "provider_missing";
        }
        notice("error", `Model request failed: ${f.kind === "error" ? f.message : "the conversation could not be resumed."}`);
        return "error";
      }

      countRound(result.value.usage);
      const reply: AssistantMessage = result.value.message;
      const calls = uniqueCallIds(reply.tool_calls ?? [], takenIds(working));
      if (calls.length === 0) {
        if (reply.content && reply.content.trim()) append({ role: "assistant", content: reply.content });
        else notice("error", "The model returned an empty reply.");
        // The user steered while this reply was being written: the turn goes on instead of ending.
        if (round + 1 < MAX_ROUNDS && deliverSteering()) continue;
        return "done";
      }
      append({ role: "assistant", content: reply.content, tool_calls: calls });

      for (const call of calls) {
        if (signal.aborted) {
          append({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: false, error: "Cancelled by the user." }) });
          continue;
        }
        if (toolCalls >= MAX_TOOL_CALLS) {
          limitHit = true;
          append({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify({ ok: false, error: "Skipped: tool-call budget for this turn is used up." }),
          });
          continue;
        }
        toolCalls += 1;
        const label = describeCall(call.function.name, call.function.arguments);
        onActivity(label);
        setPhase("tool");
        stepStarted(call.id, call.function.name, label);
        const loading = call.function.name === LOAD_TOOLS_NAME ? parseArgs(call.function.arguments) : null;
        const run = loading
          ? loading.ok ? runLoadTools(loading.args, activeGroups, allTools) : { ok: false, content: JSON.stringify({ ok: false, error: loading.error }) }
          : await executeCall(call, toolNames, serverToolNames, options, serverGate);
        stepFinished(call.id, run.ok);
        const toolResult: ToolMessage = { role: "tool", tool_call_id: call.id, content: clipResult(run.content) };
        append(toolResult);
        if (run.ok && call.function.name !== LOAD_TOOLS_NAME) {
          options.onAction?.(`${window.location.pathname}: ${journalAction(call.function.name, label)}`.slice(0, 240));
        }
      }
      if (signal.aborted) return "aborted";
      if (limitHit) break;
    }

    // Round or tool budget exhausted: one last call without tools so the user gets a summary.
    notice("info", `Reached the per-turn limit (${MAX_ROUNDS} model rounds / ${MAX_TOOL_CALLS} tool calls). Asking the model to summarise.`);
    onActivity("Summarising…");
    runtime.advance("summarising");
    // Responses mode chains this too, so the summary lands in the same gateway session instead of a reseeded copy.
    const wrapUp = await callModel(
      { temperature: 0.2 },
      buildSystemPrompt({ pathname: window.location.pathname, accountName: options.accountName }),
      null,
      [{ role: "user", content: "[Toolbox note, not from the user] The tool budget for this turn is exhausted. Do not call tools. Briefly state what was done, what is left, and what the user can ask next." }],
    );
    if (signal.aborted) return "aborted";
    if (wrapUp.ok) countRound(wrapUp.value.usage);
    if (wrapUp.ok && wrapUp.value.message.content?.trim()) {
      append({ role: "assistant", content: wrapUp.value.message.content });
    } else if (!wrapUp.ok) {
      notice("error", "Could not get a summary from the model.");
    }
    return "limit";
  } catch (exc) {
    if (signal.aborted) return "aborted";
    notice("error", `Agent error: ${exc instanceof Error ? exc.message : "unknown error"}`);
    return "error";
  } finally {
    usageFooter();
    clearSteps();
    runEnded();
    onActivity(null);
  }
}
