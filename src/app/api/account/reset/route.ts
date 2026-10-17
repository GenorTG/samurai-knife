import * as z from "zod/v4";
import { flowErrorResponse, json, parseBody, publicOnly } from "@/lib/accounts/http";
import { resetPassword } from "@/lib/accounts/flows";
import { clientIp } from "@/lib/accounts/network";
import { powField } from "@/lib/accounts/pow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ token: z.string().max(256), password: z.string().max(2_048), pow: powField }).strict();

/** POST /api/account/reset { token, password, pow } -> sets the password, ends every session and revokes every MCP key of the account. */
export async function POST(request: Request): Promise<Response> {
  const off = publicOnly();
  if (off) return off;
  const parsed = await parseBody(request, bodySchema, "{ token, password, pow }");
  if ("response" in parsed) return parsed.response;
  const result = await resetPassword(parsed.data.token, parsed.data.password, clientIp(request), parsed.data.pow);
  return result.ok ? json({ ok: true, username: result.username, mcpKeysRevoked: result.mcpKeysRevoked }) : flowErrorResponse(result);
}
