import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { openClawResponsesProblem } from "@/lib/accounts/openclaw-target";
import {
  CONTINUATION_LOST,
  forwardChat,
  forwardChatStream,
  forwardResponses,
  forwardResponsesStream,
  type ResponsesSettlement,
} from "@/lib/accounts/provider";
import { getAccount } from "@/lib/accounts/store";
import {
  beginResponsesRound,
  breakContinuation,
  commitResponsesRound,
  providerConversationId,
  type RoundStart,
} from "@/lib/agent-client/conversation-store";
import { recordRound } from "@/lib/accounts/usage-ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGES = 200;
const MAX_TOOLS = 64;

const contentPart = z.record(z.string(), z.unknown());
const content = z.union([z.string(), z.array(contentPart).max(64)]);

const toolCall = z.object({
  id: z.string().min(1).max(256),
  type: z.literal("function").optional(),
  function: z.object({
    name: z.string().min(1).max(128),
    arguments: z.string().max(200_000),
  }).passthrough(),
}).passthrough();

const message = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content }).passthrough(),
  z.object({ role: z.literal("user"), content }).passthrough(),
  z.object({
    role: z.literal("assistant"),
    content: z.union([z.string(), z.null()]).optional(),
    tool_calls: z.array(toolCall).max(32).optional(),
  }).passthrough(),
  z.object({
    role: z.literal("tool"),
    tool_call_id: z.string().min(1).max(256),
    content: z.string(),
  }).passthrough(),
]);

const toolDefinition = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string().min(1).max(128),
    description: z.string().max(8_000).optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }).passthrough(),
}).passthrough();

const bodySchema = z.object({
  messages: z.array(message).min(1).max(MAX_MESSAGES),
  tools: z.array(toolDefinition).max(MAX_TOOLS).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(64_000).optional(),
  stream: z.boolean().optional(),
  previousResponseId: z.string().max(256).nullable().optional(),
}).strict();

export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;

  const read = await readJsonBody(request, MAX_BODY_BYTES);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) {
    return jsonError(parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "), 400);
  }

  const provider = getAccount(auth.account.id)?.provider;
  if (!provider) return jsonError("provider_not_configured", 409);

  const input = {
    model: provider.model,
    messages: parsed.data.messages,
    tools: parsed.data.tools,
    temperature: parsed.data.temperature,
    maxTokens: parsed.data.maxTokens,
    previousResponseId: parsed.data.previousResponseId,
  };
  const accountId = auth.account.id;
  const providerId = providerConversationId(provider.baseUrl, provider.model);
  if (provider.openClawResponses) {
    // Stored before the PUT validated it, or hand-edited: refuse instead of sending a request the gateway cannot route.
    const problem = openClawResponsesProblem(provider.baseUrl, provider.model);
    if (problem) return jsonError(problem, 409);
    const answered = parsed.data.messages.flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : []));
    let start: RoundStart;
    try {
      start = beginResponsesRound(accountId, providerId, parsed.data.previousResponseId ?? null, answered);
    } catch {
      return jsonError("conversation_store_unavailable", 500);
    }
    if (!start.ok) return jsonError(CONTINUATION_LOST, 409);
    const { sessionId } = start;
    const onSettled = (round: ResponsesSettlement): void => {
      recordRound(accountId, { model: provider.model, usage: round.ok ? round.usage : null, ms: round.ms, failed: !round.ok && !round.aborted });
      try {
        if (round.ok) commitResponsesRound(accountId, providerId, sessionId, round.responseId, round.pendingCallIds);
        else breakContinuation(accountId, providerId, sessionId);
      } catch {
        // The round itself is answered either way; an unwritable store surfaces on the next conversation request.
      }
    };
    const responsesInput = { ...input, previousResponseId: start.previousResponseId };
    if (parsed.data.stream) {
      const streamed = await forwardResponsesStream(provider, accountId, sessionId, responsesInput, request.signal, onSettled);
      return streamed.ok ? streamed.response : jsonError(streamed.error, streamed.status);
    }
    const outcome = await forwardResponses(provider, accountId, sessionId, responsesInput, request.signal, onSettled);
    return outcome.ok ? json(outcome.result) : jsonError(outcome.error, outcome.status);
  }
  // A round that bypasses the continuation (Responses mode off) leaves the gateway session behind: drop its head.
  try {
    breakContinuation(accountId, providerId);
  } catch {
    // Conversation store problems are reported by /api/agent/conversation; a stateless round does not depend on it.
  }
  if (parsed.data.stream) {
    const streamed = await forwardChatStream(provider, input, request.signal, (round) =>
      recordRound(accountId, { model: provider.model, ...round }),
    );
    return streamed.ok ? streamed.response : jsonError(streamed.error, streamed.status);
  }
  const started = Date.now();
  const outcome = await forwardChat(provider, input);
  recordRound(accountId, { model: provider.model, usage: outcome.ok ? outcome.result.usage ?? null : null, ms: Date.now() - started, failed: !outcome.ok });
  return outcome.ok ? json(outcome.result) : jsonError(outcome.error, outcome.status);
}
