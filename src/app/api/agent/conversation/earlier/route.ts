import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { getAccount } from "@/lib/accounts/store";
import { EarlierChatError, importEarlierChat, legacySourcesOf, listEarlierChats } from "@/lib/agent-client/conversation-store";
import { quotaErrorResponse } from "@/lib/storage/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CHAT_ID = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * "Recover earlier chats" (docs/ARCHITECTURE.md "Assistant context"): provider-scoped transcripts of older releases
 * (before 0.13.0.22) that no chat took over. GET ?chats=<id,id…> (the browser's known chat ids, so their own files are
 * never listed) -> { chats: EarlierChat[] }. POST { file, chatId } copies one into an empty chat (taint included).
 * Own account only: the store reads `conversations/<account>/`.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const account = getAccount(auth.account.id);
  if (!account) return jsonError("account_not_found", 404);
  const chats = (new URL(request.url).searchParams.get("chats") ?? "").split(",").filter((id) => CHAT_ID.test(id)).slice(0, 50);
  try {
    return json({ chats: listEarlierChats(auth.account.id, legacySourcesOf(account), chats) });
  } catch {
    return jsonError("conversation_store_unavailable", 500);
  }
}

const importSchema = z.object({
  file: z.string().regex(/^[a-f0-9]{32}$/),
  chatId: z.string().regex(CHAT_ID),
}).strict();

export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const read = await readJsonBody(request, 4096);
  if ("response" in read) return read.response;
  const parsed = importSchema.safeParse(read.body);
  if (!parsed.success) return jsonError("invalid_request", 400);
  try {
    const value = importEarlierChat(auth.account.id, parsed.data.file, parsed.data.chatId);
    return json({ ok: true, chatId: parsed.data.chatId, messages: value.messages.length });
  } catch (error) {
    if (error instanceof EarlierChatError) return jsonError(error.code, error.code === "not_found" ? 404 : 409);
    return quotaErrorResponse(error) ?? jsonError("conversation_store_unavailable", 500);
  }
}
