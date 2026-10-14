import { authenticate, json, jsonError } from "@/lib/accounts/http";
import { CvStoreError, loadCv } from "@/lib/cv/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/cv: this account's CV data (profile, variants, jobs, applications) and its revision. `?revision=N` answers `{ changed:false }` when nothing is newer (cheap polling). */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  try {
    const data = loadCv(auth.account.id);
    const known = Number(new URL(request.url).searchParams.get("revision"));
    if (Number.isInteger(known) && known === data.revision && known > 0) return json({ changed: false, revision: data.revision });
    return json({ changed: true, ...data });
  } catch (error) {
    if (error instanceof CvStoreError) return jsonError(error.message, 500);
    throw error;
  }
}
