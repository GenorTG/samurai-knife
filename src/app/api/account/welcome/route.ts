import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { markWelcomed } from "@/lib/accounts/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The welcome wizard is finished or skipped: `/` stops sending this account to it. The body is an empty JSON object. */
export async function PUT(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const read = await readJsonBody(request, 1024);
  if ("response" in read) return read.response;
  const account = markWelcomed(auth.account.id);
  if (!account) return jsonError("unknown account", 404);
  return json({ needsWelcome: false });
}
