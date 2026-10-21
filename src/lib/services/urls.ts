import { createServer } from "node:net";
import { knifeHosts } from "@/lib/hosts";
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

/** Sidecars the app can serve on a host name of their own (the office editor, the ArtCraft apps) and their variable. */
const PROXY_ENV: Readonly<Record<string, string>> = { office: "KNIFE_OFFICE_PUBLIC_URL", craft: "KNIFE_CRAFT_PUBLIC_URL" };

/**
 * A sidecar served by this app on its own host name (scripts/office-proxy.mjs, scripts/craft-proxy.mjs): its variable, as
 * an origin, or null. While set, the sidecar is published on loopback only and the browser reaches it through the app.
 */
export function proxiedSidecarUrl(id: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const name = PROXY_ENV[id];
  const value = name ? env[name]?.trim() : undefined;
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** The office editor's proxied origin (KNIFE_OFFICE_PUBLIC_URL), or null. */
export function officeProxyUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  return proxiedSidecarUrl("office", env);
}

/** The ArtCraft apps' proxied origin (KNIFE_CRAFT_PUBLIC_URL), or null. */
export function craftProxyUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  return proxiedSidecarUrl("craft", env);
}

/**
 * Origins the app's pages are served from, i.e. who may frame a sidecar: KNIFE_PUBLIC_URL's origin when set, else
 * http://<host>:<KNIFE_PORT> for KNIFE_HOST and every KNIFE_ALLOWED_HOSTS name (the same rule as the office proxy).
 */
export function appOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  try {
    const url = new URL(env.KNIFE_PUBLIC_URL?.trim() ?? "");
    if (url.protocol === "https:" || url.protocol === "http:") return [url.origin];
  } catch {
    // private mode
  }
  const port = env.KNIFE_PORT?.trim() || "3210";
  return [...new Set(knifeHosts(env).map((host) => `http://${hostForUrl(host)}:${port}`))];
}

export function publicUrl(state: SidecarState): string {
  const proxied = proxiedSidecarUrl(state.id);
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
