// Usage: node scripts/serve.mjs <dev|start>
// Next reads .env.local only after its CLI has parsed --hostname, so the bind
// address is resolved here. KNIFE_HOST defaults to loopback-only.
// `start` serves the production build (`npm run build` first): the public deployment. `dev` is the owner's live toolbox.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { deployProblems } from "./deploy-config.mjs";
import { createLogWriter, ensureLogRoot, logRoot, maintainLogs, maxBytes, retentionDays } from "../src/lib/logs/core.mjs";
import { probeSandbox, sandboxLayout, sandboxPolicy, sandboxRequired, toolsOutsideSandbox } from "../src/lib/python-sandbox.mjs";

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

// Log files (src/lib/logs/core.mjs, docs/DEPLOY.md "Log files"): the server's stdout/stderr and these [serve] lines go to
// <log root>/app/app-<UTC day>.log as well as to this process's stdout/stderr (the journal / PM2 keep working).
const logs = logRoot(process.env);
const appLog = logs && (await ensureLogRoot(logs)) ? createLogWriter({ root: logs, source: "app", prefix: "app", maxBytes: maxBytes(process.env) }) : null;
for (const [name, stream] of /** @type {const} */ ([["log", "out"], ["warn", "err"], ["error", "err"]])) {
  const original = console[name].bind(console);
  console[name] = (...args) => {
    original(...args);
    appLog?.line(stream, args.map(String).join(" "));
  };
}
// Retention (legal.json logRetentionDays, read each time) + gzip of past days, at startup and hourly.
const maintain = () => logs ? maintainLogs({ root: logs, days: retentionDays(process.env) }).catch(() => undefined) : Promise.resolve();
void maintain();
setInterval(() => void maintain(), 3_600_000).unref();

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
// Fail closed on a deployment that would be insecure (scripts/deploy-config.mjs, docs/DEPLOY.md "Startup checks").
const problems = deployProblems(process.env, authMode);
// The Python parser sandbox (src/lib/python-sandbox.mjs): probed with the real binds, required in public mode.
const sandboxBox = sandboxLayout(process.env, process.cwd());
const sandboxProbe = problems.errors.length === 0 && sandboxRequired(process.env, authMode)
  ? await probeSandbox(sandboxBox, process.env)
  : { ok: false, detail: "not required" };
const sandbox = problems.errors.length === 0
  ? sandboxPolicy(process.env, authMode, sandboxProbe)
  : { use: "off", errors: [], warnings: [] };
problems.errors.push(...sandbox.errors);
problems.warnings.push(...sandbox.warnings);
if (sandbox.use === "bwrap" && sandboxProbe.ok) {
  const hidden = toolsOutsideSandbox(sandboxBox, process.env);
  if (hidden.length) problems.warnings.push(`the parser sandbox cannot see ${hidden.join(", ")}: OCR will report it missing. Add its install root to KNIFE_PY_SANDBOX_RO (docs/DEPLOY.md "Parser sandbox").`);
}
for (const warning of problems.warnings) console.warn(`[serve] ${warning}`);
if (problems.errors.length) {
  for (const error of problems.errors) console.error(`[serve] refusing to start: ${error}`);
  process.exit(2);
}
if (authMode === "public" && mode === "dev") console.warn("[serve] public mode under `next dev` (dev overlay, source maps, HMR endpoints): deploy with `npm run build && npm run start` (docs/DEPLOY.md).");
if (mode === "start" && !existsSync(new URL("../.next/BUILD_ID", import.meta.url))) {
  console.error("[serve] no production build in .next: run `npm run build` first.");
  process.exit(2);
}
console.log(`[serve] next ${mode} on ${host}:${port} (auth mode ${authMode}, parser sandbox ${sandbox.use})`);

// Preload (one: Next re-serialises NODE_OPTIONS for its child and mangles a second quoted --import): the socket peer, for
// trusting forwarded headers only from KNIFE_TRUSTED_PROXIES (src/lib/accounts/network.ts); in public mode (or with
// KNIFE_SECURITY_HEADERS=1) it also loads the security headers (CSP, frame-ancestors, HSTS...: scripts/security-headers.mjs);
// always the abuse guard and the server timeouts (scripts/abuse-guard.mjs).
const preload = new URL("./peer-address.mjs", import.meta.url).href;
const headers = authMode === "public" || process.env.KNIFE_SECURITY_HEADERS?.trim() === "1";
const nodeOptions = [process.env.NODE_OPTIONS ?? "", `--import ${JSON.stringify(preload)}`].join(" ").trim();
const bin = new URL("../node_modules/next/dist/bin/next", import.meta.url).pathname;
// UV_THREADPOOL_SIZE: libuv's pool (fs.promises, dns.lookup, zlib, scrypt) is 4 threads by default, which a burst of
// password hashing fills; it must be set before the child starts.
const env = { ...process.env, KNIFE_LOG_DIR: logs ?? "off", NODE_OPTIONS: nodeOptions, KNIFE_SERVE_MODE: mode, UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE?.trim() || "16", ...(headers ? { KNIFE_SECURITY_HEADERS_INSTALL: "1" } : {}) };
const child = spawn(process.execPath, [bin, mode, "-H", host, "-p", port], { stdio: appLog ? ["inherit", "pipe", "pipe"] : "inherit", env });
if (appLog) {
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    appLog.write("out", chunk);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    appLog.write("err", chunk);
  });
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => {
  appLog?.flush();
  appLog?.line("err", `[serve] next ${mode} exited (${signal ?? `code ${code}`})`);
  appLog?.close();
  process.exit(code ?? (signal ? 1 : 0));
});
