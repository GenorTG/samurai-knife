// SERVER ONLY. Uses node:dns / node:http(s) through `@/lib/net/safe-fetch`; never import this from client components or
// from pure `src/lib/cv` code.
import {
  checkUrl as checkOutboundUrl,
  denyList,
  nodeTransport,
  OutboundError,
  resolveAllowed,
  type OutboundPolicy,
  type ResolvedAddress,
  type Resolver,
  type Transport,
  type TransportResponse,
} from "@/lib/net/safe-fetch";
import { decodeEntities, findFirst, parseHtml, readableText, tidyText } from "./html";
import { justjoinApiUrl, justjoinSlug, parseJustjoinOffer } from "./justjoin";
import { nofluffApiUrl, nofluffSlug, parseNofluffOffer } from "./nofluffjobs";
import { classifyInput, FetchError, parseJsonDocument, parsePage, parsePlainDocument, pastedPosting, PASTE_HINT, type FetchedPosting } from "./posting";

export { FetchError, type FetchedPosting } from "./posting";
export type { ResolvedAddress, TransportRequest, TransportResponse } from "@/lib/net/safe-fetch";

/**
 * Fetch ONE job posting. Guarded against SSRF by the shared outbound policy (`src/lib/net/`): http(s) only; the host is
 * resolved first and every address must be public unicast (no loopback, private, link-local/metadata, CGNAT incl.
 * Tailscale 100.64/10, ULA, unspecified, multicast, IPv4-mapped IPv6, nor the server's own addresses and
 * KNIFE_SSRF_DENY_CIDRS); the connection is pinned to the validated address (no second DNS lookup, so no rebinding);
 * every redirect hop is re-validated from scratch (max 5); one 15 s deadline covers DNS + all hops; the body is capped
 * at 2 MB; only html / json / plain-text content types are read. Never relaxed for admins.
 */

export const MAX_REDIRECTS = 5;
export const TIMEOUT_MS = 15_000;
export const MAX_BYTES = 2_000_000;
const PAGE_POLICY: OutboundPolicy = { allowPrivate: false, ports: new Set(["", "80", "443", "8080", "8443"]), httpsOnly: false };
const USER_AGENT = "Mozilla/5.0 (compatible; samurai-knife-cv/1.0; reads one job posting at the owner's request)";

export interface FetchDeps {
  /** All addresses of a host name (default: `dns.lookup(all)`). */
  resolve?: Resolver;
  /** One HTTP exchange without redirect following (default: node http/https pinned to `ip`). */
  transport?: Transport;
  timeoutMs?: number;
  maxBytes?: number;
  /** Called with every URL before it is requested (each redirect hop, a board's API): the per-host outbound budget. */
  admitHop?: (url: URL) => void;
}

// --- guard ----------------------------------------------------------------------------------

function asFetchError(error: unknown): unknown {
  return error instanceof OutboundError ? new FetchError(`${error.message}. ${PASTE_HINT}`) : error;
}

/** Static checks on a URL before any DNS or network: scheme, credentials, port, local names. */
export function checkUrl(url: URL): void {
  try {
    checkOutboundUrl(url, PAGE_POLICY);
  } catch (error) {
    throw asFetchError(error);
  }
}

/** Resolve the host and require EVERY address to be public; returns them (IPv4 first) as the only addresses the connection may use. */
export async function resolvePublic(url: URL, resolve?: Resolver): Promise<ResolvedAddress[]> {
  try {
    return await resolveAllowed(url, PAGE_POLICY, resolve, denyList());
  } catch (error) {
    throw asFetchError(error);
  }
}

// --- download -------------------------------------------------------------------------------

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const ALLOWED_TYPES = /^(?:text\/html|application\/xhtml\+xml|application\/json|application\/ld\+json|text\/plain)$/;

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(onTimeout());
      return;
    }
    const abort = (): void => reject(onTimeout());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", abort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

function decodeBody(bytes: Uint8Array, contentType: string): string {
  let charset = /charset\s*=\s*["']?([\w:.-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
    charset = /<meta[^>]+charset\s*=\s*["']?([\w:.-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

async function readCapped(response: TransportResponse, url: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const declared = Number(response.headers["content-length"]);
  const tooBig = (): FetchError => new FetchError(`${url} is larger than ${(maxBytes / 1_000_000).toFixed(maxBytes % 1_000_000 ? 3 : 0)} MB. ${PASTE_HINT}`);
  if (Number.isFinite(declared) && declared > maxBytes) {
    response.close();
    throw tooBig();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of response.body) {
      if (signal.aborted) throw new FetchError(`${url} timed out. ${PASTE_HINT}`);
      total += chunk.byteLength;
      if (total > maxBytes) throw tooBig();
      chunks.push(chunk);
    }
  } finally {
    response.close();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

interface Downloaded {
  finalUrl: string;
  contentType: string;
  body: string;
}

async function download(start: URL, deps: FetchDeps, signal: AbortSignal): Promise<Downloaded> {
  const resolve = deps.resolve;
  const transport = deps.transport ?? nodeTransport;
  const maxBytes = deps.maxBytes ?? MAX_BYTES;
  const timedOut = (): FetchError => new FetchError(`fetching ${start.host} timed out after ${(deps.timeoutMs ?? TIMEOUT_MS) / 1000} s. ${PASTE_HINT}`);
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    checkUrl(current);
    deps.admitHop?.(current);
    const addresses = await raceAbort(resolvePublic(current, resolve), signal, timedOut);
    let response: TransportResponse;
    try {
      response = await raceAbort(
        transport({
          url: current,
          ip: addresses[0],
          addresses,
          signal,
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8",
            "Accept-Language": "pl,en;q=0.8",
            "Accept-Encoding": "identity",
          },
        }),
        signal,
        timedOut,
      );
    } catch (error) {
      if (error instanceof FetchError) throw error;
      throw new FetchError(`could not fetch ${current.host}: ${error instanceof Error ? error.message : String(error)}. ${PASTE_HINT}`);
    }
    if (REDIRECTS.has(response.status)) {
      const location = response.headers.location;
      response.close();
      if (!location) throw new FetchError(`${current.host} redirected without a Location. ${PASTE_HINT}`);
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new FetchError(`${current.host} redirected to an invalid URL. ${PASTE_HINT}`);
      }
      current = next; // re-validated from scratch at the top of the loop
      continue;
    }
    if (response.status >= 400 || response.status < 200) {
      response.close();
      throw new FetchError(`${current.href} answered HTTP ${response.status}. ${PASTE_HINT}`);
    }
    const contentType = (response.headers["content-type"] ?? "").toLowerCase();
    const mime = contentType.split(";")[0].trim();
    if (mime && !ALLOWED_TYPES.test(mime)) {
      response.close();
      throw new FetchError(`${current.href} is '${mime}', not a web page. ${PASTE_HINT}`);
    }
    const bytes = await raceAbort(readCapped(response, current.href, maxBytes, signal), signal, timedOut);
    return { finalUrl: current.href, contentType: mime, body: decodeBody(bytes, contentType) };
  }
  throw new FetchError(`${start.href} redirects more than ${MAX_REDIRECTS} times. ${PASTE_HINT}`);
}

// --- entry point ----------------------------------------------------------------------------

/** URL -> fetched + extracted. Anything else is taken as the posting text verbatim. */
export async function fetchPosting(urlOrText: string, deps: FetchDeps = {}): Promise<FetchedPosting> {
  const input = classifyInput(urlOrText);
  if (input.kind === "text") return pastedPosting(input.text);
  let start: URL;
  try {
    start = new URL(input.url);
  } catch {
    throw new FetchError(`'${input.url}' is not a valid URL. ${PASTE_HINT}`);
  }
  checkUrl(start);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? TIMEOUT_MS);
  try {
    // Known boards: their own offer JSON has the real description, skills and levels (the pages are JS shells or keep
    // the requirements out of the JSON-LD). If the board API fails (moved, rate limited), fall through to the page.
    const boards = [
      { slug: justjoinSlug(start), api: justjoinApiUrl, parse: parseJustjoinOffer },
      { slug: nofluffSlug(start), api: nofluffApiUrl, parse: parseNofluffOffer },
    ];
    for (const board of boards) {
      if (!board.slug) continue;
      try {
        const api = await download(board.api(board.slug), deps, controller.signal);
        return board.parse(api.body, input.url);
      } catch (error) {
        if (controller.signal.aborted) throw error;
      }
    }
    const got = await download(start, deps, controller.signal);
    // The URL the user gave stays the identity of the job (re-fetching refreshes it); redirects only affect parsing context.
    const page = got.contentType.includes("json") ? parseJsonDocument(got.body, input.url) : got.contentType === "text/plain" ? parsePlainDocument(got.body, input.url) : parsePage(got.body, input.url);
    return { ...page, url: input.url };
  } finally {
    clearTimeout(timer);
  }
}

export const COMPANY_TEXT_CHARS = 8_000;

/**
 * Readable text of ONE ordinary web page (a company's website), same SSRF guard and caps as postings. Used as context
 * for tailoring ("what does this company do"), never printed. Short or empty pages are returned as they are.
 */
export async function fetchPageText(url: string, deps: FetchDeps = {}): Promise<{ url: string; title: string; text: string }> {
  let start: URL;
  try {
    start = new URL(url.trim());
  } catch {
    throw new FetchError(`'${url.slice(0, 200)}' is not a valid URL.`);
  }
  if (!/^https?:$/.test(start.protocol)) throw new FetchError("only http(s) pages are read.");
  checkUrl(start);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? TIMEOUT_MS);
  try {
    const got = await download(start, deps, controller.signal);
    if (got.contentType.includes("json")) return { url: start.href, title: "", text: "" };
    if (got.contentType === "text/plain") return { url: start.href, title: "", text: tidyText(got.body).slice(0, COMPANY_TEXT_CHARS) };
    const root = parseHtml(got.body);
    const find = (tag: string) => findFirst(root, (el) => el.tag === tag);
    const titleEl = find("title");
    const title = titleEl ? readableText(titleEl).trim().slice(0, 200) : "";
    const meta = metaDescription(got.body);
    const main = find("main") ?? find("body") ?? root;
    const text = [meta, readableText(main)].filter(Boolean).join("\n\n");
    return { url: start.href, title, text: tidyText(text).slice(0, COMPANY_TEXT_CHARS) };
  } finally {
    clearTimeout(timer);
  }
}

function metaDescription(html: string): string {
  const m = /<meta[^>]+(?:name|property)=["'](?:og:)?description["'][^>]*content=["']([^"']{1,600})["']/i.exec(html) ?? /<meta[^>]+content=["']([^"']{1,600})["'][^>]*(?:name|property)=["'](?:og:)?description["']/i.exec(html);
  return m ? decodeEntities(m[1]).trim() : "";
}
