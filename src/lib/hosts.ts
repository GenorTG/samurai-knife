/**
 * Hostnames the app is reached by: loopback, the bind address (KNIFE_HOST) and any extra names from KNIFE_ALLOWED_HOSTS
 * (comma-separated: the machine name, a LAN IP…). Kept in .env.local, never in the repo. Used by next.config.ts
 * (allowedDevOrigins) and the Host/Origin guard; dependency-free so the config can import it.
 */
const split = (value: string | undefined): string[] =>
  (value ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);

export function knifeHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set(["localhost", "127.0.0.1", ...split(env.KNIFE_HOST), ...split(env.KNIFE_ALLOWED_HOSTS)])];
}
