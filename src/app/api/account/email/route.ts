import * as z from "zod/v4";
import { authenticate, flowErrorResponse, json, parseBody, publicOnly } from "@/lib/accounts/http";
import { changeEmail } from "@/lib/accounts/flows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ password: z.string().max(2_048), email: z.string().max(320) }).strict();

/** POST /api/account/email { password, email } -> 202: a link goes to the new address; the address changes when it is opened. */
export async function POST(request: Request): Promise<Response> {
  const off = publicOnly();
  if (off) return off;
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const parsed = await parseBody(request, bodySchema, "{ password, email }");
  if ("response" in parsed) return parsed.response;
  const result = await changeEmail(auth.account, parsed.data.password, parsed.data.email);
  return result.ok ? json({ ok: true, message: result.message }, 202) : flowErrorResponse(result);
}
