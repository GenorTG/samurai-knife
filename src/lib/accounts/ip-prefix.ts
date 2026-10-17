import { isIP } from "node:net";
import { authMac } from "@/lib/accounts/auth-secret";

/**
 * Client address prefixes for the sign-in defences (proof-of-work binding, adaptive difficulty, pending-account caps):
 * an IPv4 address as is (/32), an IPv6 address by its /64 (one subscriber's whole allocation), anything else (the
 * shared "local" bucket of a server without a trusted proxy) as is. `prefixTag` is the keyed hash stored on disk, so
 * accounts.json never holds client addresses.
 */

function expandIpv6(ip: string): string[] | null {
  let text = ip.toLowerCase();
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    text = `${text.slice(0, -v4[0].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...left, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.padStart(4, "0"));
}

export function clientPrefix(ip: string): string {
  const value = ip.trim().replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(value);
  if (mapped) return mapped[1];
  if (isIP(value) === 6) {
    const groups = expandIpv6(value);
    return groups ? `${groups.slice(0, 4).join(":")}::/64` : value;
  }
  return value;
}

/** 16 base64url characters of HMAC(auth key, prefix). */
export function prefixTag(ip: string): string {
  return authMac("ip-prefix", clientPrefix(ip)).toString("base64url").slice(0, 16);
}
