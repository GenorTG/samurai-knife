// Client identity, shared by the app (src/lib/accounts/network.ts) and the preloads that run before Next
// (scripts/client-address.mjs -> office proxy, abuse guard): one implementation, so the TS and .mjs sides never drift.
// Threat model: every forwarded header is client-controlled unless the TCP peer is a trusted proxy; an attacker owns a
// whole IPv6 /64 (often a /48), so per-address budgets bucket IPv6 by /64 with a coarser /48 companion, IPv4 by /32 with an
// optional /24 companion. Plain JavaScript with JSDoc types (tsconfig allowJs) and no dependencies. The prefix keys are the
// one canonical client key everywhere (rate limits, proof-of-work binding, pending caps, security events, the abuse guard):
// src/lib/accounts/ip-prefix.ts `clientPrefix` is `addressBuckets(ip).narrow`. Tests: tests/client_ip.test.mjs.
import { isIP } from "node:net";

/** Lower-cased, brackets stripped, IPv4-mapped IPv6 (`::ffff:1.2.3.4`) folded to IPv4. */
export function normalizeIp(/** @type {string} */ ip) {
  const trimmed = String(ip ?? "").trim().replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(trimmed);
  return (mapped ? mapped[1] : trimmed).toLowerCase();
}

/** @param {string} ip */
function v4(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n);
}

/** @param {string} ip @returns {bigint | null} */
function v6(ip) {
  let text = ip.replace(/%.*$/, "");
  const tail4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail4) {
    const n = v4(tail4[1]);
    if (n === null) return null;
    text = `${text.slice(0, -tail4[1].length)}${(n >> 16n).toString(16)}:${(n & 0xffffn).toString(16)}`;
  }
  const [head, tail, ...rest] = text.split("::");
  if (rest.length > 0) return null;
  const left = head ? head.split(":") : [];
  const right = tail !== undefined && tail ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (tail === undefined && missing !== 0)) return null;
  const groups = [...left, ...Array(tail === undefined ? 0 : missing).fill("0"), ...right];
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return value;
}

/** {family, value} of a literal address, or null. */
function parse(/** @type {string} */ ip) {
  const address = normalizeIp(ip);
  const family = isIP(address);
  if (family === 4) {
    const value = v4(address);
    return value === null ? null : { family: 4, value };
  }
  if (family === 6) {
    const value = v6(address);
    return value === null ? null : { family: 6, value };
  }
  return null;
}

/**
 * A rule (`1.2.3.4`, `10.0.0.0/8`, `::1`, `fd7a:115c:a1e0::/48`) as {family, value, bits}, or null when malformed.
 * @param {string} rule
 */
export function parseRule(rule) {
  const [base, bitsText, ...extra] = String(rule ?? "").trim().split("/");
  if (!base || extra.length > 0) return null;
  const network = parse(base);
  if (!network) return null;
  const width = network.family === 4 ? 32 : 128;
  const bits = bitsText === undefined ? width : /^\d{1,3}$/.test(bitsText) ? Number(bitsText) : NaN;
  if (!Number.isInteger(bits) || bits < 0 || bits > width) return null;
  return { family: network.family, value: network.value, bits };
}

/** `ip` inside `rule` (an IP or a CIDR). Malformed rules match nothing. */
export function ipMatches(/** @type {string} */ ip, /** @type {string} */ rule) {
  const address = parse(ip);
  const network = parseRule(rule);
  if (!address || !network || address.family !== network.family) return false;
  const shift = BigInt((address.family === 4 ? 32 : 128) - network.bits);
  return address.value >> shift === network.value >> shift;
}

/** KNIFE_TRUSTED_PROXIES as a list of rules (comma-separated IPs/CIDRs). */
export function trustedRules(/** @type {Record<string, string | undefined>} */ env = process.env) {
  return String(env.KNIFE_TRUSTED_PROXIES ?? "").split(",").map((rule) => rule.trim()).filter(Boolean);
}

/**
 * The client behind a request. `peer` = the TCP peer; `forwardedFor` = the raw `X-Forwarded-For` value. Forwarded entries
 * count only when the peer matches a trusted rule; then the client is the right-most entry that is not itself a trusted
 * proxy (entries further left are whatever the client chose to send). When every entry is a trusted proxy (or the header
 * is missing), the client is the right-most entry, then the peer: never a client-chosen left-hand value.
 * Returns null without a usable peer.
 * @param {{ peer: string | null | undefined, forwardedFor?: string | string[] | null, rules?: string[] }} input
 * @returns {string | null}
 */
export function resolveClient({ peer, forwardedFor, rules = [] }) {
  const from = peer ? normalizeIp(peer) : "";
  if (!from || !isIP(from)) return null;
  if (!rules.some((rule) => ipMatches(from, rule))) return from;
  const raw = Array.isArray(forwardedFor) ? forwardedFor.join(",") : String(forwardedFor ?? "");
  const chain = raw.split(",").map(normalizeIp).filter((part) => isIP(part) !== 0 && parse(part) !== null);
  for (let i = chain.length - 1; i >= 0; i--) {
    if (!rules.some((rule) => ipMatches(chain[i], rule))) return chain[i];
  }
  return chain.length ? chain[chain.length - 1] : from;
}

/** @param {bigint} value @param {number} bits */
function v6Prefix(value, bits) {
  const masked = (value >> BigInt(128 - bits)) << BigInt(128 - bits);
  const groups = [];
  for (let i = 7; i >= 0; i--) groups.push(((masked >> BigInt(i * 16)) & 0xffffn).toString(16).padStart(4, "0"));
  // The kept groups, zero-padded (one spelling per prefix): `2001:0db8:0001:0002::/64`.
  return `${groups.slice(0, bits / 16).join(":")}::/${bits}`;
}

/** @param {bigint} value @param {number} bits */
function v4Prefix(value, bits) {
  const masked = bits === 0 ? 0n : (value >> BigInt(32 - bits)) << BigInt(32 - bits);
  const parts = [24n, 16n, 8n, 0n].map((shift) => String((masked >> shift) & 0xffn));
  return bits === 32 ? parts.join(".") : `${parts.join(".")}/${bits}`;
}

/**
 * Bucket keys for an address. `narrow` = the per-client key (IPv4 /32 = the address itself, IPv6 /64, e.g.
 * `2001:0db8:0001:0002::/64`); `wide` = the coarse companion (IPv4 /24, IPv6 /48). Anything that is not an IP literal
 * ("local", or a key this function already returned) is its own narrow and wide key, so it is idempotent on narrow keys.
 * @param {string} address
 * @returns {{ narrow: string, wide: string, family: 0 | 4 | 6 }}
 */
export function addressBuckets(address) {
  const parsed = parse(address);
  if (!parsed) return { narrow: String(address), wide: String(address), family: 0 };
  if (parsed.family === 4) return { narrow: v4Prefix(parsed.value, 32), wide: v4Prefix(parsed.value, 24), family: 4 };
  return { narrow: v6Prefix(parsed.value, 64), wide: v6Prefix(parsed.value, 48), family: 6 };
}

/**
 * The coarse key for a narrow bucket key (what `addressBuckets(...).narrow` returned): `1.2.3.4` -> `1.2.3.0/24`,
 * `2001:0db8:0001:0002::/64` -> `2001:0db8:0001::/48`. Null for anything else (callers then skip the wide bucket).
 * @param {string} narrow
 * @returns {string | null}
 */
export function wideKeyOf(narrow) {
  const text = String(narrow ?? "");
  const v6Match = /^([0-9a-f:]+)::\/64$/.exec(text);
  if (v6Match) {
    const parsed = parse(`${v6Match[1]}::`);
    return parsed && parsed.family === 6 ? v6Prefix(parsed.value, 48) : null;
  }
  const parsed = parse(text);
  return parsed && parsed.family === 4 ? v4Prefix(parsed.value, 24) : null;
}

const LOOPBACK = ["127.0.0.0/8", "::1/128"];
const TAILSCALE = ["100.64.0.0/10", "fd7a:115c:a1e0::/48"];
const PRIVATE = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "fc00::/7", "fe80::/10"];

/** "loopback" | "tailscale" | "private" | "public" | null (not an IP literal). */
export function addressScope(/** @type {string} */ ip) {
  if (!parse(ip)) return null;
  if (LOOPBACK.some((rule) => ipMatches(ip, rule))) return "loopback";
  if (TAILSCALE.some((rule) => ipMatches(ip, rule))) return "tailscale";
  if (PRIVATE.some((rule) => ipMatches(ip, rule))) return "private";
  return "public";
}
