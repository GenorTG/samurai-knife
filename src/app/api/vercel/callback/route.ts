import { NextResponse } from "next/server";
import { cookieValue, resolveAccount } from "@/lib/accounts/session";
import { withCvProject } from "@/lib/cv/projects";
import { back, requestBase } from "@/lib/github-app/http";
import { SiteError } from "@/lib/site/net";
import { exchangeVercelCode, takeVercelFlow, VERCEL_STATE_COOKIE, vercelStateCookie } from "@/lib/site/vercel-oauth";
import { storeOAuthToken, vercelOAuthConfig } from "@/lib/site/vercel-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/vercel/callback?code=&state=&configurationId=&teamId= : Vercel's redirect after the integration was installed.
 * The state must be this server's, unused, under 10 minutes old, from this browser, and the session the same account
 * that started it; then the code is exchanged once and the token stored on the CV project the flow started in.
 * An install started on Vercel's side (Marketplace "Add Integration") comes without our state: its code is never
 * exchanged (nothing proves this user asked for it, so a crafted link could not attach a stranger's Vercel); the page
 * says the integration is installed and that "Connect with Vercel" in the app links it.
 */
export async function GET(request: Request): Promise<Response> {
  let base: string;
  try {
    base = requestBase(request);
  } catch {
    return new NextResponse("unknown host", { status: 400 });
  }
  const params = new URL(request.url).searchParams;
  const clear = vercelStateCookie(request, "", true);
  if (!params.get("state")) return back(base, "/tools/cv-studio?tab=website", { vercel_error: "marketplace" }, [clear]);
  const flow = takeVercelFlow(params.get("state"), cookieValue(request, VERCEL_STATE_COOKIE));
  if (!flow) return back(base, "/tools/cv-studio?tab=website", { vercel_error: "expired" }, [clear]);
  const current = resolveAccount(request);
  if (!current || current.id !== flow.accountId) return back(base, "/login", { vercel_error: "session_changed" }, [clear]);
  if (params.get("error")) return back(base, flow.returnTo, { vercel_error: "denied" }, [clear]);
  const config = vercelOAuthConfig();
  const code = params.get("code");
  if (!config || !code) return back(base, flow.returnTo, { vercel_error: "not_configured" }, [clear]);
  try {
    const got = await exchangeVercelCode(config, code, flow.redirectUri);
    await withCvProject(current.id, flow.projectId, () => storeOAuthToken(current.id, got.token, got.configurationId || params.get("configurationId") || "", got.teamId ?? params.get("teamId")));
    return back(base, flow.returnTo, { vercel: "connected" }, [clear]);
  } catch (error) {
    const message = error instanceof SiteError || error instanceof Error ? error.message : String(error);
    return back(base, flow.returnTo, { vercel_error: "vercel_error", vercel_message: message }, [clear]);
  }
}
