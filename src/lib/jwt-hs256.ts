import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Server-only HS256 JSON Web Tokens (RFC 7519), the scheme the office Document Server speaks. Node's `crypto` is fine
 * here: the "no crypto.subtle" rule is about the browser on the plain-HTTP Tailscale origin.
 */

export type JwtPayload = Record<string, unknown>;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function signJwt(payload: JwtPayload, secret: string, options: { expiresInSec?: number } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const body: JwtPayload = { ...payload, iat: payload.iat ?? now };
  if (options.expiresInSec) body.exp = now + options.expiresInSec;
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const data = `${head}.${b64url(JSON.stringify(body))}`;
  return `${data}.${createHmac("sha256", secret).update(data).digest("base64url")}`;
}

export class JwtError extends Error {}

/** Verifies signature, `alg` and `exp`/`nbf` (60 s leeway); returns the payload or throws JwtError. */
export function verifyJwt(token: string, secret: string): JwtPayload {
  const parts = token.trim().split(".");
  if (parts.length !== 3) throw new JwtError("malformed token");
  const [head, body, sig] = parts;
  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(Buffer.from(head, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new JwtError("malformed token");
  }
  if (typeof header !== "object" || header === null || (header as { alg?: unknown }).alg !== "HS256") {
    throw new JwtError("unsupported algorithm");
  }
  const expected = createHmac("sha256", secret).update(`${head}.${body}`).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new JwtError("bad signature");
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new JwtError("payload is not an object");
  const claims = payload as JwtPayload;
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === "number" && now > claims.exp + 60) throw new JwtError("token expired");
  if (typeof claims.nbf === "number" && now + 60 < claims.nbf) throw new JwtError("token not yet valid");
  return claims;
}

/** `Authorization: Bearer <jwt>` -> the token, or null. */
export function bearerToken(header: string | null): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header?.trim() ?? "");
  return match ? match[1] : null;
}
