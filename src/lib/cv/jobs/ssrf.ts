/**
 * SSRF address policy. Pure (no node APIs) so it is unit-testable and shared by `fetch.ts`.
 * Fail closed: anything that does not parse, or is not clearly a public unicast address, is refused.
 */

export function parseIPv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/** IPv6 text -> eight 16-bit groups (handles `::`, an embedded IPv4 tail and a `%zone`). */
export function parseIPv6(text: string): number[] | null {
  let s = text.replace(/%.*$/, "");
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (!s.includes(":") || /[^0-9a-fA-F:.]/.test(s)) return null;
  const tail = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const v4 = parseIPv4(tail[2]);
    if (!v4) return null;
    s = `${tail[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      groups.push(parseInt(g, 16));
    }
    return groups;
  };
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  if (!head || !rest) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - rest.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...rest];
}

const inV4 = (o: readonly number[], a: number, b: number, c: number, d: number, bits: number): boolean => {
  const value = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
  const base = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (base & mask);
};

/** Reserved / non-public IPv4 ranges: [label, a, b, c, d, prefix bits]. */
const BLOCKED_V4: readonly [string, number, number, number, number, number][] = [
  ["unspecified/this-network", 0, 0, 0, 0, 8],
  ["private (10/8)", 10, 0, 0, 0, 8],
  ["CGNAT/Tailscale (100.64/10)", 100, 64, 0, 0, 10],
  ["loopback", 127, 0, 0, 0, 8],
  ["link-local/cloud metadata (169.254/16)", 169, 254, 0, 0, 16],
  ["private (172.16/12)", 172, 16, 0, 0, 12],
  ["IETF protocol assignments", 192, 0, 0, 0, 24],
  ["documentation (TEST-NET-1)", 192, 0, 2, 0, 24],
  ["6to4 relay anycast", 192, 88, 99, 0, 24],
  ["private (192.168/16)", 192, 168, 0, 0, 16],
  ["benchmarking (198.18/15)", 198, 18, 0, 0, 15],
  ["documentation (TEST-NET-2)", 198, 51, 100, 0, 24],
  ["documentation (TEST-NET-3)", 203, 0, 113, 0, 24],
  ["multicast", 224, 0, 0, 0, 4],
  ["reserved/broadcast", 240, 0, 0, 0, 4],
];

function blockedV4(octets: readonly number[]): string | null {
  for (const [label, a, b, c, d, bits] of BLOCKED_V4) if (inV4(octets, a, b, c, d, bits)) return label;
  return null;
}

/** Non-public IPv6: everything outside global unicast 2000::/3, plus special-purpose blocks inside it. */
function blockedV6(g: readonly number[]): string | null {
  if (g.every((x) => x === 0)) return "unspecified (::)";
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback (::1)";
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return "IPv4-mapped IPv6";
  if (g.slice(0, 6).every((x) => x === 0)) return "IPv4-compatible IPv6";
  if (g[0] === 0x64 && g[1] === 0xff9b) return "NAT64 (64:ff9b::/96)";
  if ((g[0] & 0xfe00) === 0xfc00) return "unique-local (fc00::/7)";
  if ((g[0] & 0xffc0) === 0xfe80) return "link-local (fe80::/10)";
  if ((g[0] & 0xffc0) === 0xfec0) return "site-local (fec0::/10)";
  if ((g[0] & 0xff00) === 0xff00) return "multicast (ff00::/8)";
  if ((g[0] & 0xe000) !== 0x2000) return "not global unicast (outside 2000::/3)";
  if (g[0] === 0x2001 && g[1] < 0x200) return "IETF special-purpose (2001::/23, incl. Teredo)";
  if (g[0] === 0x2001 && g[1] === 0xdb8) return "documentation (2001:db8::/32)";
  if (g[0] === 0x2002) return "6to4 (2002::/16)";
  if (g[0] === 0x3fff && g[1] < 0x1000) return "documentation (3fff::/20)";
  return null;
}

/** Why `address` (IPv4 or IPv6 text, no brackets) must not be fetched; null = public unicast. */
export function blockedAddressReason(address: string): string | null {
  const v4 = parseIPv4(address);
  if (v4) return blockedV4(v4);
  const v6 = parseIPv6(address);
  if (v6) return blockedV6(v6);
  return "not a valid IP address";
}

/** Host names that are local by definition, whatever DNS says. */
export function blockedHostnameReason(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  if (!host) return "empty host";
  if (host === "localhost" || host.endsWith(".localhost")) return "localhost";
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan") || host.endsWith(".home.arpa")) return "local network name";
  return null;
}

/** WHATWG-normalised URL hostname -> IP literal text, or null for a DNS name. */
export function ipLiteralOf(hostname: string): string | null {
  if (hostname.startsWith("[") && hostname.endsWith("]")) return hostname.slice(1, -1);
  return parseIPv4(hostname) ? hostname : null;
}
