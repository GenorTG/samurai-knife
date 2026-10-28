// Mail queue (src/lib/mail/): priorities, the global pace and hour/day budgets with class shares, per-domain budgets
// (big webmail / others / newly seen / DNS-risky), per-mailbox budgets shared by +tag/dot variants, collision notices
// 1/day, the queue cap (lowest class evicted first, security never), max age, retries, suppression after a 5xx for the
// mailbox, rate-limited security events, bounded key maps; budgets and suppression persisted across restarts (keyed
// hashes, async, the queue waits for the load); then the real module end to end on the outbox transport.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/mail_queue.test.mjs
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "sk-mail-queue-"));
process.env.KNIFE_DATA_DIR = dataDir;
process.env.KNIFE_MAIL_TRANSPORT = "outbox";
process.env.KNIFE_AUTH_MODE = "public";
process.env.KNIFE_EMAIL_DNS = "off";
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const { MailQueue } = await import("../src/lib/mail/queue.ts");
const { MailBudgets, mailBudgetConfig, parseRates } = await import("../src/lib/mail/budgets.ts");
const { SuppressionList, classifySmtpError } = await import("../src/lib/mail/suppression.ts");
const templates = await import("../src/lib/mail/templates.ts");
const { mailKeyHash } = await import("../src/lib/mail/persist.ts");

/** A keyed hash shaped like persist.ts `mailKeyHash` (22 base64url chars), with its own key per test. */
const keyed = (key) => (value) => createHmac("sha256", key).update(value).digest("base64url").slice(0, 22);

const H = 3_600_000;
const content = (subject = "s") => ({ subject, text: "t", html: "<p>t</p>" });
const ok = (to) => ({ ok: true, email: to, canonical: to, domain: to.split("@")[1], mailRisk: false });

function budgetConfig(overrides = {}) {
  return {
    ...mailBudgetConfig({}),
    perMinute: 1_000,
    global: [{ max: 1_000, windowMs: H }],
    bigDomain: [{ max: 1_000, windowMs: H }],
    domain: [{ max: 1_000, windowMs: H }],
    newDomain: [{ max: 1_000, windowMs: H }],
    mailbox: [{ max: 1_000, windowMs: H }],
    ...overrides,
  };
}

/** A queue with fake deps; `gate` holds deliveries until released. */
function harness({ budgets = {}, config = {}, deliver, policy, clock, ready, budgetsInstance } = {}) {
  const sent = [];
  const events = [];
  const failures = [];
  let release = null;
  const gate = { held: false, wait: null };
  const suppression = new SuppressionList({ path: null, hash: keyed("t"), ttlMs: 30 * 24 * H, max: 1_000 });
  const queue = new MailQueue({
    config: { maxQueued: 500, maxAgeMs: 30 * 60_000, concurrency: 1, retryDelaysMs: [5, 5], eventGapMs: 60_000, ...config },
    budgets: budgetsInstance ?? new MailBudgets(budgetConfig(budgets)),
    deliver: deliver ?? (async (to, c) => {
      if (gate.held) await new Promise((resolve) => { release = resolve; });
      sent.push({ to, subject: c.subject });
    }),
    policy: policy ?? (async (to) => ok(to)),
    suppression,
    event: (kind, detail) => events.push({ kind, ...detail }),
    logFailure: (to, subject, error) => failures.push({ to, subject, error: String(error) }),
    now: clock,
    ready,
  });
  return { queue, sent, events, failures, suppression, gate, release: () => { gate.held = false; release?.(); } };
}

test("priorities: security before verification before notices, FIFO within a class", async () => {
  const h = harness();
  h.gate.held = true;
  h.queue.enqueue("register_collision", "first@example.org", content("blocker"));
  await new Promise((r) => setTimeout(r, 10)); // the blocker is in flight, the rest waits
  h.queue.enqueue("username_taken", "n1@example.org", content("notice-1"));
  h.queue.enqueue("verify_email", "v1@example.org", content("verify-1"));
  h.queue.enqueue("password_changed", "s1@example.org", content("security-1"));
  h.queue.enqueue("reset_password", "v2@example.org", content("verify-2"));
  assert.equal(h.queue.stats().queued, 4);
  h.release();
  await h.queue.flush(5_000);
  assert.deepEqual(h.sent.map((m) => m.subject), ["blocker", "security-1", "verify-1", "verify-2", "notice-1"]);
});

test("global pace: past the per-minute rate mail waits instead of being dropped", async () => {
  const h = harness({ budgets: { perMinute: 2, paceWindowMs: 150 } });
  const started = Date.now();
  for (let i = 0; i < 5; i += 1) h.queue.enqueue("verify_email", `p${i}@example.org`, content(`p${i}`));
  await h.queue.flush(5_000);
  assert.equal(h.sent.length, 5);
  assert.ok(Date.now() - started >= 280, `two pauses of a window (${Date.now() - started} ms)`);
});

test("global hour/day budgets with class shares: notices stop at 50 %, verification at 90 %, security uses all", async () => {
  const h = harness({ budgets: { global: [{ max: 10, windowMs: H }] } });
  for (let i = 0; i < 8; i += 1) h.queue.enqueue("register_collision", `n${i}@example.org`, content(`n${i}`));
  await h.queue.flush();
  assert.equal(h.sent.length, 5, "notices: 50 % of 10");
  for (let i = 0; i < 6; i += 1) h.queue.enqueue("verify_email", `v${i}@example.org`, content(`v${i}`));
  await h.queue.flush();
  assert.equal(h.sent.length, 9, "verification: up to 90 %");
  for (let i = 0; i < 3; i += 1) h.queue.enqueue("password_changed", `s${i}@example.org`, content(`s${i}`));
  await h.queue.flush();
  assert.equal(h.sent.length, 10, "security fills the last slot, then the hard cap holds");
  assert.equal(h.queue.stats().dropped.global, 3 + 2 + 2);
  assert.equal(h.events.filter((e) => e.kind === "mail_budget").length, 1, "one event per reason per gap; the rest are counted");
});

test("per-domain budgets: big providers, other domains, newly seen and DNS-risky domains", async () => {
  const now = { t: 1_000_000 };
  const risky = new Set(["shaky.example.net"]);
  const h = harness({
    clock: () => now.t,
    budgets: { bigDomain: [{ max: 4, windowMs: H }], domain: [{ max: 3, windowMs: H }], newDomain: [{ max: 2, windowMs: H }], newDomainMs: 10_000 },
    policy: async (to) => ({ ...ok(to), mailRisk: risky.has(to.split("@")[1]) }),
  });
  for (let i = 0; i < 6; i += 1) h.queue.enqueue("verify_email", `g${i}@gmail.com`, content());
  await h.queue.flush();
  assert.equal(h.sent.filter((m) => m.to.endsWith("gmail.com")).length, 4, "big provider budget");
  for (let i = 0; i < 4; i += 1) h.queue.enqueue("verify_email", `o${i}@fresh.example.org`, content());
  await h.queue.flush();
  assert.equal(h.sent.filter((m) => m.to.endsWith("fresh.example.org")).length, 2, "a newly seen domain gets the new-domain budget");
  now.t += 20_000; // no longer new
  for (let i = 4; i < 8; i += 1) h.queue.enqueue("verify_email", `o${i}@fresh.example.org`, content());
  await h.queue.flush();
  assert.equal(h.sent.filter((m) => m.to.endsWith("fresh.example.org")).length, 3, "then the ordinary domain budget (3/h) counts all of them");
  for (let i = 0; i < 2; i += 1) h.queue.enqueue("verify_email", `w${i}@shaky.example.net`, content());
  await h.queue.flush();
  now.t += 20_000;
  for (let i = 2; i < 5; i += 1) h.queue.enqueue("verify_email", `w${i}@shaky.example.net`, content());
  await h.queue.flush();
  assert.equal(h.sent.filter((m) => m.to.endsWith("shaky.example.net")).length, 2, "a DNS-risky domain keeps the strict budget");
  assert.ok(h.queue.stats().dropped.domain >= 7);
});

test("per-mailbox budget across all kinds: +tag, dot and googlemail variants are one mailbox; security counts but still goes", async () => {
  const h = harness({ budgets: { mailbox: [{ max: 3, windowMs: H }] } });
  for (const to of ["victim+1@gmail.com", "v.i.c.t.i.m@gmail.com", "Victim@googlemail.com", "vic.tim+zz@gmail.com", "victim@gmail.com"]) {
    h.queue.enqueue("verify_email", to, content(to));
  }
  h.queue.enqueue("reset_password", "victim+reset@gmail.com", content("reset"));
  h.queue.enqueue("password_changed", "victim@gmail.com", content("security"));
  await h.queue.flush();
  assert.deepEqual(h.sent.map((m) => m.subject), ["security", "victim+1@gmail.com", "v.i.c.t.i.m@gmail.com"]);
  assert.equal(h.queue.stats().dropped.mailbox, 4);
  h.queue.enqueue("account_deleted", "VICTIM+bye@gmail.com", content("security-2"));
  await h.queue.flush();
  assert.equal(h.sent.at(-1).subject, "security-2", "a full mailbox budget never blocks security mail");
  h.queue.enqueue("verify_email", "someone.else@gmail.com", content("other"));
  await h.queue.flush();
  assert.equal(h.sent.at(-1).subject, "other", "another mailbox is not affected");
});

test("collision / username-taken / email-in-use notices: at most one per mailbox per day", async () => {
  const h = harness();
  h.queue.enqueue("register_collision", "ann+a@example.org", content("c1"));
  h.queue.enqueue("username_taken", "ann+b@example.org", content("c2"));
  h.queue.enqueue("email_in_use", "ann@example.org", content("c3"));
  h.queue.enqueue("register_collision", "bob@example.org", content("c4"));
  h.queue.enqueue("verify_email", "ann@example.org", content("v"));
  await h.queue.flush();
  assert.deepEqual(h.sent.map((m) => m.subject).sort(), ["c1", "c4", "v"]);
  assert.equal(h.queue.stats().dropped.collision, 2);
});

test("queue cap: a higher class evicts the newest lowest-class message; a notice into a full queue is dropped", async () => {
  const h = harness({ config: { maxQueued: 3 } });
  h.gate.held = true;
  h.queue.enqueue("verify_email", "busy@example.org", content("busy"));
  await new Promise((r) => setTimeout(r, 10));
  h.queue.enqueue("register_collision", "n1@example.org", content("n1"));
  h.queue.enqueue("register_collision", "n2@example.org", content("n2"));
  h.queue.enqueue("verify_email", "v1@example.org", content("v1"));
  assert.deepEqual(h.queue.enqueue("password_changed", "s1@example.org", content("s1")), { queued: true, id: 5 });
  assert.deepEqual(h.queue.enqueue("register_collision", "n3@example.org", content("n3")), { queued: false, reason: "queue_full" });
  h.release();
  await h.queue.flush();
  assert.deepEqual(h.sent.map((m) => m.subject), ["busy", "s1", "v1", "n1"]);
  assert.equal(h.queue.stats().dropped.queue_full, 2);
});

test("max age: a message that waited too long is dropped, not sent late", async () => {
  const now = { t: 0 };
  const h = harness({ clock: () => now.t, config: { maxAgeMs: 1_000 } });
  h.gate.held = true;
  h.queue.enqueue("verify_email", "a@example.org", content("a"));
  await new Promise((r) => setTimeout(r, 10));
  h.queue.enqueue("verify_email", "b@example.org", content("b"));
  now.t = 5_000;
  h.release();
  await h.queue.flush();
  assert.deepEqual(h.sent.map((m) => m.subject), ["a"]);
  assert.equal(h.queue.stats().dropped.stale, 1);
});

test("SMTP errors: transient retries, a 5xx for the mailbox suppresses it (all variants), other 5xx neither", async () => {
  const tries = new Map();
  const errors = {
    "flaky@example.org": [Object.assign(new Error("421 try later"), { responseCode: 421, command: "RCPT TO" })],
    "gone@example.org": [Object.assign(new Error("550 5.1.1 no such user"), { responseCode: 550, code: "EENVELOPE", response: "550 5.1.1 <gone@example.org> no such user" })],
    "policy@example.org": [Object.assign(new Error("550 5.7.1 rejected"), { responseCode: 550, code: "EENVELOPE", response: "550 5.7.1 policy" })],
  };
  const h = harness({
    deliver: async (to, c) => {
      const n = tries.get(to) ?? 0;
      tries.set(to, n + 1);
      const fail = errors[to]?.[n];
      if (fail) throw fail;
      h.sent.push({ to, subject: c.subject });
    },
  });
  for (const to of Object.keys(errors)) h.queue.enqueue("verify_email", to, content(to));
  await h.queue.flush();
  assert.deepEqual(h.sent.map((m) => m.to), ["flaky@example.org"], "the 421 was retried; both 550s failed for good");
  assert.equal(h.queue.stats().retried, 1);
  assert.equal(h.queue.stats().failed, 2);
  assert.equal(h.suppression.size(Date.now()), 1);
  assert.ok(h.events.some((e) => e.kind === "mail_suppressed" && e.domain === "example.org"));
  h.queue.enqueue("reset_password", "Gone+again@example.org", content("again"));
  h.queue.enqueue("verify_email", "policy@example.org", content("policy-again"));
  await h.queue.flush();
  assert.equal(h.queue.stats().dropped.suppressed, 1, "the suppressed mailbox gets nothing, whatever the variant");
  assert.equal(h.sent.at(-1).subject, "policy-again", "a policy 5xx does not suppress");
  assert.ok(h.failures.every((f) => f.to.includes("@")));
});

test("classifySmtpError table", () => {
  const c = (e) => classifySmtpError(e);
  assert.equal(c(new Error("ECONNRESET")), "transient");
  assert.equal(c({ responseCode: 451, command: "RCPT TO" }), "transient");
  assert.equal(c({ responseCode: 550, command: "RCPT TO", response: "550 5.1.1 unknown" }), "recipient");
  assert.equal(c({ responseCode: 550, code: "EENVELOPE", response: "550 5.2.1 disabled" }), "recipient");
  assert.equal(c({ responseCode: 552, code: "EENVELOPE", response: "552 5.2.2 full" }), "permanent");
  assert.equal(c({ responseCode: 554, command: "RCPT TO", response: "554 5.7.1 relay denied" }), "permanent");
  assert.equal(c({ responseCode: 550, command: "RCPT TO" }), "recipient");
  assert.equal(c({ responseCode: 554, command: "DATA", response: "554 5.6.0 content" }), "permanent");
  assert.equal(c({ responseCode: 535, command: "AUTH PLAIN" }), "permanent");
});

test("suppression list on disk: keyed hashes only, survives a restart (async load), expires, bounded", async () => {
  const path = join(dataDir, "suppressed-test.json");
  const hash = keyed("server-a");
  const a = new SuppressionList({ path, hash, ttlMs: 1_000, max: 10 });
  await a.ready();
  a.add("dead@example.org", "smtp_5xx", 0);
  a.add("other@example.org", "bounce", 0);
  await a.save();
  // The live clock is far past these test stamps: restore with a clock-free check of the raw file first.
  assert.ok(!readFileSync(path, "utf8").includes("example.org"), "no address in the file");
  await a.dispose();
  const now = Date.now();
  const b = new SuppressionList({ path: join(dataDir, "suppressed-live.json"), hash, ttlMs: 60_000, max: 10 });
  await b.ready();
  b.add("dead@example.org", "smtp_5xx", now);
  b.add("other@example.org", "bounce", now);
  assert.equal(b.remove("other@example.org"), true);
  await b.dispose();
  const c = new SuppressionList({ path: join(dataDir, "suppressed-live.json"), hash, ttlMs: 60_000, max: 10 });
  assert.equal(c.has("dead@example.org", now), false, "nothing is known before the load");
  await c.ready();
  assert.equal(c.has("dead@example.org", now + 1), true, "a suppression survives a restart");
  assert.equal(c.has("other@example.org", now + 1), false, "a removal survives a restart");
  assert.equal(c.has("dead@example.org", now + 120_000), false, "after the TTL it may receive again");
  const otherKey = new SuppressionList({ path: join(dataDir, "suppressed-live.json"), hash: keyed("server-b"), ttlMs: 60_000, max: 10 });
  await otherKey.ready();
  assert.equal(otherKey.has("dead@example.org", now + 1), false, "keys depend on the server's secret");
  const capped = new SuppressionList({ path: null, hash, ttlMs: 1_000, max: 3 });
  for (let i = 0; i < 6; i += 1) capped.add(`u${i}@example.org`, "x", i);
  assert.equal(capped.size(10), 3, "bounded");
});

test("budgets on disk: day counts, domains and mailboxes survive a restart; no address or domain in the file", async () => {
  const path = join(dataDir, "budgets-test.json");
  const config = budgetConfig({ global: [{ max: 6, windowMs: 24 * H }], mailbox: [{ max: 2, windowMs: 24 * H }], domain: [{ max: 3, windowMs: 24 * H }], newDomain: [{ max: 100, windowMs: H }] });
  const hash = keyed("budget");
  const now = Date.now();
  const subject = (mailbox, kind = "verify_email") => ({ kind, cls: kind === "password_changed" ? "security" : "verification", mailbox, domain: mailbox.split("@")[1], big: false, risky: false });
  const a = new MailBudgets(config, { path, hash });
  await a.ready();
  a.commit(subject("victim@corp.example.org"), now);
  a.commit(subject("victim@corp.example.org"), now);
  a.commit(subject("x@corp.example.org"), now);
  a.commit(subject("y@other.example.net"), now);
  await a.dispose();
  const text = readFileSync(path, "utf8");
  assert.ok(!/example|victim/.test(text), "only keyed hashes on disk");
  const b = new MailBudgets(config, { path, hash });
  await b.ready();
  assert.equal(b.usage(now + 1).day, 4, "the global day count survived");
  assert.equal(b.check(subject("victim@corp.example.org"), now + 1), "mailbox", "the mailbox budget survived");
  assert.equal(b.check(subject("z@corp.example.org"), now + 1), "domain", "the domain day cap survived");
  assert.equal(b.check(subject("new@third.example.com"), now + 1), null);
  b.commit(subject("new@third.example.com"), now + 1);
  assert.equal(b.check(subject("w@fourth.example.com"), now + 2), "global", "verification's 90 % share of 6/day is used up across the restart");
  assert.equal(b.check(subject("s@fourth.example.com", "password_changed"), now + 2), null, "security keeps the headroom");
  const stranger = new MailBudgets(config, { path, hash: keyed("another-server") });
  await stranger.ready();
  assert.equal(stranger.check(subject("victim@corp.example.org"), now + 1), null, "names are keyed: another secret sees nothing");
  // A damaged file starts empty instead of crashing.
  const broken = join(dataDir, "budgets-broken.json");
  (await import("node:fs")).writeFileSync(broken, "{not json");
  const c = new MailBudgets(config, { path: broken, hash });
  await c.ready();
  assert.equal(c.usage(now).day, 0);
});

test("the queue admits nothing before the persisted counters are loaded", async () => {
  let loaded;
  const ready = new Promise((resolve) => { loaded = resolve; });
  const h = harness({ ready: () => ready });
  h.queue.enqueue("verify_email", "early@example.org", content("early"));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.sent.length, 0, "waiting for the load");
  loaded();
  await h.queue.flush();
  assert.deepEqual(h.sent.map((m) => m.subject), ["early"]);
});

test("queue cap: security mail is never the one dropped (it evicts a notice, then a verification)", async () => {
  const h = harness({ config: { maxQueued: 2 } });
  h.gate.held = true;
  h.queue.enqueue("verify_email", "busy@example.org", content("busy"));
  await new Promise((r) => setTimeout(r, 10));
  h.queue.enqueue("pending_released", "v@example.org", content("released"));
  h.queue.enqueue("register_collision", "n@example.org", content("notice"));
  assert.equal(h.queue.enqueue("login_lockout", "s1@example.org", content("lockout")).queued, true, "evicts the notice");
  assert.equal(h.queue.enqueue("admin_alert", "s2@example.org", content("alert")).queued, true, "evicts the verification");
  assert.deepEqual(h.queue.enqueue("password_changed", "s3@example.org", content("full")), { queued: false, reason: "queue_full" }, "only security left: refused, nothing evicted");
  assert.deepEqual(h.queue.enqueue("verify_email", "v2@example.org", content("v2")), { queued: false, reason: "queue_full" });
  h.release();
  await h.queue.flush();
  assert.deepEqual(h.sent.map((m) => m.subject), ["busy", "lockout", "alert"]);
});

test("bounded key maps: a full map refuses new mailboxes and never evicts a bucket that still counts", async () => {
  const h = harness({ budgets: { maxKeys: 3, mailbox: [{ max: 1, windowMs: H }] } });
  for (let i = 0; i < 3; i += 1) h.queue.enqueue("verify_email", `k${i}@example.org`, content());
  await h.queue.flush();
  h.queue.enqueue("verify_email", "k3@example.org", content());
  h.queue.enqueue("verify_email", "k0@example.org", content());
  await h.queue.flush();
  assert.equal(h.sent.length, 3);
  assert.equal(h.queue.stats().dropped.capacity, 1);
  assert.equal(h.queue.stats().dropped.mailbox, 1, "k0's bucket still counted");
});

test("address policy in the queue: a refused address is dropped before delivery and recorded", async () => {
  const h = harness({ policy: async (to) => (to.endsWith("@mailinator.com") ? { ok: false, reason: "disposable", domain: "mailinator.com" } : ok(to)) });
  h.queue.enqueue("verify_email", "x@mailinator.com", content());
  h.queue.enqueue("verify_email", "not an address", content());
  await h.queue.flush();
  assert.equal(h.sent.length, 0);
  assert.deepEqual(h.queue.stats().dropped, { policy: 1, invalid: 1 });
  assert.ok(h.events.some((e) => e.kind === "mail_policy" && e.detail === "disposable"));
});

test("parseRates: valid specs, and anything malformed keeps the safe default", () => {
  const fallback = [{ max: 3, windowMs: H }];
  assert.deepEqual(parseRates("30/m, 300/h,1500/d", fallback), [{ max: 30, windowMs: 60_000 }, { max: 300, windowMs: H }, { max: 1_500, windowMs: 24 * H }]);
  assert.deepEqual(parseRates("5/15m", fallback), [{ max: 5, windowMs: 15 * 60_000 }]);
  for (const bad of ["lots", "3/x", "-1/h", "3/h,oops", "3/0h"]) assert.deepEqual(parseRates(bad, fallback), fallback, bad);
  assert.deepEqual(parseRates(undefined, fallback), fallback);
  const defaults = mailBudgetConfig({});
  assert.equal(defaults.perMinute, 30);
  assert.deepEqual(defaults.mailbox, [{ max: 3, windowMs: H }, { max: 6, windowMs: 24 * H }]);
  assert.deepEqual(defaults.collision, [{ max: 1, windowMs: 24 * H }]);
});

test("every template names its kind; security notices are security class (never first dropped)", async () => {
  const kinds = await import("../src/lib/mail/kinds.ts");
  const alerts = await import("../src/lib/security/alerts.ts");
  const cases = [
    [templates.verifyEmailMail("ann", "https://x/verify?token=t"), "verify_email", "verification"],
    [templates.pendingReleasedMail("https://x/register"), "pending_released", "verification"],
    [templates.loginLockoutMail("ann", "https://x/forgot-password"), "login_lockout", "security"],
    [templates.registerCollisionMail("https://x"), "register_collision", "notice"],
    [templates.usernameTakenMail("ann", "https://x"), "username_taken", "notice"],
    [templates.resetPasswordMail("ann", "https://x"), "reset_password", "verification"],
    [templates.changeEmailMail("ann", "a@b.example", "https://x"), "change_email", "verification"],
    [templates.emailChangedNoticeMail("ann", "a@b.example"), "email_changed", "security"],
    [templates.emailInUseMail("https://x"), "email_in_use", "notice"],
    [templates.passwordChangedMail("ann", 2), "password_changed", "security"],
    [templates.accountDeletedMail("ann"), "account_deleted", "security"],
    [alerts.digestMail([]), "admin_alert", "security"],
  ];
  for (const [mail, kind, cls] of cases) {
    assert.equal(mail.kind, kind, mail.subject);
    assert.equal(kinds.mailClass(mail.kind), cls, kind);
  }
  assert.match(templates.passwordChangedMail("ann", 2).text, /Your 2 MCP keys were revoked/, "HEAD's signature and text kept");
  assert.equal(alerts.isAlertWorthy({ kind: "mail_suppressed", detail: { domain: "example.org" } }), true, "suppressions reach the digest");
  assert.equal(alerts.isAlertWorthy({ kind: "mail_budget", detail: { reason: "global" } }), true);
});

test("the real module: outbox delivery through the queue, stats, variants share a budget, budgets and suppression survive a restart", async () => {
  process.env.KNIFE_MAIL_MAILBOX_LIMITS = "2/h";
  const mail = await import("../src/lib/mail/index.ts");
  await mail.resetMailForTests();
  mail.sendMail("Ann+1@example.com", templates.verifyEmailMail("ann", "https://x/verify?token=a"));
  mail.sendMail("ann+2@example.com", templates.verifyEmailMail("ann", "https://x/verify?token=b"));
  mail.sendMail("ann+3@example.com", templates.verifyEmailMail("ann", "https://x/verify?token=c"));
  assert.deepEqual(mail.queueMail("admin_alert", "owner@example.com", { subject: "alert", text: "t", html: "<p>t</p>" }).queued, true);
  await mail.flushMail();
  const files = () => readdirSync(join(dataDir, "mail-outbox"));
  assert.equal(files().filter((f) => f.includes("ann")).length, 2, files().join(","));
  assert.equal(files().filter((f) => f.includes("owner")).length, 1);
  const stats = mail.mailStats();
  assert.equal(stats.transport, "outbox");
  assert.equal(stats.dropped.mailbox, 1);
  assert.equal(stats.sent, 3);
  assert.equal(stats.queued, 0);
  assert.equal(stats.policy.disposable.source, "snapshot");
  await assert.rejects(mail.sendMailNow("x@mailinator.com", templates.verifyEmailMail("x", "https://x")), /policy/);
  assert.equal(mail.suppressMailbox("Dead+x@example.com", "bounce"), true);
  await assert.rejects(mail.sendMailNow("dead@example.com", templates.passwordChangedMail("dead")), /suppressed/);
  assert.equal(mail.maskAddress("alice@example.com"), "a***@example.com");

  // Restart: a fresh queue (new process state) reloads the counters and the suppression list from disk.
  await mail.resetMailForTests();
  for (const name of ["budgets.json", "suppressed.json"]) {
    const text = readFileSync(join(dataDir, "mail", name), "utf8");
    assert.ok(!/ann|dead|example\.com/.test(text), `${name} holds no address or domain`);
  }
  mail.sendMail("ANN+after@example.com", templates.verifyEmailMail("ann", "https://x/verify?token=d"));
  await mail.flushMail();
  assert.equal(files().filter((f) => f.includes("ann")).length, 2, "the mailbox budget survived the restart");
  assert.deepEqual(mail.mailStats().dropped, { mailbox: 1 });
  await assert.rejects(mail.sendMailNow("DEAD@example.com", templates.passwordChangedMail("dead")), /suppressed/, "the suppression survived the restart");
  assert.equal(mail.mailStats().budget.day, 3, "the global day count survived");
  assert.equal(typeof mailKeyHash("x"), "string");
  delete process.env.KNIFE_MAIL_MAILBOX_LIMITS;
  await mail.resetMailForTests();
});

test("senderAddress: the bare From address for the sign-in pages' spam hint, never a placeholder", async () => {
  const { senderAddress } = await import("../src/lib/mail/index.ts");
  assert.equal(senderAddress({ KNIFE_SMTP_FROM: "Smart Knife <no-reply@mail.example.org>" }), "no-reply@mail.example.org");
  assert.equal(senderAddress({ KNIFE_SMTP_FROM: "no-reply@mail.example.org" }), "no-reply@mail.example.org");
  assert.equal(senderAddress({}), "", "the built-in .invalid default is not shown");
  assert.equal(senderAddress({ KNIFE_SMTP_FROM: "Broken <nothing here>" }), "");
});
