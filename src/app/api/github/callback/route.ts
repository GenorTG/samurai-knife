import { NextResponse } from "next/server";
import { clientIp, cookieValue, resolveAccount, rotateSession } from "@/lib/accounts/session";
import { linkGithub, signInWithGithub } from "@/lib/github-app/accounts";
import { loadApp } from "@/lib/github-app/config";
import { back, requestBase } from "@/lib/github-app/http";
import { clearStateCookie, exchangeCode, GithubFlowError, identity, STATE_COOKIE, takeFlow, userInstallations } from "@/lib/github-app/oauth";
import { linkInstallations } from "@/lib/site/service";
import { legalVersion, recordLegalVersion } from "@/lib/legal/legal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/github/callback?code=&state= : GitHub's OAuth redirect. The state must be one this server issued, unused,
 * under 10 minutes old and come back in the browser that started the flow (cookie). Then: login/register -> a session;
 * link -> the GitHub identity and the app installations GitHub says this user can reach are stored for the account,
 * each with the repositories this user's own token lists there and their push right (the only connectable ones).
 */
export async function GET(request: Request): Promise<Response> {
  let base: string;
  try {
    base = requestBase(request);
  } catch {
    return new NextResponse("unknown host", { status: 400 });
  }
  const params = new URL(request.url).searchParams;
  const flow = takeFlow(params.get("state"), cookieValue(request, STATE_COOKIE));
  const clear = clearStateCookie(request);
  if (!flow) return back(base, "/login", { github_error: "expired" }, [clear]);
  const onError = flow.purpose === "login" || flow.purpose === "register" ? "/login" : flow.returnTo;
  if (params.get("error")) return back(base, onError, { github_error: params.get("error") === "access_denied" ? "denied" : "github_error" }, [clear]);
  const app = loadApp();
  const code = params.get("code");
  if (!app || !code) return back(base, onError, { github_error: "not_configured" }, [clear]);
  try {
    const userToken = await exchangeCode(app, code, flow);
    const who = await identity(userToken);
    if (flow.purpose === "link") {
      const current = resolveAccount(request);
      if (!current || current.id !== flow.accountId) return back(base, "/login", { github_error: "session_changed" }, [clear]);
      const linked = linkGithub(current.id, who);
      if (!linked.ok) return back(base, flow.returnTo, { github_error: linked.code }, [clear]);
      await linkInstallations(current.id, who.login, userToken, await userInstallations(userToken));
      return back(base, flow.returnTo, { github: "linked" }, [clear]);
    }
    // A new account needs the Terms accepted on the sign-up page, in the version that is current now.
    const accepted = flow.purpose === "register" && flow.terms ? flow.terms : null;
    if (accepted) recordLegalVersion();
    const result = signInWithGithub(who, clientIp(request), accepted, legalVersion());
    if (result.kind === "refused") {
      const page = result.code === "terms_required" || result.code === "terms_changed" ? "/register" : "/login";
      return back(base, page, { github_error: result.code, github_message: result.message }, [clear]);
    }
    try {
      await linkInstallations(result.account.id, who.login, userToken, await userInstallations(userToken));
    } catch {
      /* installations are optional for a sign-in */
    }
    const session = rotateSession(request, result.account);
    return back(base, result.kind === "registered" ? "/account" : flow.returnTo, result.kind === "registered" ? { github: "welcome" } : {}, [clear, session]);
  } catch (error) {
    const message = error instanceof GithubFlowError ? error.message : error instanceof Error ? error.message : String(error);
    return back(base, onError, { github_error: error instanceof GithubFlowError ? error.code : "github_error", github_message: message }, [clear]);
  }
}
