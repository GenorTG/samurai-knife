#!/usr/bin/env node
// Manage Smart Knife accounts. Private mode: the only way to add one. Public mode (KNIFE_AUTH_MODE=public): people
// register themselves; this sets up the owner (password + email + role admin) and fixes accounts by hand.
// Shares accounts.json (format v2, lock file accounts.json.lock) with src/lib/accounts/store.ts. No dependencies.
//
//   npm run accounts -- list
//   npm run accounts -- add <id> --name "Display Name" [--password-prompt] [--email a@b.c] [--role admin|user]
//   npm run accounts -- set-password <id>                (also revokes the account's MCP keys)
//   npm run accounts -- set-email <id> <address>        (marked as verified: you vouch for it)
//   npm run accounts -- set-role <id> admin|user
//   npm run accounts -- set-status <id> active|disabled
//   npm run accounts -- remove <id>
//   npm run accounts -- set-default <id>
//   npm run accounts -- set-provider <id> --base-url URL --model NAME
//        [--key-prompt | --key-env VAR | --key-stdin] [--header "K: V"]... [--clear-headers] [--vision native|none]
//        (keeps the reasoning effort and vision helper; "Sees images" is kept while the URL and model stay the same)
//   npm run accounts -- set-provider <id> --preset openclaw-gateway --agent openclaw/<agentId>
//        [--backend-model provider/model] [--gateway-url URL] [--allow-main] [--key-prompt | --key-env VAR | --key-stdin]
//   npm run accounts -- set-network <id> private|public   (public mode: may an ADMIN's provider reach loopback/LAN?)
//   npm run accounts -- approve-provider <id> <baseUrl>|none   (public mode: a non-admin may use this custom provider URL)
//   npm run accounts -- approve-site <id> <url>|none   (public mode: a non-admin may audit this site without GitHub proof)
//   npm run accounts -- set-github <id> <github-login> [--github-id N] | --clear  (link a GitHub user: "Sign in with
//        GitHub" opens this account; the numeric id is looked up unless given; GITHUB_TOKEN avoids the anonymous limit)
//   npm run accounts -- provider-json <id>                (prints the provider WITH its key as JSON: for test helpers)
//
// API keys are never accepted as argv values (shell history): use --key-prompt (hidden paste), --key-env or --key-stdin.
// Keys and extra-header values are sealed on disk (AES-256-GCM, key file provider-keys.key next to accounts.json; same
// format as src/lib/accounts/secret-box.ts); plaintext ones from older files are sealed by the next write.
// Preset openclaw-gateway: the local OpenClaw gateway's OpenAI-compatible endpoint. Its `model` is an AGENT target and
// every request is a full agent run, so the main agent (exec/elevated tools) is refused unless --allow-main.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

// Agent targets that run the main agent (exec, elevated tools, messaging) when used through the gateway endpoint.
const MAIN_AGENT_TARGETS = new Set(["openclaw", "openclaw/default", "openclaw/main", "openclaw:main", "agent:main"]);
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const dir = process.env.KNIFE_DATA_DIR?.trim() || join(homedir(), ".local", "share", "samurai-knife");
const file = join(dir, "accounts.json");
const lockFile = `${file}.lock`;
const STORE_VERSION = 2;
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

// Same lock as the server (src/lib/accounts/store.ts): O_EXCL file, stale after 10 s. The CLI prompts (passwords, keys)
// between reading and writing, so it never holds the lock that long: the write is a compare-and-swap instead. Under the
// lock it re-reads the file and refuses to write when the server changed it since this command read it.
let loadedText = null;
function lock() {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 5000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      closeSync(openSync(lockFile, "wx", 0o600));
      holding = true;
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try { if (Date.now() - statSync(lockFile).mtimeMs > 10_000) rmSync(lockFile, { force: true }); } catch { /* gone */ }
      if (Date.now() > deadline) fail(`${lockFile} is held by another process (the server mid-write?); try again`);
      Atomics.wait(sleeper, 0, 0, 20);
    }
  }
}
let holding = false;
function unlock() {
  if (!holding) return;
  holding = false;
  rmSync(lockFile, { force: true });
}
// fail() exits mid-write: release only a lock this process took.
process.on("exit", unlock);

// v1 accounts (file without a version) get the v2 fields: an account made by the owner is an active admin. In a v2 file a
// missing role or status fails closed (user, disabled), the same rule as src/lib/accounts/store.ts.
function withV2Fields(account, legacy = true) {
  return {
    email: null, emailVerifiedAt: null, role: legacy ? "admin" : "user", status: legacy ? "active" : "disabled", storageQuotaBytes: null, lastLoginAt: null,
    ...account,
  };
}

// Provider secrets at rest: the format of src/lib/accounts/secret-box.ts (`enc:v1:<iv>:<tag>:<ciphertext>`, base64url,
// AAD `<account>:apiKey` / `<account>:header:<lower-cased name>`; a saved profile's secrets use `<account>:profile:<id>` as the owner).
const KEY_FILE = join(dir, "provider-keys.key");
const SEALED = "enc:v1:";
let secretKey = null;
function readSecretKey(create) {
  if (secretKey) return secretKey;
  if (existsSync(KEY_FILE)) {
    const text = readFileSync(KEY_FILE, "utf8").trim();
    if (!/^[0-9a-f]{64}$/.test(text)) fail(`${KEY_FILE} is malformed (expected 64 hex characters)`);
    secretKey = Buffer.from(text, "hex");
  } else if (create) {
    const key = randomBytes(32);
    const temp = `${KEY_FILE}.${process.pid}.tmp`;
    writeFileSync(temp, `${key.toString("hex")}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, KEY_FILE);
    secretKey = key;
  }
  return secretKey;
}
function sealValue(value, context) {
  if (!value || value.startsWith(SEALED)) return value;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", readSecretKey(true), iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${SEALED}${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${body.toString("base64url")}`;
}
function openValue(value, context) {
  if (typeof value !== "string" || !value.startsWith(SEALED)) return value;
  const key = readSecretKey(false);
  if (!key) fail(`${file} holds sealed provider keys but ${KEY_FILE} is missing`);
  try {
    const [iv, tag, body] = value.slice(SEALED.length).split(":").map((part) => Buffer.from(part, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return fail(`a provider secret (${context}) does not decrypt with ${KEY_FILE}`);
  }
}
function mapConfig(config, owner, fn) {
  const out = { ...config, apiKey: fn(config.apiKey, `${owner}:apiKey`) };
  if (config.extraHeaders) {
    out.extraHeaders = Object.fromEntries(Object.entries(config.extraHeaders).map(([name, value]) => [name, fn(value, `${owner}:header:${name.toLowerCase()}`)]));
  }
  return out;
}
function mapSecrets(account, fn) {
  const out = { ...account };
  if (account.provider) out.provider = mapConfig(account.provider, account.id, fn);
  if (Array.isArray(account.providerProfiles)) {
    out.providerProfiles = account.providerProfiles.map((profile) => ({ ...profile, config: mapConfig(profile.config, `${account.id}:profile:${profile.id}`, fn) }));
  }
  return out;
}

function writeStore(store) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* not ours */ }
  const emails = store.accounts.map((a) => a.email).filter(Boolean);
  if (new Set(emails).size !== emails.length) fail("two accounts would share an email address");
  const accounts = store.accounts.map((a) => mapSecrets(withV2Fields(a, false), sealValue));
  const text = `${JSON.stringify({ ...store, version: STORE_VERSION, accounts }, null, 2)}\n`;
  lock();
  try {
    const current = existsSync(file) ? readFileSync(file, "utf8") : null;
    if (current !== loadedText) fail(`${file} changed while this command ran (the server wrote it); run the command again`);
    const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(temp, text, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
    loadedText = text;
  } finally {
    unlock();
  }
}

/**
 * Revokes every MCP key of an account in `mcp-keys.json` (same file and format as src/lib/accounts/mcp-keys.ts, whose
 * revokeAllMcpKeys the web password reset/change uses): a new password must end an attacker's agent access too, and a
 * removed id registered again must not inherit the old keys. Returns how many were revoked.
 */
function revokeMcpKeys(accountId) {
  const keysFile = join(dir, "mcp-keys.json");
  if (!existsSync(keysFile)) return 0;
  let raw;
  try {
    raw = JSON.parse(readFileSync(keysFile, "utf8"));
  } catch {
    console.error(`warning: ${keysFile} is damaged; the app already refuses every key in it (fail closed)`);
    return 0;
  }
  const keys = Array.isArray(raw.keys) ? raw.keys : [];
  const kept = keys.filter((k) => k?.accountId !== accountId);
  if (kept.length === keys.length) return 0;
  const temp = `${keysFile}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ version: 1, keys: kept })}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, keysFile);
  return keys.length - kept.length;
}

function readStore() {
  if (!existsSync(file)) {
    const initial = {
      version: STORE_VERSION,
      defaultAccountId: "genor",
      accounts: [withV2Fields({ id: "genor", displayName: "Genor", provider: null, createdAt: new Date().toISOString() })],
    };
    writeStore(initial);
    return initial;
  }
  let store;
  try {
    loadedText = readFileSync(file, "utf8");
    store = JSON.parse(loadedText);
  } catch (error) {
    fail(`${file} is not valid JSON: ${error.message}`);
  }
  if (!store || !Array.isArray(store.accounts) || (store.accounts.length > 0 && !store.accounts.some((a) => a.id === store.defaultAccountId))) {
    fail(`${file} has an unexpected shape`);
  }
  if (typeof store.version === "number" && store.version > STORE_VERSION) fail(`${file} is format v${store.version}; this CLI knows v${STORE_VERSION}`);
  const legacy = typeof store.version !== "number";
  store.accounts = store.accounts.map((a) => mapSecrets(withV2Fields(a, legacy), openValue));
  return store;
}

function hashPassword(password) {
  // Same parameters as src/lib/accounts/password.ts (OWASP: N=2^17, r=8, p=1).
  const N = 131072, r = 8, p = 1;
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N, r, p, maxmem: 288 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

const KNOWN_FLAGS = ["name", "email", "role", "password-prompt", "base-url", "model", "key-env", "key-stdin", "key-prompt", "header", "clear-headers", "preset", "agent", "backend-model", "gateway-url", "allow-main", "clear", "github-id", "vision"];
const BOOLEAN_FLAGS = ["password-prompt", "key-stdin", "key-prompt", "clear-headers", "allow-main", "clear"];

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
  // Public mode needs 10 (the same rule as registration); private mode keeps the old floor of 8.
  const min = (process.env.KNIFE_AUTH_MODE ?? "").trim().toLowerCase() === "public" ? 10 : 8;
  if (first.length < min) fail(`password must be at least ${min} characters`);
  if (process.stdin.isTTY) {
    const second = await promptHidden("Repeat password: ");
    if (second !== first) fail("passwords do not match");
  }
  return hashPassword(first);
}

function verifiedEmail(store, id, raw) {
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!EMAIL.test(email) || email.length > 254) fail("a valid email address is required");
  if (store.accounts.some((a) => a.id !== id && a.email === email)) fail(`${email} already belongs to another account`);
  return { email, emailVerifiedAt: new Date().toISOString() };
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
      const marks = [
        a.id === store.defaultAccountId ? "default" : null,
        a.passwordHash ? "password" : "no password",
        a.role,
        a.status,
        a.email ? `${a.email}${a.emailVerifiedAt ? "" : " (unverified)"}` : "no email",
      ].filter(Boolean);
      console.log(`${a.id}\t${a.displayName}\t[${marks.join(", ")}]\t${provider}`);
    }
  },

  async add(store, { positional, flags }) {
    const id = positional[0];
    if (!id || !ID_PATTERN.test(id)) fail("id must match [a-z0-9][a-z0-9_-]{0,31}");
    if (store.accounts.some((a) => a.id === id)) fail(`account already exists: ${id}`);
    const name = flags.get("name")?.[0];
    if (typeof name !== "string" || !name.trim()) fail('--name "<display name>" is required');
    const role = flags.get("role")?.[0] ?? "admin";
    if (role !== "admin" && role !== "user") fail("--role must be admin or user");
    const account = withV2Fields({ id, displayName: name.trim().slice(0, 80), provider: null, createdAt: new Date().toISOString(), role });
    if (flags.has("email")) Object.assign(account, verifiedEmail(store, id, flags.get("email")[0]));
    if (flags.has("password-prompt")) account.passwordHash = await newPassword();
    store.accounts.push(account);
    writeStore(store);
    console.log(`added ${id}${account.passwordHash ? " (password set)" : " (no password; only the default account may be passwordless to be usable)"}`);
  },

  async "set-password"(store, { positional }) {
    const account = requireAccount(store, positional[0]);
    account.passwordHash = await newPassword();
    writeStore(store);
    const keys = revokeMcpKeys(account.id);
    console.log(`password set for ${account.id}; existing sessions are invalidated; ${keys} MCP key(s) revoked${keys ? " (create new ones for the agents)" : ""}`);
  },

  "set-email"(store, { positional }) {
    const account = requireAccount(store, positional[0]);
    Object.assign(account, verifiedEmail(store, account.id, positional[1]));
    delete account.emailChange;
    if (account.status === "pending") account.status = "active";
    writeStore(store);
    console.log(`email of ${account.id} is now ${account.email} (verified)`);
  },

  "set-role"(store, { positional }) {
    const account = requireAccount(store, positional[0]);
    const role = positional[1];
    if (role !== "admin" && role !== "user") fail("role must be admin or user");
    account.role = role;
    if (role === "admin" && account.storageQuotaBytes !== null && account.storageQuotaBytes !== undefined) account.storageQuotaBytes = null;
    writeStore(store);
    console.log(`${account.id} is now ${role}`);
  },

  "set-status"(store, { positional }) {
    const account = requireAccount(store, positional[0]);
    const status = positional[1];
    if (status !== "active" && status !== "disabled") fail("status must be active or disabled");
    account.status = status;
    writeStore(store);
    console.log(`${account.id} is now ${status}${status === "disabled" ? " (its sessions stop working at once)" : ""}`);
  },

  "set-network"(store, { positional }) {
    const account = requireAccount(store, positional[0]);
    const value = positional[1];
    if (value !== "private" && value !== "public") fail("network must be private (may reach loopback/LAN) or public");
    account.privateNetwork = value === "private";
    writeStore(store);
    const note = account.role === "admin" ? "" : " (has no effect until the account is an admin)";
    console.log(`${account.id}: provider requests ${value === "private" ? "may reach private addresses in public mode" : "are limited to public addresses in public mode"}${note}`);
  },

  "approve-provider"(store, { positional }) {
    const account = requireAccount(store, positional[0]);
    const value = positional[1];
    if (!value) fail("give the provider base URL to approve, or none");
    if (value === "none") {
      account.approvedProviderUrl = null;
      writeStore(store);
      console.log(`${account.id}: known model providers only`);
      return;
    }
    let url;
    try {
      url = new URL(value);
    } catch {
      fail("not a valid URL");
    }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) fail("baseUrl must be an http(s) URL without credentials, query or fragment");
    account.approvedProviderUrl = url.toString().replace(/\/+$/, "");
    writeStore(store);
    console.log(`${account.id}: may use ${account.approvedProviderUrl} as its model provider (public mode)`);
  },

  "approve-site"(store, { positional }) {
    const account = requireAccount(store, positional[0]);
    const value = positional[1];
    if (!value) fail("give the site URL to approve, or none");
    if (value === "none") {
      account.approvedSiteUrl = null;
      writeStore(store);
      console.log(`${account.id}: may audit GitHub-verified sites only`);
      return;
    }
    let url;
    try {
      url = new URL(value);
    } catch {
      fail("not a valid URL");
    }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) fail("the site must be an http(s) URL without credentials");
    account.approvedSiteUrl = url.origin;
    writeStore(store);
    console.log(`${account.id}: may audit ${account.approvedSiteUrl} (public mode)`);
  },

  async "set-github"(store, { positional, flags }) {
    const account = requireAccount(store, positional[0]);
    if (flags.has("clear")) {
      account.github = null;
      writeStore(store);
      console.log(`${account.id}: GitHub link removed`);
      return;
    }
    const login = positional[1];
    if (!login || !/^[A-Za-z0-9-]{1,39}$/.test(login)) fail("usage: set-github <id> <github-login> | set-github <id> --clear");
    // The stable numeric id is what sign-in matches (a login can be renamed); GitHub's public user API has it.
    let user;
    const given = flags.get("github-id")?.at(-1);
    if (given !== undefined) {
      if (!/^[1-9][0-9]{0,11}$/.test(String(given))) fail("--github-id must be GitHub's numeric user id");
      user = { id: Number(given), login };
    } else {
      const api = (process.env.KNIFE_GITHUB_API_URL?.trim() || "https://api.github.com").replace(/\/+$/, "");
      const token = process.env.GITHUB_TOKEN?.trim();
      const res = await fetch(`${api}/users/${login}`, { headers: { accept: "application/vnd.github+json", "user-agent": "smart-knife-accounts-cli", ...(token ? { authorization: `Bearer ${token}` } : {}) } });
      if (!res.ok) fail(`GitHub user ${login}: HTTP ${res.status}${res.status === 403 ? " (anonymous rate limit: set GITHUB_TOKEN or pass --github-id N, e.g. from `gh api users/" + login + " --jq .id`)" : ""}`);
      user = await res.json();
    }
    const other = store.accounts.find((a) => a.github?.id === user.id && a.id !== account.id);
    if (other) fail(`GitHub user ${user.login} is already linked to ${other.id}`);
    account.github = { id: user.id, login: user.login, linkedAt: new Date().toISOString() };
    writeStore(store);
    console.log(`${account.id} is linked to GitHub user ${user.login} (id ${user.id}): signing in with GitHub opens this account`);
  },

  "provider-json"(store, { positional }) {
    const account = requireAccount(store, positional[0]);
    process.stdout.write(`${JSON.stringify(account.provider ?? null)}\n`);
  },

  remove(store, { positional }) {
    const account = requireAccount(store, positional[0]);
    if (account.id === store.defaultAccountId) fail("refusing to remove the default account; run set-default first");
    store.accounts = store.accounts.filter((a) => a.id !== account.id);
    writeStore(store);
    const keys = revokeMcpKeys(account.id);
    console.log(`removed ${account.id}${keys ? `; ${keys} MCP key(s) revoked` : ""}`);
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
    const visionFlag = flags.get("vision")?.[0];
    if (flags.has("vision") && visionFlag !== "native" && visionFlag !== "none") fail("--vision takes native (the model sees images) or none (text only)");

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

    // Settings made in the app survive a CLI change (they used to be dropped): the reasoning effort and the vision helper
    // always, "Sees images" while the endpoint and model stay the same (it describes that model), --vision sets it.
    const previous = account.provider ?? null;
    const baseUrl = normalizeBaseUrl(baseUrlFlag);
    const sameModel = previous !== null && previous.baseUrl === baseUrl && previous.model === model.trim();
    const vision = visionFlag ?? (sameModel ? previous.vision : undefined);
    account.provider = {
      baseUrl,
      apiKey,
      model: model.trim(),
      ...(extraHeaders && Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {}),
      ...(previous?.reasoningEffort ? { reasoningEffort: previous.reasoningEffort } : {}),
      ...(vision ? { vision } : {}),
      ...(previous?.visionHelper ? { visionHelper: previous.visionHelper } : {}),
    };
    // `provider` is the active saved profile's config (src/lib/accounts/store.ts): keep that profile in step, or make one.
    const profiles = Array.isArray(account.providerProfiles) ? account.providerProfiles : [];
    const active = profiles.find((profile) => profile.id === account.activeProviderProfile);
    if (active) active.config = account.provider;
    else {
      if (profiles.length >= 20) fail(`${account.id} already has 20 saved provider profiles: delete one in the app first`);
      const id = randomBytes(6).toString("hex");
      account.providerProfiles = [...profiles, { id, name: "Default", config: account.provider }];
      account.activeProviderProfile = id;
    }
    writeStore(store);
    console.log(`provider saved for ${account.id}: ${account.provider.baseUrl} model=${account.provider.model} key=${keyHint(apiKey)}`);
  },
};

const [command, ...rest] = process.argv.slice(2);
if (!command || command === "help" || command === "--help" || !(command in commands)) {
  console.error(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).slice(0, 24).map((l) => l.slice(3)).join("\n"));
  process.exit(command && command !== "help" && command !== "--help" ? 2 : 0);
}
await commands[command](readStore(), parseArgs(rest));
