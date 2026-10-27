import { NextResponse } from "next/server";
import { back, requestBase } from "@/lib/github-app/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/github/setup?installation_id=&setup_action= : GitHub's "after install" redirect. The installation id in the
 * URL proves nothing (anyone can type one), so the signed-in user goes through a GitHub sign-in (`link`), which
 * records only the installations that GitHub says this user can reach.
 */
export async function GET(request: Request): Promise<Response> {
  let base: string;
  try {
    base = requestBase(request);
  } catch {
    return new NextResponse("unknown host", { status: 400 });
  }
  return back(base, "/api/github/start", { purpose: "link", returnTo: "/tools/cv-studio?tab=website&step=connect" });
}
