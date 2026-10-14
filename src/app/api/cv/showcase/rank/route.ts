import { authenticate, json } from "@/lib/accounts/http";
import { showcaseErrorResponse } from "@/lib/cv/showcase/http";
import { showcaseRank } from "@/lib/cv/showcase/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/cv/showcase/rank?owner=: top public non-fork repos by showcase value, with reasons and what to improve first. */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  try {
    return json(await showcaseRank(new URL(request.url).searchParams.get("owner") ?? undefined));
  } catch (error) {
    return showcaseErrorResponse(error);
  }
}
