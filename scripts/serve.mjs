// Usage: node scripts/serve.mjs <dev|start>
// Next reads .env.local only after its CLI has parsed --hostname, so the bind
// address is resolved here. KNIFE_HOST defaults to loopback-only.
// `start` serves the production build (`npm run build` first): the public deployment. `dev` is the owner's live toolbox.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const mode = process.argv[2];
if (mode !== "dev" && mode !== "start") {
  console.error("usage: node scripts/serve.mjs <dev|start>");
  process.exit(2);
}

try {
  process.loadEnvFile(".env.local");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const host = process.env.KNIFE_HOST?.trim() || "127.0.0.1";
const port = process.env.KNIFE_PORT?.trim() || "3210";

// "Never bind 0.0.0.0" is the access-control model (the default account has no password; the loopback/Tailscale bind is the
// boundary), so a wildcard address is refused here instead of being trusted to a comment in .env.example.
const WILDCARD = /^(?:0\.0\.0\.0|0|::|\[::\]|::ffff:0\.0\.0\.0|\*)$/i;
if (WILDCARD.test(host)) {
  console.error(`[serve] refusing KNIFE_HOST=${host}: binding every interface would expose the passwordless account. Use 127.0.0.1 or this machine's Tailscale IP.`);
  process.exit(2);
}
const authMode = (process.env.KNIFE_AUTH_MODE ?? "").trim().toLowerCase() || "private";
if (authMode !== "private" && authMode !== "public") {
  console.error(`[serve] refusing KNIFE_AUTH_MODE=${process.env.KNIFE_AUTH_MODE}: use private (default) or public.`);
  process.exit(2);
}
if (authMode === "public") {
  if (!process.env.KNIFE_PUBLIC_URL?.trim()) console.warn("[serve] public mode without KNIFE_PUBLIC_URL: links in mail point at the bind address.");
  if (!process.env.KNIFE_TRUSTED_PROXIES?.trim()) console.warn("[serve] public mode without KNIFE_TRUSTED_PROXIES: X-Forwarded-For/-Proto are ignored, so every client shares one rate-limit bucket and cookies are never Secure.");
  if (mode === "dev") console.warn("[serve] public mode under `next dev` (dev overlay, source maps, HMR endpoints): deploy with `npm run build && npm run start` (docs/DEPLOY.md).");
}
if (mode === "start" && !existsSync(new URL("../.next/BUILD_ID", import.meta.url))) {
  console.error("[serve] no production build in .next: run `npm run build` first.");
  process.exit(2);
}
console.log(`[serve] next ${mode} on ${host}:${port} (auth mode ${authMode})`);

// Preload (one: Next re-serialises NODE_OPTIONS for its child and mangles a second quoted --import): the socket peer, for
// trusting forwarded headers only from KNIFE_TRUSTED_PROXIES (src/lib/accounts/network.ts); in public mode (or with
// KNIFE_SECURITY_HEADERS=1) it also loads the security headers (CSP, frame-ancestors, HSTS...: scripts/security-headers.mjs).
const preload = new URL("./peer-address.mjs", import.meta.url).href;
const headers = authMode === "public" || process.env.KNIFE_SECURITY_HEADERS?.trim() === "1";
const nodeOptions = [process.env.NODE_OPTIONS ?? "", `--import ${JSON.stringify(preload)}`].join(" ").trim();
const bin = new URL("../node_modules/next/dist/bin/next", import.meta.url).pathname;
const env = { ...process.env, NODE_OPTIONS: nodeOptions, KNIFE_SERVE_MODE: mode, ...(headers ? { KNIFE_SECURITY_HEADERS_INSTALL: "1" } : {}) };
const child = spawn(process.execPath, [bin, mode, "-H", host, "-p", port], { stdio: "inherit", env });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
