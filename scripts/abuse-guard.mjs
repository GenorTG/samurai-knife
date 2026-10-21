// Preloaded into the Next server by scripts/peer-address.mjs (serve.mjs), last, so it wraps every other hook and decides a
// request before the office proxy, the security headers or Next see it. The decisions live in src/lib/security/guard.mjs
// (budgets, scanner scoring, escalating blocks); this file wires them into `Server.prototype.emit` and hardens the Node
// server itself: header/request/keep-alive timeouts, a connection cap and per-route body deadlines (a slow-trickle body
// cannot hold a socket for minutes). A refused request costs microseconds: 429 + Retry-After + a one-line body, the
// connection closed. KNIFE_ABUSE_GUARD=off disables the guard (never in public mode: serve.mjs refuses it), the hardening
// stays. docs/ACCOUNTS.md "Abuse guard". tests/abuse_guard.test.mjs. No dependencies.
import http from "node:http";
import https from "node:https";
import { AbuseGuard, GUARD_KEY, credentialHash, guardMode, guardPolicy } from "../src/lib/security/guard.mjs";
import { recordSecurityEvent, securityDir } from "../src/lib/security/events-core.mjs";
import { clientAddress, trustedRules } from "./client-address.mjs";

const SECOND = 1_000;

/** Request bodies that may legitimately take minutes (large uploads); everything else must arrive within 30 s. */
const SLOW_BODY = /^\/api\/(?:pdf|office\/docs|cv\/import|cv\/photo|workspace|agent\/conversation|mcp)(?:\/|$)/;

/** Server-wide timeouts and caps (env overrides for unusual deployments). */
export function serverLimits(env = process.env) {
  const int = (name, fallback) => {
    const value = Number(env[name]?.trim());
    return Number.isInteger(value) && value > 0 ? value : fallback;
  };
  return {
    headersTimeout: int("KNIFE_HEADERS_TIMEOUT_MS", 20 * SECOND),
    // The whole request (headers + body). The largest upload (PDF, 512 MB streamed) gets 5 minutes plus margin.
    requestTimeout: int("KNIFE_REQUEST_TIMEOUT_MS", 330 * SECOND),
    keepAliveTimeout: int("KNIFE_KEEPALIVE_TIMEOUT_MS", 10 * SECOND),
    maxConnections: int("KNIFE_MAX_CONNECTIONS", 1_024),
    bodyTimeout: int("KNIFE_BODY_TIMEOUT_MS", 30 * SECOND),
    slowBodyTimeout: int("KNIFE_SLOW_BODY_TIMEOUT_MS", 300 * SECOND),
  };
}

const hardened = new WeakSet();

function harden(server, limits) {
  if (hardened.has(server)) return;
  hardened.add(server);
  server.headersTimeout = limits.headersTimeout;
  server.requestTimeout = Math.max(limits.requestTimeout, limits.headersTimeout + SECOND);
  server.keepAliveTimeout = Math.min(limits.keepAliveTimeout, limits.headersTimeout - SECOND);
  server.maxConnections = limits.maxConnections;
}

function hasBody(request) {
  const length = request.headers["content-length"];
  return Boolean(request.headers["transfer-encoding"]) || (length !== undefined && length !== "0");
}

/** A body that has not fully arrived by its deadline ends the request (408) and the connection. */
function bodyDeadline(request, response, path, limits) {
  if (!hasBody(request)) return;
  const ms = SLOW_BODY.test(path) ? limits.slowBodyTimeout : limits.bodyTimeout;
  const timer = setTimeout(() => {
    if (request.complete) return;
    if (!response.headersSent) {
      response.writeHead(408, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", Connection: "close" });
      response.end("Request body too slow.\n");
    }
    setTimeout(() => request.socket?.destroy(), 1_000).unref();
  }, ms);
  timer.unref();
  const clear = () => clearTimeout(timer);
  request.once("end", clear);
  request.once("close", clear);
  response.once("close", clear);
  response.once("finish", clear);
}

function refuse(response, status, retryAfter) {
  if (response.headersSent) return response.destroy();
  const headers = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Connection: "close" };
  if (retryAfter > 0) headers["Retry-After"] = String(retryAfter);
  response.writeHead(status, headers);
  response.end(status === 404 ? "Not found.\n" : "Too many requests.\n");
}

function refuseUpgrade(socket, retryAfter) {
  if (!socket.writable) return socket.destroy();
  socket.end(`HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nRetry-After: ${retryAfter}\r\nContent-Length: 0\r\n\r\n`);
  setTimeout(() => socket.destroy(), 5_000).unref();
}

function hostOf(value) {
  try {
    const url = new URL(value?.trim() || "");
    return { host: url.host.toLowerCase(), name: url.hostname.toLowerCase() };
  } catch {
    return null;
  }
}

function officeHostOf(env) {
  return hostOf(env.KNIFE_OFFICE_PUBLIC_URL);
}

function pathOf(url) {
  const raw = String(url ?? "/");
  if (raw.startsWith("/")) return raw.split("?")[0].split("#")[0] || "/";
  try {
    return new URL(raw).pathname; // absolute-form request target
  } catch {
    return "/";
  }
}

/** Installs the guard (idempotent). Returns the guard, or null when disabled. */
export function installAbuseGuard(env = process.env) {
  const limits = serverLimits(env);
  const enabled = env.KNIFE_ABUSE_GUARD?.trim().toLowerCase() !== "off";
  const holder = /** @type {Record<symbol, any>} */ (globalThis);
  const mode = guardMode(env);
  const guard = enabled
    ? (holder[GUARD_KEY] ??= new AbuseGuard({ policy: guardPolicy({ mode, scale: Number(env.KNIFE_GUARD_SCALE ?? 1) }), dataDir: securityDir(env) }))
    : null;
  const rules = trustedRules(env);
  // The office editor's and the ArtCraft apps' own hosts: their proxies keep per-account budgets of their own.
  const sidecarHosts = [officeHostOf(env), hostOf(env.KNIFE_CRAFT_PUBLIC_URL)].filter(Boolean);
  const isOffice = (request) => {
    if (!sidecarHosts.length) return false;
    const host = String(request.headers.host ?? "").toLowerCase();
    return sidecarHosts.some((side) => host === side.host || host.replace(/:\d+$/, "") === side.name);
  };
  if (guard) process.once("exit", () => guard.saveNow());

  for (const Server of [http.Server, https.Server]) {
    const original = Server.prototype.emit;
    if (original.knifeGuard) continue;
    let failures = 0;
    const patched = function emit(event, request, ...rest) {
      if ((event === "request" || event === "upgrade") && request?.headers) {
        harden(this, limits);
        if (guard) {
          try {
            const path = pathOf(request.url);
            const verdict = guard.check({
              address: clientAddress(request, rules),
              path,
              method: request.method,
              credHash: credentialHash(request.headers),
              office: isOffice(request),
            });
            if (event === "upgrade") {
              if (!verdict.ok && verdict.status === 429) {
                refuseUpgrade(rest[0], verdict.retryAfter);
                return true;
              }
            } else {
              const response = rest[0];
              if (!verdict.ok) {
                if (verdict.reason !== "blocked") {
                  if (verdict.reason !== "probe") recordSecurityEvent({ kind: "rate_block", ipPrefix: verdict.ctx.narrow, path, status: verdict.status, detail: verdict.reason });
                }
                guard.observe(verdict.ctx, verdict.status);
                refuse(response, verdict.status, verdict.retryAfter);
                return true;
              }
              response.once("finish", () => guard.observe(verdict.ctx, response.statusCode));
              bodyDeadline(request, response, path, limits);
            }
          } catch (error) {
            if (failures++ < 5) console.error("[abuse-guard]", error);
          }
        } else if (event === "request") {
          bodyDeadline(request, rest[0], pathOf(request.url), limits);
        }
      }
      return original.call(this, event, request, ...rest);
    };
    patched.knifeGuard = true;
    Server.prototype.emit = patched;
  }
  if (guard) console.log(`[abuse-guard] on (${mode} mode${guard.policy.block ? ", blocking" : ", budgets only"})`);
  else console.warn("[abuse-guard] off (KNIFE_ABUSE_GUARD=off): server timeouts only");
  return guard;
}

if (process.env.KNIFE_ABUSE_GUARD_INSTALL !== "0") installAbuseGuard();
