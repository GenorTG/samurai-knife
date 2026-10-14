#!/usr/bin/env node
// Manage Samurai Knife accounts (no self-registration exists; this is the only way to add one).
// Shares accounts.json with src/lib/accounts/store.ts. Self-contained, no dependencies.
//
//   npm run accounts -- list
//   npm run accounts -- add <id> --name "Display Name" [--password-prompt]
//   npm run accounts -- set-password <id>
//   npm run accounts -- remove <id>
//   npm run accounts -- set-default <id>
//   npm run accounts -- set-provider <id> --base-url URL --model NAME
//        [--key-prompt | --key-env VAR | --key-stdin] [--header "K: V"]... [--clear-headers]
//   npm run accounts -- set-provider <id> --preset openclaw-gateway --agent openclaw/<agentId>
//        [--backend-model provider/model] [--gateway-url URL] [--allow-main] [--key-prompt | --key-env VAR | --key-stdin]
//
// API keys are never accepted as argv values (shell history): use --key-prompt (hidden paste), --key-env or --key-stdin.
// Preset openclaw-gateway: the local OpenClaw gateway's OpenAI-compatible endpoint. Its `model` is an AGENT target and
// every request is a full agent run, so the main agent (exec/elevated tools) is refused unless --allow-main.
import { randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

// Agent targets that run the main agent (exec, elevated tools, messaging) when used through the gateway endpoint.
const MAIN_AGENT_TARGETS = new Set(["openclaw", "openclaw/default", "openclaw/main", "openclaw:main", "agent:main"]);
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const dir = process.env.KNIFE_DATA_DIR?.trim() || join(homedir(), ".local", "share", "samurai-knife");
const file = join(dir, "accounts.json");

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function writeStore(store) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* not ours */ }
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}

function readStore() {
  if (!existsSync(file)) {
    const initial = {
      defaultAccountId: "genor",
      accounts: [{ id: "genor", displayName: "Genor", provider: null, createdAt: new Date().toISOString() }],
    };
    writeStore(initial);
    return initial;
  }
  let store;
  try {
    store = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${file} is not valid JSON: ${error.message}`);
  }
  if (!store || !Array.isArray(store.accounts) || !store.accounts.some((a) => a.id === store.defaultAccountId)) {
    fail(`${file} has an unexpected shape`);
  }
  return store;
}

function hashPassword(password) {
  const N = 16384, r = 8, p = 1;
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

const KNOWN_FLAGS = ["name", "password-prompt", "base-url", "model", "key-env", "key-stdin", "key-prompt", "header", "clear-headers", "preset", "agent", "backend-model", "gateway-url", "allow-main"];
const BOOLEAN_FLAGS = ["password-prompt", "key-stdin", "key-prompt", "clear-headers", "allow-main"];

function parseArgs(argv) {
  const positional = [];
  const flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (!KNOWN_FLAGS.includes(name)) fail(`unknown option --${name} (API keys are only accepted via --key-prompt, --key-env or --key-stdin)`);
    const boolean = BOOLEAN_FLAGS.includes(name);
    let value = true;
    if (!boolean) {
      value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined) fail(`--${name} needs a value`);
    }
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { positional, flags };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function promptHidden(label) {
  if (!process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin });
    for await (const line of rl) { rl.close(); return line; }
    return "";
  }
  return new Promise((resolve) => {
    process.stderr.write(label);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stderr.write("\n");
          return resolve(value);
        }
        if (ch === "\u0003") { process.stdin.setRawMode(false); process.stderr.write("\n"); process.exit(130); }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function newPassword() {
  const first = await promptHidden("New password: ");
  if (first.length < 8) fail("password must be at least 8 characters");
  if (process.stdin.isTTY) {
    const second = await promptHidden("Repeat password: ");
    if (second !== first) fail("passwords do not match");
  }
  return hashPassword(first);
}

function requireAccount(store, id) {
  if (!id) fail("missing account id");
  const account = store.accounts.find((a) => a.id === id);
  if (!account) fail(`no such account: ${id}`);
  return account;
}

function keyHint(key) {
  if (!key) return "none";
  return key.length >= 12 ? `…${key.slice(-4)}` : "…";
}

function normalizeBaseUrl(raw) {
  let url;
  try { url = new URL(raw.trim()); } catch { fail("--base-url is not a valid URL"); }
  if (!["http:", "https:"].includes(url.protocol)) fail("--base-url must be http(s)");
  if (url.username || url.password || url.search || url.hash) fail("--base-url must not contain credentials, query or fragment");
  return url.toString().replace(/\/+$/, "");
}

const commands = {
  list(store) {
    for (const a of store.accounts) {
      const provider = a.provider
        ? `${a.provider.baseUrl} model=${a.provider.model} key=${keyHint(a.provider.apiKey)}`
        : "no provider";
      const marks = [a.id === store.defaultAccountId ? "default" : null, a.passwordHash ? "password" : "no password"].filter(Boolean);
      console.log(`${a.id}\t${a.displayName}\t[${marks.join(", ")}]\t${provider}`);
    }
  },

  async add(store, { positional, flags }) {
    const id = positional[0];
    if (!id || !ID_PATTERN.test(id)) fail("id must match [a-z0-9][a-z0-9_-]{0,31}");
    if (store.accounts.some((a) => a.id === id)) fail(`account already exists: ${id}`);
    const name = flags.get("name")?.[0];
    if (typeof name !== "string" || !name.trim()) fail('--name "<display name>" is required');
    const account = { id, displayName: name.trim().slice(0, 80), provider: null, createdAt: new Date().toISOString() };
    if (flags.has("password-prompt")) account.passwordHash = await newPassword();
    store.accounts.push(account);
    writeStore(store);
    console.log(`added ${id}${account.passwordHash ? " (password set)" : " (no password; only the default account may be passwordless to be usable)"}`);
  },

  async "set-password"(store, { positional }) {
    const account = requireAccount(store, positional[0]);
    account.passwordHash = await newPassword();
    writeStore(store);
    console.log(`password set for ${account.id}; existing sessions are invalidated`);
  },

  remove(store, { positional }) {
    const account = requireAccount(store, positional[0]);
    if (account.id === store.defaultAccountId) fail("refusing to remove the default account; run set-default first");
    store.accounts = store.accounts.filter((a) => a.id !== account.id);
    writeStore(store);
    console.log(`removed ${account.id}`);
  },

  "set-default"(store, { positional }) {
    const account = requireAccount(store, positional[0]);
    store.defaultAccountId = account.id;
    writeStore(store);
    console.log(`default account is now ${account.id}${account.passwordHash ? "" : " (no password: anyone on the tailnet acts as this account)"}`);
  },

  async "set-provider"(store, { positional, flags }) {
    const account = requireAccount(store, positional[0]);
    const preset = flags.get("preset")?.[0];
    let baseUrlFlag = flags.get("base-url")?.[0];
    let model = flags.get("model")?.[0];
    let presetHeaders;
    if (preset !== undefined) {
      if (preset !== "openclaw-gateway") fail(`unknown --preset ${preset} (known: openclaw-gateway)`);
      if (baseUrlFlag !== undefined || model !== undefined) fail("--preset sets the URL and model itself: drop --base-url/--model (use --gateway-url/--agent)");
      const agent = flags.get("agent")?.[0];
      if (typeof agent !== "string" || !/^(openclaw|agent)([/:][A-Za-z0-9_-]+)?$/.test(agent)) fail("--agent openclaw/<agentId> is required for the openclaw-gateway preset");
      if (MAIN_AGENT_TARGETS.has(agent) && !flags.has("allow-main")) {
        fail(`refusing agent target ${agent}: every request is a full run of the main agent (exec/elevated tools). Use a restricted agent (e.g. openclaw/knife-test) or pass --allow-main to accept the risk.`);
      }
      baseUrlFlag = flags.get("gateway-url")?.[0] ?? "http://127.0.0.1:18789/v1";
      model = agent;
      const backend = flags.get("backend-model")?.[0];
      if (backend) presetHeaders = { "x-openclaw-model": backend };
    } else if (["agent", "backend-model", "gateway-url", "allow-main"].some((f) => flags.has(f))) {
      fail("--agent/--backend-model/--gateway-url/--allow-main only apply with --preset openclaw-gateway");
    }
    if (typeof baseUrlFlag !== "string") fail("--base-url is required (or --preset)");
    if (typeof model !== "string" || !model.trim()) fail("--model is required (or --preset)");
    if (["key-env", "key-stdin", "key-prompt"].filter((f) => flags.has(f)).length > 1) fail("use only one of --key-prompt / --key-env / --key-stdin");

    let apiKey = account.provider?.apiKey ?? "";
    if (flags.has("key-env")) {
      const name = flags.get("key-env")[0];
      const value = process.env[name];
      if (!value) fail(`environment variable ${name} is empty or unset`);
      apiKey = value.trim();
    } else if (flags.has("key-stdin")) {
      apiKey = (await readStdin()).trim();
      if (!apiKey) fail("no key received on stdin");
    } else if (flags.has("key-prompt")) {
      apiKey = (await promptHidden(`API key for ${account.id} (input hidden): `)).trim();
      if (!apiKey) fail("no key entered");
    }

    let extraHeaders = flags.has("clear-headers") ? undefined : (presetHeaders ?? account.provider?.extraHeaders);
    if (preset !== undefined && presetHeaders === undefined && !flags.has("header")) extraHeaders = undefined; // a preset replaces, never inherits, the old provider's headers
    if (flags.has("header")) {
      extraHeaders = { ...(presetHeaders ?? {}) };
      for (const raw of flags.get("header")) {
        const index = raw.indexOf(":");
        if (index < 1) fail(`--header must look like "Name: value" (got "${raw}")`);
        const name = raw.slice(0, index).trim();
        const value = raw.slice(index + 1).trim();
        if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(name)) fail(`invalid header name: ${name}`);
        if (["authorization", "content-type", "content-length", "host", "cookie"].includes(name.toLowerCase())) {
          fail(`header ${name} is managed by the server`);
        }
        if (/[\r\n\0]/.test(value)) fail(`invalid header value for ${name}`);
        extraHeaders[name] = value;
      }
    }

    account.provider = {
      baseUrl: normalizeBaseUrl(baseUrlFlag),
      apiKey,
      model: model.trim(),
      ...(extraHeaders && Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {}),
    };
    writeStore(store);
    console.log(`provider saved for ${account.id}: ${account.provider.baseUrl} model=${account.provider.model} key=${keyHint(apiKey)}`);
  },
};

const [command, ...rest] = process.argv.slice(2);
if (!command || command === "help" || command === "--help" || !(command in commands)) {
  console.error(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).slice(0, 22).map((l) => l.slice(3)).join("\n"));
  process.exit(command && command !== "help" && command !== "--help" ? 2 : 0);
}
await commands[command](readStore(), parseArgs(rest));
