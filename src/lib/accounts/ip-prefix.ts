import { authMac } from "@/lib/accounts/auth-secret";
import { addressBuckets } from "@/lib/net/client-ip.mjs";

/**
 * Client address prefixes for the sign-in defences (proof-of-work binding, adaptive difficulty, pending-account caps,
 * rate limits, security events): an IPv4 address as is (/32), an IPv6 address by its /64 (one subscriber's whole
 * allocation, zero-padded: `2001:0db8:0000:0000::/64`), anything else (the shared "local" bucket of a server started
 * without the peer stamp) as is. One implementation, shared with the preloads: src/lib/net/client-ip.mjs
 * `addressBuckets`. Idempotent: `clientPrefix(clientPrefix(ip)) === clientPrefix(ip)`, so it is safe on a value that
 * network.ts `clientIp` already grouped. `prefixTag` is the keyed hash stored on disk, so accounts.json never holds
 * client addresses.
 */
export function clientPrefix(ip: string): string {
  return addressBuckets(ip).narrow;
}

/** 16 base64url characters of HMAC(auth key, prefix). */
export function prefixTag(ip: string): string {
  return authMac("ip-prefix", clientPrefix(ip)).toString("base64url").slice(0, 16);
}
