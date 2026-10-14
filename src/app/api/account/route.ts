import { authenticate, json } from "@/lib/accounts/http";
import { toPublicAccount } from "@/lib/accounts/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  return json(toPublicAccount(auth.account));
}
