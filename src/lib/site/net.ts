// SERVER ONLY. Outbound requests of the website studio: pages of the user's site (audits) and the JSON APIs it uses
// (GitHub, PageSpeed Insights), all through the shared SSRF guard (src/lib/net/safe-fetch.ts).
import { isPublicMode } from "@/lib/accounts/mode";
import { OutboundRefused } from "@/lib/net/outbound";
import type { Account } from "@/lib/accounts/store";
import {
  checkUrl,
  denyList,
  nodeTransport,
  OutboundError,
  readTextCapped,
  resolveAllowed,
  safeFetch,
  type OutboundPolicy,
  type Resolver,
  type Transport,
  type TransportResponse,
} from "@/lib/net/safe-fetch";
import { msgf } from "@/lib/i18n/msg";

export class SiteError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "SiteError";
    this.status = status;
  }
}

/**
 * Where a site audit may go. Private mode (the owner's toolbox): any address, so a dev server on the LAN can be audited,
 * like the provider rule. Public mode: public addresses only; an admin with `privateNetwork` may reach private ones.
 * Every request is resolved once and pinned (no DNS rebinding); every redirect hop is re-checked from scratch.
 */
export function sitePolicy(account: Pick<Account, "role" | "privateNetwork">): OutboundPolicy {
  if (!isPublicMode()) return { allowPrivate: true, ports: null, httpsOnly: false };
  return { allowPrivate: account.role === "admin" && account.privateNetwork, ports: new Set(["", "80", "443", "8080", "8443"]), httpsOnly: false };
}

/**
 * The fixed JSON APIs (GitHub, PageSpeed): https only, public addresses. An operator override of their base URL
 * (KNIFE_GITHUB_API_URL / KNIFE_GITHUB_WEB_URL / KNIFE_PSI_API_URL: GitHub Enterprise on the LAN, test mocks) is server
 * configuration, not a user-steered URL, so it may be private in any mode.
 */
export function apiPolicy(url: string): OutboundPolicy {
  const builtIn = /^https:\/\/(api\.github\.com|github\.com|www\.googleapis\.com)\//.test(url);
  if (!builtIn && isOperatorOverride(url)) return { allowPrivate: true, ports: null, httpsOnly: false };
  return { allowPrivate: false, ports: null, httpsOnly: true };
}

function isOperatorOverride(url: string): boolean {
  return ["KNIFE_GITHUB_API_URL", "KNIFE_GITHUB_WEB_URL", "KNIFE_PSI_API_URL"].some((name) => {
    const base = process.env[name]?.trim().replace(/\/+$/, "");
    return !!base && (url === base || url.startsWith(`${base}/`) || url.startsWith(`${base}?`));
  });
}

export interface NetDeps {
  resolve?: Resolver;
  transport?: Transport;
  /** Called with every page URL before it is requested (each redirect hop): the per-host outbound budget. */
  admitHop?: (url: URL) => void;
}

export interface FetchedPage {
  /** The URL asked for. */
  url: string;
  /** After redirects. */
  finalUrl: string;
  /** Every hop, first to last, with its status (a redirect chain shows here). */
  hops: { url: string; status: number }[];
  status: number;
  /** Lower-cased header names of the final response. */
  headers: Record<string, string>;
  contentType: string;
  body: string;
  bytes: number;
  /** Time to the first byte of the final response, ms. */
  ttfbMs: number;
  totalMs: number;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
export const PAGE_TIMEOUT_MS = 20_000;
export const PAGE_MAX_BYTES = 4_000_000;
const UA = "Mozilla/5.0 (compatible; samurai-knife-site/1.0; audits a website at its owner's request)";

function headerRecord(response: TransportResponse): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) out[name.toLowerCase()] = value;
  return out;
}

async function readBody(response: TransportResponse, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of response.body) {
      if (signal.aborted) throw new SiteError("the page timed out", 504);
      total += chunk.byteLength;
      if (total > maxBytes) throw new SiteError(msgf("the page is larger than {value} MB", { value: maxBytes / 1_000_000 }), 413);
      chunks.push(chunk);
    }
  } finally {
    response.close();
  }
  return Buffer.concat(chunks);
}

function decode(bytes: Uint8Array, contentType: string): string {
  let charset = /charset\s*=\s*["']?([\w:.-]+)/i.exec(contentType)?.[1];
  if (!charset) charset = /<meta[^>]+charset\s*=\s*["']?([\w:.-]+)/i.exec(new TextDecoder("latin1").decode(bytes.subarray(0, 2048)))?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/**
 * GET one page of a site, following up to 5 redirects (each hop re-validated), with the final status, headers and
 * timing kept (an audit needs a 404 as much as a 200). Bodies of html/xml/text/json only; others are counted, not kept.
 */
export async function fetchPage(input: string, policy: OutboundPolicy, deps: NetDeps = {}, timeoutMs = PAGE_TIMEOUT_MS): Promise<FetchedPage> {
  let current: URL;
  try {
    current = new URL(input);
  } catch {
    throw new SiteError(msgf("'{input}' is not a valid URL", { input: input.slice(0, 200) }));
  }
  if (!/^https?:$/.test(current.protocol)) throw new SiteError("only http(s) pages can be audited");
  const started = Date.now();
  const signal = AbortSignal.timeout(timeoutMs);
  const hops: FetchedPage["hops"] = [];
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      checkUrl(current, policy);
      deps.admitHop?.(current);
      const addresses = await resolveAllowed(current, policy, deps.resolve, denyList());
      const sent = Date.now();
      let response: TransportResponse;
      try {
        response = await (deps.transport ?? nodeTransport)({
          url: current,
          ip: addresses[0],
          addresses,
          method: "GET",
          headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5", "accept-language": "pl,en;q=0.8" },
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw new SiteError(msgf("{host} did not answer within {value} s", { host: current.host, value: timeoutMs / 1000 }), 504);
        throw new SiteError(msgf("could not connect to {host}: {value}", { host: current.host, value: error instanceof Error ? error.message : String(error) }), 502);
      }
      const ttfbMs = Date.now() - sent;
      hops.push({ url: current.href, status: response.status });
      const location = response.headers.location;
      if (REDIRECTS.has(response.status) && location) {
        response.close();
        try {
          current = new URL(location, current);
        } catch {
          throw new SiteError(msgf("{host} redirected to an invalid URL", { host: current.host }), 502);
        }
        continue;
      }
      const headers = headerRecord(response);
      const contentType = (headers["content-type"] ?? "").toLowerCase();
      const textual = !contentType || /text\/|xml|json|javascript/.test(contentType);
      const raw = await readBody(response, PAGE_MAX_BYTES, signal);
      return {
        url: input,
        finalUrl: current.href,
        hops,
        status: response.status,
        headers,
        contentType: contentType.split(";")[0].trim(),
        body: textual ? decode(raw, contentType) : "",
        bytes: raw.byteLength,
        ttfbMs,
        totalMs: Date.now() - started,
      };
    }
  } catch (error) {
    if (error instanceof OutboundError) throw new SiteError(error.message, error.kind === "refused" ? 400 : 502);
    if (error instanceof OutboundRefused) throw new SiteError(error.message, 429);
    throw error;
  }
  throw new SiteError(msgf("{input} redirects more than {maxRedirects} times", { input, maxRedirects: MAX_REDIRECTS }), 502);
}

/** JSON request to a fixed API (GitHub, PageSpeed). Non-2xx answers are returned (status + parsed body), not thrown. */
export async function apiJson(
  url: string,
  init: { method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; headers?: Record<string, string>; body?: unknown; timeoutMs?: number; maxBytes?: number },
  deps: NetDeps = {},
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const method = init.method ?? "GET";
  // safeFetch speaks GET/POST only; PATCH/PUT/DELETE go through rawRequest (same checks, same pinned connection).
  const timeoutMs = init.timeoutMs ?? 30_000;
  const signal = AbortSignal.timeout(timeoutMs);
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  const headers = { "user-agent": UA, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...init.headers };
  let response: Response;
  try {
    if (method === "GET" || method === "POST") {
      response = await safeFetch(url, { method, headers, body, signal, policy: apiPolicy(url), resolve: deps.resolve, transport: deps.transport });
    } else {
      response = await rawRequest(url, method, headers, body, signal, deps);
    }
  } catch (error) {
    if (error instanceof OutboundError) throw new SiteError(error.message, 502);
    if (signal.aborted) throw new SiteError(msgf("{host} did not answer within {value} s", { host: new URL(url).host, value: timeoutMs / 1000 }), 504);
    throw error;
  }
  const text = await readTextCapped(response, init.maxBytes ?? 8_000_000);
  if (text === null) throw new SiteError(msgf("{host} answered more than {value} MB", { host: new URL(url).host, value: (init.maxBytes ?? 8_000_000) / 1_000_000 }), 502);
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON: keep the text */
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

/** PATCH/PUT/DELETE with the same pinned-address checks as safeFetch (no redirects). */
async function rawRequest(url: string, method: string, headers: Record<string, string>, body: string | undefined, signal: AbortSignal, deps: NetDeps): Promise<Response> {
  const target = new URL(url);
  const policy = apiPolicy(url);
  checkUrl(target, policy);
  const addresses = await resolveAllowed(target, policy, deps.resolve);
  let response: TransportResponse;
  try {
    response = await (deps.transport ?? nodeTransport)({ url: target, ip: addresses[0], addresses, method, headers, body, signal });
  } catch (error) {
    throw new OutboundError("network", msgf("could not connect to {host}: {value}", { host: target.host, value: error instanceof Error ? error.message : String(error) }));
  }
  const raw = await readBody(response, 8_000_000, signal);
  const out = new Headers();
  for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) out.set(name, value);
  const status = response.status >= 200 && response.status <= 599 ? response.status : 502;
  return new Response(status === 204 || status === 205 || status === 304 ? null : new Uint8Array(raw), { status, headers: out });
}
