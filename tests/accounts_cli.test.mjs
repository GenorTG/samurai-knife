import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Drives scripts/accounts.mjs for real against a throwaway KNIFE_DATA_DIR. Fake keys only.
const dir = mkdtempSync(join(tmpdir(), "knife-accounts-"));
const run = (args, input = "") => spawnSync(process.execPath, ["scripts/accounts.mjs", ...args], { env: { ...process.env, KNIFE_DATA_DIR: dir }, input, encoding: "utf8" });
const accounts = () => JSON.parse(readFileSync(join(dir, "accounts.json"), "utf8")).accounts;
const FAKE = "fake-gateway-token-0123456789abcdef";
/** The provider as the app sees it: keys are sealed on disk, `provider-json` opens them. */
const opened = (id) => JSON.parse(run(["provider-json", id]).stdout);

test("add a password-protected account (profile) for the gateway", () => {
  const r = run(["add", "openclaw", "--name", "OpenClaw gateway", "--password-prompt"], "longenough1\n");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(accounts().some((a) => a.id === "openclaw" && a.passwordHash));
});

test("the openclaw-gateway preset needs an explicit agent and refuses the main agent", () => {
  let r = run(["set-provider", "openclaw", "--preset", "openclaw-gateway", "--key-stdin"], FAKE);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--agent openclaw\/<agentId> is required/);
  for (const main of ["openclaw", "openclaw/default", "openclaw/main", "agent:main"]) {
    r = run(["set-provider", "openclaw", "--preset", "openclaw-gateway", "--agent", main, "--key-stdin"], FAKE);
    assert.notEqual(r.status, 0, main);
    assert.match(r.stderr, /refusing agent target/);
  }
  assert.equal(accounts().find((a) => a.id === "openclaw").provider, null, "nothing was saved by the refused attempts");
  r = run(["set-provider", "openclaw", "--preset", "openclaw-gateway", "--agent", "openclaw/main", "--allow-main", "--key-stdin"], FAKE);
  assert.equal(r.status, 0, r.stderr);
});

test("preset with a restricted agent: URL, model, header, hidden prompt key, 0600 file, key never printed", () => {
  const r = run(["set-provider", "openclaw", "--preset", "openclaw-gateway", "--agent", "openclaw/knife-test", "--backend-model", "anthropic/claude-sonnet-5-5", "--key-prompt"], `${FAKE}\n`);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes(FAKE) && !r.stderr.includes(FAKE), "the key must never be printed");
  assert.match(r.stdout, /key=…cdef/);
  const provider = opened("openclaw");
  assert.deepEqual([provider.baseUrl, provider.model, provider.apiKey], ["http://127.0.0.1:18789/v1", "openclaw/knife-test", FAKE]);
  assert.deepEqual(provider.extraHeaders, { "x-openclaw-model": "anthropic/claude-sonnet-5-5" });
  assert.equal(statSync(join(dir, "accounts.json")).mode & 0o777, 0o600);
  const raw = readFileSync(join(dir, "accounts.json"), "utf8");
  assert.ok(!raw.includes(FAKE) && !raw.includes("anthropic/claude-sonnet-5-5"), "key and header values are sealed on disk");
  assert.match(accounts().find((a) => a.id === "openclaw").provider.apiKey, /^enc:v1:/);
  assert.equal(statSync(join(dir, "provider-keys.key")).mode & 0o777, 0o600);
  const listed = run(["list"]).stdout;
  assert.ok(!listed.includes(FAKE), "list shows only a key hint");
  assert.match(listed, /openclaw\tOpenClaw gateway.*http:\/\/127\.0\.0\.1:18789\/v1 model=openclaw\/knife-test key=…cdef/);
});

test("a preset replaces the old headers instead of inheriting them; flags that need the preset are rejected without it", () => {
  let r = run(["set-provider", "openclaw", "--preset", "openclaw-gateway", "--agent", "openclaw/knife-test", "--gateway-url", "http://127.0.0.1:18789/v1"]);
  assert.equal(r.status, 0, r.stderr);
  const provider = opened("openclaw");
  assert.equal(provider.extraHeaders, undefined, "stale x-openclaw-model must not survive");
  assert.equal(provider.apiKey, FAKE, "no key flag keeps the stored key");
  r = run(["set-provider", "openclaw", "--base-url", "https://example.com/v1", "--model", "m", "--agent", "openclaw/x"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /only apply with --preset/);
  r = run(["set-provider", "openclaw", "--preset", "nope"]);
  assert.match(r.stderr, /unknown --preset/);
  r = run(["set-provider", "openclaw", "--preset", "openclaw-gateway", "--agent", "openclaw/knife-test", "--base-url", "http://x/v1"]);
  assert.match(r.stderr, /drop --base-url\/--model/);
});

test("argv keys are still impossible and only one key source is allowed", () => {
  let r = run(["set-provider", "openclaw", "--base-url", "http://a/v1", "--model", "m", "--key", "secret"]);
  assert.match(r.stderr, /unknown option --key/);
  r = run(["set-provider", "openclaw", "--base-url", "http://a/v1", "--model", "m", "--key-prompt", "--key-stdin"], "x\n");
  assert.match(r.stderr, /use only one of/);
  r = run(["set-provider", "openclaw", "--base-url", "http://a/v1", "--model", "m", "--key-prompt"], "\n");
  assert.match(r.stderr, /no key entered/);
});

test("set-password revokes the account's MCP keys (like the web reset) and says so; other accounts keep theirs", () => {
  const key = (id, accountId) => ({ id, accountId, name: "agent", hash: "0".repeat(64), hint: "skm_abcd…", createdAt: "2026-10-18T00:00:00.000Z", lastUsedAt: null });
  const keysFile = join(dir, "mcp-keys.json");
  writeFileSync(keysFile, JSON.stringify({ version: 1, keys: [key("mk_1", "openclaw"), key("mk_2", "openclaw"), key("mk_3", "someone-else")] }), { mode: 0o600 });
  const r = run(["set-password", "openclaw"], "anotherlongone2\nanotherlongone2\n");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 MCP key\(s\) revoked/);
  const left = JSON.parse(readFileSync(keysFile, "utf8")).keys;
  assert.deepEqual(left.map((k) => k.id), ["mk_3"]);
  assert.equal(statSync(keysFile).mode & 0o777, 0o600);
  const again = run(["set-password", "openclaw"], "anotherlongone3\nanotherlongone3\n");
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /0 MCP key\(s\) revoked/);
});

test("set-provider keeps the app's vision, helper and reasoning settings; --vision sets it", () => {
  assert.equal(run(["add", "visioner", "--name", "Visioner"]).status, 0);
  let r = run(["set-provider", "visioner", "--base-url", "https://api.example.test/v1", "--model", "m-1", "--vision", "native", "--key-stdin"], FAKE);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(opened("visioner").vision, "native");
  // Settings the app saved (reasoning effort, helper) survive a CLI change; "Sees images" stays for the same model.
  const file = join(dir, "accounts.json");
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const account = raw.accounts.find((a) => a.id === "visioner");
  account.provider.reasoningEffort = "high";
  account.provider.visionHelper = "abc123";
  writeFileSync(file, JSON.stringify(raw));
  r = run(["set-provider", "visioner", "--base-url", "https://api.example.test/v1/", "--model", "m-1"]);
  assert.equal(r.status, 0, r.stderr);
  let provider = opened("visioner");
  assert.deepEqual([provider.vision, provider.visionHelper, provider.reasoningEffort], ["native", "abc123", "high"]);
  const profiles = accounts().find((a) => a.id === "visioner").providerProfiles;
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].config.vision, "native", "the active profile mirrors the provider");
  // Another model: "Sees images" described the old one, so it is not carried over.
  r = run(["set-provider", "visioner", "--base-url", "https://api.example.test/v1", "--model", "m-2"]);
  assert.equal(r.status, 0, r.stderr);
  provider = opened("visioner");
  assert.equal(provider.vision, undefined);
  assert.equal(provider.visionHelper, "abc123");
  r = run(["set-provider", "visioner", "--base-url", "https://api.example.test/v1", "--model", "m-2", "--vision", "maybe"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--vision takes native/);
});
