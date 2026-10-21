// Sign-in hardening (security lane "accounts", audit 2026-10-17): open-redirect rule (M1), MCP keys after takeover (M2),
// pre-registration hijack (M3), email change (L3), scrypt parameters + rehash (L2), fail-closed store defaults (L6),
// hash budget and cheap checks first (abuse #4, #6), session cap (#10), lockout DoS + known devices (#9), GitHub OAuth
// state (#12, in github_app.test.mjs), pending caps (#15) and the proof-of-work (design B).
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/accounts_hardening.test.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "knife-accounts-hardening-"));
process.env.KNIFE_DATA_DIR = dataDir;
process.env.KNIFE_MAIL_TRANSPORT = "outbox";
process.env.KNIFE_AUTH_MODE = "public";
process.env.KNIFE_EMAIL_POLICY = "off"; // the addresses use reserved .example names; email_policy.test.mjs covers the policy
process.env.KNIFE_POW_BITS = "6";
process.env.KNIFE_POW_MAX_BITS = "12";
delete process.env.KNIFE_TRUSTED_PROXIES;
delete process.env.KNIFE_SCRYPT_CONCURRENCY;
delete process.env.KNIFE_SCRYPT_QUEUE;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const { safeReturnPath } = await import("../src/lib/safe-return.ts");
const store = await import("../src/lib/accounts/store.ts");
const password = await import("../src/lib/accounts/password.ts");
const gate = await import("../src/lib/accounts/hash-gate.ts");
const pow = await import("../src/lib/accounts/pow.ts");
const solve = await import("../src/lib/pow/solve.ts");
const flows = await import("../src/lib/accounts/flows.ts");
const session = await import("../src/lib/accounts/session.ts");
const keys = await import("../src/lib/accounts/mcp-keys.ts");
const limits = await import("../src/lib/accounts/rate-limit.ts");
const device = await import("../src/lib/accounts/known-device.ts");
const ipPrefix = await import("../src/lib/accounts/ip-prefix.ts");
const pending = await import("../src/lib/accounts/pending.ts");
const gaccounts = await import("../src/lib/github-app/accounts.ts");
const securityEvents = await import("../src/lib/security/events.ts");
const accountsFile = join(dataDir, "accounts.json");
const outbox = join(dataDir, "mail-outbox");

const solved = (form, ip, context) => {
  const { c, bits } = pow.issueChallenge(form, ip, context);
  return { c, nonce: solve.solvePow(c, bits) };
};

async function mails(to, count) {
  for (let i = 0; i < 150; i++) {
    const found = existsSync(outbox) ? readdirSync(outbox).filter((name) => name.includes(to)).sort() : [];
    if (found.length >= count) return found.map((name) => readFileSync(join(outbox, name), "utf8").replace(/=\r?\n/g, ""));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return (existsSync(outbox) ? readdirSync(outbox).filter((name) => name.includes(to)).sort() : []).map((name) => readFileSync(join(outbox, name), "utf8").replace(/=\r?\n/g, ""));
}
const tokenIn = (mail, path) => new RegExp(`${path}\\?token=3D([A-Za-z0-9_-]+)`).exec(mail)?.[1];

function addAccount(id, extra = {}) {
  store.mutateStore((s) => {
    s.accounts.push(store.newAccountRecord({
      id,
      displayName: id,
      email: `${id}@example.com`,
      emailVerifiedAt: "2026-01-01T00:00:00.000Z",
      role: "user",
      status: "active",
      ...extra,
    }));
  });
}

/* ------------------------------------------------------------------------------------- M1 open redirect */

test("safe return path: only same-site paths survive (audit M1 table)", () => {
  const refused = [
    "//evil.com", "/\\evil.com", "\\\\evil.com", "/\t/evil.com", "/\n/evil.com", "/\r//evil.com", "/\u0000/x", "/\u007f/evil.com",
    "https://evil.com", "http:/evil.com", "javascript:alert(1)", "data:text/html,x", "evil.com", "./x", "?next=1", "",
    "/.//evil.com", "/./\\evil.com", "/x/..//evil.com", " //evil.com", "／／evil.com", "/∕∕evil.com", "/。evil.com",
    "/​/evil.com", "/‮/moc.live", "/\u0085/evil.com", "/" + "a".repeat(600), "/a b",
  ];
  for (const value of refused) assert.equal(safeReturnPath(value, "/fallback"), "/fallback", JSON.stringify(value));
  const kept = [
    ["/", "/"], ["/tools/site-studio?tab=connect", "/tools/site-studio?tab=connect"], ["/account#keys", "/account#keys"],
    ["/%09/evil.com", "/%09/evil.com"], ["/%2F%2Fevil.com", "/%2F%2Fevil.com"], ["/%5Cevil.com", "/%5Cevil.com"],
    ["/x?next=//evil.com", "/x?next=//evil.com"], ["/a/../b", "/b"], ["/@evil.com", "/@evil.com"],
  ];
  for (const [value, expected] of kept) assert.equal(safeReturnPath(value), expected, JSON.stringify(value));
  assert.equal(safeReturnPath(null), "/");
  assert.equal(safeReturnPath(undefined, "/x"), "/x");
});

test("safe return path: anything it accepts stays on the site when a browser resolves it (fuzz)", () => {
  const alphabet = ["/", "\\", "\t", "\n", ".", "%", "0", "9", "a", "e", ":", "@", "?", "#", "/", "/", "　", "／", "e", "v", "l"];
  let seed = 7;
  const rand = (n) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
  for (let i = 0; i < 20_000; i++) {
    let value = "";
    for (let j = 0, len = 1 + rand(10); j < len; j++) value += alphabet[rand(alphabet.length)];
    const out = safeReturnPath(value, "/fallback");
    for (const base of ["https://site.example", "https://site.example/deep/page?q=1"]) {
      assert.equal(new URL(out, base).origin, "https://site.example", `${JSON.stringify(value)} -> ${out}`);
    }
    assert.ok(out.startsWith("/") && !out.startsWith("//"), JSON.stringify(value));
  }
});

/* ------------------------------------------------------------------------------- L2 scrypt + hash budget */

test("password hashes use N=2^17; old N=2^14 hashes still verify and are flagged for rehash; absurd params are refused fast", async () => {
  const fresh = await password.hashPasswordAsync("correct horse battery");
  assert.match(fresh, /^scrypt\$131072\$8\$1\$/);
  assert.equal(password.needsRehash(fresh), false);
  assert.equal(await password.verifyPasswordAsync("correct horse battery", fresh), true);
  assert.equal(await password.verifyPasswordAsync("wrong horse battery", fresh), false);
  const { scryptSync, randomBytes } = await import("node:crypto");
  const salt = randomBytes(16);
  const legacy = `scrypt$16384$8$1$${salt.toString("base64")}$${scryptSync("old password 1", salt, 64, { N: 16384, r: 8, p: 1 }).toString("base64")}`;
  assert.equal(password.needsRehash(legacy), true);
  assert.equal(await password.verifyPasswordAsync("old password 1", legacy), true, "old hashes keep working");
  const start = Date.now();
  assert.equal(await password.verifyPasswordAsync("x", `scrypt$1073741824$8$1$${salt.toString("base64")}$AAAA`), false);
  assert.ok(Date.now() - start < 50, "a hash with huge parameters is not attempted");
});

test("unknown accounts cost the same as real ones (dummy hash at the current parameters)", async () => {
  const real = await password.hashPasswordAsync("some password 12");
  const time = async (stored) => {
    const t = process.hrtime.bigint();
    await password.verifyPasswordAsync("guess guess 1", stored);
    return Number(process.hrtime.bigint() - t) / 1e6;
  };
  const known = [];
  const unknown = [];
  for (let i = 0; i < 4; i++) {
    known.push(await time(real));
    unknown.push(await time(undefined));
  }
  const median = (list) => list.sort((a, b) => a - b)[Math.floor(list.length / 2)];
  const ratio = median(unknown) / median(known);
  assert.ok(ratio > 0.6 && ratio < 1.6, `unknown/known timing ratio ${ratio.toFixed(2)} (${median(unknown).toFixed(0)} vs ${median(known).toFixed(0)} ms)`);
  assert.equal(await password.verifyPasswordAsync("guess guess 1", undefined), false);
});

test("hash budget: 2 running, a bounded FIFO queue, refusal beyond it (audit #4)", async () => {
  process.env.KNIFE_SCRYPT_CONCURRENCY = "2";
  process.env.KNIFE_SCRYPT_QUEUE = "3";
  try {
    const order = [];
    let peak = 0;
    let running = 0;
    const releases = [];
    const job = (name) => gate.withHashSlot(async () => {
      running += 1;
      peak = Math.max(peak, running);
      order.push(name);
      await new Promise((resolve) => releases.push(resolve));
      running -= 1;
      return name;
    });
    const jobs = ["a", "b", "c", "d", "e"].map(job);
    await assert.rejects(job("f"), (error) => error instanceof gate.HashBusyError && error.retryAfterSeconds >= 1, "the 6th (2 running + 3 waiting) is refused at once");
    assert.deepEqual(gate.hashGateStats().running, 2);
    assert.deepEqual(gate.hashGateStats().waiting, 3);
    while (releases.length > 0 || order.length < 5) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      releases.shift()?.();
    }
    assert.deepEqual(await Promise.all(jobs), ["a", "b", "c", "d", "e"]);
    assert.deepEqual(order, ["a", "b", "c", "d", "e"], "FIFO");
    assert.equal(peak, 2);
    assert.deepEqual(gate.hashGateStats().running, 0);
  } finally {
    delete process.env.KNIFE_SCRYPT_CONCURRENCY;
    delete process.env.KNIFE_SCRYPT_QUEUE;
  }
});

test("a full hash budget turns logins and registrations into 503 busy, not stalls", async () => {
  process.env.KNIFE_SCRYPT_CONCURRENCY = "1";
  process.env.KNIFE_SCRYPT_QUEUE = "0";
  try {
    let release;
    const holder = gate.withHashSlot(() => new Promise((resolve) => { release = resolve; }));
    const login = await session.attemptLogin("nobody-busy", "whatever pw 1", "198.51.100.200");
    assert.equal(login.ok, false);
    assert.equal(login.reason, "busy");
    const reg = await flows.register({ acceptTerms: (await import("../src/lib/legal/legal.ts")).legalVersion(),  username: "busyreg", email: "busyreg@example.com", password: "busy password 1" }, "198.51.100.201", solved("register", "198.51.100.201"));
    assert.deepEqual([reg.status, reg.error], [503, "busy"]);
    assert.ok(reg.retryAfterSeconds >= 1);
    release();
    await holder;
  } finally {
    delete process.env.KNIFE_SCRYPT_CONCURRENCY;
    delete process.env.KNIFE_SCRYPT_QUEUE;
  }
});

/* ------------------------------------------------------------------------------ L6 + #6 store behaviour */

test("store defaults fail closed in v2, v1 files are migrated explicitly to active admins", () => {
  writeFileSync(accountsFile, JSON.stringify({
    version: 2,
    defaultAccountId: "owner",
    accounts: [
      { id: "owner", displayName: "Owner", provider: null, createdAt: "2026-01-01T00:00:00.000Z", role: "admin", status: "active" },
      { id: "forgot-fields", displayName: "Forgot", provider: null, createdAt: "2026-01-01T00:00:00.000Z" },
    ],
  }), { mode: 0o600 });
  const missing = store.getAccount("forgot-fields");
  assert.equal(missing.role, "user", "a missing role is never admin");
  assert.equal(missing.status, "disabled", "a missing status is never active");
  assert.equal(session.accountUsable(missing, false), false);
  writeFileSync(accountsFile, JSON.stringify({
    defaultAccountId: "genor",
    accounts: [{ id: "genor", displayName: "Genor", provider: null, createdAt: "2026-01-01T00:00:00.000Z" }],
  }), { mode: 0o600 });
  const v1 = store.getAccount("genor");
  assert.deepEqual([v1.role, v1.status], ["admin", "active"]);
  const fresh = store.newAccountRecord({ id: "plain", displayName: "Plain" });
  assert.deepEqual([fresh.role, fresh.status], ["user", "disabled"]);
});

test("store reads are cached by file identity, hand out copies, and see outside writes (audit #6)", () => {
  store.mutateStore((s) => {
    s.accounts = s.accounts.filter((a) => a.id === "genor");
    for (let i = 0; i < 1500; i++) {
      s.accounts.push(store.newAccountRecord({ id: `bulk-${i}`, displayName: `Bulk ${i}`, email: `bulk-${i}@example.com`, role: "user", status: "active" }));
    }
  });
  store.getAccount("genor");
  const start = performance.now();
  for (let i = 0; i < 2000; i++) store.getAccount(`bulk-${i % 1500}`);
  for (let i = 0; i < 2000; i++) store.findByEmail(`BULK-${i % 1500}@example.com`);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 400, `4000 cached lookups on 1500 accounts took ${elapsed.toFixed(0)} ms`);
  const copy = store.getAccount("bulk-1");
  copy.role = "admin";
  assert.equal(store.getAccount("bulk-1").role, "user", "mutating a returned account never touches the cache");
  // An outside writer (the CLI) replaces the file: the next read sees it.
  const raw = JSON.parse(readFileSync(accountsFile, "utf8"));
  raw.accounts.find((a) => a.id === "bulk-2").displayName = "Renamed by CLI";
  writeFileSync(`${accountsFile}.tmp`, JSON.stringify(raw));
  const { renameSync } = awaitImportFs();
  renameSync(`${accountsFile}.tmp`, accountsFile);
  assert.equal(store.getAccount("bulk-2").displayName, "Renamed by CLI");
  store.mutateStore((s) => { s.accounts = s.accounts.filter((a) => !a.id.startsWith("bulk-")); });
});

function awaitImportFs() {
  return { renameSync: (from, to) => writeFileSync(to, readFileSync(from)) && undefined };
}

/* --------------------------------------------------------------------------- #4 #6 cheap checks first */

test("made-up verify/reset tokens never write accounts.json or hash a password; both are limited per address and per token", async () => {
  const before = statSync(accountsFile);
  const fake = "A".repeat(43);
  const t = Date.now();
  assert.equal(flows.verifyToken(fake, "198.51.100.10").error, "invalid_or_expired");
  assert.equal((await flows.resetPassword(fake, "a new password 1", "198.51.100.10", solved("reset", "198.51.100.10"))).error, "invalid_or_expired");
  assert.ok(Date.now() - t < 150, "no scrypt for a token that does not exist");
  const after = statSync(accountsFile);
  assert.deepEqual([after.ino, after.mtimeMs], [before.ino, before.mtimeMs], "no lock, no rewrite");
  // Per token hash: 5 per 10 minutes, from any address.
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push(flows.verifyToken("B".repeat(43), `198.51.100.${20 + i}`).status);
  assert.deepEqual(codes, [400, 400, 400, 400, 400, 429]);
  // Per address: 20 per 10 minutes, whatever the token.
  const ipCodes = [];
  for (let i = 0; i < 21; i++) ipCodes.push(flows.verifyToken(`C${String(i).padStart(42, "x")}`, "198.51.100.30").status);
  assert.equal(ipCodes.slice(0, 20).every((code) => code === 400), true);
  assert.equal(ipCodes[20], 429);
});

/* ------------------------------------------------------------------------------------------------ PoW */

test("proof-of-work: the JS SHA-256 matches node:crypto and the solver's nonces verify", () => {
  for (const len of [0, 1, 54, 55, 56, 63, 64, 65, 118, 119, 120, 200, 300]) {
    const text = "c".repeat(len).replace(/c/g, (_, i) => String.fromCharCode(33 + ((i * 7) % 90)));
    const words = solve.sha256Words(text);
    const buf = Buffer.alloc(32);
    words.forEach((w, i) => buf.writeUInt32BE(w >>> 0, i * 4));
    assert.equal(buf.toString("hex"), createHash("sha256").update(text).digest("hex"), `length ${len}`);
  }
  for (const len of [10, 54, 63, 64, 120, 190]) {
    const c = "k".repeat(len);
    const nonce = solve.solvePow(c, 12);
    assert.ok(solve.leadingZeroBitsOfBytes(createHash("sha256").update(`${c}:${nonce}`).digest()) >= 12);
  }
});

test("proof-of-work: bound to form, client prefix, age; one use; enough work; tampering refused", () => {
  pow.resetPowState();
  const ip = "203.0.113.50";
  const good = solved("forgot", ip);
  assert.deepEqual(pow.checkPow("forgot", ip, good), { ok: true });
  assert.equal(pow.checkPow("forgot", ip, good).error, "challenge_invalid", "replay refused");
  assert.equal(pow.checkPow("forgot", ip, undefined).error, "challenge_required");
  assert.equal(pow.checkPow("forgot", ip, undefined).status, 428);
  assert.equal(pow.checkPow("register", ip, solved("forgot", ip)).error, "challenge_invalid", "another form's challenge");
  assert.equal(pow.checkPow("forgot", "203.0.113.51", solved("forgot", ip)).error, "challenge_invalid", "another client's challenge");
  const old = pow.issueChallenge("forgot", ip, {}, Date.now() - 11 * 60_000);
  assert.equal(pow.checkPow("forgot", ip, { c: old.c, nonce: solve.solvePow(old.c, old.bits) }).error, "challenge_required", "expired");
  const fresh = pow.issueChallenge("forgot", ip);
  let lazy = 0;
  while (solve.leadingZeroBitsOfBytes(createHash("sha256").update(`${fresh.c}:${lazy}`).digest()) >= fresh.bits) lazy += 1;
  assert.equal(pow.checkPow("forgot", ip, { c: fresh.c, nonce: String(lazy) }).error, "challenge_invalid", "not enough work");
  const [payload, sig] = fresh.c.split(".");
  const forged = JSON.parse(Buffer.from(payload, "base64url").toString());
  forged.b = 1;
  const forgedC = `${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${sig}`;
  assert.equal(pow.checkPow("forgot", ip, { c: forgedC, nonce: solve.solvePow(forgedC, 1) }).error, "challenge_invalid", "an edited difficulty breaks the signature");
  assert.equal(pow.checkPow("forgot", ip, { c: fresh.c, nonce: "1".repeat(17) }).error, "challenge_invalid", "nonce length capped");
  // IPv6: one /64 is one client.
  const v6 = solved("resend", "2001:db8:1:2:aaaa::1");
  assert.deepEqual(pow.checkPow("resend", "2001:db8:1:2:ffff:eeee:dddd:1", v6), { ok: true });
});

test("proof-of-work: difficulty rises under load from one prefix; easy challenges collected earlier stop working", () => {
  pow.resetPowState();
  const ip = "203.0.113.60";
  const base = pow.requiredBits("forgot", ip);
  assert.equal(base, 6);
  const stash = pow.issueChallenge("forgot", ip);
  for (let i = 0; i < 6; i++) assert.deepEqual(pow.checkPow("forgot", ip, solved("forgot", ip)), { ok: true });
  assert.equal(pow.requiredBits("forgot", ip), base + 3);
  assert.equal(pow.checkPow("forgot", ip, { c: stash.c, nonce: solve.solvePow(stash.c, stash.bits) }).error, "challenge_required");
  assert.equal(pow.requiredBits("forgot", "203.0.113.61"), base, "other clients are not affected");
  assert.equal(pow.requiredBits("login", "203.0.113.61", { identifierUnderAttack: true }), base + 3);
  assert.ok(pow.requiredBits("login", "203.0.113.61", { identifierUnderAttack: true }) <= 12, "never above KNIFE_POW_MAX_BITS");
});

test("proof-of-work: the replay set is bounded and fails closed when full", () => {
  pow.resetPowState();
  const key = Symbol.for("samurai-knife.pow.v1");
  const used = globalThis[key].used;
  const later = Date.now() + 3_600_000;
  for (let i = 0; i < 50_000; i++) used.set(`x${i}`, later);
  const verdict = pow.checkPow("forgot", "203.0.113.70", solved("forgot", "203.0.113.70"));
  assert.deepEqual([verdict.status, verdict.error], [503, "busy"]);
  pow.resetPowState();
});

test("every public pre-login flow refuses without proof-of-work, before limits, hashing, store or mail", async () => {
  const before = statSync(accountsFile).mtimeMs;
  const r = await flows.register({ acceptTerms: (await import("../src/lib/legal/legal.ts")).legalVersion(),  username: "nopow", email: "nopow@example.com", password: "nopow password" }, "198.51.100.40");
  assert.deepEqual([r.status, r.error, typeof r.bits], [428, "challenge_required", "number"]);
  assert.equal(flows.forgotPassword("nopow@example.com", "198.51.100.40").status, 428);
  assert.equal(flows.resendVerification("nopow@example.com", "198.51.100.40").status, 428);
  assert.equal((await flows.resetPassword("D".repeat(43), "new password 12", "198.51.100.40")).status, 428);
  assert.equal(statSync(accountsFile).mtimeMs, before);
  assert.equal((await mails("nopow@example.com", 1)).length, 0);
  // The per-email bucket is not consumed by unpaid requests (no lockout of an address for free).
  for (let i = 0; i < 5; i++) flows.forgotPassword("victim-bucket@example.com", `198.51.100.${50 + i}`);
  assert.equal(limits.checkLimits([limits.LIMITS.forgotEmail("victim-bucket@example.com")]).ok, true);
});

/* ------------------------------------------------------------------------- #15 pending caps and sweep */

test("pending accounts: per client prefix cap, per domain cap, total cap, timed sweep (audit #15)", async () => {
  const ip = "198.51.100.77";
  const results = [];
  for (let i = 0; i < 6; i++) {
    results.push(await flows.register({ acceptTerms: (await import("../src/lib/legal/legal.ts")).legalVersion(),  username: `squat${i}`, email: `squat${i}@squat.example`, password: "squat password 1" }, ip, solved("register", ip)));
  }
  assert.deepEqual(results.slice(0, 5).map((r) => r.ok), [true, true, true, true, true]);
  assert.deepEqual([results[5].status, results[5].error], [429, "pending_full"], "the 6th pending sign-up from one prefix");
  const stored = store.getAccount("squat0");
  assert.equal(stored.pendingIpp, ipPrefix.prefixTag(ip));
  assert.ok(!readFileSync(accountsFile, "utf8").includes(ip), "no client address in accounts.json");
  // Domain and total caps press on prefixes first: at the soft cap a prefix without a pending sign-up still gets in, up to
  // the hard cap (1.25x, rounded up); a prefix that already holds one is refused at the soft cap.
  process.env.KNIFE_PENDING_PER_DOMAIN = "5";
  const fresh = [];
  for (const [i, otherIp] of ["198.51.100.78", "198.51.100.80", "198.51.100.81"].entries()) {
    fresh.push((await flows.register({ acceptTerms: (await import("../src/lib/legal/legal.ts")).legalVersion(),  username: `squat-d${i}`, email: `another${i}@squat.example`, password: "squat password 1" }, otherIp, solved("register", otherIp))).error ?? "ok");
  }
  assert.deepEqual(fresh, ["ok", "ok", "pending_full"], "5 pending: fresh prefixes get in until 7, then the domain is full");
  const sameAgain = await flows.register({ acceptTerms: (await import("../src/lib/legal/legal.ts")).legalVersion(),  username: "squat-d9", email: "again@squat.example", password: "squat password 1" }, "198.51.100.78", solved("register", "198.51.100.78"));
  assert.equal(sameAgain.error, "pending_full", "a prefix that already waits is refused at the soft cap");
  delete process.env.KNIFE_PENDING_PER_DOMAIN;
  process.env.KNIFE_PENDING_MAX = "5";
  const totalFull = await flows.register({ acceptTerms: (await import("../src/lib/legal/legal.ts")).legalVersion(),  username: "squat-t", email: "t@elsewhere.example", password: "squat password 1" }, "198.51.100.79", solved("register", "198.51.100.79"));
  assert.equal(totalFull.error, "pending_full", "7 pending is past the hard total cap (ceil(5 x 1.25))");
  delete process.env.KNIFE_PENDING_MAX;
  // Expire them: the sweep frees names and addresses without a registration.
  store.mutateStore((s) => {
    for (const a of s.accounts) {
      if (a.id.startsWith("squat")) {
        a.createdAt = new Date(Date.now() - 25 * 3_600_000).toISOString();
        a.verifyToken.expiresAt = new Date(Date.now() - 3_600_000).toISOString();
      }
    }
  });
  assert.equal(pending.sweepPending(), 7);
  assert.equal(store.getAccount("squat0"), undefined);
  assert.equal(pending.sweepPending(), 0, "nothing left: no write");
  pending.ensurePendingSweeper();
  pending.ensurePendingSweeper();
});

test("pending caps cannot be used to block a big webmail domain: 60 fake gmail sign-ups, a real one still gets in (fix-mail #6)", async () => {
  process.env.KNIFE_PENDING_PER_DOMAIN = "50";
  const fakes = Array.from({ length: 60 }, (_, i) => store.newAccountRecord({
    id: `gfake${i}`, displayName: `gfake${i}`, passwordHash: "x", email: `fake${i}@gmail.com`, role: "user", status: "pending",
    storageQuotaBytes: 1, verifyToken: { hash: createHash("sha256").update(`g${i}`).digest("hex"), expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, pendingIpp: `ipp${i % 12}`,
  }));
  store.mutateStore((s) => { s.accounts.push(...fakes); });
  const ip = "198.51.100.120";
  const real = await flows.register({ acceptTerms: (await import("../src/lib/legal/legal.ts")).legalVersion(),  username: "realgmail", email: "Real.Person@googlemail.com", password: "real password 12" }, ip, solved("register", ip));
  assert.equal(real.ok, true, "gmail.com (and googlemail.com) has no per-domain pending cap");
  // An ordinary domain still has its cap (canonical domain, soft/hard by prefix).
  store.mutateStore((s) => {
    s.accounts.push(...Array.from({ length: 63 }, (_, i) => store.newAccountRecord({
      id: `cfake${i}`, displayName: `cfake${i}`, passwordHash: "x", email: `f${i}@corp.example`, role: "user", status: "pending",
      storageQuotaBytes: 1, verifyToken: { hash: createHash("sha256").update(`c${i}`).digest("hex"), expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, pendingIpp: `cipp${i % 13}`,
    })));
  });
  assert.equal(pending.pendingRoomNow("someone@corp.example", "fresh-prefix"), "pending_full", "63 >= ceil(50 x 1.25): full even for a fresh prefix");
  assert.equal(pending.pendingRoomNow("someone@gmail.com", "fresh-prefix"), "ok");
  // The total cap presses on prefixes that already wait before refusing everyone.
  process.env.KNIFE_PENDING_MAX = String(store.readStore().accounts.filter((a) => a.status === "pending").length);
  assert.equal(pending.pendingRoomNow("x@gmail.com", "ipp1"), "pending_full", "at the soft total, a waiting prefix is refused");
  assert.equal(pending.pendingRoomNow("x@gmail.com", "brand-new"), "ok", "a fresh prefix still gets in below the hard total");
  delete process.env.KNIFE_PENDING_MAX;
  delete process.env.KNIFE_PENDING_PER_DOMAIN;
  store.mutateStore((s) => { s.accounts = s.accounts.filter((a) => !/^(gfake|cfake|realgmail)/.test(a.id)); });
});

test("per-email flow limits key on the canonical mailbox: +tag, dot and googlemail variants share one bucket (fix-mail #5)", async () => {
  const variants = ["Victim@gmail.com", "victim+1@gmail.com", "v.i.c.t.i.m@googlemail.com", "VIC.TIM+zz@gmail.com"];
  const answers = [];
  for (const [i, email] of variants.entries()) {
    const ip = `198.51.100.${130 + i}`;
    answers.push(flows.forgotPassword(email, ip, solved("forgot", ip)).status ?? 200);
  }
  assert.deepEqual(answers, [200, 200, 200, 429], "3 per 15 min for the mailbox, whatever the spelling");
  assert.equal(limits.LIMITS.registerEmail("a.b+x@googlemail.com").key, limits.LIMITS.registerEmail("ab@gmail.com").key);
  assert.equal(limits.LIMITS.resendEmail("Ann+x@Example.org").key, limits.LIMITS.resendEmail("ann@example.org").key);
  assert.notEqual(limits.LIMITS.forgotEmail("a.b@example.org").key, limits.LIMITS.forgotEmail("ab@example.org").key, "dots only fold for gmail");
});

/* ----------------------------------------------------------------------- M3 pre-registration hijack */

test("pre-registration hijack (M3): forgot/resend on a pending sign-up cancels it and mails 'create your account', never the squatter's link", async () => {
  const attacker = "198.51.100.90";
  const ok = await flows.register({ acceptTerms: (await import("../src/lib/legal/legal.ts")).legalVersion(),  username: "squatter", email: "victim@example.org", password: "attacker knows 1" }, attacker, solved("register", attacker));
  assert.equal(ok.ok, true);
  const [verify] = await mails("victim@example.org", 1);
  assert.match(verify, /Someone signed up for Smart Knife with the username "squatter" and this email address/);
  assert.match(verify, /If it was not you, do not open the link/);
  const squatLink = tokenIn(verify, "/verify");
  assert.ok(squatLink);
  const victim = "198.51.100.91";
  assert.equal(flows.forgotPassword("victim@example.org", victim, solved("forgot", victim)).message, flows.GENERIC_FORGOT);
  assert.equal(store.getAccount("squatter"), undefined, "the squatted pending record is gone");
  const all = await mails("victim@example.org", 2);
  assert.match(all[1], /Create your Smart Knife account/);
  assert.match(all[1], /\/register/);
  assert.equal(tokenIn(all[1], "/verify"), undefined, "no verification link goes to the victim");
  assert.equal(flows.verifyToken(squatLink, attacker).ok, false, "the old link is dead");
  // Resend does the same.
  await flows.register({ acceptTerms: (await import("../src/lib/legal/legal.ts")).legalVersion(),  username: "squatter2", email: "victim2@example.org", password: "attacker knows 1" }, "198.51.100.92", solved("register", "198.51.100.92"));
  flows.resendVerification("victim2@example.org", "198.51.100.93", solved("resend", "198.51.100.93"));
  assert.equal(store.getAccount("squatter2"), undefined);
  // An active owner-made account without a confirmed address still gets a real confirmation link from resend.
  addAccount("cliowner", { emailVerifiedAt: null, email: "cliowner@example.org" });
  flows.resendVerification("cliowner@example.org", "198.51.100.94", solved("resend", "198.51.100.94"));
  assert.ok(tokenIn((await mails("cliowner@example.org", 1))[0], "/verify"));
  assert.ok(store.getAccount("cliowner"));
});

test("GitHub sign-up is not blocked by a squatted pending address or an unconfirmed address change", async () => {
  await flows.register({ acceptTerms: (await import("../src/lib/legal/legal.ts")).legalVersion(),  username: "ghsquat", email: "octo@example.org", password: "attacker knows 1" }, "198.51.100.95", solved("register", "198.51.100.95"));
  addAccount("changer");
  store.mutateStore((s) => {
    s.accounts.find((a) => a.id === "changer").emailChange = { hash: "a".repeat(64), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), email: "octo2@example.org" };
  });
  const first = gaccounts.signInWithGithub({ id: 777001, login: "octo", name: "Octo", verifiedEmail: "octo@example.org" }, "198.51.100.96", "terms-test", "terms-test");
  assert.equal(first.kind, "registered");
  assert.equal(store.getAccount("ghsquat"), undefined);
  const second = gaccounts.signInWithGithub({ id: 777002, login: "octo2", name: "Octo 2", verifiedEmail: "octo2@example.org" }, "198.51.100.97", "terms-test", "terms-test");
  assert.equal(second.kind, "registered");
  assert.equal(store.getAccount("changer").emailChange, undefined, "the unproven change claim gave way");
  // A verified account with the address is still never taken over.
  const third = gaccounts.signInWithGithub({ id: 777003, login: "octo3", name: "Octo 3", verifiedEmail: "changer@example.com" }, "198.51.100.98", "terms-test", "terms-test");
  assert.equal(third.kind, "refused");
});

/* ----------------------------------------------------------------------------- M2, L3 credentials */

test("password reset and change revoke every MCP key and say so in the mail (M2)", async () => {
  addAccount("keyed", { passwordHash: await password.hashPasswordAsync("keyed password 1") });
  const { key } = keys.createMcpKey("keyed", "intruder");
  keys.createMcpKey("keyed", "second");
  assert.equal(keys.accountForMcpKey({ username: "keyed", key })?.id, "keyed");
  const ip = "198.51.100.110";
  flows.forgotPassword("keyed@example.com", ip, solved("forgot", ip));
  const reset = tokenIn((await mails("keyed@example.com", 1))[0], "/reset-password");
  const done = await flows.resetPassword(reset, "keyed password 2", ip, solved("reset", ip));
  assert.equal(done.ok, true);
  assert.equal(done.mcpKeysRevoked, 2);
  assert.equal(keys.accountForMcpKey({ username: "keyed", key }), null, "the intruder's key is dead");
  assert.match((await mails("keyed@example.com", 2))[1], /Your 2 MCP keys were revoked/);
  keys.createMcpKey("keyed", "again");
  const changed = await flows.changePassword(store.getAccount("keyed"), "keyed password 2", "keyed password 3");
  assert.equal(changed.ok, true);
  assert.equal(changed.mcpKeysRevoked, 1);
  assert.deepEqual(keys.listMcpKeys("keyed"), []);
});

test("a confirmed email change drops the pending reset link and signs out the other sessions (L3)", async () => {
  addAccount("mover", { passwordHash: await password.hashPasswordAsync("mover password 1") });
  const account = store.getAccount("mover");
  const here = session.createSession(account);
  const elsewhere = session.createSession(account);
  const ip = "198.51.100.120";
  flows.forgotPassword("mover@example.com", ip, solved("forgot", ip));
  const staleReset = tokenIn((await mails("mover@example.com", 1))[0], "/reset-password");
  assert.ok(store.getAccount("mover").resetToken);
  const change = await flows.changeEmail(store.getAccount("mover"), "mover password 1", "moved@example.com");
  assert.equal(change.ok, true);
  const confirm = tokenIn((await mails("moved@example.com", 1))[0], "/verify");
  const result = flows.verifyToken(confirm, ip, here);
  assert.equal(result.kind, "email_changed");
  assert.equal(store.getAccount("mover").resetToken, undefined);
  assert.equal(session.accountForSessionToken(here)?.id, "mover", "the browser that confirmed keeps its session");
  assert.equal(session.accountForSessionToken(elsewhere), null, "other sessions end");
  assert.equal((await flows.resetPassword(staleReset, "mover password 2", ip, solved("reset", ip))).error, "invalid_or_expired");
});

/* --------------------------------------------------------------------------------- #10 sessions */

test("sessions: at most 20 per account, the oldest go first; other accounts are untouched (#10)", () => {
  addAccount("many", { passwordHash: "scrypt$131072$8$1$AAAA$BBBB" });
  addAccount("bystander", { passwordHash: "scrypt$131072$8$1$AAAA$CCCC" });
  const other = session.createSession(store.getAccount("bystander"));
  const tokens = [];
  for (let i = 0; i < 25; i++) tokens.push(session.createSession(store.getAccount("many")));
  assert.equal(session.sessionCount("many"), 20);
  assert.equal(session.accountForSessionToken(tokens[0]), null, "oldest evicted");
  assert.equal(session.accountForSessionToken(tokens[4]), null);
  assert.equal(session.accountForSessionToken(tokens[5])?.id, "many");
  assert.equal(session.accountForSessionToken(tokens[24])?.id, "many");
  assert.equal(session.accountForSessionToken(other)?.id, "bystander");
});

test("successful logins are limited per account (30/h)", async () => {
  addAccount("busylogin", { passwordHash: await password.hashPasswordAsync("busy login pw 1") });
  const bucket = limits.LIMITS.loginSuccess("busylogin");
  for (let i = 0; i < 30; i++) limits.hitLimits([bucket]);
  const result = await session.attemptLogin("busylogin", "busy login pw 1", "198.51.100.130");
  assert.deepEqual([result.ok, result.reason], [false, "rate_limited"]);
});

test("login rehashes an old hash transparently and keeps existing sessions signed in", async () => {
  const { scryptSync, randomBytes } = await import("node:crypto");
  const salt = randomBytes(16);
  const legacy = `scrypt$16384$8$1$${salt.toString("base64")}$${scryptSync("legacy password", salt, 64, { N: 16384, r: 8, p: 1 }).toString("base64")}`;
  addAccount("legacy", { passwordHash: legacy });
  const existing = session.createSession(store.getAccount("legacy"));
  const result = await session.attemptLogin("legacy", "legacy password", "198.51.100.140");
  assert.equal(result.ok, true);
  assert.match(store.getAccount("legacy").passwordHash, /^scrypt\$131072\$/);
  assert.equal(result.account.passwordHash, store.getAccount("legacy").passwordHash);
  assert.equal(session.accountForSessionToken(existing)?.id, "legacy", "the session follows the new fingerprint");
  assert.equal((await session.attemptLogin("legacy", "legacy password", "198.51.100.140")).ok, true, "the new hash verifies");
});

/* ------------------------------------------------------------------------ #9 lockout DoS, known devices */

test("lockout DoS (#9): strangers hammering an identifier cannot lock out its known device; others solve PoW instead of a refusal", async () => {
  pow.resetPowState();
  addAccount("target", { passwordHash: await password.hashPasswordAsync("target password 1") });
  const owner = store.getAccount("target");
  // The owner logged in from this browser before: it holds a device cookie.
  const cookieHeader = device.deviceCookieHeader(undefined, "target", session.passwordFingerprint(owner), true);
  const deviceCookie = cookieHeader.split(";")[0].slice(`${device.DEVICE_COOKIE}=`.length);
  assert.match(cookieHeader, /Path=\/api\/account\/login; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure/);
  // The attacker sends wrong passwords from many addresses; after 3 failures it has to solve challenges itself.
  let required = 0;
  for (let i = 0; i < 22; i++) {
    const ip = `192.0.2.${i + 1}`;
    let result = await session.attemptLogin("target", "wrong guess", ip);
    if (!result.ok && result.reason === "challenge_required") {
      required += 1;
      result = await session.attemptLogin("target", "wrong guess", ip, { pow: solved("login", ip, { identifierUnderAttack: !limits.checkLimits([limits.LIMITS.loginAccount("target")]).ok }) });
    }
    assert.equal(result.reason, "invalid_credentials");
  }
  assert.ok(required >= 18, `challenges were required after the first failures (${required})`);
  assert.equal(limits.checkLimits([limits.LIMITS.loginAccount("target")]).ok, false, "the identifier bucket is full");
  // Even from the exact address that filled the old identifier+address bucket, the signed device bypasses it.
  for (let i = 0; i < 5; i++) {
    let result = await session.attemptLogin("target", "bad", "203.0.113.202");
    if (!result.ok && result.reason === "challenge_required") {
      result = await session.attemptLogin("target", "bad", "203.0.113.202", { pow: solved("login", "203.0.113.202", { identifierUnderAttack: true }) });
    }
    assert.equal(result.reason, "invalid_credentials");
  }
  assert.equal((await session.attemptLogin("target", "target password 1", "203.0.113.202", { deviceCookie })).ok, true);
  // Before: a hard 429 for everyone. Now: the known device logs straight in…
  const fromDevice = await session.attemptLogin("target", "target password 1", "203.0.113.200", { deviceCookie });
  assert.equal(fromDevice.ok, true, JSON.stringify(fromDevice));
  // …and a new browser is asked for proof-of-work at a raised difficulty, not refused.
  const fresh = await session.attemptLogin("target", "target password 1", "203.0.113.201");
  assert.deepEqual([fresh.ok, fresh.reason], [false, "challenge_required"]);
  assert.equal(fresh.bits, 6 + 3);
  const paid = await session.attemptLogin("target", "target password 1", "203.0.113.201", { pow: solved("login", "203.0.113.201", { identifierUnderAttack: true }) });
  assert.equal(paid.ok, true);
  // The daily identifier ceiling is also pressure, never a hard refusal for a fresh browser.
  limits.clearLimit(limits.LIMITS.loginAccount("target").key);
  limits.clearLimit(limits.LIMITS.loginFailAccount("target").key);
  limits.hitLimits(Array.from({ length: 200 }, () => limits.LIMITS.loginAccountDay("target")));
  const dailyPressure = await session.attemptLogin("target", "target password 1", "203.0.113.203");
  assert.deepEqual([dailyPressure.ok, dailyPressure.reason, dailyPressure.bits], [false, "challenge_required", 6 + 3]);
  const dailyPaid = await session.attemptLogin("target", "target password 1", "203.0.113.203", { pow: solved("login", "203.0.113.203", { identifierUnderAttack: true }) });
  assert.equal(dailyPaid.ok, true);
  // The device cookie of another account, or from before a password change, vouches for nothing.
  assert.equal(device.knownDeviceFor(deviceCookie, "someone-else", session.passwordFingerprint(owner)), null);
  assert.equal(device.knownDeviceFor(deviceCookie, "target", "000000000000"), null);
  assert.equal(device.knownDeviceFor(`${deviceCookie.slice(0, -2)}xx`, "target", session.passwordFingerprint(owner)), null);
  // A known device has its own failure bucket.
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await session.attemptLogin("target", "bad from device", `203.0.113.${210 + i}`, { deviceCookie })).reason);
  assert.equal(codes.slice(0, 10).every((r) => r === "invalid_credentials"), true);
  assert.equal(codes[10], "rate_limited");
  // The lockout was recorded and the owner told once.
  await securityEvents.flushSecurityEvents();
  const eventsFile = join(dataDir, "security", `events-${new Date().toISOString().slice(0, 10)}.jsonl`);
  const events = readFileSync(eventsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(events.some((e) => e.kind === "login_lockout" && e.account === "target"));
  assert.equal(statSync(eventsFile).mode & 0o777, 0o600);
  const notices = (await mails("target@example.com", 1)).filter((m) => m.includes("Many failed logins"));
  assert.equal(notices.length, 1, "one notice per day");
});

test("device cookie: keeps up to 4 accounts and one device id", () => {
  let header;
  let value;
  for (const id of ["a1", "a2", "a3", "a4", "a5"]) {
    header = device.deviceCookieHeader(value, id, "pf", false);
    value = header.split(";")[0].slice(`${device.DEVICE_COOKIE}=`.length);
  }
  assert.ok(!header.includes("Secure"));
  assert.equal(device.knownDeviceFor(value, "a1", "pf"), null, "the oldest of five fell out");
  const id = device.knownDeviceFor(value, "a5", "pf");
  assert.ok(id);
  assert.equal(device.knownDeviceFor(value, "a2", "pf"), id, "one device id for every account on this browser");
});

test("client prefixes: IPv6 by /64, mapped IPv4 as IPv4", () => {
  assert.equal(ipPrefix.clientPrefix("2001:db8::1"), "2001:0db8:0000:0000::/64");
  assert.equal(ipPrefix.clientPrefix("2001:db8:0:0:ffff::9"), "2001:0db8:0000:0000::/64");
  assert.equal(ipPrefix.clientPrefix("::ffff:198.51.100.1"), "198.51.100.1");
  assert.equal(ipPrefix.clientPrefix("198.51.100.1"), "198.51.100.1");
  assert.equal(ipPrefix.clientPrefix("local"), "local");
  assert.equal(ipPrefix.prefixTag("2001:db8::1"), ipPrefix.prefixTag("2001:db8::2"));
  assert.notEqual(ipPrefix.prefixTag("2001:db8::1"), ipPrefix.prefixTag("2001:db8:0:1::1"));
});

/* --------------------------------------------- edge lane: global failed-login budget (E2), full namespace (E1) */

test("E2: a full server-wide failed-login budget only raises proof-of-work, never refuses; known devices skip it", async () => {
  await limits.resetRateLimitsForTests();
  pow.resetPowState();
  process.env.KNIFE_LOGIN_GLOBAL_FAILS = "30";
  addAccount("stuffed", { passwordHash: await password.hashPasswordAsync("stuffed password 1") });
  const owner = store.getAccount("stuffed");
  const deviceCookie = device.deviceCookieHeader(undefined, "stuffed", session.passwordFingerprint(owner), true).split(";")[0].slice(`${device.DEVICE_COOKIE}=`.length);
  // Credential stuffing: one failure per random identifier and address, never 3 from one place.
  for (let i = 0; i < 30; i++) {
    const r = await session.attemptLogin(`nobody${i}@example.com`, "guess guess", `198.18.${i}.1`);
    assert.equal(r.reason, "invalid_credentials");
  }
  assert.equal(limits.checkLimits([limits.LIMITS.loginGlobal()]).ok, false, "the global budget is full");
  const fresh = await session.attemptLogin("stuffed", "stuffed password 1", "203.0.113.230");
  assert.deepEqual([fresh.ok, fresh.reason, fresh.bits], [false, "challenge_required", 6 + 3], "a fresh browser pays raised proof-of-work, no 429");
  const paid = await session.attemptLogin("stuffed", "stuffed password 1", "203.0.113.230", { pow: solved("login", "203.0.113.230", { atLeastBits: fresh.bits }) });
  assert.equal(paid.ok, true, JSON.stringify(paid));
  const fromDevice = await session.attemptLogin("stuffed", "stuffed password 1", "203.0.113.231", { deviceCookie });
  assert.equal(fromDevice.ok, true, "the known device needs no proof at all");
  // The challenge route honours the difficulty a 428 named (the browser flow under attack), never less than required.
  assert.equal(pow.issueChallenge("login", "203.0.113.232", { atLeastBits: 9 }).bits, 9);
  assert.equal(pow.issueChallenge("login", "203.0.113.232", { atLeastBits: 1 }).bits, 6);
  assert.equal(pow.issueChallenge("login", "203.0.113.232", { atLeastBits: 99 }).bits, 12, "capped at KNIFE_POW_MAX_BITS");
  delete process.env.KNIFE_LOGIN_GLOBAL_FAILS;
  await limits.resetRateLimitsForTests();
});

test("E1: a `login` namespace filled by one attacker locks out neither other clients nor known devices", async () => {
  await limits.resetRateLimitsForTests({ login: { maxKeys: 400 } });
  pow.resetPowState();
  addAccount("crowded", { passwordHash: await password.hashPasswordAsync("crowded password 1") });
  const owner = store.getAccount("crowded");
  const deviceCookie = device.deviceCookieHeader(undefined, "crowded", session.passwordFingerprint(owner), true).split(";")[0].slice(`${device.DEVICE_COOKIE}=`.length);
  // One /48, rotating /64s, junk identifiers: each failure creates identifier keys until the namespace is past its cap.
  const now = Date.now();
  for (let i = 0; i < 600; i++) {
    const ip = `2001:0db8:00ee:${i.toString(16).padStart(4, "0")}::/64`;
    limits.hitLimits([limits.LIMITS.loginPair(`junk${i}`, ip), limits.LIMITS.loginIp(ip), limits.LIMITS.loginAccount(`junk${i}`), limits.LIMITS.loginFailAccount(`junk${i}`), limits.LIMITS.loginFailIp(ip)], now);
  }
  assert.ok(limits.rateLimitStats().login.keys >= 400, "past the soft cap");
  const attacker = await session.attemptLogin("junk-next", "guess", "2001:0db8:00ee:ffff::/64");
  assert.equal(attacker.reason, "rate_limited", "the creating /48 is refused new keys");
  let other = await session.attemptLogin("crowded", "crowded password 1", "198.51.100.231");
  if (!other.ok && other.reason === "challenge_required") other = await session.attemptLogin("crowded", "crowded password 1", "198.51.100.231", { pow: solved("login", "198.51.100.231", { atLeastBits: other.bits }) });
  assert.equal(other.ok, true, `another client still logs in: ${JSON.stringify(other)}`);
  // Hard cap reached by many creators: strangers wait, the known device does not.
  for (let i = 0; i < 300; i++) limits.hitLimits([limits.LIMITS.loginPair(`bot${i}`, `192.0.${i % 250}.${Math.floor(i / 250) + 1}`)], now);
  assert.equal(limits.rateLimitStats().login.keys, 500, "hard cap 1.25x");
  const stranger = await session.attemptLogin("crowded", "crowded password 1", "198.51.100.232");
  assert.equal(stranger.reason, "rate_limited");
  const known = await session.attemptLogin("crowded", "crowded password 1", "198.51.100.233", { deviceCookie });
  assert.equal(known.ok, true, "a known device always gets in");
  const knownWrong = await session.attemptLogin("crowded", "wrong", "198.51.100.233", { deviceCookie });
  assert.equal(knownWrong.reason, "invalid_credentials", "and its failures still count in its own bucket");
  await limits.resetRateLimitsForTests();
});
