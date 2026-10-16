import * as z from "zod/v4";
import { flowErrorResponse, json, parseBody, publicOnly } from "@/lib/accounts/http";
import { verifyToken } from "@/lib/accounts/flows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ token: z.string().max(256) }).strict();

/** POST /api/account/verify { token } -> { kind: "verified" | "email_changed", username }; the link works once. */
export async function POST(request: Request): Promise<Response> {
  const off = publicOnly();
  if (off) return off;
  const parsed = await parseBody(request, bodySchema, "{ token }");
  if ("response" in parsed) return parsed.response;
  const result = verifyToken(parsed.data.token);
  return result.ok ? json({ ok: true, kind: result.kind, username: result.username }) : flowErrorResponse(result);
}
