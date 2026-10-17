// Preloaded into the Next server by scripts/peer-address.mjs (serve.mjs). With KNIFE_OFFICE_PUBLIC_URL set, every request
// and websocket upgrade whose Host is that URL's host name goes to the office sidecar (Euro-Office Document Server) and
// never reaches Next: the editor runs on its own origin (a document or an editor bug can never act as the signed-in user on
// the app's origin), the sidecar itself is published on loopback only, and nothing outside the app has to proxy it.
//
// Who gets through: the app's editor config (src/lib/office/editor.ts) loads api.js with `?knife_ticket=<ticket>`, a
// short-lived HMAC ticket naming the account (key derived from the sidecar's JWT secret); a valid ticket sets the
// `knife_office` cookie on the office host, and every later request and websocket must carry it. Only the paths the editor
// uses are forwarded (static editor files, the document websocket, cache files and the editor's own up/download routes);
// the command/conversion/admin/info/internal/AI-proxy routes are 404 from outside. Per-account request budgets and
// connection caps, a per-address cap on refused requests, body size and idle timeouts hold here.
// docs/SIDECARS.md "Office editor behind the app". tests/office_proxy.test.mjs. No dependencies.
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { clientAddress, requestIsHttps, trustedRules } from "./client-address.mjs";

export const TICKET_PARAM = "knife_ticket";
export const COOKIE_NAME = "knife_office";
export const TICKET_CONTEXT = "knife-office-proxy-v1";
export const TICKET_TTL_SEC = 6 * 3600;

const b64 = (buffer) => Buffer.from(buffer).toString("base64url");

/** The ticket key: HMAC of a fixed context under the sidecar's JWT secret (never the secret itself). */
export function ticketKey(jwtSecret) {
  return createHmac("sha256", String(jwtSecret)).update(TICKET_CONTEXT).digest();
}

/** `v1.<payload>.<mac>`; payload = {a: account id, e: expiry (unix seconds)}. Same format as src/lib/office/proxy.ts. */
export function signTicket(key, account, ttlSec = TICKET_TTL_SEC, nowSec = Math.floor(Date.now() / 1000)) {
  const payload = b64(JSON.stringify({ a: account, e: nowSec + ttlSec }));
  return `v1.${payload}.${b64(createHmac("sha256", key).update(`v1.${payload}`).digest())}`;
}

/** {account, expires} for a valid unexpired ticket, else null. */
export function verifyTicket(key, ticket, nowSec = Math.floor(Date.now() / 1000)) {
  if (typeof ticket !== "string" || ticket.length > 512) return null;
  const parts = ticket.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const expected = createHmac("sha256", key).update(`v1.${parts[1]}`).digest();
  const given = Buffer.from(parts[2], "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (typeof claims.a !== "string" || !claims.a || !Number.isInteger(claims.e) || claims.e <= nowSec) return null;
    return { account: claims.a, expires: claims.e };
  } catch {
    return null;
  }
}

// What the editor needs, after an optional version prefix (`/9.3.5-<hash>`): its static files, the document websocket /
// long-poll (`/doc/<id>/c/...`), signed cache links and its own per-document up/download routes. Everything else the
// Document Server answers (CommandService, ConvertService, converter/docbuilder, info, internal, admin, ai-proxy, the
// welcome/example pages, healthcheck, WOPI) is refused.
const VERSION_PREFIX = String.raw`(?:/\d+\.\d+\.\d+[.-]\w+)?`;
const ALLOWED_PATH = new RegExp(
  `^${VERSION_PREFIX}/(?:` +
    [
      String.raw`(?:web-apps|sdkjs|sdkjs-plugins|fonts|dictionaries)/[^?#]*`,
      String.raw`document_editor_service_worker\.js`,
      String.raw`meta/formats`,
      String.raw`(?:plugins|themes)\.json`,
      String.raw`doc/[^/?#]+/c(?:/[^?#]*)?`,
      String.raw`cache/files/[^?#]+`,
      String.raw`(?:downloadas|savefile|printfile|downloadfile|upload|uploadold)/[^?#]+`,
    ].join("|") +
    `)$`,
);
const API_JS = new RegExp(`^${VERSION_PREFIX}/web-apps/apps/api/documents/api\\.js$`);
const WEBSOCKET_PATH = new RegExp(`^${VERSION_PREFIX}/doc/[^/?#]+/c(?:/[^?#]*)?$`);

/** The path part of a request target if it is one the editor uses and is plainly written (no traversal tricks), else null. */
export function allowedPath(target) {
  const raw = String(target ?? "");
  if (!raw.startsWith("/") || raw.length > 4096) return null;
  const path = raw.split("?")[0];
  // `//` stays allowed: the editor itself asks for `sdkjs/slide/themes//themes.js` (its nginx merges slashes).
  if (/[\\\0-\x1f\x7f]|(?:^|\/)\.\.?(?:\/|$)|%(?:2e|2f|5c|00)/i.test(path)) return null;
  return ALLOWED_PATH.test(path) ? path : null;
}

export const isApiJs = (path) => API_JS.test(path);
export const isWebsocketPath = (path) => WEBSOCKET_PATH.test(path);

function cookieValue(header, name) {
  for (const part of String(header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

/** Fixed-window counters with a hard cap on distinct keys (a flood of new keys cannot grow memory). */
class Budget {
  constructor(limit, windowMs, maxKeys = 20_000) {
    Object.assign(this, { limit, windowMs, maxKeys, map: new Map() });
  }
  take(key, now = Date.now()) {
    let entry = this.map.get(key);
    if (!entry || now - entry.start >= this.windowMs) {
      if (!entry && this.map.size >= this.maxKeys) {
        for (const [k, v] of this.map) if (now - v.start >= this.windowMs) this.map.delete(k);
        if (this.map.size >= this.maxKeys) return false;
      }
      entry = { start: now, count: 0 };
      this.map.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "host", "cookie", "forwarded", "via", "x-real-ip", "proxy-authorization"]);
const DROPPED_RESPONSE = new Set(["set-cookie", "server", "x-powered-by", "connection", "keep-alive", "transfer-encoding"]);

function upstreamHeaders(request, options) {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower.startsWith("x-forwarded-") || lower.startsWith("x-knife-") || lower.startsWith("proxy-")) continue;
    headers[lower] = value;
  }
  headers.host = `${options.upstream.host.includes(":") ? `[${options.upstream.host}]` : options.upstream.host}:${options.upstream.port}`;
  // The Document Server builds its absolute URLs (redirects, cache links) from these (its nginx maps the_host/the_scheme).
  headers["x-forwarded-host"] = options.officeHost;
  headers["x-forwarded-proto"] = options.scheme;
  headers["x-forwarded-for"] = options.client;
  return headers;
}

function plain(response, status, text, extra = {}) {
  if (response.headersSent) return response.destroy();
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra });
  response.end(`${text}\n`);
}

function rejectUpgrade(socket, status, text) {
  if (!socket.writable) return socket.destroy();
  // end() flushes the answer; destroy() right after would drop it. A client that never reads is cut off after 5 s.
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? ""}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
  setTimeout(() => socket.destroy(), 5_000).unref();
}

/**
 * The proxy. `config()` is read per request: {upstream: {host, port} | null, key: Buffer | null}. Options:
 * officeUrl (the office host's public URL), appOrigin (the only page allowed to frame the editor), trusted (proxy rules).
 */
export function createOfficeProxy({ officeUrl, appOrigin = "", config, trusted = trustedRules(), limits = {}, log = console.warn }) {
  const office = new URL(officeUrl);
  const officeHost = office.host.toLowerCase();
  const officeName = office.hostname.toLowerCase();
  const lim = {
    requestsPerMinute: 3000, // a cold editor load is ~400-600 files; reloads and several tabs fit
    concurrentPerAccount: 64,
    websocketsPerAccount: 16,
    websocketsTotal: 512,
    refusedPerMinute: 60, // requests without a valid ticket/cookie or on refused paths, per client address
    maxBodyBytes: 110 * 1024 * 1024, // the editor's own upload cap is 100 MB
    idleMs: 300_000, // conversions on download/save can take minutes
    websocketIdleMs: 900_000, // the editor pings every ~25 s
    ...limits,
  };
  const perAccount = new Budget(lim.requestsPerMinute, 60_000);
  const refused = new Budget(lim.refusedPerMinute, 60_000);
  const inflight = new Map();
  const sockets = new Map();
  let socketsTotal = 0;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 256, maxFreeSockets: 32, timeout: lim.idleMs });
  const frameAncestors = [appOrigin, office.origin].filter(Boolean).join(" ");
  const denied = new Set();

  const matches = (request) => {
    const host = String(request.headers.host ?? "").toLowerCase();
    return host === officeHost || host === officeName || host.replace(/:\d+$/, "") === officeName;
  };

  function note(path, why) {
    if (denied.size >= 50 || denied.has(path)) return;
    denied.add(path);
    log(`[office-proxy] refused ${path.slice(0, 200)}: ${why}`);
  }

  function authorize(request, path, url, current) {
    const fromQuery = isApiJs(path) ? url.searchParams.get(TICKET_PARAM) : null;
    if (fromQuery) {
      const claims = verifyTicket(current.key, fromQuery);
      if (claims) return { account: claims.account, setCookie: { ticket: fromQuery, expires: claims.expires } };
    }
    const cookie = cookieValue(request.headers.cookie, COOKIE_NAME);
    const claims = cookie ? verifyTicket(current.key, cookie) : null;
    return claims ? { account: claims.account } : null;
  }

  /** Common gate for requests and upgrades: {path, url, account, setCookie, client, scheme, current} or {status, text}. */
  function gate(request) {
    const client = clientAddress(request, trusted);
    const scheme = requestIsHttps(request, trusted) || office.protocol === "https:" ? "https" : "http";
    const path = allowedPath(request.url);
    const refuse = (status, text, why) => {
      if (!refused.take(client)) return { status: 429, text: "Too many refused requests; slow down." };
      if (why) note(String(request.url).split("?")[0], why);
      return { status, text };
    };
    if (!path) return refuse(404, "Not found.", "path not on the editor allow-list");
    const current = config();
    if (!current.key || !current.upstream) return { status: 503, text: "The office editor is not installed." };
    const url = new URL(request.url, "http://office.invalid");
    const auth = authorize(request, path, url, current);
    if (!auth) return refuse(403, "Open documents from the app; this address only serves its editor.", null);
    if (!perAccount.take(auth.account)) return { status: 429, text: "Too many editor requests; wait a minute." };
    if (auth.setCookie) url.searchParams.delete(TICKET_PARAM);
    return { path, target: url.pathname + url.search, account: auth.account, setCookie: auth.setCookie, client, scheme, current };
  }

  function securityHeaders(scheme) {
    const headers = {
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      "content-security-policy": `frame-ancestors ${frameAncestors}`,
    };
    if (scheme === "https") headers["strict-transport-security"] = "max-age=15552000";
    return headers;
  }

  function handleRequest(request, response) {
    const g = gate(request);
    if (g.status) return plain(response, g.status, g.text, g.status === 429 ? { "Retry-After": "60" } : {});
    if (!["GET", "HEAD", "POST", "PUT", "OPTIONS"].includes(request.method)) return plain(response, 405, "Method not allowed.");
    const declared = Number(request.headers["content-length"] ?? 0);
    if (declared > lim.maxBodyBytes) return plain(response, 413, "Too large.");
    const running = inflight.get(g.account) ?? 0;
    if (running >= lim.concurrentPerAccount) return plain(response, 429, "Too many editor requests at once.", { "Retry-After": "5" });
    inflight.set(g.account, running + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const left = (inflight.get(g.account) ?? 1) - 1;
      if (left > 0) inflight.set(g.account, left);
      else inflight.delete(g.account);
    };
    response.on("close", release);

    const upstream = http.request({
      host: g.current.upstream.host,
      port: g.current.upstream.port,
      method: request.method,
      path: g.target,
      headers: upstreamHeaders(request, { upstream: g.current.upstream, officeHost, scheme: g.scheme, client: g.client }),
      agent,
      timeout: lim.idleMs,
    });
    upstream.on("response", (answer) => {
      const headers = {};
      for (const [name, value] of Object.entries(answer.headers)) if (!DROPPED_RESPONSE.has(name)) headers[name] = value;
      const ours = securityHeaders(g.scheme);
      if (headers["content-security-policy"]) ours["content-security-policy"] = [headers["content-security-policy"], ours["content-security-policy"]].flat();
      Object.assign(headers, ours);
      if (g.setCookie) {
        const maxAge = Math.max(0, g.setCookie.expires - Math.floor(Date.now() / 1000));
        headers["set-cookie"] = `${COOKIE_NAME}=${g.setCookie.ticket}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${g.scheme === "https" ? "; Secure" : ""}`;
        headers["cache-control"] = "no-store";
      }
      response.writeHead(answer.statusCode ?? 502, headers);
      answer.pipe(response);
      answer.on("error", () => response.destroy());
    });
    upstream.on("timeout", () => upstream.destroy(new Error("upstream idle timeout")));
    upstream.on("error", (error) => {
      const down = error?.code === "ECONNREFUSED" || error?.code === "EHOSTUNREACH";
      plain(response, down ? 503 : 502, down ? "The office editor is not running; open the document again from the app." : "The office editor did not answer.");
    });
    let seen = 0;
    request.on("data", (chunk) => {
      seen += chunk.length;
      if (seen > lim.maxBodyBytes) {
        upstream.destroy();
        plain(response, 413, "Too large.");
        request.destroy();
      }
    });
    request.on("aborted", () => upstream.destroy());
    request.pipe(upstream);
  }

  function handleUpgrade(request, socket, head) {
    socket.on("error", () => socket.destroy());
    const g = gate(request);
    if (g.status) return rejectUpgrade(socket, g.status, g.text);
    if (String(request.headers.upgrade ?? "").toLowerCase() !== "websocket" || !isWebsocketPath(g.path)) return rejectUpgrade(socket, 404, "Not found.");
    const mine = sockets.get(g.account) ?? 0;
    if (mine >= lim.websocketsPerAccount || socketsTotal >= lim.websocketsTotal) return rejectUpgrade(socket, 429, "Too many editor connections.");
    sockets.set(g.account, mine + 1);
    socketsTotal += 1;
    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      socketsTotal -= 1;
      const left = (sockets.get(g.account) ?? 1) - 1;
      if (left > 0) sockets.set(g.account, left);
      else sockets.delete(g.account);
    };

    const upstream = net.connect({ host: g.current.upstream.host, port: g.current.upstream.port });
    const headers = upstreamHeaders(request, { upstream: g.current.upstream, officeHost, scheme: g.scheme, client: g.client });
    headers.connection = "Upgrade";
    headers.upgrade = "websocket";
    const lines = [`${request.method} ${g.target} HTTP/1.1`];
    for (const [name, value] of Object.entries(headers)) for (const item of [value].flat()) lines.push(`${name}: ${String(item).replace(/[\r\n]/g, "")}`);
    const close = () => {
      done();
      upstream.destroy();
      socket.destroy();
    };
    upstream.on("connect", () => {
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    for (const side of [socket, upstream]) {
      side.setTimeout(lim.websocketIdleMs, close);
      side.on("close", close);
      side.on("error", close);
    }
  }

  return { matches, handleRequest, handleUpgrade };
}

/** The live configuration: the sidecar's state (loopback address + port) and its JWT secret, re-read when they change. */
export function sidecarConfig(dataDir) {
  const dir = join(dataDir, "services", "office");
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
      const secret = /^JWT_SECRET=(.+)$/m.exec(readFileSync(join(dir, "secrets.env"), "utf8"))?.[1]?.trim();
      const port = Number(state.hostPort);
      const upstream = typeof state.bindHost === "string" && state.bindHost && Number.isInteger(port) ? { host: state.bindHost, port } : null;
      cache = { at: now, stamp, value: { upstream, key: secret ? ticketKey(secret) : null } };
    } catch {
      cache = { at: now, stamp, value: { upstream: null, key: null } };
    }
    return cache.value;
  };
}

function install() {
  const officeUrl = process.env.KNIFE_OFFICE_PUBLIC_URL?.trim();
  if (!officeUrl) return;
  let parsed;
  try {
    parsed = new URL(officeUrl);
  } catch {
    console.error(`[office-proxy] KNIFE_OFFICE_PUBLIC_URL=${officeUrl} is not a URL; the office proxy is off.`);
    return;
  }
  let appOrigin = "";
  try {
    appOrigin = new URL(process.env.KNIFE_PUBLIC_URL ?? "").origin;
  } catch {
    // private mode: the bind address frames the editor (frame-ancestors gets only the office origin plus what follows)
  }
  const appHosts = [process.env.KNIFE_HOST, ...(process.env.KNIFE_ALLOWED_HOSTS ?? "").split(",")].map((h) => h?.trim()).filter(Boolean);
  if (!appOrigin && appHosts.length) appOrigin = appHosts.map((h) => `http://${h}:${process.env.KNIFE_PORT?.trim() || "3210"}`).join(" ");
  const dataDir = process.env.KNIFE_DATA_DIR?.trim() || join(homedir(), ".local", "share", "samurai-knife");
  const proxy = createOfficeProxy({ officeUrl: parsed.href, appOrigin, config: sidecarConfig(dataDir) });
  for (const Server of [http.Server, https.Server]) {
    const original = Server.prototype.emit;
    if (original.knifeOffice) continue;
    const patched = function emit(event, request, ...rest) {
      if ((event === "request" || event === "upgrade") && request?.headers && proxy.matches(request)) {
        try {
          if (event === "request") proxy.handleRequest(request, rest[0]);
          else proxy.handleUpgrade(request, rest[0], rest[1]);
        } catch (error) {
          console.error("[office-proxy]", error);
          if (event === "request") plain(rest[0], 500, "Office proxy error.");
          else rejectUpgrade(rest[0], 500, "Office proxy error.");
        }
        return true;
      }
      return original.call(this, event, request, ...rest);
    };
    patched.knifeOffice = true;
    Server.prototype.emit = patched;
  }
  console.log(`[office-proxy] serving the office editor on ${parsed.host}`);
}

if (process.env.KNIFE_OFFICE_PROXY_INSTALL !== "0") install();
