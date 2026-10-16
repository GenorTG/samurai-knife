import { authenticate, json } from "@/lib/accounts/http";
import { storageUsage } from "@/lib/storage/quota";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/account/storage -> `{ usedBytes, quotaBytes (null = unlimited), fraction, areas }` for the calling account. */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  return json(storageUsage(auth.account.id));
}
