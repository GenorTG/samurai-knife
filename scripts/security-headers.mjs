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
export function securityHeaders({ dev = false, publicUrl = "", frameOrigins = [], formOrigins = [] } = {}) {
  const extra = [...new Set(frameOrigins.filter(Boolean))].join(" ");
  const withExtra = (list) => (extra ? `${list} ${extra}` : list);
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
    withExtra("frame-src 'self' blob:"),
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

/** The office sidecar's browser-facing origin from its state file (`publicUrl`, else http://<bindHost>:<hostPort>). */
export function sidecarOrigins(dataDir) {
  try {
    const state = JSON.parse(readFileSync(join(dataDir, "services", "office", "state.json"), "utf8"));
    const host = String(state.bindHost ?? "");
    const fallback = host && state.hostPort ? `http://${host.includes(":") ? `[${host}]` : host}:${state.hostPort}` : null;
    const origin = originOf(state.publicUrl || fallback || "");
    return origin ? [origin] : [];
  } catch {
    return [];
  }
}

function install() {
  const dev = process.env.KNIFE_SERVE_MODE === "dev";
  const dataDir = process.env.KNIFE_DATA_DIR?.trim() || join(homedir(), ".local", "share", "samurai-knife");
  const extra = (process.env.KNIFE_CSP_FRAME_ORIGINS ?? "").split(/[\s,]+/).map(originOf).filter(Boolean);
  const stateFile = join(dataDir, "services", "office", "state.json");
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
    try {
      mtime = statSync(stateFile).mtimeMs;
    } catch {
      // not installed
    }
    if (mtime !== cached.mtime || cached.headers.length === 0) {
      const options = {
        dev,
        frameOrigins: [...sidecarOrigins(dataDir), ...extra],
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
