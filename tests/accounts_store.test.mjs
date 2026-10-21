// Account foundation (src/lib/accounts): v1 -> v2 migration, the store lock, unique emails, trusted-proxy address rules,
// rate-limit buckets, public-mode flows against a throwaway data dir (outbox mail), account data deletion.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/accounts_store.test.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "knife-accounts-store-"));
process.env.KNIFE_DATA_DIR = dataDir;
process.env.KNIFE_MAIL_TRANSPORT = "outbox";
process.env.KNIFE_POW_BITS = "4"; // the forms' proof-of-work, solved below at a test difficulty
process.env.KNIFE_EMAIL_DNS = "off"; // example.com publishes a null MX; the DNS check has its own suite (email_policy.test.mjs)
delete process.env.KNIFE_AUTH_MODE;
delete process.env.KNIFE_TRUSTED_PROXIES;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const store = await import("../src/lib/accounts/store.ts");
const network = await import("../src/lib/accounts/network.ts");
const limits = await import("../src/lib/accounts/rate-limit.ts");
const mode = await import("../src/lib/accounts/mode.ts");
const accountsFile = join(dataDir, "accounts.json");

function writeV1() {
  writeFileSync(accountsFile, JSON.stringify({
    defaultAccountId: "genor",
    accounts: [
      { id: "genor", displayName: "Genor", provider: null, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "openclaw", displayName: "OpenClaw", passwordHash: "scrypt$16384$8$1$AAAA$BBBB", provider: null, createdAt: "2026-01-02T00:00:00.000Z" },
    ],
  }), { mode: 0o600 });
}

test("v1 accounts are read as v2 admins and written back as version 2 by the next mutation", () => {
  writeV1();
  const read = store.readStore();
  assert.equal(read.accounts.length, 2);
  for (const account of read.accounts) {
    assert.equal(account.role, "admin");
    assert.equal(account.status, "active");
    assert.equal(account.email, null);
    assert.equal(account.storageQuotaBytes, null);
    assert.equal(account.lastLoginAt, null);
  }
  assert.equal(JSON.parse(readFileSync(accountsFile, "utf8")).version, undefined, "a read does not rewrite the file");
  store.mutateStore((s) => { s.accounts[1].email = "Owner@Example.COM"; });
  const raw = JSON.parse(readFileSync(accountsFile, "utf8"));
  assert.equal(raw.version, 2);
  assert.equal(store.findByEmail("owner@example.com").id, "openclaw", "lookup is case-insensitive");
  assert.equal(store.findByIdentifier("OWNER@example.com").id, "openclaw");
  assert.equal(store.findByIdentifier("OpenClaw").id, "openclaw");
});

test("the CLI reads and keeps the v2 file (role, status, email shown; set-email / set-role)", () => {
  const cli = (...args) => spawnSync(process.execPath, ["scripts/accounts.mjs", ...args], { env: { ...process.env, KNIFE_DATA_DIR: dataDir }, encoding: "utf8" });
  let r = cli("list");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /openclaw\tOpenClaw\t\[password, admin, active, owner@example\.com \(unverified\)\]/);
  r = cli("set-email", "genor", "Genor@Knife.Example.com");
  assert.equal(r.status, 0, r.stderr);
  r = cli("set-email", "openclaw", "genor@knife.example.com");
  assert.notEqual(r.status, 0, "an address another account owns is refused");
  assert.match(r.stderr, /already belongs/);
  r = cli("set-role", "openclaw", "user");
  assert.equal(r.status, 0, r.stderr);
  const raw = JSON.parse(readFileSync(accountsFile, "utf8"));
  assert.equal(raw.version, 2);
  const genor = raw.accounts.find((a) => a.id === "genor");
  assert.equal(genor.email, "genor@knife.example.com");
  assert.ok(genor.emailVerifiedAt, "the owner vouches for the address");
  assert.equal(raw.accounts.find((a) => a.id === "openclaw").role, "user");
});

test("unique emails are enforced on write; a throwing mutation writes nothing", () => {
  const before = readFileSync(accountsFile, "utf8");
  assert.throws(() => store.mutateStore((s) => { s.accounts[1].email = "genor@knife.example.com"; }), /share an email/);
  assert.equal(readFileSync(accountsFile, "utf8"), before);
  assert.throws(() => store.mutateStore(() => { throw new Error("boom"); }), /boom/);
  assert.equal(readFileSync(accountsFile, "utf8"), before);
});

test("the lock: a live lock blocks (then times out), a stale one is taken over, and it is released after use", () => {
  const lock = `${accountsFile}.lock`;
  writeFileSync(lock, "");
  const started = Date.now();
  assert.throws(() => store.mutateStore(() => undefined), /locked by another process/);
  assert.ok(Date.now() - started >= 4_500, "waited for the holder");
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  store.mutateStore((s) => { s.accounts[0].displayName = "Genor"; });
  assert.equal(existsSync(lock), false);
});

test("auth mode fails closed", () => {
  assert.equal(mode.authMode({}), "private");
  assert.equal(mode.authMode({ KNIFE_AUTH_MODE: "private" }), "private");
  assert.equal(mode.authMode({ KNIFE_AUTH_MODE: "public" }), "public");
  assert.equal(mode.authMode({ KNIFE_AUTH_MODE: "publc" }), "public", "a typo never means passwordless");
});

const req = (headers) => new Request("http://knife.example.com/api/x", { headers });

test("forwarded headers are trusted only from KNIFE_TRUSTED_PROXIES (IP and CIDR, IPv4 and IPv6)", () => {
  assert.equal(network.ipMatches("10.1.2.3", "10.0.0.0/8"), true);
  assert.equal(network.ipMatches("11.1.2.3", "10.0.0.0/8"), false);
  assert.equal(network.ipMatches("::ffff:127.0.0.1", "127.0.0.1"), true);
  assert.equal(network.ipMatches("fd7a:115c:a1e0::1", "fd7a:115c:a1e0::/48"), true);
  assert.equal(network.ipMatches("fd7a:115d::1", "fd7a:115c:a1e0::/48"), false);
  assert.equal(network.ipMatches("::1", "::1"), true);
  assert.equal(network.ipMatches("1.2.3.4", "garbage"), false);

  const env = { KNIFE_TRUSTED_PROXIES: "127.0.0.1, 10.0.0.0/8" };
  const spoof = { "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" };
  assert.equal(network.clientIp(req(spoof), env), "local", "no peer stamp (not started through serve.mjs): never trusted");
  assert.equal(network.clientIp(req({ ...spoof, "x-knife-peer": "192.0.2.50" }), env), "192.0.2.50", "untrusted peer: the peer itself, header ignored");
  assert.equal(network.isHttps(req({ ...spoof, "x-knife-peer": "192.0.2.50" }), env), false);
  assert.equal(network.clientIp(req({ ...spoof, "x-knife-peer": "::ffff:127.0.0.1" }), env), "203.0.113.9");
  assert.equal(network.isHttps(req({ ...spoof, "x-knife-peer": "127.0.0.1" }), env), true);
  // Right-most untrusted hop wins: the client cannot pick its own bucket by prepending addresses.
  assert.equal(network.clientIp(req({ "x-forwarded-for": "1.1.1.1, 198.51.100.4, 10.0.0.2", "x-knife-peer": "127.0.0.1" }), env), "198.51.100.4");
  assert.equal(network.clientIp(req({ "x-knife-peer": "127.0.0.1" }), {}), "127.0.0.1", "no trusted proxies configured: the peer");
});

test("rate limits: sliding window per bucket, any full bucket refuses, retry-after is positive", () => {
  const a = { key: "t:a", max: 2, windowMs: 1_000 };
  const b = { key: "t:b", max: 5, windowMs: 1_000 };
  const now = 1_000_000;
  assert.equal(limits.consumeLimits([a, b], now).ok, true);
  assert.equal(limits.consumeLimits([a, b], now + 1).ok, true);
  const third = limits.consumeLimits([a, b], now + 2);
  assert.equal(third.ok, false);
  assert.ok(third.retryAfterSeconds >= 1);
  assert.equal(limits.consumeLimits([b], now + 3).ok, true, "the other bucket still has room");
  assert.equal(limits.consumeLimits([a], now + 1_001).ok, true, "the window slides");
});

test("public flows: generic answers, hashed single-use tokens, collision mail, purge of every data location", async () => {
  process.env.KNIFE_AUTH_MODE = "public";
  const flows = await import("../src/lib/accounts/flows.ts");
  const data = await import("../src/lib/accounts/data.ts");
  const outbox = join(dataDir, "mail-outbox");
  const mails = async (to, count) => {
    for (let i = 0; i < 100; i++) {
      const found = existsSync(outbox) ? readdirSync(outbox).filter((name) => name.includes(to)) : [];
      if (found.length >= count) return found.map((name) => readFileSync(join(outbox, name), "utf8"));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(`no mail for ${to}`);
  };
  const tokenIn = (mail) => /token=3D([A-Za-z0-9_=\r\n-]+)/.exec(mail)[1].replace(/=\r?\n/g, "").replace(/\s.*$/s, "");
  const pow = await import("../src/lib/accounts/pow.ts");
  const { solvePow } = await import("../src/lib/pow/solve.ts");
  const solved = (form, ip) => {
    const { c, bits } = pow.issueChallenge(form, ip);
    return { c, nonce: solvePow(c, bits) };
  };
  const terms = (await import("../src/lib/legal/legal.ts")).legalVersion();
  const register = (input, ip) => flows.register({ acceptTerms: terms, ...input }, ip, solved("register", ip));

  const ok = await register({ username: "zoe", email: "Zoe@Example.com", password: "zoe password 1" }, "ip-1");
  assert.equal(ok.ok, true);
  const taken = await register({ username: "zoe2", email: "zoe@example.com", password: "zoe password 1" }, "ip-2");
  const takenName = await register({ username: "zoe", email: "other@example.com", password: "zoe password 1" }, "ip-3");
  assert.deepEqual([taken, takenName], [ok, ok], "the same answer for a new account, a taken address and a taken name");
  assert.equal((await register({ username: "zoe", email: "x@example.com", password: "short" }, "ip-4")).status, 400);

  const [first, collision] = await mails("zoe@example.com", 2);
  const raw = tokenIn([first, collision].find((mail) => mail.includes("Confirm my email")));
  assert.ok([first, collision].some((mail) => mail.includes("tried to create a new")), "the owner of the address hears about the attempt");
  assert.match((await mails("other@example.com", 1))[0], /not available/);
  const zoe = store.getAccount("zoe");
  assert.equal(zoe.status, "pending");
  assert.equal(zoe.role, "user");
  assert.equal(zoe.storageQuotaBytes, 1024 ** 3);
  assert.equal(zoe.verifyToken.hash, createHash("sha256").update(raw).digest("hex"), "only the hash is stored");
  assert.ok(!readFileSync(accountsFile, "utf8").includes(raw), "the raw token is nowhere in the file");
  const ttl = Date.parse(zoe.verifyToken.expiresAt) - Date.now();
  assert.ok(ttl > 23.9 * 3600_000 && ttl <= 24 * 3600_000);
  assert.equal(store.getAccount("zoe2"), undefined);

  assert.equal(flows.verifyToken(raw).ok, true);
  assert.equal(flows.verifyToken(raw).ok, false, "single use");
  assert.equal(store.getAccount("zoe").status, "active");

  assert.deepEqual(flows.forgotPassword("nobody@example.com", "ip-5", solved("forgot", "ip-5")), flows.forgotPassword("zoe@example.com", "ip-6", solved("forgot", "ip-6")));
  const reset = tokenIn((await mails("zoe@example.com", 3)).find((mail) => mail.includes("reset-password")));
  const resetTtl = Date.parse(store.getAccount("zoe").resetToken.expiresAt) - Date.now();
  assert.ok(resetTtl > 59 * 60_000 && resetTtl <= 3600_000, "reset links live 1 h");
  assert.equal((await flows.resetPassword(reset, "brand new password", "ip-7", solved("reset", "ip-7"))).ok, true);
  assert.equal((await flows.resetPassword(reset, "brand new password", "ip-7", solved("reset", "ip-7"))).ok, false, "single use");

  for (const rel of ["cv/zoe.json", "cv/zoe.photo.jpg", "cv/zoe.snapshots/1.json", "conversations/zoe/p.json", "docs/zoe/d1/current.docx", "learn/zoe.json", "usage/zoe.json", "cv/zoey.json"]) {
    mkdirSync(join(dataDir, rel, ".."), { recursive: true });
    writeFileSync(join(dataDir, rel), "x");
  }
  assert.ok(data.accountStorageBytes("zoe") >= 7);
  const purged = flows.purgeAccount("zoe");
  assert.deepEqual(purged.removed.slice(3).sort(), ["conversations/zoe", "cv/zoe.json", "cv/zoe.photo.jpg", "cv/zoe.snapshots", "docs/zoe", "learn/zoe.json", "usage/zoe.json"]);
  assert.deepEqual(purged.removed.slice(0, 3), ["accounts.json (record)", "sessions.json (sessions)", "mcp-keys.json (MCP keys)"]);
  assert.equal(store.getAccount("zoe"), undefined);
  assert.equal(existsSync(join(dataDir, "cv/zoey.json")), true, "another account's files with a common prefix survive");
  delete process.env.KNIFE_AUTH_MODE;
});
