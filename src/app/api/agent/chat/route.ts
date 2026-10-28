import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { forwardChat, forwardChatStream } from "@/lib/accounts/provider";
import { getAccount } from "@/lib/accounts/store";
import { noteUntrusted, providerConversationId } from "@/lib/agent-client/conversation-store";
import { recordRound } from "@/lib/accounts/usage-ledger";
import { admitProvider, outboundLimitMessage, providerNet } from "@/lib/net/outbound";
import { toolContextFor } from "@/lib/accounts/authz";
import { carriesUntrusted, UNTRUSTED_HEADER } from "@/lib/agent-client/server-tool-policy";
import { getToolEffects } from "@/lib/mcp/tools";
import { visionModeOf } from "@/lib/vision/config";
import { getImage } from "@/lib/vision/images";
import { withLatestImages } from "@/lib/vision/inject";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGES = 200;
// Every knife_* tool (69 with the office folder/version tools) plus the page tools must fit; the body cap bounds the size.
const MAX_TOOLS = 128;

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
  // Sent by pages loaded before the Responses continuation was removed (2026-10-25): accepted and ignored.
  previousResponseId: z.string().max(256).nullable().optional(),
  chatId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional(),
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
  const budget = admitProvider(auth.account, "provider", provider.baseUrl);
  if (budget.problem) return jsonError(budget.problem, 403, { code: "provider_not_allowed" });
  if (!budget.ok) {
    const limited = jsonError(outboundLimitMessage(budget.retryAfterSeconds), 429, { retryAfterSeconds: budget.retryAfterSeconds });
    limited.headers.set("Retry-After", String(budget.retryAfterSeconds));
    return limited;
  }
  const net = providerNet(auth.account);
  const accountId = auth.account.id;

  // Vision (src/lib/vision/inject.ts): screenshots named by the latest tool results go to a model that sees as image
  // parts; a text-only profile never gets one (its tools already answered with the helper's description).
  const messages = visionModeOf(provider) === "native"
    ? withLatestImages(parsed.data.messages, (id) => {
      const image = getImage(accountId, id);
      return image ? { mime: image.mime, data: image.bytes } : null;
    }).messages
    : parsed.data.messages;

  const input = {
    model: provider.model,
    messages,
    tools: parsed.data.tools,
    temperature: parsed.data.temperature,
    maxTokens: parsed.data.maxTokens,
  };
  const providerId = providerConversationId(provider.baseUrl, provider.model, parsed.data.chatId ?? "default");
  // The conversation's taint is server-owned (never written by the browser): every round's messages are checked and
  // the sticky flag goes back as a header, so the widget's approval policy holds across turns and reloads.
  const seen = carriesUntrusted(parsed.data.messages, getToolEffects(toolContextFor(auth.account)));
  let untrusted = seen;
  try {
    untrusted = noteUntrusted(accountId, providerId, seen);
  } catch {
    // An unreadable store: this round's own messages still decide.
  }
  const mark = (response: Response): Response => {
    if (untrusted) response.headers.set(UNTRUSTED_HEADER, "1");
    return response;
  };
  if (parsed.data.stream) {
    const streamed = await forwardChatStream(provider, input, request.signal, (round) =>
      recordRound(accountId, { model: provider.model, ...round }), net,
    );
    return streamed.ok ? mark(streamed.response) : jsonError(streamed.error, streamed.status);
  }
  const started = Date.now();
  const outcome = await forwardChat(provider, input, net);
  recordRound(accountId, { model: provider.model, usage: outcome.ok ? outcome.result.usage ?? null : null, ms: Date.now() - started, failed: !outcome.ok });
  return outcome.ok ? mark(json(outcome.result)) : jsonError(outcome.error, outcome.status);
}
