import { isIP } from "node:net";
import { addressBuckets, ipMatches, normalizeIp as normalize, resolveClient, trustedRules as sharedTrustedRules } from "@/lib/net/client-ip.mjs";

/**
 * Who is on the other end of a request. Next hands route handlers a `Request` without the socket, and it only fills
 * `X-Forwarded-For` from the socket when the client did not send one, so the socket peer is stamped into PEER_HEADER by
 * scripts/peer-address.mjs (preloaded by scripts/serve.mjs) and that value always overwrites whatever the client sent.
 *
 * Forwarded headers (`X-Forwarded-For`, `X-Forwarded-Proto`) are honoured only when the peer matches KNIFE_TRUSTED_PROXIES
 * (comma-separated IPs or IPv4/IPv6 CIDRs, e.g. `127.0.0.1,::1` for a reverse proxy on the same host); otherwise the
 * client is the socket peer. The rules are shared with the preloads (src/lib/net/client-ip.mjs). Rate limits bucket the
 * client by prefix: IPv4 /32, IPv6 /64 (`clientIp`), with /24 and /48 companions added by src/lib/accounts/rate-limit.ts.
 */
export const PEER_HEADER = "x-knife-peer";

export { ipMatches };

function trustedRules(env: NodeJS.ProcessEnv): string[] {
  return sharedTrustedRules(env);
}

/** The socket peer stamped by the preload, or null when the server was not started through scripts/serve.mjs. */
export function socketPeer(request: Request): string | null {
  const value = request.headers.get(PEER_HEADER)?.trim();
  return value && isIP(normalize(value)) ? normalize(value) : null;
}

export function fromTrustedProxy(request: Request, env: NodeJS.ProcessEnv = process.env): boolean {
  const peer = socketPeer(request);
  return peer !== null && trustedRules(env).some((rule) => ipMatches(peer, rule));
}

/**
 * The client's address: the socket peer, or behind a trusted proxy the right-most `X-Forwarded-For` entry that is not
 * itself a trusted proxy (entries further left are client-supplied). "local" when the server was not started through
 * scripts/serve.mjs (no peer stamp).
 */
export function clientAddress(request: Request, env: NodeJS.ProcessEnv = process.env): string {
  const peer = request.headers.get(PEER_HEADER);
  return resolveClient({ peer, forwardedFor: request.headers.get("x-forwarded-for"), rules: trustedRules(env) }) ?? "local";
}

/**
 * Key used to bucket per-client rate limits: the client address grouped by prefix (IPv4 /32, IPv6 /64: one host owns a
 * whole /64), e.g. `203.0.113.9` or `2001:0db8:0001:0002::/64` (src/lib/accounts/ip-prefix.ts `clientPrefix`); "local" without a peer stamp.
 */
export function clientIp(request: Request, env: NodeJS.ProcessEnv = process.env): string {
  return addressBuckets(clientAddress(request, env)).narrow;
}

/** HTTPS as the browser sees it: `X-Forwarded-Proto` from a trusted proxy, else the request URL itself. */
export function isHttps(request: Request, env: NodeJS.ProcessEnv = process.env): boolean {
  if (fromTrustedProxy(request, env)) {
    const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
    if (forwarded) return forwarded === "https";
  }
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}
