import * as z from "zod/v4";
import { flowErrorResponse, json, parseBody, publicOnly } from "@/lib/accounts/http";
import { clientIp } from "@/lib/accounts/network";
import { forgotPassword } from "@/lib/accounts/flows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ email: z.string().max(320) }).strict();

/** POST /api/account/forgot { email } -> 202, same answer for every address; a reset link (1 h, single use) goes to a known one. */
export async function POST(request: Request): Promise<Response> {
  const off = publicOnly();
  if (off) return off;
  const parsed = await parseBody(request, bodySchema, "{ email }");
  if ("response" in parsed) return parsed.response;
  const result = forgotPassword(parsed.data.email, clientIp(request));
  return result.ok ? json({ ok: true, message: result.message }, 202) : flowErrorResponse(result);
}
