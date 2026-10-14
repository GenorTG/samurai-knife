// Usage: node scripts/serve.mjs <dev|start>
// Next reads .env.local only after its CLI has parsed --hostname, so the bind
// address is resolved here. KNIFE_HOST defaults to loopback-only.
import { spawn } from "node:child_process";

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
console.log(`[serve] next ${mode} on ${host}:${port}`);

const bin = new URL("../node_modules/next/dist/bin/next", import.meta.url).pathname;
const child = spawn(process.execPath, [bin, mode, "-H", host, "-p", port], { stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
