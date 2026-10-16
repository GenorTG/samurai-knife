import { isIP } from "node:net";

/**
 * Who is on the other end of a request. Next hands route handlers a `Request` without the socket, and it only fills
 * `X-Forwarded-For` from the socket when the client did not send one, so the socket peer is stamped into PEER_HEADER by
 * scripts/peer-address.cjs (preloaded by scripts/serve.mjs) and that value always overwrites whatever the client sent.
 *
 * Forwarded headers (`X-Forwarded-For`, `X-Forwarded-Proto`) are honoured only when the peer matches KNIFE_TRUSTED_PROXIES
 * (comma-separated IPs or IPv4/IPv6 CIDRs, e.g. `127.0.0.1,::1` for a reverse proxy on the same host). Without that every
 * client is "local": one shared rate-limit bucket per account, the same as before this module existed.
 */
export const PEER_HEADER = "x-knife-peer";

function normalize(ip: string): string {
  const trimmed = ip.trim().replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(trimmed);
  return (mapped ? mapped[1] : trimmed).toLowerCase();
}

function ipv4ToBigInt(ip: string): bigint {
  return ip.split(".").reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n);
}

function ipv6ToBigInt(ip: string): bigint | null {
  let text = ip;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const n = ipv4ToBigInt(v4[1]);
    text = `${text.slice(0, -v4[1].length)}${(n >> 16n).toString(16)}:${(n & 0xffffn).toString(16)}`;
  }
  const [head, tail, ...rest] = text.split("::");
  if (rest.length > 0) return null;
  const left = head ? head.split(":") : [];
  const right = tail !== undefined && tail ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (tail === undefined && missing !== 0)) return null;
  const groups = [...left, ...Array<string>(tail === undefined ? 0 : missing).fill("0"), ...right];
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return value;
}

/** `ip` inside `rule` (an IP or a CIDR). Malformed rules match nothing. */
export function ipMatches(ip: string, rule: string): boolean {
  const address = normalize(ip);
  const [base, bitsText, ...extra] = rule.trim().split("/");
  if (!base || extra.length > 0) return false;
  const network = normalize(base);
  const family = isIP(address);
  if (family === 0 || family !== isIP(network)) return false;
  const width = family === 4 ? 32 : 128;
  const bits = bitsText === undefined ? width : Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > width) return false;
  const a = family === 4 ? ipv4ToBigInt(address) : ipv6ToBigInt(address);
  const n = family === 4 ? ipv4ToBigInt(network) : ipv6ToBigInt(network);
  if (a === null || n === null) return false;
  const shift = BigInt(width - bits);
  return a >> shift === n >> shift;
}

function trustedRules(env: NodeJS.ProcessEnv): string[] {
  return (env.KNIFE_TRUSTED_PROXIES ?? "").split(",").map((rule) => rule.trim()).filter(Boolean);
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
 * Address used to bucket rate limits. From a trusted proxy: the right-most `X-Forwarded-For` entry that is not itself a
 * trusted proxy (entries further left are client-supplied). Otherwise "local" (the old behaviour, a single bucket).
 */
export function clientIp(request: Request, env: NodeJS.ProcessEnv = process.env): string {
  if (!fromTrustedProxy(request, env)) return "local";
  const rules = trustedRules(env);
  const chain = (request.headers.get("x-forwarded-for") ?? "").split(",").map((part) => normalize(part)).filter((part) => isIP(part));
  for (let i = chain.length - 1; i >= 0; i--) {
    if (!rules.some((rule) => ipMatches(chain[i], rule))) return chain[i];
  }
  return chain[0] ?? socketPeer(request) ?? "local";
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
