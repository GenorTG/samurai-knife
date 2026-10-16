import { NextResponse } from "next/server";
import {
  hostHeaderValidationResponse,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { resolveAccount } from "@/lib/accounts/session";
import { loginChoices, type Account } from "@/lib/accounts/store";
import { authMode, isPublicMode } from "@/lib/accounts/mode";
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
  return jsonError("login_required", 401, { accounts: loginChoices(isPublicMode()), mode: authMode() });
}

/** Routes that exist only in public mode answer exactly like a missing route in private mode. */
export function publicOnly(): NextResponse | null {
  return isPublicMode() ? null : jsonError("not_found", 404);
}

/** A failed account flow as a response (`Retry-After` on 429). */
export function flowErrorResponse(failure: { status: number; error: string; retryAfterSeconds?: number }): NextResponse {
  const response = jsonError(failure.error, failure.status, failure.retryAfterSeconds ? { retryAfterSeconds: failure.retryAfterSeconds } : undefined);
  if (failure.retryAfterSeconds) response.headers.set("Retry-After", String(failure.retryAfterSeconds));
  return response;
}

/** Guard + JSON body + zod parse in one step, for the account routes. */
export async function parseBody<T>(request: Request, schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } }, usage: string, maxBytes = 8 * 1024): Promise<{ data: T } | { response: NextResponse }> {
  const blocked = guard(request, true);
  if (blocked) return { response: blocked };
  const read = await readJsonBody(request, maxBytes);
  if ("response" in read) return read;
  const parsed = schema.safeParse(read.body);
  return parsed.success ? { data: parsed.data } : { response: jsonError(`Expected ${usage}.`, 400) };
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

function megabytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

/** 413 with a readable message (the `error` code stays `payload_too_large` for callers that match on it). */
export function payloadTooLarge(maxBytes: number): NextResponse {
  return jsonError("payload_too_large", 413, { message: `The request body is larger than ${megabytes(maxBytes)}.`, maxBytes });
}

export type CappedBody = { bytes: Uint8Array } | { tooLarge: true } | { failed: true };

/**
 * The request body, refused by a declared Content-Length over `maxBytes` before reading anything, and while streaming
 * (chunked bodies declare none) as soon as the count passes `maxBytes`: never more than `maxBytes` + one chunk in memory.
 */
export async function readBodyCapped(request: Request, maxBytes: number): Promise<CappedBody> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > maxBytes) return { tooLarge: true };
  if (!request.body) return { bytes: new Uint8Array(0) };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        reader.cancel().catch(() => undefined);
        return { tooLarge: true };
      }
      chunks.push(value);
    }
  } catch {
    return { failed: true };
  }
  return { bytes: Buffer.concat(chunks, total) };
}

/**
 * For handlers that read the body themselves (the MCP SDK): the same request with its body read under the cap first, or
 * the 413 to return.
 */
export async function withCappedBody(request: Request, maxBytes: number): Promise<{ request: Request } | { response: NextResponse }> {
  const read = await readBodyCapped(request, maxBytes);
  if ("tooLarge" in read) return { response: payloadTooLarge(maxBytes) };
  if ("failed" in read) return { response: jsonError("invalid_body", 400) };
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return { request: new Request(request.url, { method: request.method, headers, body: read.bytes.byteLength ? Buffer.from(read.bytes) : null, signal: request.signal }) };
}

export async function readJsonBody(request: Request, maxBytes: number): Promise<JsonBody> {
  // Only application/json: a cross-site page can send text/plain or form bodies without a CORS preflight ("simple" requests),
  // and the Origin guard compares hostnames only (another port on the same host passes it). JSON forces the preflight, which
  // this app never answers, so the browser stops such a request before it is sent.
  if (!/^application\/json\s*(?:;|$)/i.test((request.headers.get("content-type") ?? "").trim())) {
    return { response: jsonError("unsupported_media_type", 415) };
  }
  const read = await readBodyCapped(request, maxBytes);
  if ("tooLarge" in read) return { response: payloadTooLarge(maxBytes) };
  if ("failed" in read) return { response: jsonError("invalid_body", 400) };
  try {
    return { body: JSON.parse(new TextDecoder().decode(read.bytes)) as unknown };
  } catch {
    return { response: jsonError("invalid_json", 400) };
  }
}
