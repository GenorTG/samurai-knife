import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { MAX_CALL_RESULT_CHARS, answerCall, validClientId } from "@/lib/ui-bridge/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  clientId: z.string().max(64),
  callId: z.uuid(),
  status: z.enum(["done", "declined", "busy", "unavailable"]),
  ok: z.boolean(),
  // a little over the stored cap so a tab that clips at the cap is never refused for its envelope
  content: z.string().max(MAX_CALL_RESULT_CHARS + 1_000),
}).strict();

/**
 * POST /api/ui/call { clientId, callId, status, ok, content }: an open tab answers a knife_ui_call an MCP agent sent it
 * (docs/MCP.md "knife_ui_call"). Only the account and the tab the call went to can answer it; a late or unknown answer
 * is accepted and ignored (`taken: false`), so a tab learns nothing about other calls.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const read = await readJsonBody(request, 256 * 1024);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success || !validClientId(parsed.data.clientId)) return jsonError("Bad request: call answer", 422);
  const { clientId, callId, ...answer } = parsed.data;
  return json({ taken: answerCall(auth.account.id, clientId, callId, answer) });
}
