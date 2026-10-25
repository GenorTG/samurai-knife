import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { LIVE_TOOL_NAME, reportPresence, validClientId } from "@/lib/ui-bridge/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  clientId: z.string().max(64),
  path: z.string().max(500).startsWith("/"),
  title: z.string().max(200).default(""),
  visible: z.boolean(),
  active: z.boolean(),
  /** live tools the page offers now (for knife_ui_state / knife_ui_call) */
  tools: z.array(z.string().regex(LIVE_TOOL_NAME)).max(64).default([]),
  live: z.string().max(300).default(""),
}).strict();

/** POST /api/ui/presence { clientId, path, title, visible, active, tools?, live? }: an open tab says where it is and which live tools its page offers (for MCP agents). */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const read = await readJsonBody(request, 4 * 1024);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success || !validClientId(parsed.data.clientId)) return jsonError("Bad request: presence", 422);
  reportPresence(auth.account.id, parsed.data);
  return json({ ok: true });
}
