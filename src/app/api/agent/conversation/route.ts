import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import {
  conversationContentSchema,
  providerConversationId,
  readConversation,
  resetConversation,
  saveConversationContent,
  type ConversationContent,
} from "@/lib/agent-client/conversation-store";
import { getAccount } from "@/lib/accounts/store";
import { quotaErrorResponse } from "@/lib/storage/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CHAT_ID = /^[a-zA-Z0-9_-]{1,64}$/;

function scope(accountId: string, request: Request) {
  const provider = getAccount(accountId)?.provider;
  if (!provider) return null;
  const chatId = new URL(request.url).searchParams.get("chat") ?? "default";
  if (!CHAT_ID.test(chatId)) return null;
  return { provider, id: providerConversationId(provider.baseUrl, provider.model, chatId) };
}

export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const current = scope(auth.account.id, request);
  if (!current && getAccount(auth.account.id)?.provider) return jsonError("invalid_chat_id", 400);
  if (!current) return jsonError("provider_not_configured", 409);
  try {
    return json(readConversation(auth.account.id, current.id));
  } catch {
    return jsonError("conversation_store_unavailable", 500);
  }
}

// Browser-owned fields only. Unknown keys (sessionId/responseId from an older tab) are stripped: the
// continuation state belongs to /api/agent/chat and a transcript save must never roll it back.
const bodySchema = conversationContentSchema.extend({
  messages: z.array(z.unknown()).max(200),
  actions: z.array(z.string().trim().min(1).max(240)).max(40),
});

export async function PUT(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const current = scope(auth.account.id, request);
  if (!current && getAccount(auth.account.id)?.provider) return jsonError("invalid_chat_id", 400);
  if (!current) return jsonError("provider_not_configured", 409);
  const read = await readJsonBody(request, 2 * 1024 * 1024);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) return jsonError("invalid_conversation", 400);
  const content = conversationContentSchema.safeParse(parsed.data);
  if (!content.success) return jsonError("invalid_conversation", 400);
  try {
    saveConversationContent(auth.account.id, current.id, content.data as ConversationContent);
    return json({ ok: true });
  } catch (error) {
    return quotaErrorResponse(error) ?? jsonError("conversation_store_unavailable", 500);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const current = scope(auth.account.id, request);
  if (!current && getAccount(auth.account.id)?.provider) return jsonError("invalid_chat_id", 400);
  if (!current) return jsonError("provider_not_configured", 409);
  try {
    resetConversation(auth.account.id, current.id);
    return json({ ok: true });
  } catch {
    return jsonError("conversation_store_unavailable", 500);
  }
}
