// Security event log (src/lib/security/events-core.mjs + events.ts), the one API for every module: both call shapes and
// the older aliases, coalescing, 0600 daily files in a 0700 dir, 30-day retention (also of the old single events.jsonl),
// drop-on-overflow, sanitising (no query strings, no full IPv6 address, flat short details), the ring reloaded after a
// restart, and the admin alert digest (alerts.ts): mailed (outbox transport) to active confirmed admins only, at most once
// per interval, escaped.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/security_events.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "knife-sec-events-"));
process.env.KNIFE_DATA_DIR = dataDir;
process.env.KNIFE_MAIL_TRANSPORT = "outbox";
process.env.KNIFE_AUTH_MODE = "public";
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const core = await import("../src/lib/security/events-core.mjs");
const events = await import("../src/lib/security/events.ts");
const alerts = await import("../src/lib/security/alerts.ts");
const store = await import("../src/lib/accounts/store.ts");
const secDir = join(dataDir, "security");
const today = () => new Date().toISOString().slice(0, 10);

test("events are coalesced, flushed to a 0600 daily file in a 0700 dir, and sanitised", async () => {
  core.resetSecurityEventsForTests();
  for (let i = 0; i < 5; i++) events.recordSecurityEvent({ kind: "rate_block", ipPrefix: "203.0.113.1", path: "/api/x?token=secret", detail: "budget:api" });
  events.recordSecurityEvent({ kind: "nonsense", detail: "line\nbreak\u0000" });
  await events.flushSecurityEvents();
  const file = join(secDir, `events-${today()}.jsonl`);
  assert.equal(statSync(secDir).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const lines = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].count, 5, "five identical events, one line");
  assert.equal(lines[0].path, "/api/x", "query string never logged");
  assert.equal(lines[1].kind, "other");
  assert.equal(lines[1].label, "nonsense");
  assert.equal(lines[1].detail, "line break ");
});

test("drop on overflow: a flood of distinct events is capped and the drop itself is logged", async () => {
  core.resetSecurityEventsForTests();
  for (let i = 0; i < 5_000; i++) events.recordSecurityEvent({ kind: "rate_block", path: `/api/${i}` });
  await events.flushSecurityEvents();
  const lines = readFileSync(join(secDir, `events-${today()}.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const dropped = lines.find((line) => /dropped/.test(line.detail ?? ""));
  assert.ok(dropped, "a quota_full line says how many were dropped");
  assert.match(dropped.detail, /3000 event/);
});

test("retention: files older than 30 days are deleted on the first write of a day; the ring reloads after a restart", async () => {
  mkdirSync(secDir, { recursive: true });
  writeFileSync(join(secDir, "events-2000-01-01.jsonl"), "{}\n");
  writeFileSync(join(secDir, "notes.txt"), "keep");
  core.resetSecurityEventsForTests();
  events.recordSecurityEvent({ kind: "scanner_block", ipPrefix: "198.51.100.1", detail: "scanner: blocked 15m (level 1)" });
  await events.flushSecurityEvents();
  assert.equal(existsSync(join(secDir, "events-2000-01-01.jsonl")), false);
  assert.equal(existsSync(join(secDir, "notes.txt")), true, "only event files are pruned");
  core.resetSecurityEventsForTests(); // restart: memory gone
  assert.equal(events.recentSecurityEvents().length, 0);
  await events.loadSecurityHistory();
  const recent = events.recentSecurityEvents();
  assert.ok(recent.some((event) => event.kind === "scanner_block" && event.ipPrefix === "198.51.100.1"), "loaded from the file tail");
  assert.ok(readdirSync(secDir).every((name) => !name.endsWith(".tmp")));
});

test("one API: object and positional shapes, older aliases (type/accountId/ip), mail_* kinds, flat details", async () => {
  core.resetSecurityEventsForTests();
  events.recordSecurityEvent({ kind: "hash_busy" });
  events.recordSecurityEvent({ kind: "login_lockout", account: "alice", ipPrefix: "203.0.113.5", detail: undefined });
  events.recordSecurityEvent({ type: "github-app-access-lost", accountId: "carol", detail: { reason: "relink" } });
  events.recordSecurityEvent({ type: "outbound-budget", accountId: "dave", detail: { purpose: "page", limit: 30, admin: false, nested: { x: 1 } } });
  events.recordSecurityEvent("mail_suppressed", { domain: "example.com", reason: "x".repeat(500) });
  events.recordSecurityEvent("mail_bounce_storm", "many bounces", { account: "erin" });
  events.recordSecurityEvent("tool_timeout", "pdf: ocr killed after 120 s", { account: "frank", path: "/api/pdf?x=1" });
  events.recordSecurityEvent({ kind: "pow_fail", ip: "2001:db8:aa:bb:1:2:3:4", path: "login" });
  const got = events.recentSecurityEvents();
  const by = (kind) => got.find((event) => event.kind === kind);
  assert.equal(by("hash_busy").count, 1);
  assert.deepEqual([by("login_lockout").account, by("login_lockout").ipPrefix], ["alice", "203.0.113.5"]);
  assert.deepEqual([by("github_app_access_lost").account, by("github_app_access_lost").detail], ["carol", { reason: "relink" }]);
  assert.deepEqual(by("outbound_budget").detail, { purpose: "page", limit: 30, admin: false }, "nested values dropped");
  assert.equal(by("outbound_budget").account, "dave");
  assert.equal(by("mail_suppressed").detail.reason.length, 120, "detail strings capped");
  assert.deepEqual([by("mail_bounce_storm").detail, by("mail_bounce_storm").account], ["many bounces", "erin"]);
  assert.deepEqual([by("tool_timeout").path, by("tool_timeout").account], ["/api/pdf", "frank"]);
  assert.equal(by("pow_fail").ipPrefix, "2001:0db8:00aa:00bb::/64", "a raw address is reduced to its /64");
  assert.ok(got.every((event) => !("type" in event) && !("accountId" in event) && !("ip" in event)), "one stored shape");
  assert.match(events.describeSecurityEvent(by("outbound_budget")), /outbound_budget {2}account dave {2}purpose=page limit=30 admin=false/);
  await events.flushSecurityEvents();
});

test("the old single events.jsonl becomes a dated legacy file and ages out with the rest", async () => {
  mkdirSync(secDir, { recursive: true });
  for (const name of readdirSync(secDir)) rmSync(join(secDir, name), { force: true });
  const legacy = join(secDir, "events.jsonl");
  writeFileSync(legacy, `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", kind: "login_lockout" })}\n`);
  core.resetSecurityEventsForTests();
  events.recordSecurityEvent({ kind: "rate_block" });
  await events.flushSecurityEvents();
  assert.equal(existsSync(legacy), false);
  const adopted = readdirSync(secDir).filter((name) => name.endsWith(".legacy.jsonl"));
  assert.equal(adopted.length, 1, readdirSync(secDir).join(","));
  assert.match(adopted[0], /^events-\d{4}-\d{2}-\d{2}\.legacy\.jsonl$/);
});

test("recording is cheap: 100k events take well under a second and never throw on junk input", () => {
  core.resetSecurityEventsForTests();
  const start = performance.now();
  for (let i = 0; i < 100_000; i++) events.recordSecurityEvent({ kind: "rate_block", ipPrefix: `198.51.100.${i % 50}`, path: "/api/x" });
  for (const junk of [null, undefined, 42, "x", { kind: { toString: () => { throw new Error("boom"); } } }]) events.recordSecurityEvent(junk);
  assert.ok(performance.now() - start < 1_500, `${Math.round(performance.now() - start)} ms`);
  core.resetSecurityEventsForTests();
});

test("alerts: only serious events page, the digest goes to active confirmed admins once per interval", async () => {
  core.resetSecurityEventsForTests();
  assert.equal(alerts.isAlertWorthy({ kind: "scanner_block", detail: "scanner: blocked 24h (level 3)" }), true);
  assert.equal(alerts.isAlertWorthy({ kind: "scanner_block", detail: "scanner: blocked 15m (level 1)" }), false);
  assert.equal(alerts.isAlertWorthy({ kind: "login_lockout", detail: "login-global:all" }), true);
  assert.equal(alerts.isAlertWorthy({ kind: "mail_budget", detail: { domain: "example.com" } }), true, "record details too");
  assert.equal(alerts.isAlertWorthy({ kind: "login_lockout", detail: "login:account" }), false);
  assert.equal(alerts.isAlertWorthy({ kind: "rate_block" }), false);
  const html = alerts.digestMail([{ ts: new Date().toISOString(), kind: "other", detail: "<script>", count: 1 }]).html;
  assert.equal(html.includes("<script>"), false);

  const now = new Date().toISOString();
  store.mutateStore((s) => {
    s.accounts.push(store.newAccountRecord({ id: "boss", displayName: "Boss", role: "admin", status: "active", email: "boss@example.com", emailVerifiedAt: now }));
    s.accounts.push(store.newAccountRecord({ id: "ghost", displayName: "Ghost", role: "admin", status: "disabled", email: "ghost@example.com", emailVerifiedAt: now }));
    s.accounts.push(store.newAccountRecord({ id: "user", displayName: "User", role: "user", status: "active", email: "user@example.com", emailVerifiedAt: now }));
  });
  alerts.startSecurityAlerts();
  events.recordSecurityEvent({ kind: "rate_block", detail: "not alert-worthy" });
  events.recordSecurityEvent({ kind: "scanner_block", ipPrefix: "2001:0db8:0001::/48", detail: "scanner: blocked 24h (level 3)" });
  events.recordSecurityEvent({ kind: "mail_budget", detail: "global hourly mail budget" });
  assert.equal(alerts.alertStatus().pending, 2);
  assert.equal(alerts.flushSecurityAlerts(Date.now(), true), 1, "one recipient: the active, confirmed admin");
  events.recordSecurityEvent({ kind: "disk_low", detail: "100 MB free" });
  assert.equal(alerts.flushSecurityAlerts(Date.now()), 0, "not again within the interval");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const outbox = join(dataDir, "mail-outbox");
  const mails = readdirSync(outbox);
  assert.equal(mails.length, 1, mails.join(","));
  assert.ok(mails[0].includes("boss"));
  const text = readFileSync(join(outbox, mails[0]), "utf8");
  assert.match(text, /security alert/i);
  assert.match(text, /2001:0db8:0001::\/48/);
  assert.equal(/not alert-worthy/.test(text), false);
});
