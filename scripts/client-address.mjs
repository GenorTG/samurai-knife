// Client address of a raw Node request (IncomingMessage), for the preloads that run before Next (scripts/office-proxy.mjs).
// Same rules as src/lib/accounts/network.ts: `X-Forwarded-For` / `X-Forwarded-Proto` count only when the TCP peer matches
// KNIFE_TRUSTED_PROXIES, and the client is the right-most forwarded entry that is not itself a trusted proxy. No
// dependencies; tests/office_proxy.test.mjs.
import { isIP } from "node:net";

function normalize(ip) {
  const trimmed = String(ip).trim().replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(trimmed);
  return (mapped ? mapped[1] : trimmed).toLowerCase();
}

function v4(ip) {
  return ip.split(".").reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n);
}

function v6(ip) {
  let text = ip;
  const tail4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail4) {
    const n = v4(tail4[1]);
    text = `${text.slice(0, -tail4[1].length)}${(n >> 16n).toString(16)}:${(n & 0xffffn).toString(16)}`;
  }
  const [head, tail, ...rest] = text.split("::");
  if (rest.length > 0) return null;
  const left = head ? head.split(":") : [];
  const right = tail !== undefined && tail ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (tail === undefined && missing !== 0)) return null;
  const groups = [...left, ...Array(tail === undefined ? 0 : missing).fill("0"), ...right];
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return groups.length === 8 ? value : null;
}

/** `ip` inside `rule` (an IP or a CIDR). Malformed rules match nothing. */
export function ipMatches(ip, rule) {
  const address = normalize(ip);
  const [base, bitsText, ...extra] = String(rule).trim().split("/");
  if (!base || extra.length > 0) return false;
  const network = normalize(base);
  const family = isIP(address);
  if (family === 0 || family !== isIP(network)) return false;
  const width = family === 4 ? 32 : 128;
  const bits = bitsText === undefined ? width : Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > width) return false;
  const a = family === 4 ? v4(address) : v6(address);
  const n = family === 4 ? v4(network) : v6(network);
  if (a === null || n === null) return false;
  const shift = BigInt(width - bits);
  return a >> shift === n >> shift;
}

export function trustedRules(env = process.env) {
  return (env.KNIFE_TRUSTED_PROXIES ?? "").split(",").map((rule) => rule.trim()).filter(Boolean);
}

function fromTrusted(request, rules) {
  const peer = request.socket?.remoteAddress;
  return Boolean(peer) && rules.some((rule) => ipMatches(peer, rule));
}

/** The client's address: the TCP peer, or the right-most untrusted `X-Forwarded-For` entry behind a trusted proxy. */
export function clientAddress(request, rules = trustedRules()) {
  const peer = normalize(request.socket?.remoteAddress ?? "") || "unknown";
  if (!fromTrusted(request, rules)) return peer;
  const chain = String(request.headers["x-forwarded-for"] ?? "").split(",").map(normalize).filter((part) => isIP(part));
  for (let i = chain.length - 1; i >= 0; i--) {
    if (!rules.some((rule) => ipMatches(chain[i], rule))) return chain[i];
  }
  return chain[0] ?? peer;
}

/** HTTPS as the browser sees it: `X-Forwarded-Proto` from a trusted proxy, else whether the socket is TLS. */
export function requestIsHttps(request, rules = trustedRules()) {
  if (fromTrusted(request, rules)) {
    const forwarded = String(request.headers["x-forwarded-proto"] ?? "").split(",")[0].trim().toLowerCase();
    if (forwarded) return forwarded === "https";
  }
  return Boolean(request.socket?.encrypted);
}
