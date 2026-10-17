import { NextResponse } from "next/server";
import { isPublicMode } from "@/lib/accounts/mode";
import { consumeLimits, LIMITS } from "@/lib/accounts/rate-limit";
import { clientIp, resolveAccount } from "@/lib/accounts/session";
import { GITHUB_WEB, loadApp } from "@/lib/github-app/config";
import { back, requestBase } from "@/lib/github-app/http";
import { callbackPaths, publicBase } from "@/lib/github-app/manifest";
import { authorizeUrl, beginFlow, safeReturnTo, stateCookie, type FlowPurpose } from "@/lib/github-app/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/github/start?purpose=login|register|link|install&returnTo=/path
 * login/register (public mode): "Continue with GitHub". link: the signed-in account proves its GitHub user and the app
 * installations it can reach. install: GitHub's install page (choose repositories); GitHub then comes back to /setup,
 * which runs `link` to verify the installation.
 */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const purpose = params.get("purpose") as FlowPurpose | null;
  let base: string;
  try {
    base = requestBase(request);
  } catch {
    return new NextResponse("unknown host", { status: 400 });
  }
  // Every GitHub flow runs on the public address (the only one GitHub knows): opened elsewhere, start over there, so the
  // state cookie and GitHub's callback land on the same origin.
  const pub = publicBase();
  if (pub && pub !== base) {
    const url = new URL(request.url);
    return NextResponse.redirect(`${pub}${url.pathname}${url.search}`, 303);
  }
  const app = loadApp();
  const returnTo = safeReturnTo(params.get("returnTo"), purpose === "login" || purpose === "register" ? "/" : "/account");
  const fail = (code: string) => back(base, purpose === "login" || purpose === "register" ? "/login" : returnTo, { github_error: code });
  if (!app || !pub) return fail("not_configured");
  if (purpose !== "login" && purpose !== "register" && purpose !== "link" && purpose !== "install") return fail("bad_request");
  const account = resolveAccount(request);
  if (purpose === "login" || purpose === "register") {
    if (!isPublicMode()) return fail("public_only");
    // No session yet: bounded per client address (each start costs a sealed cookie and a GitHub round trip).
    if (!consumeLimits([LIMITS.githubStartIp(clientIp(request))]).ok) return fail("rate_limited");
  } else if (!account) {
    return back(base, "/login", { next: `/api/github/start?purpose=${purpose}&returnTo=${encodeURIComponent(returnTo)}` });
  }
  if (purpose === "install") {
    // Nothing to verify yet: the installation is checked after GitHub sends the user back (setup -> link).
    return NextResponse.redirect(`${GITHUB_WEB()}/apps/${app.slug}/installations/new`, 303);
  }
  const redirectUri = callbackPaths(pub).callback;
  const { state, challenge, cookie } = beginFlow({ purpose, accountId: account?.id ?? null, redirectUri, returnTo });
  const response = NextResponse.redirect(authorizeUrl(app, redirectUri, state, challenge), 303);
  response.headers.append("Set-Cookie", stateCookie(request, cookie));
  response.headers.set("Cache-Control", "no-store");
  return response;
}
