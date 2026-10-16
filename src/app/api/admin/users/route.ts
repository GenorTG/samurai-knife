import { authenticate, json } from "@/lib/accounts/http";
import { requireAdmin } from "@/lib/accounts/authz";
import { listUsers } from "@/lib/accounts/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/users -> { users: AdminUserRow[] } (admins only in public mode). */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const denied = requireAdmin(auth.account, "manage users");
  if (denied) return denied;
  return json({ users: listUsers(), self: auth.account.id });
}
