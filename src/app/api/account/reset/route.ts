import * as z from "zod/v4";
import { flowErrorResponse, json, parseBody, publicOnly } from "@/lib/accounts/http";
import { resetPassword } from "@/lib/accounts/flows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ token: z.string().max(256), password: z.string().max(2_048) }).strict();

/** POST /api/account/reset { token, password } -> sets the password and ends every session of the account. */
export async function POST(request: Request): Promise<Response> {
  const off = publicOnly();
  if (off) return off;
  const parsed = await parseBody(request, bodySchema, "{ token, password }");
  if ("response" in parsed) return parsed.response;
  const result = await resetPassword(parsed.data.token, parsed.data.password);
  return result.ok ? json({ ok: true, username: result.username }) : flowErrorResponse(result);
}
