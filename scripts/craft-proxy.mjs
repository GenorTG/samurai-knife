// Preloaded into the Next server by scripts/peer-address.mjs (serve.mjs). With KNIFE_CRAFT_PUBLIC_URL set, every request
// whose Host is that URL's host name goes to the ArtCraft sidecar (an nginx serving thirteen static WebAssembly apps) and never
// reaches Next: the apps run on their own origin (an app bug can never act as the signed-in user on the app's origin), the
// sidecar is published on loopback only, and the reverse proxy only has to send that name to the app's port.
//
// Who gets through: the ArtCraft page asks GET /api/craft for each app's URL, which carries `?knife_ticket=<ticket>` (HMAC
// ticket naming the account, 12 h, key derived from the sidecar's TICKET_SECRET). A valid ticket answers 303 to the same
// URL without it and sets the `knife_craft` cookie on the craft host (so the ticket never stays in the address bar, the
// history or a Referer); every other request needs that cookie. GET/HEAD on `/<app>/...` only, no websockets; only cache
// and content-negotiation headers reach nginx; per-account request budgets and concurrency, a per-address cap on refused
// requests and an idle timeout hold here. docs/SIDECARS.md "ArtCraft". tests/craft_proxy.test.mjs. No dependencies.
import { createHmac } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { addressBuckets, clientAddress, requestIsHttps, trustedRules } from "./client-address.mjs";
import { Budget, TICKET_PARAM, cookieValue, plain, rejectUpgrade, signTicket, verifyTicket } from "./office-proxy.mjs";

export { TICKET_PARAM };
export const COOKIE_NAME = "knife_craft";
export const TICKET_CONTEXT = "knife-craft-proxy-v1";
export const TICKET_TTL_SEC = 12 * 3600;

/** The ticket key: HMAC of a fixed context under the sidecar's TICKET_SECRET (same derivation as src/lib/craft/launch.ts). */
export function craftTicketKey(secret) {
  return createHmac("sha256", String(secret)).update(TICKET_CONTEXT).digest();
}

export function signCraftTicket(key, account, ttlSec = TICKET_TTL_SEC, nowSec) {
  return signTicket(key, account, ttlSec, nowSec);
}

/** `/<app>/<file path>` written plainly (no traversal, encoded dots/slashes, control characters or `//`), else null. */
export function craftPath(target) {
  const raw = String(target ?? "");
  if (!raw.startsWith("/") || raw.length > 2048) return null;
  const path = raw.split("?")[0];
  if (/[\\\0-\x1f\x7f]|\/\/|(?:^|\/)\.\.?(?:\/|$)|%(?:2e|2f|5c|00)/i.test(path)) return null;
  return /^\/[a-z][a-z0-9-]{0,31}(?:\/[A-Za-z0-9._~%/-]*)?$/.test(path) ? path : null;
}

// Only what a static file server uses; cookies, credentials, forwarding headers and everything else stay here.
const FORWARDED_REQUEST = ["accept", "accept-encoding", "accept-language", "cache-control", "if-modified-since", "if-none-match", "if-range", "pragma", "range"];
const DROPPED_RESPONSE = new Set(["set-cookie", "server", "x-powered-by", "connection", "keep-alive", "transfer-encoding"]);

/**
 * The proxy. `config()` is read per request: {upstream: {host, port} | null, key: Buffer | null}. Options: craftUrl (the
 * craft host's public URL), trusted (proxy rules), limits, log.
 */
export function createCraftProxy({ craftUrl, config, trusted = trustedRules(), limits = {}, log = console.warn }) {
  const craft = new URL(craftUrl);
  const craftHost = craft.host.toLowerCase();
  const craftName = craft.hostname.toLowerCase();
  const lim = {
    requestsPerMinute: 1200, // a cold app load is 5-20 files; EffectCraft's service worker caches its own
    concurrentPerAccount: 32,
    refusedPerMinute: 60,
    idleMs: 120_000,
    ...limits,
  };
  const perAccount = new Budget(lim.requestsPerMinute, 60_000);
  const refused = new Budget(lim.refusedPerMinute, 60_000);
  const inflight = new Map();
  const agent = new http.Agent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 16, timeout: lim.idleMs });
  const denied = new Set();

  const matches = (request) => {
    const host = String(request.headers.host ?? "").toLowerCase();
    return host === craftHost || host === craftName || host.replace(/:\d+$/, "") === craftName;
  };

  function note(path, why) {
    if (denied.size >= 50 || denied.has(path)) return;
    denied.add(path);
    log(`[craft-proxy] refused ${path.slice(0, 200)}: ${why}`);
  }

  function extraHeaders(scheme) {
    return scheme === "https" ? { "strict-transport-security": "max-age=15552000" } : {};
  }

  function handleRequest(request, response) {
    const client = clientAddress(request, trusted);
    const scheme = requestIsHttps(request, trusted) || craft.protocol === "https:" ? "https" : "http";
    const refuse = (status, text, why) => {
      if (!refused.take(addressBuckets(client).narrow)) return plain(response, 429, "Too many refused requests; slow down.", { "Retry-After": "60" });
      if (why) note(String(request.url).split("?")[0], why);
      return plain(response, status, text, extraHeaders(scheme));
    };
    if (request.method !== "GET" && request.method !== "HEAD") return refuse(405, "Method not allowed.", null);
    const path = craftPath(request.url);
    if (!path) return refuse(404, "Not found.", "path not allowed");
    const current = config();
    if (!current.key || !current.upstream) return plain(response, 503, "The ArtCraft apps are not installed.");
    const url = new URL(request.url, "http://craft.invalid");
    const ticket = url.searchParams.get(TICKET_PARAM);
    if (ticket !== null) {
      const claims = verifyTicket(current.key, ticket);
      if (!claims) return refuse(403, "This link has expired; open the app again from Smart Knife.", null);
      url.searchParams.delete(TICKET_PARAM);
      const maxAge = Math.max(0, claims.expires - Math.floor(Date.now() / 1000));
      response.writeHead(303, {
        Location: url.pathname + url.search,
        "Set-Cookie": `${COOKIE_NAME}=${ticket}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${scheme === "https" ? "; Secure" : ""}`,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Content-Length": "0",
        ...extraHeaders(scheme),
      });
      return response.end();
    }
    const cookie = cookieValue(request.headers.cookie, COOKIE_NAME);
    const claims = cookie ? verifyTicket(current.key, cookie) : null;
    if (!claims) return refuse(403, "Open ArtCraft from Smart Knife; this address only serves its apps.", null);
    if (!perAccount.take(claims.account)) return plain(response, 429, "Too many requests; wait a minute.", { "Retry-After": "60" });
    const running = inflight.get(claims.account) ?? 0;
    if (running >= lim.concurrentPerAccount) return plain(response, 429, "Too many requests at once.", { "Retry-After": "5" });
    inflight.set(claims.account, running + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const left = (inflight.get(claims.account) ?? 1) - 1;
      if (left > 0) inflight.set(claims.account, left);
      else inflight.delete(claims.account);
    };
    response.on("close", release);

    const headers = { host: `${current.upstream.host.includes(":") ? `[${current.upstream.host}]` : current.upstream.host}:${current.upstream.port}` };
    for (const name of FORWARDED_REQUEST) if (request.headers[name] !== undefined) headers[name] = request.headers[name];
    const upstream = http.request({ host: current.upstream.host, port: current.upstream.port, method: request.method, path: url.pathname + url.search, headers, agent, timeout: lim.idleMs });
    upstream.on("response", (answer) => {
      const out = {};
      for (const [name, value] of Object.entries(answer.headers)) if (!DROPPED_RESPONSE.has(name)) out[name] = value;
      Object.assign(out, extraHeaders(scheme));
      response.writeHead(answer.statusCode ?? 502, out);
      answer.pipe(response);
      answer.on("error", () => response.destroy());
    });
    upstream.on("timeout", () => upstream.destroy(new Error("upstream idle timeout")));
    upstream.on("error", (error) => {
      const down = error?.code === "ECONNREFUSED" || error?.code === "EHOSTUNREACH";
      plain(response, down ? 503 : 502, down ? "The ArtCraft apps are not running; open them again from Smart Knife." : "The ArtCraft server did not answer.");
    });
    request.on("aborted", () => upstream.destroy());
    upstream.end();
  }

  function handleUpgrade(_request, socket) {
    socket.on("error", () => socket.destroy());
    rejectUpgrade(socket, 404, "Not found.");
  }

  return { matches, handleRequest, handleUpgrade };
}

/** The live configuration: the sidecar's state (loopback address + port) and its ticket secret, re-read when they change. */
export function craftSidecarConfig(dataDir) {
  const dir = join(dataDir, "services", "craft");
  let cache = { at: 0, stamp: "", value: { upstream: null, key: null } };
  return () => {
    const now = Date.now();
    if (now - cache.at < 2_000) return cache.value;
    cache.at = now;
    let stamp = "";
    try {
      stamp = `${statSync(join(dir, "state.json")).mtimeMs}:${statSync(join(dir, "secrets.env")).mtimeMs}`;
    } catch {
      cache = { at: now, stamp: "", value: { upstream: null, key: null } };
      return cache.value;
    }
    if (stamp === cache.stamp) return cache.value;
    try {
      const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
      const secret = /^TICKET_SECRET=(.+)$/m.exec(readFileSync(join(dir, "secrets.env"), "utf8"))?.[1]?.trim();
      const port = Number(state.hostPort);
      const upstream = typeof state.bindHost === "string" && state.bindHost && Number.isInteger(port) ? { host: state.bindHost, port } : null;
      cache = { at: now, stamp, value: { upstream, key: secret ? craftTicketKey(secret) : null } };
    } catch {
      cache = { at: now, stamp, value: { upstream: null, key: null } };
    }
    return cache.value;
  };
}

function install() {
  const craftUrl = process.env.KNIFE_CRAFT_PUBLIC_URL?.trim();
  if (!craftUrl) return;
  let parsed;
  try {
    parsed = new URL(craftUrl);
  } catch {
    console.error(`[craft-proxy] KNIFE_CRAFT_PUBLIC_URL=${craftUrl} is not a URL; the ArtCraft proxy is off.`);
    return;
  }
  const dataDir = process.env.KNIFE_DATA_DIR?.trim() || join(homedir(), ".local", "share", "samurai-knife");
  const proxy = createCraftProxy({ craftUrl: parsed.href, config: craftSidecarConfig(dataDir) });
  for (const Server of [http.Server, https.Server]) {
    const original = Server.prototype.emit;
    if (original.knifeCraft) continue;
    const patched = function emit(event, request, ...rest) {
      if ((event === "request" || event === "upgrade") && request?.headers && proxy.matches(request)) {
        try {
          if (event === "request") proxy.handleRequest(request, rest[0]);
          else proxy.handleUpgrade(request, rest[0]);
        } catch (error) {
          console.error("[craft-proxy]", error);
          if (event === "request") plain(rest[0], 500, "ArtCraft proxy error.");
          else rejectUpgrade(rest[0], 500, "ArtCraft proxy error.");
        }
        return true;
      }
      return original.call(this, event, request, ...rest);
    };
    patched.knifeCraft = true;
    Server.prototype.emit = patched;
  }
  console.log(`[craft-proxy] serving the ArtCraft apps on ${parsed.host}`);
}

if (process.env.KNIFE_CRAFT_PROXY_INSTALL !== "0") install();
