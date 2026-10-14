import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { reportPresence, validClientId } from "@/lib/ui-bridge/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  clientId: z.string().max(64),
  path: z.string().max(500).startsWith("/"),
  title: z.string().max(200).default(""),
  visible: z.boolean(),
  active: z.boolean(),
}).strict();

/** POST /api/ui/presence { clientId, path, title, visible, active }: an open tab says where it is (for MCP agents). */
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
