import { createServer } from "node:net";
import type { SidecarState } from "./state";

/**
 * Addresses. The app binds KNIFE_HOST:KNIFE_PORT (scripts/serve.mjs); a sidecar is published on the same KNIFE_HOST at a
 * free port near KNIFE_PORT. Two URLs matter:
 *  - publicUrl: the browser -> sidecar (editor scripts, websocket). Default http://<bindHost>:<hostPort>.
 *  - appUrl: the container -> this app (document download, save callback). Default http://<KNIFE_HOST>:<KNIFE_PORT>; a
 *    container can reach the host's Tailscale/LAN address, but not its loopback, so a loopback-bound app needs an
 *    explicit appUrl (or KNIFE_SIDECAR_APP_URL) and a listener the container can reach (docs/SIDECARS.md).
 */

export function appHost(): string {
  return process.env.KNIFE_HOST?.trim() || "127.0.0.1";
}

export function appPort(): number {
  const parsed = Number.parseInt(process.env.KNIFE_PORT ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 3210;
}

export function isLoopback(host: string): boolean {
  return /^(?:127\.\d+\.\d+\.\d+|localhost|::1|\[::1\])$/i.test(host.trim());
}

function hostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function stripSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * The office editor served by this app on its own host name (scripts/office-proxy.mjs): KNIFE_OFFICE_PUBLIC_URL, as an
 * origin, or null. While set, the office sidecar is published on loopback only and the browser reaches it through the app.
 */
export function officeProxyUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.KNIFE_OFFICE_PUBLIC_URL?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

export function publicUrl(state: SidecarState): string {
  const proxied = state.id === "office" ? officeProxyUrl() : null;
  if (proxied) return proxied;
  return stripSlash(state.publicUrl || `http://${hostForUrl(state.bindHost)}:${state.hostPort}`);
}

/** Address the app itself uses to call the sidecar (health checks, downloading saved files). */
export function internalUrl(state: SidecarState): string {
  return `http://${hostForUrl(state.bindHost)}:${state.hostPort}`;
}

export interface AppUrlChoice {
  url: string;
  source: "state" | "env" | "derived";
  /** Set when the derived URL cannot work (loopback-bound app). */
  warning?: string;
}

export function appUrl(state: SidecarState | null): AppUrlChoice {
  if (state?.appUrl) return { url: stripSlash(state.appUrl), source: "state" };
  const fromEnv = process.env.KNIFE_SIDECAR_APP_URL?.trim();
  if (fromEnv) return { url: stripSlash(fromEnv), source: "env" };
  const host = appHost();
  const url = `http://${hostForUrl(host)}:${appPort()}`;
  if (isLoopback(host)) {
    return {
      url: `http://host.docker.internal:${appPort()}`,
      source: "derived",
      warning: `The app listens on ${host} only, which a container cannot reach. Bind the app to this machine's Tailscale/LAN address (KNIFE_HOST) or set the app URL to an address the container can reach.`,
    };
  }
  return { url, source: "derived" };
}

export function validateHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "must be http(s)";
    if (url.username || url.password) return "must not contain credentials";
    if (url.search || url.hash) return "must not contain a query or fragment";
    return null;
  } catch {
    return "not a URL";
  }
}

export function portFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/** First free port in [near+1, near+200] on `host`, skipping ones already claimed by other sidecars. */
export async function pickPort(host: string, near: number, taken: ReadonlySet<number>): Promise<number> {
  for (let port = near + 1; port <= Math.min(65535, near + 200); port += 1) {
    if (taken.has(port)) continue;
    if (await portFree(host, port)) return port;
  }
  throw new Error(`no free port on ${host} between ${near + 1} and ${near + 200}`);
}
