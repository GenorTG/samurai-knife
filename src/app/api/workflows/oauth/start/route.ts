import { authenticate, jsonError } from "@/lib/accounts/http";
import { authorizationUrl } from "@/lib/workflows/server/oauth";
import { WorkflowStoreError } from "@/lib/workflows/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/workflows/oauth/start?credential=<id> -> 302 to the provider (the user's own OAuth app). */
export function GET(request: Request): Response {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const id = new URL(request.url).searchParams.get("credential") ?? "";
  try {
    return new Response(null, { status: 302, headers: { location: authorizationUrl(auth.account.id, id), "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof WorkflowStoreError) return jsonError(error.message, error.status);
    throw error;
  }
}
