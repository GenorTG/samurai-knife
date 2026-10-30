import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { currentLegalEdition, currentRelease } from "@/lib/accounts/seen";
import { markSeen } from "@/lib/accounts/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The "What's new" window: what the user last confirmed and what this server is (src/lib/release-notes.ts). */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  return json({ seen: auth.account.seen ?? null, current: { version: currentRelease(), legalEdition: currentLegalEdition() } });
}

/** "Got it": the current release notes and legal edition are seen. The body is an empty JSON object. */
export async function PUT(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const read = await readJsonBody(request, 1024);
  if ("response" in read) return read.response;
  const account = markSeen(auth.account.id);
  if (!account) return jsonError("unknown account", 404);
  return json({ seen: account.seen });
}
