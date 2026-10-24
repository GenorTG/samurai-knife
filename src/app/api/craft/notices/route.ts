import { guard, json, jsonError } from "@/lib/accounts/http";
import { NoticeError, appNotices } from "@/lib/craft/notices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/craft/notices?app=<id> -> the licence and notice texts of the Craft app version this install serves
 * (src/lib/craft/notices.ts): copyright, licence, the release's LICENSE files, the repository's NOTICE and the
 * third-party licence files it names. Public and read-only so the legal texts are reachable from /credits without an
 * account; app ids and upstream repositories are fixed by ARTCRAFT_APPS, and fetched text is size-bounded and cached.
 */
export async function GET(request: Request): Promise<Response> {
  const blocked = guard(request, false);
  if (blocked) return blocked;
  const app = new URL(request.url).searchParams.get("app") ?? "";
  try {
    return json(await appNotices(app));
  } catch (error) {
    if (error instanceof NoticeError) return jsonError(error.message, 400);
    throw error;
  }
}
