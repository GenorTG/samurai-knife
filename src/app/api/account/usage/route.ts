import { authenticate, json } from "@/lib/accounts/http";
import { usageSummary } from "@/lib/accounts/usage-ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/account/usage: this account's token counters (today, 7 days, total, per day, per model). */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  return json(usageSummary(auth.account.id));
}
