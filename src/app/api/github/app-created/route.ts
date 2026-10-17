import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/accounts/authz";
import { resolveAccount } from "@/lib/accounts/session";
import { back, requestBase } from "@/lib/github-app/http";
import { exchangeManifestCode, takeManifestState } from "@/lib/github-app/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/github/app-created?code=&state= : GitHub's redirect after the admin confirmed the app manifest. */
export async function GET(request: Request): Promise<Response> {
  let base: string;
  try {
    base = requestBase(request);
  } catch {
    return new NextResponse("unknown host", { status: 400 });
  }
  const params = new URL(request.url).searchParams;
  const account = resolveAccount(request);
  if (!account || !isAdmin(account)) return back(base, "/login", { next: "/account/admin" });
  if (!takeManifestState(params.get("state"), account.id)) return back(base, "/account/admin", { github_error: "expired" });
  try {
    await exchangeManifestCode(params.get("code") ?? "");
    return back(base, "/account/admin", { github: "created" });
  } catch (error) {
    return back(base, "/account/admin", { github_error: "exchange_failed", github_message: error instanceof Error ? error.message : String(error) });
  }
}
