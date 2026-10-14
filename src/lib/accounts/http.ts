import { NextResponse } from "next/server";
import {
  hostHeaderValidationResponse,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { resolveAccount } from "@/lib/accounts/session";
import { loginChoices, type Account } from "@/lib/accounts/store";
import { knifeHosts } from "@/lib/hosts";

/** Host allow-list; KNIFE_MCP_ALLOWED_HOSTS (comma-separated) replaces it entirely. */
export function allowedHosts(): string[] {
  const configured = process.env.KNIFE_MCP_ALLOWED_HOSTS
    ?.split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return configured?.length ? configured : knifeHosts();
}

export function jsonError(error: string, status: number, extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ error, ...extra }, { status, headers: { "Cache-Control": "no-store" } });
}

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** Host allow-list for every request; Origin allow-list for mutating ones (same guard as /api/mcp). */
export function guard(request: Request, mutating: boolean): NextResponse | null {
  const hosts = allowedHosts();
  if (hostHeaderValidationResponse(request, hosts)) return jsonError("forbidden_host", 403);
  if (mutating && originValidationResponse(request, hosts)) return jsonError("forbidden_origin", 403);
  return null;
}

export function loginRequired(): NextResponse {
  return jsonError("login_required", 401, { accounts: loginChoices() });
}

export type Authenticated = { account: Account } | { response: NextResponse };

/** Guard + identity resolution in one step. */
export function authenticate(request: Request, mutating: boolean): Authenticated {
  const blocked = guard(request, mutating);
  if (blocked) return { response: blocked };
  const account = resolveAccount(request);
  return account ? { account } : { response: loginRequired() };
}

export type JsonBody = { body: unknown } | { response: NextResponse };

export async function readJsonBody(request: Request, maxBytes: number): Promise<JsonBody> {
  // Only application/json: a cross-site page can send text/plain or form bodies without a CORS preflight ("simple" requests),
  // and the Origin guard compares hostnames only (another port on the same host passes it). JSON forces the preflight, which
  // this app never answers, so the browser stops such a request before it is sent.
  if (!/^application\/json\s*(?:;|$)/i.test((request.headers.get("content-type") ?? "").trim())) {
    return { response: jsonError("unsupported_media_type", 415) };
  }
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > maxBytes) return { response: jsonError("payload_too_large", 413) };
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { response: jsonError("invalid_body", 400) };
  }
  if (Buffer.byteLength(text) > maxBytes) return { response: jsonError("payload_too_large", 413) };
  try {
    return { body: JSON.parse(text) as unknown };
  } catch {
    return { response: jsonError("invalid_json", 400) };
  }
}
