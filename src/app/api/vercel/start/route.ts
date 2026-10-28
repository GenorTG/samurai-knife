import { NextResponse } from "next/server";
import { resolveAccount } from "@/lib/accounts/session";
import { currentProjectId } from "@/lib/cv/projects";
import { back, requestBase } from "@/lib/github-app/http";
import { beginVercelFlow, installUrl, redirectUriFor, vercelStateCookie } from "@/lib/site/vercel-oauth";
import { vercelOAuthConfig } from "@/lib/site/vercel-service";
import { safeReturnPath } from "@/lib/safe-return";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/vercel/start?returnTo=/path[&project=<cv project>] : "Connect with Vercel". Needs a session; opens the
 * integration's install page on Vercel (pick the team and projects there), which comes back to /api/vercel/callback.
 */
export async function GET(request: Request): Promise<Response> {
  let base: string;
  try {
    base = requestBase(request);
  } catch {
    return new NextResponse("unknown host", { status: 400 });
  }
  const params = new URL(request.url).searchParams;
  const returnTo = safeReturnPath(params.get("returnTo"), "/tools/cv-studio?tab=website");
  const account = resolveAccount(request);
  if (!account) return back(base, "/login", { next: `/api/vercel/start?returnTo=${encodeURIComponent(returnTo)}` });
  const config = vercelOAuthConfig();
  if (!config) return back(base, returnTo, { vercel_error: "not_configured" });
  const wanted = params.get("project");
  const projectId = wanted && /^[A-Za-z0-9_-]{1,40}$/.test(wanted) ? wanted : currentProjectId(account.id);
  const { state, cookie } = beginVercelFlow({ accountId: account.id, projectId, returnTo, redirectUri: redirectUriFor(base) });
  const response = NextResponse.redirect(installUrl(config, state), 303);
  response.headers.append("Set-Cookie", vercelStateCookie(request, cookie));
  response.headers.set("Cache-Control", "no-store");
  return response;
}
