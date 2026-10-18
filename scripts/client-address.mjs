// Client address of a raw Node request (IncomingMessage), for the preloads that run before Next (scripts/office-proxy.mjs,
// scripts/abuse-guard.mjs). The rules live in src/lib/net/client-ip.mjs, shared with src/lib/accounts/network.ts:
// `X-Forwarded-For` / `X-Forwarded-Proto` count only when the TCP peer matches KNIFE_TRUSTED_PROXIES, and the client is
// the right-most forwarded entry that is not itself a trusted proxy. No dependencies; tests/client_ip.test.mjs.
import { ipMatches, normalizeIp, resolveClient, trustedRules } from "../src/lib/net/client-ip.mjs";

export { addressBuckets, ipMatches, trustedRules } from "../src/lib/net/client-ip.mjs";

function fromTrusted(request, rules) {
  const peer = request.socket?.remoteAddress;
  return Boolean(peer) && rules.some((rule) => ipMatches(peer, rule));
}

/** The client's address: the TCP peer, or the right-most untrusted `X-Forwarded-For` entry behind a trusted proxy. */
export function clientAddress(request, rules = trustedRules()) {
  return resolveClient({ peer: request.socket?.remoteAddress, forwardedFor: request.headers?.["x-forwarded-for"], rules })
    ?? (normalizeIp(request.socket?.remoteAddress ?? "") || "unknown");
}

/** HTTPS as the browser sees it: `X-Forwarded-Proto` from a trusted proxy, else whether the socket is TLS. */
export function requestIsHttps(request, rules = trustedRules()) {
  if (fromTrusted(request, rules)) {
    const forwarded = String(request.headers["x-forwarded-proto"] ?? "").split(",")[0].trim().toLowerCase();
    if (forwarded) return forwarded === "https";
  }
  return Boolean(request.socket?.encrypted);
}
