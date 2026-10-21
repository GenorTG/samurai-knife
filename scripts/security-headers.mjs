// Preloaded into the Next server by scripts/serve.mjs (NODE_OPTIONS --import) in public mode (or KNIFE_SECURITY_HEADERS=1):
// sets the security headers on every response before Next handles the request. Here and not in next.config `headers()`
// because those are frozen into the build, while the editor's origin (the office sidecar's public URL) and the public URL
// are runtime settings. No dependencies. docs/ARCHITECTURE.md "Security headers".
import { readFileSync, statSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";

/** An http(s) URL -> its origin, or null. */
export function originOf(value) {
  try {
    const url = new URL(String(value).trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * The header set. `frameOrigins`: origins the app embeds and loads scripts from (the office editor). What the app needs:
 * inline scripts (Next's bootstrap and the theme script; no nonces because the pages are static), `eval` (ajv compiles
 * JSON Schemas in the JSON Schema tool), WebAssembly (sql.js, tesseract), workers from same-origin and blob: URLs
 * (tesseract), data:/blob: images and fonts, https images in Markdown previews. So script-src is not the XSS barrier
 * (React escaping and DOMPurify are); the policy's value is frame-ancestors (no clickjacking of the trust prompts),
 * connect-src 'self' (page data cannot be posted elsewhere), object-src/base-uri/form-action, and frame-src.
 */
export function securityHeaders({ dev = false, publicUrl = "", frameOrigins = [], frameOnlyOrigins = [], formOrigins = [] } = {}) {
  const extra = [...new Set(frameOrigins.filter(Boolean))].join(" ");
  const withExtra = (list) => (extra ? `${list} ${extra}` : list);
  // Embedded only (the ArtCraft apps: the page frames them and never loads their scripts or talks to them).
  const frames = [...new Set([...frameOrigins, ...frameOnlyOrigins].filter(Boolean))].join(" ");
  const https = originOf(publicUrl)?.startsWith("https:") ?? false;
  const csp = [
    "default-src 'self'",
    withExtra(`script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'`),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    withExtra(`connect-src 'self'${dev ? " ws: wss:" : ""}`),
    "worker-src 'self' blob:",
    frames ? `frame-src 'self' blob: ${frames}` : "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    // The GitHub App's manifest is POSTed to github.com by the admin's browser (docs/GITHUB.md).
    ["form-action 'self'", ...new Set(formOrigins.filter(Boolean))].join(" "),
    "frame-ancestors 'self'",
    "manifest-src 'self'",
    ...(https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
  const headers = [
    ["Content-Security-Policy", csp],
    ["X-Content-Type-Options", "nosniff"],
    ["X-Frame-Options", "SAMEORIGIN"],
    ["Referrer-Policy", "strict-origin-when-cross-origin"],
    ["Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()"],
  ];
  // Browsers ignore HSTS on plain http, and the reverse proxy terminates TLS; no includeSubDomains (other names on the
  // same domain are not ours to pin).
  if (https) headers.push(["Strict-Transport-Security", "max-age=15552000"]);
  return headers;
}

/** KNIFE_AUTH_MODE the way src/lib/accounts/mode.ts reads it: anything but empty/`private` is public (fails closed). */
export function isPublicAuthMode(env = process.env) {
  const value = String(env.KNIFE_AUTH_MODE ?? "").trim().toLowerCase();
  return Boolean(value) && value !== "private";
}

function ipv4Private(text) {
  const parts = text.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  const [a, b] = parts.map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

/**
 * Host names a public page must never trust: private, loopback, link-local, CGNAT/Tailscale, multicast and reserved IPv4,
 * every IPv6 literal that is not global unicast (loopback, ULA, link-local, mapped), and names that only resolve inside a
 * network (single label, localhost, .local, .internal, .lan, .home.arpa, Tailscale's .ts.net).
 */
export function isPrivateHost(hostname) {
  const host = String(hostname).trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return true;
  const v4 = ipv4Private(host);
  if (v4 !== null) return v4;
  if (host.includes(":")) {
    // Only global unicast (2000::/3) passes; ::ffff:a.b.c.d and friends never do.
    return !/^[23][0-9a-f]{0,3}:/.test(host) || host.includes(".");
  }
  if (!host.includes(".")) return true;
  return /(^|\.)(localhost|local|internal|lan|home\.arpa|ts\.net)$/.test(host);
}

/**
 * The office sidecar's browser-facing origin(s) for the CSP.
 *
 * Public mode (host audit M3: the dev server's Tailscale address once landed in the live CSP through the state file's
 * `bindHost:hostPort` fallback): KNIFE_OFFICE_PUBLIC_URL only, and only when it is https on a public host name; else none
 * at all (fails closed: the editor does not load until it is configured; `install()` warns at startup). The state file
 * is never consulted. Private mode is unchanged: KNIFE_OFFICE_PUBLIC_URL, else the state file (`publicUrl`, else
 * bind:port). Returns `{ origins, warning }`; `sidecarOrigins()` keeps the old array shape.
 */
export function officeOrigins(dataDir, env = process.env) {
  const configured = String(env.KNIFE_OFFICE_PUBLIC_URL ?? "").trim();
  if (isPublicAuthMode(env)) {
    if (!configured) return { origins: [], warning: null };
    const verdict = publicOriginVerdict(configured);
    return verdict.origin ? { origins: [verdict.origin], warning: null } : { origins: [], warning: `KNIFE_OFFICE_PUBLIC_URL ${verdict.reason}; the office editor origin is left out of the CSP.` };
  }
  // Proxied by the app on its own host name (scripts/office-proxy.mjs): that origin, whatever the state says.
  const proxied = originOf(configured);
  if (proxied) return { origins: [proxied], warning: null };
  return { origins: stateOrigin(join(dataDir, "services", "office", "state.json")), warning: null };
}

/**
 * The ArtCraft sidecar's origin for frame-src, by the same rules as the office editor: public mode only an https
 * KNIFE_CRAFT_PUBLIC_URL on a public host name; private mode that variable, else the state file (`publicUrl`, else
 * bind:port). Returns `{ origins, warning }`.
 */
export function craftOrigins(dataDir, env = process.env) {
  const configured = String(env.KNIFE_CRAFT_PUBLIC_URL ?? "").trim();
  if (isPublicAuthMode(env)) {
    if (!configured) return { origins: [], warning: null };
    const verdict = publicOriginVerdict(configured);
    return verdict.origin ? { origins: [verdict.origin], warning: null } : { origins: [], warning: `KNIFE_CRAFT_PUBLIC_URL ${verdict.reason}; the ArtCraft origin is left out of the CSP.` };
  }
  const proxied = originOf(configured);
  if (proxied) return { origins: [proxied], warning: null };
  return { origins: stateOrigin(join(dataDir, "services", "craft", "state.json")), warning: null };
}

/** A sidecar's browser origin from its state file: `publicUrl`, else http://bindHost:hostPort; none when not installed. */
function stateOrigin(file) {
  try {
    const state = JSON.parse(readFileSync(file, "utf8"));
    const host = String(state.bindHost ?? "");
    const fallback = host && state.hostPort ? `http://${host.includes(":") ? `[${host}]` : host}:${state.hostPort}` : null;
    const origin = originOf(state.publicUrl || fallback || "");
    return origin ? [origin] : [];
  } catch {
    return [];
  }
}

/** `{ origin }` when `value` is an https URL on a public host name, else `{ origin: null, reason }`. */
export function publicOriginVerdict(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    return { origin: null, reason: "is not a URL" };
  }
  if (url.protocol !== "https:") return { origin: null, reason: "is not https" };
  if (url.username || url.password) return { origin: null, reason: "carries credentials" };
  if (isPrivateHost(url.hostname)) return { origin: null, reason: "names a private or local address" };
  return { origin: url.origin, reason: "" };
}

/** Back-compatible: the office origins only. */
export function sidecarOrigins(dataDir, env = process.env) {
  return officeOrigins(dataDir, env).origins;
}

/**
 * KNIFE_CSP_FRAME_ORIGINS entries. Public mode keeps only https origins on public host names (the same rule as the office
 * origin) and names the ones it drops; private mode keeps every http(s) origin.
 */
export function extraFrameOrigins(env = process.env) {
  const entries = String(env.KNIFE_CSP_FRAME_ORIGINS ?? "").split(/[\s,]+/).filter(Boolean);
  if (!isPublicAuthMode(env)) return { origins: entries.map(originOf).filter(Boolean), dropped: [] };
  const origins = [];
  const dropped = [];
  for (const entry of entries) {
    const verdict = publicOriginVerdict(entry);
    if (verdict.origin) origins.push(verdict.origin);
    else dropped.push(entry);
  }
  return { origins, dropped };
}

function install() {
  const dev = process.env.KNIFE_SERVE_MODE === "dev";
  const dataDir = process.env.KNIFE_DATA_DIR?.trim() || join(homedir(), ".local", "share", "samurai-knife");
  const extras = extraFrameOrigins();
  const extra = extras.origins;
  if (extras.dropped.length) console.warn(`[security-headers] KNIFE_CSP_FRAME_ORIGINS: dropped ${extras.dropped.length} entr${extras.dropped.length === 1 ? "y" : "ies"} that are not https on a public host name.`);
  if (isPublicAuthMode()) {
    const office = officeOrigins(dataDir);
    if (office.warning) console.warn(`[security-headers] ${office.warning}`);
    else if (office.origins.length === 0) console.warn("[security-headers] public mode without KNIFE_OFFICE_PUBLIC_URL (https): no office editor origin in the CSP, so the editor cannot load.");
    const craft = craftOrigins(dataDir);
    if (craft.warning) console.warn(`[security-headers] ${craft.warning}`);
  }
  const stateFiles = ["office", "craft"].map((id) => join(dataDir, "services", id, "state.json"));
  // Two variants: requests on the public host (https through the proxy) get HSTS and upgrade-insecure-requests; requests
  // on any other address (the owner's plain-http Tailscale/LAN URL) get the same policy without both, or the browser
  // would rewrite every script URL to https on an address without TLS and the page would never start.
  const publicHost = (() => {
    try {
      return new URL(process.env.KNIFE_PUBLIC_URL ?? "").host.toLowerCase();
    } catch {
      return "";
    }
  })();
  let cached = { at: 0, mtime: -1, headers: [], plain: [] };
  const current = () => {
    const now = Date.now();
    if (now - cached.at < 5_000) return cached;
    let mtime = 0;
    for (const file of stateFiles) {
      try {
        mtime += statSync(file).mtimeMs;
      } catch {
        // not installed
      }
    }
    if (mtime !== cached.mtime || cached.headers.length === 0) {
      const options = {
        dev,
        frameOrigins: [...officeOrigins(dataDir).origins, ...extra],
        frameOnlyOrigins: craftOrigins(dataDir).origins,
        formOrigins: [originOf(process.env.KNIFE_GITHUB_WEB_URL ?? "") ?? "https://github.com"],
      };
      cached.headers = securityHeaders({ ...options, publicUrl: process.env.KNIFE_PUBLIC_URL ?? "" });
      cached.plain = securityHeaders({ ...options, publicUrl: "" });
      cached.mtime = mtime;
    }
    cached.at = now;
    return cached;
  };
  const forRequest = (request) => {
    const set = current();
    const host = String(request?.headers?.host ?? "").toLowerCase();
    return publicHost && host === publicHost ? set.headers : set.plain;
  };
  for (const Server of [http.Server, https.Server]) {
    const original = Server.prototype.emit;
    if (original.knifeHeaders) continue;
    const patched = function emit(event, request, response, ...rest) {
      if (event === "request" && response && typeof response.setHeader === "function") {
        for (const [name, value] of forRequest(request)) response.setHeader(name, value);
      }
      return original.call(this, event, request, response, ...rest);
    };
    patched.knifeHeaders = true;
    Server.prototype.emit = patched;
  }
}

if (process.env.KNIFE_SECURITY_HEADERS_INSTALL === "1") install();
