import { JwtError } from "@/lib/jwt-hs256";
import { json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { getAccount } from "@/lib/accounts/store";
import { handleCallback, type CallbackBody } from "@/lib/office/callback";
import { OfficeUnavailableError, readCapability, readServerToken } from "@/lib/office/editor";
import { DocError } from "@/lib/office/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/office/ds/callback?t=<capability jwt> — the Document Server's save/status callback, called by the CONTAINER.
 * Same guard exception and double JWT check as ../file/route.ts; the body is still JSON-only through readJsonBody. The
 * status fields are taken from the signed token, never from the unsigned body.
 */
export async function POST(request: Request): Promise<Response> {
  const read = await readJsonBody(request, 1024 * 1024);
  if ("response" in read) return read.response;
  const raw = (typeof read.body === "object" && read.body !== null ? read.body : {}) as Record<string, unknown>;
  try {
    const signed = readServerToken(request, raw.token) as CallbackBody;
    const cap = readCapability(new URL(request.url).searchParams.get("t"), "callback");
    if (!getAccount(cap.acc)) return jsonError("unknown account", 404);
    const outcome = await handleCallback(cap.acc, cap.doc, signed);
    if (outcome.action === "failed" || (outcome.action === "ignored" && outcome.message)) {
      console.warn(`[office] callback ${cap.doc}: ${outcome.action}${outcome.message ? ` (${outcome.message})` : ""}`);
    }
    return json({ error: outcome.error });
  } catch (error) {
    if (error instanceof JwtError) return jsonError(`forbidden: ${error.message}`, 403);
    if (error instanceof OfficeUnavailableError) return jsonError(error.message, 409);
    if (error instanceof DocError) return json({ error: 1, message: error.message });
    throw error;
  }
}
