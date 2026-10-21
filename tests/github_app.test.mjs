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
import { PRIVATE_REPO } from "./mock_github_app.mjs";
import { REPO } from "./mock_site_world.mjs";

const dir = mkdtempSync(join(tmpdir(), "knife-ghapp-"));
process.env.KNIFE_DATA_DIR = join(dir, "data");
process.env.KNIFE_AUTH_MODE = "public";
process.env.KNIFE_EMAIL_POLICY = "enforce"; // GitHub's verified address uses the same static/list policy; GitHub itself verified delivery
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
process.env.KNIFE_PUBLIC_URL = BASE;
accounts.mutateStore((s) => {
  s.accounts.push(accounts.newAccountRecord({ id: "owner", displayName: "Owner", role: "admin", status: "active", email: "owner@example.test", emailVerifiedAt: new Date().toISOString(), passwordHash: "x" }));
  s.accounts.push(accounts.newAccountRecord({ id: "bob", displayName: "Bob", role: "user", status: "active", email: "bob@example.org", emailVerifiedAt: new Date().toISOString(), passwordHash: "x" }));
  s.defaultAccountId = "owner";
});

/** What a browser does: follow GitHub's redirect and read the parameters it brings back. */
function redirectParams(response) {
  assert.equal(response[0], 302, String(response[1]));
  return new URL(response[1]).searchParams;
}

test("manifest: permissions and callback URLs; state is one-time and bound to the admin", () => {
  assert.deepEqual(manifest.callbackBases(), [BASE], "by default only the public URL is registered");
  delete process.env.KNIFE_PUBLIC_URL;
  assert.throws(() => manifest.buildManifest("owner"), /KNIFE_PUBLIC_URL/, "no public URL, no app");
  process.env.KNIFE_PUBLIC_URL = `${BASE}/some/path`;
  process.env.KNIFE_GITHUB_EXTRA_BASES = "http://100.64.0.7:3210, https://knife.example.org";
  const built = manifest.buildManifest("owner", { name: "Knife Test" });
  assert.deepEqual(built.manifest.default_permissions, { contents: "write", pull_requests: "write", metadata: "read", statuses: "read", deployments: "read", checks: "read", pages: "read", emails: "read" });
  assert.deepEqual(built.manifest.callback_urls, [`${BASE}/api/github/callback`, "http://100.64.0.7:3210/api/github/callback", "https://knife.example.org/api/github/callback"]);
  assert.equal(built.manifest.hook_attributes.active, false);
  assert.equal(built.manifest.setup_url, `${BASE}/api/github/setup`);
  assert.ok(built.postUrl.startsWith(`http://127.0.0.1:${web.port}/settings/apps/new?state=`));
  assert.equal(manifest.takeManifestState(built.state, "bob"), false, "another account cannot finish it");
  assert.equal(manifest.takeManifestState(built.state, "owner"), false, "and the state is gone after one try");
  assert.equal(built.manifest.redirect_url, `${BASE}/api/github/app-created`, "the public origin, not the path");
  delete process.env.KNIFE_GITHUB_EXTRA_BASES;
  process.env.KNIFE_PUBLIC_URL = BASE;
});

test("manifest flow end to end: GitHub's code becomes the saved app (0600); the app JWT verifies", async () => {
  const built = manifest.buildManifest("owner", { name: "Knife Test" });
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
  const { state, challenge, cookie } = oauth.beginFlow({ redirectUri, returnTo: "/", ...flow });
  const back = redirectParams(world.web("GET", new URL(oauth.authorizeUrl(app, redirectUri, state, challenge)), ""));
  const pending = oauth.takeFlow(back.get("state"), cookie);
  assert.ok(pending, "the state comes back once, in the same browser");
  const token = await oauth.exchangeCode(app, back.get("code"), pending);
  return { token, who: await oauth.identity(token) };
}

test("OAuth state: one-time, must come back in the same browser (sealed cookie, nothing kept per started flow)", () => {
  const a = oauth.beginFlow({ purpose: "login", accountId: null, redirectUri: "x", returnTo: "/" });
  const b = oauth.beginFlow({ purpose: "link", accountId: "bob", redirectUri: "x", returnTo: "/account" });
  assert.equal(oauth.takeFlow(a.state, undefined), null, "a callback opened in another browser (no cookie) is refused");
  assert.equal(oauth.takeFlow(a.state, b.cookie), null, "another flow's cookie does not carry this state");
  assert.equal(oauth.takeFlow(a.state, a.state), null, "the bare state is not a cookie");
  const parts = a.cookie.split(".");
  const flipped = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -2)}${parts[2].endsWith("AA") ? "BB" : "AA"}`;
  assert.equal(oauth.takeFlow(a.state, flipped), null, "a tampered cookie does not open");
  assert.ok(!a.cookie.includes("login") && !Buffer.from(parts[2], "base64url").toString("utf8").includes("verifier"), "the PKCE verifier and purpose are sealed, not readable");
  const flow = oauth.takeFlow(a.state, a.cookie);
  assert.equal(flow?.purpose, "login");
  assert.equal(oauth.takeFlow(a.state, a.cookie), null, "and the state is burnt: the same cookie works once");
  assert.equal(oauth.takeFlow("made-up", "made-up"), null);
  const old = oauth.beginFlow({ purpose: "login", accountId: null, redirectUri: "x", returnTo: "/" });
  assert.equal(oauth.takeFlow(old.state, old.cookie, Date.now() + 11 * 60_000), null, "older than 10 minutes");
  const evil = oauth.beginFlow({ purpose: "login", accountId: null, redirectUri: "x", returnTo: "/\t/evil.example" });
  assert.equal(oauth.takeFlow(evil.state, evil.cookie)?.returnTo, "/", "the return path is re-checked");
  assert.equal(oauth.safeReturnTo("//evil.example"), "/");
  assert.equal(oauth.safeReturnTo("https://evil.example"), "/");
  assert.equal(oauth.safeReturnTo("/\t/evil.example"), "/", "audit M1: a tab that browsers strip");
  assert.equal(oauth.safeReturnTo("/tools/site-studio?tab=connect"), "/tools/site-studio?tab=connect");
});

test("OAuth: the consumed-state set is bounded and refuses instead of forgetting a live state", () => {
  const key = Symbol.for("samurai-knife.github-consumed-states.v1");
  const used = globalThis[key];
  assert.ok(used instanceof Map);
  const saved = new Map(used);
  try {
    const later = Date.now() + 60 * 60_000;
    for (let i = used.size; i < 10_000; i += 1) used.set(`filler-${i}`, later);
    const f = oauth.beginFlow({ purpose: "login", accountId: null, redirectUri: "x", returnTo: "/" });
    assert.equal(oauth.takeFlow(f.state, f.cookie), null, "full with live entries: refused (fail closed)");
    for (const k of [...used.keys()].filter((k) => k.startsWith("filler-")).slice(0, 10)) used.set(k, Date.now() - 1);
    assert.ok(oauth.takeFlow(f.state, f.cookie), "expired entries make room again");
  } finally {
    used.clear();
    for (const [k, v] of saved) used.set(k, v);
  }
});

test("PKCE: a wrong verifier is refused by GitHub", async () => {
  const app = config.loadApp();
  const redirectUri = `${BASE}/api/github/callback`;
  const { state, challenge, cookie } = oauth.beginFlow({ purpose: "login", accountId: null, redirectUri, returnTo: "/" });
  const back = redirectParams(world.web("GET", new URL(oauth.authorizeUrl(app, redirectUri, state, challenge)), ""));
  const pending = oauth.takeFlow(back.get("state"), cookie);
  await assert.rejects(oauth.exchangeCode(app, back.get("code"), { ...pending, verifier: "forged" }), /PKCE|did not accept/);
});

test("sign-in: a new GitHub user registers (verified email, user role, no password); signing in again logs in", async () => {
  const { who } = await oauthAs("alice", { purpose: "login", accountId: null });
  assert.deepEqual({ login: who.login, email: who.verifiedEmail }, { login: "alice", email: "alice@example.org" });
  const first = gaccounts.signInWithGithub(who, "203.0.113.5", "terms-v1", "terms-v1");
  assert.equal(first.kind, "registered");
  assert.deepEqual({ id: first.account.id, role: first.account.role, status: first.account.status, pw: first.account.passwordHash, gh: first.account.github.id }, { id: "alice", role: "user", status: "active", pw: undefined, gh: 1001 });
  assert.ok(first.account.emailVerifiedAt);
  assert.equal(first.account.termsVersion, "terms-v1", "the accepted legal version is recorded");
  assert.ok(first.account.termsAcceptedAt);
  const { accountUsable } = await import("../src/lib/accounts/session.ts");
  assert.equal(accountUsable(first.account), true, "a password-less GitHub account may hold a session (public mode)");
  assert.equal(accountUsable({ ...first.account, github: null }), false, "without GitHub and without a password it may not");
  const again = gaccounts.signInWithGithub(who, "203.0.113.5", "terms-v1", "terms-v1");
  assert.equal(again.kind, "login");
  assert.equal(again.account.id, "alice");
});

test("sign-up needs the Terms accepted in the current version; a known GitHub user signs in without", async () => {
  const carol = await oauthAs("carol", { purpose: "login", accountId: null });
  const none = gaccounts.signInWithGithub(carol.who, "203.0.113.8", null, "terms-v2");
  assert.deepEqual([none.kind, none.code], ["refused", "terms_required"]);
  const stale = gaccounts.signInWithGithub(carol.who, "203.0.113.8", "terms-v1", "terms-v2");
  assert.deepEqual([stale.kind, stale.code], ["refused", "terms_changed"]);
  assert.ok(!accounts.getAccount("carol"), "no account without a valid acceptance");
  const alice = await oauthAs("alice", { purpose: "login", accountId: null });
  assert.equal(gaccounts.signInWithGithub(alice.who, "203.0.113.5", null, "terms-v2").kind, "login", "existing accounts are not blocked");
});

test("sign-in never takes over an account by email; no verified email and disabled accounts are refused", async () => {
  const bob = await oauthAs("bob", { purpose: "login", accountId: null });
  const r = gaccounts.signInWithGithub(bob.who, "203.0.113.6", "terms-v1", "terms-v1");
  assert.equal(r.kind, "refused");
  assert.equal(r.code, "email_in_use");
  assert.equal(accounts.getAccount("bob").github, null, "the existing account stays unlinked");
  const ghost = await oauthAs("noemail", { purpose: "login", accountId: null });
  assert.equal(gaccounts.signInWithGithub(ghost.who, "203.0.113.7", "terms-v1", "terms-v1").code, "no_email");
  accounts.mutateStore((s) => {
    s.accounts.find((a) => a.id === "alice").status = "disabled";
  });
  const alice = await oauthAs("alice", { purpose: "login", accountId: null });
  assert.equal(gaccounts.signInWithGithub(alice.who, "203.0.113.5", "terms-v1", "terms-v1").code, "disabled");
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
  assert.deepEqual((await installations.installationRepos(7)).map((r) => r.fullName), [REPO, PRIVATE_REPO], "the installation's own list: every repository the app is on");
  await assert.rejects(installations.installationToken(8, REPO), /no longer installed/);
});

test("website studio on an installation: only installations proven by the user's GitHub sign-in; no token stored", async () => {
  // Mallory claims installation 7 (e.g. by typing it into the setup URL): her sign-in lists none, so nothing is linked.
  await oauthAs("mallory", { purpose: "login", accountId: null }).then(({ who }) => gaccounts.signInWithGithub(who, "203.0.113.9", "terms-v1", "terms-v1"));
  const mal = await oauthAs("mallory", { purpose: "link", accountId: "mallory" });
  await service.linkInstallations("mallory", mal.who.login, mal.token, await oauth.userInstallations(mal.token));
  await assert.rejects(service.connect("mallory", { repo: REPO, tokenSource: "app", installationId: 7, productionUrl: "" }), /not linked to your account/);
  // Alice can reach installation 7: linked, connected, and the stored connection holds no secret.
  const al = await oauthAs("alice", { purpose: "link", accountId: "alice" });
  const insts = await oauth.userInstallations(al.token);
  assert.deepEqual(insts, [{ id: 7, account: "genor", accountType: "User" }]);
  await service.linkInstallations("alice", al.who.login, al.token, insts);
  const repos = service.appRepositories("alice");
  assert.deepEqual(repos.installations[0].repos.map((r) => r.fullName), [REPO, PRIVATE_REPO], "alice administers both");
  await assert.rejects(service.connect("alice", { repo: "genor/other", tokenSource: "app", installationId: 7 }), /not one of your repositories/);
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

const events = await import("../src/lib/security/events.ts");

async function signUpAndLink(user) {
  const { who } = await oauthAs(user, { purpose: "login", accountId: null });
  const signed = gaccounts.signInWithGithub(who, "203.0.113.20", "terms-v1", "terms-v1");
  const id = signed.account.id;
  const linked = await oauthAs(user, { purpose: "link", accountId: id });
  await service.linkInstallations(id, linked.who.login, linked.token, await oauth.userInstallations(linked.token));
  return id;
}

test("H1: an installation member gets only the repositories GITHUB lists for HER token, and only with push", async () => {
  const mintedBefore = world.state.minted.length;
  const carol = await signUpAndLink("carol");
  // The attack from the audit: carol sees installation 7 (an org she belongs to) and names a repository she cannot read.
  assert.deepEqual(siteStore.loadSite(carol).github.installations.map((i) => i.id), [7], "the installation is linked");
  assert.deepEqual(siteStore.loadSite(carol).github.installations[0].repos.map((r) => [r.fullName, r.push]), [[REPO, false]], "the private repository is not even listed for her token");
  assert.deepEqual(service.appRepositories(carol).installations[0].repos, [], "the Connect picker lists no repository she cannot push to (not the installation's private ones)");
  await assert.rejects(service.connect(carol, { repo: PRIVATE_REPO, tokenSource: "app", installationId: 7 }), /not one of your repositories/);
  await assert.rejects(service.connect(carol, { repo: REPO, tokenSource: "app", installationId: 7 }), /no write access/);
  assert.equal(siteStore.loadSite(carol).connection, null, "nothing connected");
  assert.deepEqual(world.state.minted.slice(mintedBefore), [], "no installation token was minted for her at all");
});

test("H1: lost access, a renamed login and unlinking drop the app connection", async () => {
  const carol = "carol";
  world.state.access[REPO].carol = "write";
  const linked = await oauthAs("carol", { purpose: "link", accountId: carol });
  await service.linkInstallations(carol, linked.who.login, linked.token, await oauth.userInstallations(linked.token));
  const { view } = await service.connect(carol, { repo: REPO, tokenSource: "app", installationId: 7 });
  assert.equal(view.connection.repo, REPO, "with write access the connection works");
  await service.listFiles(carol);
  // Access revoked on GitHub: the next operation after the cache window re-checks, refuses and drops the connection.
  world.state.access[REPO].carol = "read";
  service.clearAppAccessCache();
  const before = events.recentSecurityEvents().length;
  await assert.rejects(service.listFiles(carol), /connection was removed: GitHub says @carol can no longer push/);
  assert.equal(siteStore.loadSite(carol).connection, null);
  assert.ok(events.recentSecurityEvents().slice(before).some((e) => e.kind === "github_app_access_lost" && e.account === carol));
  // Re-linking after the access came back restores the right to connect; a relink that no longer lists push drops it.
  world.state.access[REPO].carol = "write";
  await service.connect(carol, { repo: REPO, tokenSource: "app", installationId: 7 });
  world.state.access[REPO].carol = "read";
  const again = await oauthAs("carol", { purpose: "link", accountId: carol });
  await service.linkInstallations(carol, again.who.login, again.token, await oauth.userInstallations(again.token));
  assert.equal(siteStore.loadSite(carol).connection, null, "a relink without push drops the connection at once");
  // The GitHub user behind the login changed (rename + someone else took it): the stable id no longer matches.
  world.state.access[REPO].carol = "write";
  const third = await oauthAs("carol", { purpose: "link", accountId: carol });
  await service.linkInstallations(carol, third.who.login, third.token, await oauth.userInstallations(third.token));
  await service.connect(carol, { repo: REPO, tokenSource: "app", installationId: 7 });
  accounts.mutateStore((s) => {
    s.accounts.find((a) => a.id === carol).github.id = 999_999;
  });
  service.clearAppAccessCache();
  await assert.rejects(service.listFiles(carol), /connection was removed/);
  accounts.mutateStore((s) => {
    s.accounts.find((a) => a.id === carol).github.id = 5005;
  });
  // Unlinking GitHub takes the app connection with it.
  await service.connect(carol, { repo: REPO, tokenSource: "app", installationId: 7 });
  service.forgetInstallations(carol);
  assert.equal(siteStore.loadSite(carol).connection, null, "unlink drops the app connection");
});
