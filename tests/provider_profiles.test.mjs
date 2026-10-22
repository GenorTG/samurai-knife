// Saved provider profiles (src/lib/accounts/store.ts): several named endpoint/key/model sets per account, the active
// one mirrored into `provider` (what the assistant and every older caller read). Legacy single provider = "Default";
// create/update/activate/duplicate/delete keep provider and profiles in agreement; keys sealed per profile at rest;
// the public view carries hints only.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/provider_profiles.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "knife-profiles-"));
process.env.KNIFE_DATA_DIR = dataDir;
delete process.env.KNIFE_AUTH_MODE;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const store = await import("../src/lib/accounts/store.ts");
const box = await import("../src/lib/accounts/secret-box.ts");

const KEY_A = "sk-profile-a-0123456789abcdef";
const KEY_B = "sk-profile-b-fedcba9876543210";
const cfg = (key, model = "m-1", extra = {}) => ({ baseUrl: "https://api.example.test/v1", apiKey: key, model, ...extra });

test("an account with a provider from before profiles shows it as the active Default profile", () => {
  store.mutateStore((s) => {
    s.accounts.push(store.newAccountRecord({ id: "legacy", displayName: "Legacy", provider: cfg(KEY_A) }));
  });
  const account = store.getAccount("legacy");
  assert.deepEqual(store.providerProfilesOf(account).map((p) => [p.id, p.name]), [["default", "Default"]]);
  assert.equal(store.activeProfileIdOf(account), "default");
  const pub = store.toPublicAccount(account);
  assert.deepEqual(pub.providerProfiles.map((p) => [p.id, p.name, p.active, p.model]), [["default", "Default", true, "m-1"]]);
  assert.ok(!JSON.stringify(pub).includes(KEY_A), "no key in the public view");
});

test("create / activate / update / duplicate / delete keep `provider` = the active profile", () => {
  store.mutateStore((s) => {
    s.accounts.push(store.newAccountRecord({ id: "ana", displayName: "Ana" }));
  });
  // The first provider saved through the old route becomes the profile "Default".
  store.setProvider("ana", cfg(KEY_A));
  let account = store.getAccount("ana");
  assert.equal(account.providerProfiles.length, 1);
  assert.equal(account.providerProfiles[0].name, "Default");
  const def = account.activeProviderProfile;

  const created = store.saveProviderProfile("ana", { name: "Local LM", config: cfg(KEY_B, "local-model") });
  account = created.account;
  assert.equal(account.provider.model, "m-1", "a new profile is not active unless asked");
  assert.equal(account.providerProfiles.length, 2);

  account = store.activateProviderProfile("ana", created.profileId);
  assert.equal(account.provider.model, "local-model");
  assert.equal(account.provider.apiKey, KEY_B);

  // Editing the active provider through the old route edits the active profile.
  store.setProvider("ana", cfg(KEY_B, "local-model-2"));
  account = store.getAccount("ana");
  assert.equal(store.providerProfileConfig(account, created.profileId).model, "local-model-2");
  assert.equal(store.providerProfileConfig(account, def).model, "m-1", "the other profile is untouched");

  const copy = store.saveProviderProfile("ana", { name: "Copy", config: store.providerProfileConfig(account, def) });
  assert.equal(store.providerProfileConfig(copy.account, copy.profileId).apiKey, KEY_A);

  // Deleting the active profile activates the next one.
  account = store.deleteProviderProfile("ana", created.profileId);
  assert.equal(account.activeProviderProfile, def);
  assert.equal(account.provider.model, "m-1");
  assert.throws(() => store.activateProviderProfile("ana", "nope"), /Unknown profile/);
  account = store.deleteProviderProfile("ana", def);
  account = store.deleteProviderProfile("ana", copy.profileId);
  assert.equal(account.provider, null);
  assert.equal(account.activeProviderProfile, null);
});

test("at rest every profile's key and headers are sealed, bound to that profile", () => {
  store.mutateStore((s) => {
    s.accounts.push(store.newAccountRecord({ id: "seal", displayName: "Seal" }));
  });
  const saved = store.saveProviderProfile("seal", { name: "With header", config: cfg(KEY_A, "m", { extraHeaders: { "X-Secret": "header-secret-value" } }), activate: true });
  store.saveProviderProfile("seal", { name: "Second", config: cfg(KEY_B) });
  const raw = readFileSync(join(dataDir, "accounts.json"), "utf8");
  for (const secret of [KEY_A, KEY_B, "header-secret-value"]) assert.ok(!raw.includes(secret), `${secret} is not in accounts.json`);
  // A sealed key moved from one profile to another does not open (the AAD names the profile).
  const parsed = JSON.parse(raw);
  const seal = parsed.accounts.find((a) => a.id === "seal");
  const [one, two] = seal.providerProfiles;
  assert.notEqual(one.config.apiKey, two.config.apiKey);
  two.config.apiKey = one.config.apiKey;
  writeFileSync(join(dataDir, "accounts.json"), JSON.stringify(parsed));
  assert.throws(() => store.readStore(), /does not decrypt/);
  // Put it back (re-seal from the good copy) for the other tests.
  two.config.apiKey = box.seal(box.readKey(dataDir), KEY_B, box.secretContext("seal", "apiKey", two.id));
  writeFileSync(join(dataDir, "accounts.json"), JSON.stringify(parsed));
  assert.equal(store.providerProfileConfig(store.getAccount("seal"), saved.profileId).apiKey, KEY_A);
});

test("at most MAX_PROVIDER_PROFILES profiles", () => {
  store.mutateStore((s) => {
    s.accounts.push(store.newAccountRecord({ id: "many", displayName: "Many" }));
  });
  for (let i = 0; i < store.MAX_PROVIDER_PROFILES; i += 1) store.saveProviderProfile("many", { name: `P${i}`, config: cfg(`k-${i}`) });
  assert.throws(() => store.saveProviderProfile("many", { name: "one too many", config: cfg("x") }), /At most/);
});

test("the accounts CLI keeps the active profile in step and leaves the others readable", async () => {
  const { spawnSync } = await import("node:child_process");
  const cli = (args, input) =>
    spawnSync(process.execPath, ["scripts/accounts.mjs", ...args], { env: { ...process.env, KNIFE_DATA_DIR: dataDir }, input, encoding: "utf8" });
  store.mutateStore((s) => {
    s.accounts.push(store.newAccountRecord({ id: "cli", displayName: "Cli" }));
  });
  const first = store.saveProviderProfile("cli", { name: "One", config: cfg(KEY_A, "m-one"), activate: true }).profileId;
  const second = store.saveProviderProfile("cli", { name: "Two", config: cfg(KEY_B, "m-two"), activate: true }).profileId;
  const r = cli(["set-provider", "cli", "--base-url", "https://api.example.test/v1", "--model", "m-cli", "--key-stdin"], "sk-from-the-cli-000111\n");
  assert.equal(r.status, 0, r.stderr);
  const account = store.getAccount("cli");
  assert.equal(account.activeProviderProfile, second);
  assert.equal(account.provider.model, "m-cli");
  assert.equal(store.providerProfileConfig(account, second).apiKey, "sk-from-the-cli-000111");
  assert.equal(store.providerProfileConfig(account, first).apiKey, KEY_A, "the other profile still opens");
  assert.ok(!readFileSync(join(dataDir, "accounts.json"), "utf8").includes("sk-from-the-cli"), "sealed on disk");

  // An account without profiles gets a "Default" one.
  store.mutateStore((s) => {
    s.accounts.push(store.newAccountRecord({ id: "cli2", displayName: "Cli two" }));
  });
  assert.equal(cli(["set-provider", "cli2", "--base-url", "https://api.example.test/v1", "--model", "m-x", "--key-stdin"], "sk-cli-two-000222\n").status, 0);
  const two = store.getAccount("cli2");
  assert.deepEqual(store.providerProfilesOf(two).map((p) => [p.name, p.config.model]), [["Default", "m-x"]]);
  assert.equal(two.activeProviderProfile, two.providerProfiles[0].id);
});
