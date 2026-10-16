// SERVER ONLY. Uses node:dns / node:http(s) / node:os; never import this from client components.
import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { networkInterfaces } from "node:os";
import { blockedAddressReason, blockedHostnameReason, ipLiteralOf, isIpAddress, parseCidr, parseCidrList, parseIPv6, type Cidr } from "./address-policy";

/**
 * The one SSRF-safe outbound HTTP path for anything a user can point the server at (provider base URL, job postings,
 * company pages). Per request: static URL checks (scheme, credentials, port, local names) -> resolve the host once ->
 * EVERY address must pass the policy (reserved ranges + the deny list) -> connect to one of exactly those addresses
 * (pinned: no second DNS lookup, so no rebinding) -> no redirect is followed here (callers that follow them re-run the
 * whole check per hop). The real host name is kept only for the Host header and TLS (SNI + certificate check).
 *
 * Deny list (on top of loopback/private/link-local/CGNAT incl. Tailscale/ULA/metadata/...): `KNIFE_SSRF_DENY_CIDRS`
 * (the host's public IPv4 for hairpin NAT, the LAN's delegated IPv6 prefix, other networks of yours) plus every address
 * on this machine's interfaces, and the /64 of each global IPv6 one (the LAN's prefix, discovered).
 */

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface TransportRequest {
  url: URL;
  /** The preferred validated address; the transport must connect to an address from `addresses` and never resolve the host again. */
  ip: ResolvedAddress;
  /** Every validated address of the host (IPv4 first), for fallback when one family is unreachable. */
  addresses: ResolvedAddress[];
  method?: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  signal: AbortSignal;
}

export interface TransportResponse {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
  close(): void;
}

export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export interface OutboundPolicy {
  /** Admin opt-out (and private mode): loopback/LAN/Tailscale destinations allowed. The connection is still pinned. */
  allowPrivate: boolean;
  /** Allowed URL ports ("" = scheme default); null = any. */
  ports: ReadonlySet<string> | null;
  httpsOnly: boolean;
}

export type OutboundErrorKind = "refused" | "resolve" | "network" | "timeout";

/** A refused or failed outbound request. `message` is safe to show the user (no response body, no internal detail). */
export class OutboundError extends Error {
  readonly kind: OutboundErrorKind;
  constructor(kind: OutboundErrorKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = "OutboundError";
  }
}

// --- deny list -------------------------------------------------------------------------------

let cachedDeny: { at: number; env: string; cidrs: Cidr[] } | null = null;
const DENY_TTL_MS = 60_000;

/** The host's own interface addresses (+ the /64 of global IPv6 ones). Private ones are blocked anyway; listing them is harmless. */
function interfaceCidrs(): Cidr[] {
  const out: Cidr[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      const address = info.address.replace(/%.*$/, "");
      const exact = parseCidr(address);
      if (exact) out.push(exact);
      const groups = info.family === "IPv6" ? parseIPv6(address) : null;
      if (groups && (groups[0] & 0xe000) === 0x2000) {
        const prefix = parseCidr(`${groups.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`);
        if (prefix) out.push(prefix);
      }
    }
  }
  return out;
}

/** KNIFE_SSRF_DENY_CIDRS + this machine's own addresses; re-read once a minute (interfaces and env can change). */
export function denyList(env: NodeJS.ProcessEnv = process.env, now = Date.now()): Cidr[] {
  const raw = env.KNIFE_SSRF_DENY_CIDRS ?? "";
  if (cachedDeny && cachedDeny.env === raw && now - cachedDeny.at < DENY_TTL_MS) return cachedDeny.cidrs;
  const { cidrs, invalid } = parseCidrList(raw);
  if (invalid.length) console.warn(`[safe-fetch] KNIFE_SSRF_DENY_CIDRS: ignoring ${invalid.join(", ")} (not an address or CIDR)`);
  const all = [...cidrs, ...interfaceCidrs()];
  cachedDeny = { at: now, env: raw, cidrs: all };
  return all;
}

// --- checks ----------------------------------------------------------------------------------

function refused(url: URL, why: string): OutboundError {
  return new OutboundError("refused", `refusing to fetch ${url.protocol}//${url.host}: ${why}`);
}

function describePorts(ports: ReadonlySet<string>): string {
  return [...ports].filter(Boolean).join(", ");
}

/** Static checks before any DNS or network: scheme, credentials, port, local names, address literals. */
export function checkUrl(url: URL, policy: OutboundPolicy, deny: readonly Cidr[] = denyList()): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new OutboundError("refused", `refusing '${url.protocol}': only http(s) URLs are fetched`);
  if (policy.httpsOnly && url.protocol !== "https:") throw refused(url, "only https URLs are allowed");
  if (url.username || url.password) throw refused(url, "URLs with embedded credentials are not allowed");
  if (policy.ports && !policy.ports.has(url.port)) throw refused(url, `port ${url.port} is not allowed (${describePorts(policy.ports)} only)`);
  if (policy.allowPrivate) return;
  const local = blockedHostnameReason(url.hostname);
  if (local) throw refused(url, `${local} is not a public address`);
  const literal = ipLiteralOf(url.hostname);
  const reason = literal ? blockedAddressReason(literal, deny) : null;
  if (reason) throw refused(url, `${literal} (${reason}) is not a public address`);
}

function systemResolve(hostname: string): Promise<ResolvedAddress[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 })));
    });
  });
}

/** Resolve the host and require EVERY address to pass; returns them (IPv4 first) as the only addresses the connection may use. */
export async function resolveAllowed(url: URL, policy: OutboundPolicy, resolve: Resolver = systemResolve, deny: readonly Cidr[] = denyList()): Promise<ResolvedAddress[]> {
  const literal = ipLiteralOf(url.hostname);
  let addresses: ResolvedAddress[];
  if (literal) {
    addresses = [{ address: literal, family: literal.includes(":") ? 6 : 4 }];
  } else {
    try {
      addresses = await resolve(url.hostname);
    } catch (error) {
      throw new OutboundError("resolve", `could not resolve ${url.hostname}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!addresses.length) throw new OutboundError("resolve", `${url.hostname} did not resolve to any address`);
  for (const { address } of addresses) {
    const reason = policy.allowPrivate ? (isIpAddress(address) ? null : "not a valid IP address") : blockedAddressReason(address, deny);
    if (reason) throw refused(url, `${url.hostname} resolves to ${address} (${reason}), which is not a public address`);
  }
  return [...addresses.filter((a) => a.family === 4), ...addresses.filter((a) => a.family === 6)];
}

// --- transport -------------------------------------------------------------------------------

/**
 * One exchange pinned to a validated address. We connect to the IP literal and keep the real host name only for the
 * Host header and TLS (SNI + certificate check via `servername`). A custom `lookup` option is NOT used: on Node 26 a
 * failed connect through it surfaces as uncaught exceptions that take the whole server down.
 */
function attempt(request: TransportRequest, target: ResolvedAddress): Promise<TransportResponse> {
  return new Promise((resolve, reject) => {
    const secure = request.url.protocol === "https:";
    const client = secure ? https : http;
    const body = typeof request.body === "string" ? Buffer.from(request.body) : request.body;
    const req = client.request(
      {
        host: target.address,
        port: request.url.port || (secure ? 443 : 80),
        path: `${request.url.pathname}${request.url.search}`,
        method: request.method ?? "GET",
        headers: { ...request.headers, Host: request.url.host, ...(body ? { "Content-Length": String(body.byteLength) } : {}) },
        ...(secure ? { servername: request.url.hostname.replace(/^\[|\]$/g, "") } : {}),
        signal: request.signal,
        agent: false,
      },
      (res) => {
        const headers: Record<string, string | undefined> = {};
        for (const [name, value] of Object.entries(res.headers)) headers[name] = Array.isArray(value) ? value.join(", ") : value;
        resolve({ status: res.statusCode ?? 0, headers, body: res, close: () => res.destroy() });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** Tries each validated address in order (IPv4 first) until one connects. */
export async function nodeTransport(request: TransportRequest): Promise<TransportResponse> {
  let failure: unknown = new Error("no address to connect to");
  for (const target of request.addresses) {
    try {
      return await attempt(request, target);
    } catch (error) {
      failure = error;
      if (request.signal.aborted) break;
    }
  }
  throw failure;
}

// --- fetch -----------------------------------------------------------------------------------

export interface SafeFetchInit {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  policy: OutboundPolicy;
  /** Test seams. */
  resolve?: Resolver;
  transport?: Transport;
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/**
 * `fetch` for user-steered URLs: checks + pinned connection, NO redirects (a 3xx is an error, like `redirect: "error"`),
 * streaming body. Rejects with OutboundError ("refused" before any connection; "network"/"timeout" after), or with the
 * signal's reason name kept (`AbortError`/`TimeoutError`) when the caller's signal fired.
 */
export async function safeFetch(input: string | URL, init: SafeFetchInit): Promise<Response> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new OutboundError("refused", "not a valid URL");
  }
  const signal = init.signal ?? AbortSignal.timeout(30_000);
  checkUrl(url, init.policy);
  const addresses = await resolveAllowed(url, init.policy, init.resolve);
  if (signal.aborted) throw abortError(signal);
  let response: TransportResponse;
  try {
    response = await (init.transport ?? nodeTransport)({
      url,
      ip: addresses[0],
      addresses,
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      body: init.body,
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw abortError(signal);
    throw new OutboundError("network", `could not connect to ${url.host}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status >= 300 && response.status < 400) {
    response.close();
    throw new OutboundError("network", `${url.host} answered with a redirect (HTTP ${response.status}); redirects are not followed`);
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(name, value);
  const status = response.status >= 200 && response.status <= 599 ? response.status : 502;
  const body = NULL_BODY.has(status) ? null : toWebStream(response);
  if (!body) response.close();
  return new Response(body, { status, headers });
}

/** Pull-based: nothing is read from the socket until the consumer asks; cancelling closes the connection. */
function toWebStream(response: TransportResponse): ReadableStream<Uint8Array> {
  const iterator = response.body[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await iterator.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      response.close();
    },
  });
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

/** Reads a Response body as text, aborting past `maxBytes` (returns null then). */
export async function readTextCapped(response: Response, maxBytes: number): Promise<string | null> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) return null;
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString("utf8");
}
