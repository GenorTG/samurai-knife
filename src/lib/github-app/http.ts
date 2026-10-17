import { NextResponse } from "next/server";
import { allowedHosts } from "@/lib/accounts/http";
import { isHttps } from "@/lib/accounts/network";
import { safeReturnPath } from "@/lib/safe-return";

/**
 * This server's own base URL for GitHub callbacks: KNIFE_PUBLIC_URL when the request came in on its host, else the
 * request's host (only hosts on the allow-list: a forged Host header never becomes a redirect target).
 */
export function requestBase(request: Request): string {
  const host = (request.headers.get("host") ?? new URL(request.url).host).toLowerCase();
  const pub = (process.env.KNIFE_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  if (pub) {
    try {
      if (new URL(pub).host.toLowerCase() === host) return pub;
    } catch {
      /* invalid public URL: fall through */
    }
  }
  const bare = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (!allowedHosts().includes(bare)) throw new Error(`host ${host} is not an allowed host of this server`);
  return `${isHttps(request) ? "https" : "http"}://${host}`;
}

/**
 * 303 to a same-site path with extra query parameters (results and error codes for the page to show). The path goes
 * through `safeReturnPath` here as well, so no caller can turn this into an open redirect.
 */
export function back(base: string, path: string, params: Record<string, string> = {}, cookies: string[] = []): NextResponse {
  const url = new URL(safeReturnPath(path), base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v.slice(0, 300));
  const response = NextResponse.redirect(url, 303);
  for (const c of cookies) response.headers.append("Set-Cookie", c);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
