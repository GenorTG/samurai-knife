// GitHub App (src/lib/github-app, docs/GITHUB.md) against tests/mock_github_app.mjs, public mode: the manifest flow
// (one-time state per admin, credentials saved 0600), the app JWT, OAuth with PKCE and a browser-bound one-time state,
// sign-in/registration rules (new user, returning user, email collision, no verified email, disabled), linking,
// installation tokens scoped to one repository, and the website studio on an installation (no token stored; another
// user's installation refused).
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/github_app.test.mjs
import assert from "node:assert/strict";
import { createPublicKey, createVerify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAppWorld, serveApi, serveWeb } from "./mock_github_app.mjs";
import { REPO } from "./mock_site_world.mjs";

const dir = mkdtempSync(join(tmpdir(), "knife-ghapp-"));
process.env.KNIFE_DATA_DIR = join(dir, "data");
process.env.KNIFE_AUTH_MODE = "public";
process.env.KNIFE_HOST = "127.0.0.1";
process.env.KNIFE_GITHUB_APP_FILE = join(dir, "ops", "github-app.json");
const world = createAppWorld();
const api = await serveApi(world);
const web = await serveWeb(world);
process.env.KNIFE_GITHUB_API_URL = `http://127.0.0.1:${api.port}`;
process.env.KNIFE_GITHUB_WEB_URL = `http://127.0.0.1:${web.port}`;
test.after(() => {
  api.server.close();
  web.server.close();
  rmSync(dir, { recursive: true, force: true });
});

const accounts = await import("../src/lib/accounts/store.ts");
const config = await import("../src/lib/github-app/config.ts");
const manifest = await import("../src/lib/github-app/manifest.ts");
const oauth = await import("../src/lib/github-app/oauth.ts");
const gaccounts = await import("../src/lib/github-app/accounts.ts");
const installations = await import("../src/lib/github-app/installations.ts");
const service = await import("../src/lib/site/service.ts");
const siteStore = await import("../src/lib/site/store.ts");

const BASE = "http://127.0.0.1:3999";
accounts.mutateStore((s) => {
  s.accounts.push(accounts.newAccountRecord({ id: "owner", displayName: "Owner", role: "admin", status: "active", email: "owner@example.test", emailVerifiedAt: new Date().toISOString(), passwordHash: "x" }));
  s.accounts.push(accounts.newAccountRecord({ id: "bob", displayName: "Bob", role: "user", status: "active", email: "bob@example.test", emailVerifiedAt: new Date().toISOString(), passwordHash: "x" }));
  s.defaultAccountId = "owner";
});

/** What a browser does: follow GitHub's redirect and read the parameters it brings back. */
function redirectParams(response) {
  assert.equal(response[0], 302, String(response[1]));
  return new URL(response[1]).searchParams;
}

test("manifest: permissions and callback URLs; state is one-time and bound to the admin", () => {
  process.env.KNIFE_GITHUB_EXTRA_BASES = "http://100.64.0.7:3210, https://knife.example.org";
  const built = manifest.buildManifest(BASE, "owner", { name: "Knife Test" });
  assert.deepEqual(built.manifest.default_permissions, { contents: "write", pull_requests: "write", metadata: "read", statuses: "read", deployments: "read", checks: "read", email_addresses: "read" });
  assert.deepEqual(built.manifest.callback_urls, [`${BASE}/api/github/callback`, "http://100.64.0.7:3210/api/github/callback", "https://knife.example.org/api/github/callback"]);
  assert.equal(built.manifest.hook_attributes.active, false);
  assert.equal(built.manifest.setup_url, `${BASE}/api/github/setup`);
  assert.ok(built.postUrl.startsWith(`http://127.0.0.1:${web.port}/settings/apps/new?state=`));
  assert.equal(manifest.takeManifestState(built.state, "bob"), false, "another account cannot finish it");
  assert.equal(manifest.takeManifestState(built.state, "owner"), false, "and the state is gone after one try");
  delete process.env.KNIFE_GITHUB_EXTRA_BASES;
});

test("manifest flow end to end: GitHub's code becomes the saved app (0600); the app JWT verifies", async () => {
  const built = manifest.buildManifest(BASE, "owner", { name: "Knife Test" });
  const back = redirectParams(world.web("POST", new URL(built.postUrl), `manifest=${encodeURIComponent(JSON.stringify(built.manifest))}`));
  assert.equal(back.get("state"), built.state);
  assert.equal(manifest.takeManifestState(back.get("state"), "owner"), true);
  const app = await manifest.exchangeManifestCode(back.get("code"));
  assert.equal(app.slug, "knife-test");
  assert.equal(statSync(process.env.KNIFE_GITHUB_APP_FILE).mode & 0o777, 0o600);
  assert.equal(config.appStatus().configured, true);
  assert.equal(config.appStatus().installUrl, `http://127.0.0.1:${web.port}/apps/knife-test/installations/new`);
  const jwt = config.appJwt(app);
  const [h, p, sig] = jwt.split(".");
  const v = createVerify("RSA-SHA256");
  v.update(`${h}.${p}`);
  assert.ok(v.verify(createPublicKey(app.pem), Buffer.from(sig, "base64url")));
  const payload = JSON.parse(Buffer.from(p, "base64url").toString());
  assert.equal(payload.iss, app.clientId);
  assert.equal(payload.exp - payload.iat, 600);
  await assert.rejects(manifest.exchangeManifestCode(back.get("code")), /refused/, "a code works once");
});

async function oauthAs(user, flow) {
  await fetch(`http://127.0.0.1:${web.port}/__mock/user`, { method: "POST", body: JSON.stringify({ login: user }) });
  const app = config.loadApp();
  const redirectUri = `${BASE}/api/github/callback`;
  const { state, challenge } = oauth.beginFlow({ redirectUri, returnTo: "/", ...flow });
  const back = redirectParams(world.web("GET", new URL(oauth.authorizeUrl(app, redirectUri, state, challenge)), ""));
  const pending = oauth.takeFlow(back.get("state"), state);
  assert.ok(pending, "the state comes back once, in the same browser");
  const token = await oauth.exchangeCode(app, back.get("code"), pending);
  return { token, who: await oauth.identity(token) };
}

test("OAuth state: one-time, must come back in the same browser (cookie)", () => {
  const { state } = oauth.beginFlow({ purpose: "login", accountId: null, redirectUri: "x", returnTo: "/" });
  assert.equal(oauth.takeFlow(state, "other-browser"), null, "a callback opened in another browser is refused");
  assert.equal(oauth.takeFlow(state, state), null, "and the state is burnt");
  assert.equal(oauth.takeFlow("made-up", "made-up"), null);
  assert.equal(oauth.safeReturnTo("//evil.example"), "/");
  assert.equal(oauth.safeReturnTo("https://evil.example"), "/");
  assert.equal(oauth.safeReturnTo("/tools/site-studio?tab=connect"), "/tools/site-studio?tab=connect");
});

test("PKCE: a wrong verifier is refused by GitHub", async () => {
  const app = config.loadApp();
  const redirectUri = `${BASE}/api/github/callback`;
  const { state, challenge } = oauth.beginFlow({ purpose: "login", accountId: null, redirectUri, returnTo: "/" });
  const back = redirectParams(world.web("GET", new URL(oauth.authorizeUrl(app, redirectUri, state, challenge)), ""));
  const pending = oauth.takeFlow(back.get("state"), state);
  await assert.rejects(oauth.exchangeCode(app, back.get("code"), { ...pending, verifier: "forged" }), /PKCE|did not accept/);
});

test("sign-in: a new GitHub user registers (verified email, user role, no password); signing in again logs in", async () => {
  const { who } = await oauthAs("alice", { purpose: "login", accountId: null });
  assert.deepEqual({ login: who.login, email: who.verifiedEmail }, { login: "alice", email: "alice@example.test" });
  const first = gaccounts.signInWithGithub(who, "203.0.113.5", true);
  assert.equal(first.kind, "registered");
  assert.deepEqual({ id: first.account.id, role: first.account.role, status: first.account.status, pw: first.account.passwordHash, gh: first.account.github.id }, { id: "alice", role: "user", status: "active", pw: undefined, gh: 1001 });
  assert.ok(first.account.emailVerifiedAt);
  const again = gaccounts.signInWithGithub(who, "203.0.113.5", true);
  assert.equal(again.kind, "login");
  assert.equal(again.account.id, "alice");
});

test("sign-in never takes over an account by email; no verified email and disabled accounts are refused", async () => {
  const bob = await oauthAs("bob", { purpose: "login", accountId: null });
  const r = gaccounts.signInWithGithub(bob.who, "203.0.113.6", true);
  assert.equal(r.kind, "refused");
  assert.equal(r.code, "email_in_use");
  assert.equal(accounts.getAccount("bob").github, null, "the existing account stays unlinked");
  const ghost = await oauthAs("noemail", { purpose: "login", accountId: null });
  assert.equal(gaccounts.signInWithGithub(ghost.who, "203.0.113.7", true).code, "no_email");
  accounts.mutateStore((s) => {
    s.accounts.find((a) => a.id === "alice").status = "disabled";
  });
  const alice = await oauthAs("alice", { purpose: "login", accountId: null });
  assert.equal(gaccounts.signInWithGithub(alice.who, "203.0.113.5", true).code, "disabled");
  accounts.mutateStore((s) => {
    s.accounts.find((a) => a.id === "alice").status = "active";
  });
});

test("linking: bob links GitHub while signed in; one GitHub user per account; a GitHub-only account cannot unlink", async () => {
  const bobgh = await oauthAs("bob", { purpose: "link", accountId: "bob" });
  assert.deepEqual(gaccounts.linkGithub("bob", bobgh.who), { ok: true });
  assert.equal(accounts.getAccount("bob").github.login, "bobgh");
  const alice = await oauthAs("alice", { purpose: "link", accountId: "bob" });
  assert.equal(gaccounts.linkGithub("bob", alice.who).code, "github_taken", "alice's GitHub user belongs to the alice account");
  assert.equal(gaccounts.unlinkGithub("alice").ok, false, "alice has no password: unlinking would lock her out");
  assert.equal(gaccounts.unlinkGithub("bob").ok, true);
  assert.equal(gaccounts.usernameFor("Owner", (id) => id === "owner"), "owner-2");
  assert.equal(gaccounts.usernameFor("admin", () => false), "admin-2", "reserved names are skipped");
});

test("installation tokens: minted with the app JWT, scoped to one repository, cached", async () => {
  installations.clearInstallationTokens();
  const before = world.state.minted.length;
  const t1 = await installations.installationToken(7, REPO);
  const t2 = await installations.installationToken(7, REPO);
  assert.equal(t1, t2, "cached until close to expiry");
  assert.equal(world.state.minted.length, before + 1);
  assert.deepEqual(world.state.minted.at(-1), { installation: 7, repositories: ["website"] });
  assert.deepEqual((await installations.installationRepos(7)).map((r) => r.fullName), [REPO]);
  await assert.rejects(installations.installationToken(8, REPO), /no longer installed/);
});

test("website studio on an installation: only installations proven by the user's GitHub sign-in; no token stored", async () => {
  // Mallory claims installation 7 (e.g. by typing it into the setup URL): her sign-in lists none, so nothing is linked.
  await oauthAs("mallory", { purpose: "login", accountId: null }).then(({ who }) => gaccounts.signInWithGithub(who, "203.0.113.9", true));
  const mal = await oauthAs("mallory", { purpose: "link", accountId: "mallory" });
  service.linkInstallations("mallory", mal.who.login, await oauth.userInstallations(mal.token));
  await assert.rejects(service.connect("mallory", { repo: REPO, tokenSource: "app", installationId: 7, productionUrl: "" }), /not linked to your account/);
  // Alice can reach installation 7: linked, connected, and the stored connection holds no secret.
  const al = await oauthAs("alice", { purpose: "link", accountId: "alice" });
  const insts = await oauth.userInstallations(al.token);
  assert.deepEqual(insts, [{ id: 7, account: "genor", accountType: "User" }]);
  service.linkInstallations("alice", al.who.login, insts);
  const repos = await service.appRepositories("alice");
  assert.deepEqual(repos.installations[0].repos.map((r) => r.fullName), [REPO]);
  await assert.rejects(service.connect("alice", { repo: "genor/other", tokenSource: "app", installationId: 7 }), /not installed on genor\/other/);
  const { view, warning } = await service.connect("alice", { repo: REPO, tokenSource: "app", installationId: 7 });
  assert.equal(warning, "");
  assert.deepEqual({ source: view.connection.token.source, login: view.connection.token.login, inst: view.connection.token.installationId }, { source: "app", login: "alice", inst: 7 });
  const raw = JSON.stringify(siteStore.loadSite("alice").connection);
  assert.ok(!/ghs_|ghu_|ghp_/.test(raw), "no token of any kind is stored");
  const status = await service.status("alice");
  assert.equal(status.repo.canPush, true, "the app's own contents:write");
  const w = await service.replaceText("alice", "lib/site-data.ts", '["Samurai Knife"]', '["Samurai Knife", "Alice"]', "Add Alice");
  assert.match(w.branch, /^knife\//);
  assert.match(world.gh.fileAt(w.branch, "lib/site-data.ts"), /Alice/);
  assert.equal(readFileSync(process.env.KNIFE_GITHUB_APP_FILE, "utf8").includes("PRIVATE KEY"), true, "the app key lives only in the app file");
});
