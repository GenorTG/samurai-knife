import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
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
