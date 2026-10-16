import * as z from "zod/v4";
import { authenticate, flowErrorResponse, json, parseBody, publicOnly } from "@/lib/accounts/http";
import { clearedCookieHeader } from "@/lib/accounts/session";
import { deleteOwnAccount } from "@/lib/accounts/flows";
import { readStore } from "@/lib/accounts/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ password: z.string().max(2_048) }).strict();

/** POST /api/account/delete { password } -> the account, its sessions and every data location are removed (listed in `removed`). */
export async function POST(request: Request): Promise<Response> {
  const off = publicOnly();
  if (off) return off;
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const parsed = await parseBody(request, bodySchema, "{ password }");
  if ("response" in parsed) return parsed.response;
  const result = await deleteOwnAccount(auth.account, parsed.data.password, readStore());
  if (!result.ok) return flowErrorResponse(result);
  const response = json({ ok: true, removed: result.removed });
  response.headers.append("Set-Cookie", clearedCookieHeader(request));
  return response;
}
