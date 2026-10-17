import * as z from "zod/v4";
import { flowErrorResponse, json, parseBody, publicOnly } from "@/lib/accounts/http";
import { clientIp } from "@/lib/accounts/network";
import { register } from "@/lib/accounts/flows";
import { powField } from "@/lib/accounts/pow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  username: z.string().max(64),
  email: z.string().max(320),
  password: z.string().max(2_048),
  pow: powField,
}).strict();

/**
 * POST /api/account/register { username, email, password, pow } -> 202 with the same message whether or not the name or address
 * is taken (public mode only; 404 in private mode). docs/ACCOUNTS.md.
 */
export async function POST(request: Request): Promise<Response> {
  const off = publicOnly();
  if (off) return off;
  const parsed = await parseBody(request, bodySchema, "{ username, email, password }");
  if ("response" in parsed) return parsed.response;
  const result = await register(parsed.data, clientIp(request), parsed.data.pow);
  return result.ok ? json({ ok: true, message: result.message }, 202) : flowErrorResponse(result);
}
