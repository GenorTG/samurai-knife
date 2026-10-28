// SERVER ONLY. The network a screenshot's browser gets (docs/WEBSITE-STUDIO.md "Screenshots").
import http from "node:http";
import net from "node:net";
import { rmSync } from "node:fs";
import { checkUrl, denyList, OutboundError, resolveAllowed, type OutboundPolicy, type ResolvedAddress, type Resolver } from "@/lib/net/safe-fetch";

/**
 * Chromium runs inside the Python lane's bubblewrap sandbox, which has no network of its own. Its only way out is this
 * HTTP proxy, listening on a unix socket inside the job's scratch dir (bound into the sandbox; the script relays the
 * sandbox loopback to it). Every connection is checked like any other outbound request of the server
 * (src/lib/net/safe-fetch.ts): scheme, port and literal checks, one DNS resolution, EVERY address against the policy
 * (no loopback, LAN, Tailscale, metadata or the host's own addresses in public mode), then a connection pinned to one of
 * those addresses. So a page that embeds `http://169.254.169.254/` or `http://localhost:3210/` (or a DNS name pointing
 * there) gets a refusal, never the content. HTTPS goes through CONNECT (the proxy never sees inside TLS); plain HTTP is
 * forwarded in absolute form. Per job: a cap on connections and on bytes in both directions, and a wall-clock limit.
 */

export interface ProxyLimits {
  /** CONNECT tunnels + plain HTTP requests. */
  maxConnections: number;
  /** Bytes relayed in both directions, all connections together. */
  maxBytes: number;
}

export interface ProxyStats {
  connections: number;
  refused: number;
  bytes: number;
  /** First refusal reasons (for the job's notes). */
  reasons: string[];
  /** Destination hosts reached, first seen first (bounded). */
  hosts: string[];
}

export interface ScreenshotProxy {
  socketPath: string;
  stats(): ProxyStats;
  close(): void;
}

export interface ProxyOptions {
  policy: OutboundPolicy;
  limits: ProxyLimits;
  resolve?: Resolver;
  /** Called with every destination before it is contacted; throwing refuses it (a per-host budget). */
  admit?: (url: URL) => void;
}

export const DEFAULT_PROXY_LIMITS: ProxyLimits = { maxConnections: 400, maxBytes: 60 * 1024 * 1024 };
const CONNECT_TIMEOUT_MS = 15_000;
const HOP_HEADERS = new Set(["proxy-connection", "proxy-authorization", "connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"]);

/** `host:port` of a CONNECT request -> an https URL to check, or null when malformed. */
export function connectTarget(authority: string | undefined): URL | null {
  if (!authority || authority.length > 300 || /[\s/@?#]/.test(authority)) return null;
  const match = /^(\[[0-9a-fA-F:.]+\]|[^:[\]]+):(\d{1,5})$/.exec(authority);
  if (!match) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65_535) return null;
  try {
    // Port 443 in an https URL is the default ("" in URL.port), which is what the policy's port list expects.
    return new URL(`https://${match[1]}:${port}/`);
  } catch {
    return null;
  }
}

/**
 * The check every destination passes: static URL rules, the caller's admission (budget), then resolution with every
 * address allowed. Returns the addresses the connection may use. Exported for tests.
 */
export async function admitDestination(url: URL, options: Pick<ProxyOptions, "policy" | "resolve" | "admit">): Promise<ResolvedAddress[]> {
  const deny = denyList();
  checkUrl(url, options.policy, deny);
  options.admit?.(url);
  return resolveAllowed(url, options.policy, options.resolve, deny);
}

function reasonOf(error: unknown): string {
  if (error instanceof OutboundError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function dial(addresses: ResolvedAddress[], port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let index = 0;
    const next = (failure?: unknown): void => {
      const target = addresses[index++];
      if (!target) {
        reject(failure ?? new Error("no address to connect to"));
        return;
      }
      const socket = net.connect({ host: target.address, port, family: target.family });
      const timer = setTimeout(() => socket.destroy(new Error("connect timeout")), CONNECT_TIMEOUT_MS);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.removeAllListeners("error");
        resolve(socket);
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        socket.destroy();
        next(error);
      });
    };
    next();
  });
}

export function startScreenshotProxy(socketPath: string, options: ProxyOptions): Promise<ScreenshotProxy> {
  const sockets = new Set<net.Socket>();
  const stats: ProxyStats = { connections: 0, refused: 0, bytes: 0, reasons: [], hosts: [] };
  let closed = false;

  const track = (socket: net.Socket): void => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  };
  const count = (n: number): boolean => {
    stats.bytes += n;
    if (stats.bytes > options.limits.maxBytes) {
      for (const socket of sockets) socket.destroy();
      return false;
    }
    return true;
  };
  const refuse = (why: string): void => {
    stats.refused += 1;
    if (stats.reasons.length < 8 && !stats.reasons.includes(why)) stats.reasons.push(why.slice(0, 300));
  };
  const opened = (url: URL): string | null => {
    if (closed) return "the screenshot is finished";
    if (stats.connections >= options.limits.maxConnections) return "too many connections for one screenshot";
    if (stats.bytes > options.limits.maxBytes) return "the page downloaded more than the size limit";
    stats.connections += 1;
    const host = url.hostname.toLowerCase();
    if (stats.hosts.length < 64 && !stats.hosts.includes(host)) stats.hosts.push(host);
    return null;
  };
  /** Bytes in both directions, counted against the job's cap. */
  const meter = (from: net.Socket | NodeJS.ReadableStream, to: NodeJS.WritableStream): void => {
    from.on("data", (chunk: Buffer) => {
      if (count(chunk.byteLength)) to.write(chunk);
    });
    from.on("end", () => to.end());
  };

  const server = http.createServer((req, res) => {
    // Plain HTTP in absolute form (`GET http://host/path`). Anything else is not a proxy request.
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (url.protocol !== "http:") {
      refuse("only http(s) requests are proxied");
      res.writeHead(400).end();
      return;
    }
    void (async () => {
      let addresses: ResolvedAddress[];
      try {
        addresses = await admitDestination(url, options);
      } catch (error) {
        refuse(reasonOf(error));
        if (!res.headersSent) res.writeHead(403, { "content-type": "text/plain" }).end("refused by the screenshot proxy");
        return;
      }
      const busy = opened(url);
      if (busy) {
        refuse(busy);
        res.writeHead(429).end();
        return;
      }
      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (value !== undefined && !HOP_HEADERS.has(name.toLowerCase())) headers[name] = value;
      }
      headers.host = url.host;
      const upstream = http.request({
        host: addresses[0].address,
        family: addresses[0].family,
        port: url.port || 80,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers,
        agent: false,
        timeout: CONNECT_TIMEOUT_MS,
      }, (answer) => {
        const out: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(answer.headers)) {
          if (value !== undefined && !HOP_HEADERS.has(name.toLowerCase())) out[name] = value;
        }
        res.writeHead(answer.statusCode ?? 502, out);
        meter(answer, res);
      });
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502).end();
        else res.destroy();
      });
      upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
      meter(req, upstream);
    })();
  });

  server.on("connect", (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    track(client);
    const url = connectTarget(req.url);
    if (!url) {
      refuse("malformed CONNECT target");
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    void (async () => {
      let addresses: ResolvedAddress[];
      try {
        addresses = await admitDestination(url, options);
      } catch (error) {
        refuse(reasonOf(error));
        client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      const busy = opened(url);
      if (busy) {
        refuse(busy);
        client.end("HTTP/1.1 429 Too Many Requests\r\n\r\n");
        return;
      }
      let upstream: net.Socket;
      try {
        upstream = await dial(addresses, Number(url.port || 443));
      } catch {
        client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        return;
      }
      track(upstream);
      if (closed || client.destroyed) {
        upstream.destroy();
        return;
      }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.byteLength && count(head.byteLength)) upstream.write(head);
      meter(client, upstream);
      meter(upstream, client);
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
    })();
  });
  server.on("connection", track);
  server.on("clientError", (_error, socket) => socket.destroy());

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve({
        socketPath,
        stats: () => ({ ...stats, reasons: [...stats.reasons], hosts: [...stats.hosts] }),
        close() {
          if (closed) return;
          closed = true;
          for (const socket of sockets) socket.destroy();
          server.close();
          rmSync(socketPath, { force: true });
        },
      });
    });
  });
}
