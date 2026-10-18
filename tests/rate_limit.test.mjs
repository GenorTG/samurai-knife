// Rate limiter (src/lib/accounts/rate-limit.ts): namespaced bounded stores, the audit's eviction flush (abuse #2: a flood
// of junk keys must not reset the bucket that is stopping an attacker), a full pre-login namespace refusing only heavy
// creators and never a known device (E1), 24 h buckets in their own namespace, IPv6 /48 and IPv4 /24 companions on every
// per-address limit (abuse #3), persistence across a restart under HMAC names (E4) with capped rows and an async, bounded
// load (E3), and refusal events without personal data. attemptLogin itself (E1/E2) is in accounts_hardening.test.mjs.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/rate_limit.test.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "knife-rate-limit-"));
process.env.KNIFE_DATA_DIR = dataDir;
delete process.env.KNIFE_AUTH_MODE;
delete process.env.KNIFE_AUTH_KEY_FILE;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const rl = await import("../src/lib/accounts/rate-limit.ts");
const events = await import("../src/lib/security/events-core.mjs");
const { LIMITS } = rl;
const file = join(dataDir, "security", "rate-limits.json");

const T0 = Date.now();

test("regression (abuse #2): a flood of new keys never evicts the bucket that is limiting a victim's account", async () => {
  await rl.resetRateLimitsForTests({ login: { maxKeys: 1_000 } });
  const victim = [LIMITS.loginAccount("victim")];
  for (let i = 0; i < 20; i++) rl.hitLimits(victim, T0 + i);
  assert.equal(rl.checkLimits(victim, T0 + 100).ok, false, "victim bucket full after 20 failures");
  // The old store evicted the oldest-inserted key past 5,000; here ~10x the namespace cap of junk identifiers.
  for (let i = 0; i < 10_000; i++) rl.hitLimits([LIMITS.loginAccount(`junk-${i}`), LIMITS.loginIp(`203.0.113.${i % 250}`)], T0 + 200 + i);
  assert.equal(rl.checkLimits(victim, T0 + 20_000).ok, false, "still full after the flood");
  assert.ok(rl.rateLimitStats().login.keys <= 1_250, `namespace stayed bounded (${rl.rateLimitStats().login.keys})`);
});

test("E1: past the soft cap only the heavy creator is refused; a light newcomer still gets new keys", async () => {
  await rl.resetRateLimitsForTests({ login: { maxKeys: 1_000 } });
  const now = T0 + 30_000;
  // One attacker rotating /64s inside one /48 fills the namespace with junk identifiers.
  for (let i = 0; i < 1_000; i++) {
    const ip = `2001:0db8:00aa:${(i % 4000).toString(16).padStart(4, "0")}::/64`;
    rl.hitLimits([LIMITS.loginPair(`junk-${i}`, ip), LIMITS.loginAccount(`junk-${i}`)], now + i);
  }
  assert.ok(rl.rateLimitStats().login.keys >= 1_000);
  const attacker = rl.checkLimits([LIMITS.loginPair("junk-new", "2001:0db8:00aa:9999::/64"), LIMITS.loginIp("2001:0db8:00aa:9999::/64")], now + 2_000);
  assert.equal(attacker.ok, false, "the /48 that created the keys is refused new ones");
  const newcomer = [LIMITS.loginPair("alice", "198.51.100.7"), LIMITS.loginIp("198.51.100.7")];
  assert.equal(rl.checkLimits(newcomer, now + 2_001).ok, true, "a different client is not locked out");
  rl.hitLimits(newcomer, now + 2_002);
  assert.equal(rl.checkLimits(newcomer, now + 2_003).ok, true, "and its keys were stored");
});

test("E1: at the hard cap new keys are refused, except for a trusted caller (known device), which makes room", async () => {
  await rl.resetRateLimitsForTests({ login: { maxKeys: 100 }, "login-device": { maxKeys: 10 } });
  const now = T0 + 60_000;
  // Many distinct creators (a botnet), each under its fair share, fill past the soft cap up to the hard cap (125).
  for (let i = 0; i < 200; i++) rl.hitLimits([LIMITS.loginPair(`junk-${i}`, `192.0.${i}.1`)], now + i);
  assert.equal(rl.rateLimitStats().login.keys, 125, "hard cap = 1.25x");
  const fresh = [LIMITS.loginPair("bob", "198.51.100.9"), LIMITS.loginIp("198.51.100.9")];
  assert.equal(rl.checkLimits(fresh, now + 500).ok, false, "everyone else waits at the hard cap");
  assert.equal(rl.checkLimits(fresh, now + 500, { trusted: true }).ok, true, "a known device is never refused for a full namespace");
  rl.hitLimits(fresh, now + 501, { trusted: true });
  assert.ok(rl.rateLimitStats().login.keys <= 125, "room was made by evicting non-limiting buckets");
  // The device's own bucket lives in a signed-in namespace: it evicts the least recently hit, never refuses.
  for (let i = 0; i < 30; i++) rl.hitLimits([LIMITS.loginDevice(`device-${i}`)], now + 600 + i);
  assert.equal(rl.rateLimitStats()["login-device"].keys, 10);
});

test("E1: 24 h identifier buckets have their own namespace and cannot fill `login`", async () => {
  await rl.resetRateLimitsForTests({ "login-day": { maxKeys: 50 } });
  const now = T0 + 90_000;
  for (let i = 0; i < 500; i++) rl.hitLimits([LIMITS.loginAccountDay(`junk-${i}`)], now + i);
  assert.ok(rl.rateLimitStats()["login-day"].keys <= 63);
  assert.equal(rl.rateLimitStats().login, undefined, "nothing landed in `login`");
  assert.equal(rl.checkLimits([LIMITS.loginPair("carol", "198.51.100.10"), LIMITS.loginIp("198.51.100.10")], now + 600).ok, true);
});

test("full signed-in namespace: the least recently hit non-limiting bucket goes, a limiting one never does", async () => {
  await rl.resetRateLimitsForTests({ outbound: { maxKeys: 3 } });
  const now = T0 + 5_000;
  const busy = { key: "outbound:page:busy", max: 2, windowMs: 60_000 };
  rl.hitLimits([busy], now);
  rl.hitLimits([busy], now + 1);
  rl.hitLimits([{ key: "outbound:page:a", max: 30, windowMs: 60_000 }], now + 2);
  rl.hitLimits([{ key: "outbound:page:b", max: 30, windowMs: 60_000 }], now + 3);
  rl.hitLimits([{ key: "outbound:page:c", max: 30, windowMs: 60_000 }], now + 4);
  assert.equal(rl.checkLimits([busy], now + 5).ok, false, "the limiting bucket survived although it was the oldest");
  assert.equal(rl.rateLimitStats().outbound.keys, 3);
});

test("abuse #3: every per-address limit has a /48 companion (5x); registration also an IPv4 /24 one (3x)", async () => {
  await rl.resetRateLimitsForTests();
  const now = T0 + 10_000;
  let refused = 0;
  for (let i = 0; i < 200; i++) {
    const prefix = `2001:0db8:0001:${i.toString(16).padStart(4, "0")}::/64`;
    if (!rl.consumeLimits([LIMITS.forgotIp(prefix)], now + i).ok) refused += 1;
  }
  assert.equal(refused, 200 - 50, "10/h per /64 but 50/h per /48");
  let regRefused = 0;
  for (let i = 1; i <= 40; i++) if (!rl.consumeLimits([LIMITS.registerIp(`198.51.100.${i}`)], now + i).ok) regRefused += 1;
  assert.equal(regRefused, 40 - 30, "registration: 30/h per IPv4 /24");
  for (let i = 1; i <= 40; i++) rl.consumeLimits([LIMITS.forgotIp(`192.0.2.${i}`)], now + i);
  assert.equal(rl.consumeLimits([LIMITS.forgotIp("192.0.2.200")], now + 50).ok, true, "no /24 companion outside registration");
  const v6 = "2001:0db8:0002:0003::/64";
  for (const [name, limit] of Object.entries({
    loginIp: LIMITS.loginIp(v6), loginFailIp: LIMITS.loginFailIp(v6), verifyIp: LIMITS.verifyIp(v6), resetIp: LIMITS.resetIp(v6),
    githubStartIp: LIMITS.githubStartIp(v6), registerIp: LIMITS.registerIp(v6), resendIp: LIMITS.resendIp(v6), mcpAuthIp: LIMITS.mcpAuthIp(v6),
  })) {
    assert.equal(limit.also?.[0]?.key.endsWith(":2001:0db8:0002::/48"), true, `${name} has a /48 companion`);
    assert.equal(limit.also[0].max, limit.max * 5, name);
  }
  assert.equal(LIMITS.loginFailIp(v6).also[0].quiet, true, "a signal's companion is a signal too");
});

test("persistence (E4): security buckets survive a restart under HMAC names, never emails or plain hashes", async () => {
  await rl.resetRateLimitsForTests();
  const now = Date.now();
  for (let i = 0; i < 3; i++) rl.hitLimits([LIMITS.forgotEmail("alice@example.com"), LIMITS.loginAccount("alice")], now + i);
  for (let i = 3; i < 20; i++) rl.hitLimits([LIMITS.loginAccount("alice")], now + i);
  await rl.saveRateLimits(now + 30);
  const text = readFileSync(file, "utf8");
  assert.equal(text.includes("alice"), false, "keys are hashed");
  for (const key of [LIMITS.loginAccount("alice").key, LIMITS.forgotEmail("alice@example.com").key]) {
    const plain = createHash("sha256").update(key).digest();
    assert.equal(text.includes(plain.toString("hex").slice(0, 32)) || text.includes(plain.toString("base64url").slice(0, 22)), false, "not a plain sha256 an attacker can recompute from a guessed email");
  }
  assert.equal(statSync(file).mode & 0o777, 0o600);
  await rl.resetRateLimitsForTests(); // a "restart": memory gone, reloaded from disk (asynchronously)
  assert.equal(rl.checkLimits([LIMITS.loginAccount("alice")], now + 60).ok, false, "login pressure survived");
  assert.equal(rl.checkLimits([LIMITS.forgotEmail("alice@example.com")], now + 60).ok, false, "mail budget survived");
  assert.equal(rl.checkLimits([LIMITS.loginAccount("bob")], now + 60).ok, true);
});

test("E3: saves are asynchronous and capped (limiting buckets first); an oversized or junk file is ignored on load", async () => {
  await rl.resetRateLimitsForTests({ forgot: { maxKeys: 200_000 } });
  const now = Date.now();
  for (let i = 0; i < 60_000; i++) rl.hitLimits([{ key: `forgot:email:u${i}@x.test`, max: 3, windowMs: 15 * 60_000 }], now);
  const hot = { key: "forgot:email:hot@x.test", max: 3, windowMs: 15 * 60_000 };
  for (let i = 0; i < 3; i++) rl.hitLimits([hot], now + i);
  const pending = rl.saveRateLimits(now + 10);
  assert.ok(pending instanceof Promise);
  await pending;
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.buckets.length, 50_000, "at most 50,000 rows");
  assert.equal(saved.buckets[0][3].length, 3, "the limiting bucket comes first");
  await rl.resetRateLimitsForTests();
  assert.equal(rl.checkLimits([hot], now + 20).ok, false, "the limiting bucket survived the cap");
  mkdirSync(join(dataDir, "security"), { recursive: true });
  writeFileSync(file, JSON.stringify({ v: 2, buckets: [["../../etc", 1, 1, [now]], ["x".repeat(22), "1", 1, []], 5] }));
  await rl.resetRateLimitsForTests();
  assert.equal(rl.checkLimits([hot], now + 30).ok, true, "junk rows are skipped");
  writeFileSync(file, "x".repeat(17 * 1024 * 1024));
  const start = performance.now();
  await rl.resetRateLimitsForTests();
  assert.ok(performance.now() - start < 500, "an oversized file is not parsed");
  rmSync(file, { force: true });
});

test("refusals are security events, once per bucket and window, without the attacker-chosen part; signals stay quiet", async () => {
  events.resetSecurityEventsForTests();
  await rl.resetRateLimitsForTests();
  const now = T0 + 40_000;
  const limits = [LIMITS.forgotIp("203.0.113.7"), LIMITS.forgotEmail("secret.person@example.com")];
  for (let i = 0; i < 6; i++) rl.consumeLimits(limits, now + i);
  const recorded = events.recentSecurityEvents().filter((event) => event.kind === "rate_block");
  assert.equal(recorded.length, 1, JSON.stringify(recorded));
  assert.equal(recorded[0].detail, "forgot:email");
  assert.equal(JSON.stringify(recorded).includes("secret.person"), false);
  for (let i = 0; i < 25; i++) rl.hitLimits([LIMITS.loginAccount("bob"), LIMITS.loginFailIp("198.51.100.9")], now + i);
  rl.checkLimits([LIMITS.loginAccount("bob")], now + 30);
  rl.checkLimits([LIMITS.loginFailIp("198.51.100.9")], now + 30);
  assert.equal(events.recentSecurityEvents().filter((event) => /login/.test(String(event.detail))).length, 0, "signal buckets never log");
  process.env.KNIFE_LOGIN_GLOBAL_FAILS = "5";
  for (let i = 0; i < 5; i++) rl.hitLimits([LIMITS.loginGlobal()], now + i);
  rl.checkLimits([LIMITS.loginGlobal()], now + 10);
  rl.checkLimits([LIMITS.loginGlobal()], now + 11);
  const global = events.recentSecurityEvents().filter((event) => event.kind === "login_lockout");
  assert.deepEqual(global.map((event) => event.detail), ["login-global:all"], "the global budget is logged once (alert-worthy)");
  delete process.env.KNIFE_LOGIN_GLOBAL_FAILS;
  await events.flushSecurityEvents();
});

test("the original contract still holds: sliding window, any full bucket refuses, retry-after positive", async () => {
  await rl.resetRateLimitsForTests();
  const a = { key: "t:a", max: 2, windowMs: 1_000 };
  const b = { key: "t:b", max: 5, windowMs: 1_000 };
  const now = 1_000_000;
  assert.equal(rl.consumeLimits([a, b], now).ok, true);
  assert.equal(rl.consumeLimits([a, b], now + 1).ok, true);
  const third = rl.consumeLimits([a, b], now + 2);
  assert.equal(third.ok, false);
  assert.ok(third.retryAfterSeconds >= 1);
  assert.equal(rl.consumeLimits([b], now + 3).ok, true);
  assert.equal(rl.consumeLimits([a], now + 1_001).ok, true, "the window slides");
  rl.clearLimit("t:a");
  assert.equal(rl.consumeLimits([a], now + 1_002).ok, true);
});
