// Email address policy (src/lib/accounts/email-policy.ts): canonical mailbox keys, every static reject class, the
// disposable list (domain and every parent, downloaded list vs vendored snapshot), owner allow/deny files that win and
// reload on change, the MX check against a fake resolver (null MX, NXDOMAIN, implicit MX, private MX, DNS failure ->
// mailRisk, cache, de-duplication), and the wiring into register / email change / GitHub sign-up.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/email_policy.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "sk-email-policy-"));
process.env.KNIFE_DATA_DIR = dataDir;
process.env.KNIFE_MAIL_TRANSPORT = "outbox";
process.env.KNIFE_AUTH_MODE = "public";
process.env.KNIFE_PUBLIC_URL = "https://knife.example.org";
process.env.KNIFE_SMTP_FROM = "Smart Knife <knife-mail@mail.example.org>";
delete process.env.KNIFE_EMAIL_POLICY;
delete process.env.KNIFE_EMAIL_DNS;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const policy = await import("../src/lib/accounts/email-policy.ts");
const listDir = join(dataDir, "email-policy");

/** Fake resolver: `zones[name] = { mx?: [...] | "NXDOMAIN" | "NODATA" | "SERVFAIL", a?: [...], aaaa?: [...] }`. */
function fakeResolver(zones, calls = []) {
  const fail = (code) => Object.assign(new Error(code), { code });
  const answer = (name, field) => {
    calls.push(`${field}:${name}`);
    const zone = zones[name];
    if (!zone) return Promise.reject(fail("ENOTFOUND"));
    const value = zone[field];
    if (value === "SERVFAIL") return Promise.reject(fail("ESERVFAIL"));
    if (value === "TIMEOUT") return Promise.reject(fail("ETIMEOUT"));
    if (value === "NXDOMAIN") return Promise.reject(fail("ENOTFOUND"));
    if (value === undefined || value === "NODATA") return Promise.reject(fail("ENODATA"));
    return Promise.resolve(value);
  };
  return { resolveMx: (n) => answer(n, "mx"), resolve4: (n) => answer(n, "a"), resolve6: (n) => answer(n, "aaaa") };
}

test("canonical mailbox key: case, +tags, gmail dots and googlemail, Yahoo dash tags, IDN, trailing dot", () => {
  const key = policy.canonicalEmailKey;
  assert.equal(key("Vic.Tim+promo@GoogleMail.com"), "victim@gmail.com");
  assert.equal(key("v.i.c.t.i.m@gmail.com."), "victim@gmail.com");
  assert.equal(key("victim+1+2@gmail.com"), "victim@gmail.com");
  assert.equal(key("first.last+x@example.org"), "first.last@example.org", "dots only fold for providers that ignore them");
  assert.equal(key("base-shop@yahoo.com"), "base@yahoo.com");
  assert.equal(key("base-shop@example.org"), "base-shop@example.org");
  assert.equal(key("jan@Bücher.de"), "jan@xn--bcher-kva.de");
  assert.equal(key("a@b@example.org"), null, "one @ only");
  assert.equal(key("a b@example.org"), null);
});

test("every static reject class", () => {
  const r = (address) => policy.staticReject(address);
  assert.equal(r("user@[192.0.2.1]"), "ip_literal");
  assert.equal(r("user@192.0.2.1"), "ip_literal");
  assert.equal(r("user@[IPv6:2001:db8::1]"), "ip_literal");
  assert.equal(r("user@localhost"), "single_label");
  assert.equal(r("user@com"), "single_label");
  for (const tld of ["invalid", "test", "example", "localhost", "local", "internal", "onion"]) assert.equal(r(`user@host.${tld}`), "reserved_tld", tld);
  assert.equal(r("user@knife.example.org"), "own_domain", "the app's own host");
  assert.equal(r("user@sub.knife.example.org"), "own_domain", "and its subdomains");
  assert.equal(r("Knife-Mail+x@mail.example.org"), "own_domain", "the From address itself (mail loop)");
  assert.equal(r("someone@mail.example.org"), null, "other mailboxes on the From domain are fine (the owner's own mail)");
  for (const local of ["postmaster", "abuse", "mailer-daemon", "noreply", "root"]) assert.equal(r(`${local}@example.org`), "reserved_local", local);
  assert.equal(r("abuse+tag@example.org"), "reserved_local");
  for (const bad of ["@example.org", "user@", "a..b@example.org", ".a@example.org", `${"x".repeat(65)}@example.org`, "user@-bad-.org", "user@exa mple.org"]) {
    assert.equal(r(bad), "syntax", bad);
  }
  assert.equal(r("jan.kowalski@wp.pl"), null);
});

test("disposable list: domain and every parent domain, never a mere suffix; the snapshot ships with the code", () => {
  const sync = (address) => policy.checkEmailPolicySync(address);
  assert.deepEqual(sync("x@mailinator.com"), { ok: false, reason: "disposable", domain: "mailinator.com" });
  assert.equal(sync("x@inbox.mailinator.com").reason, "disposable");
  assert.equal(sync("x@a.b.c.mailinator.com").reason, "disposable");
  assert.equal(sync("x@mailinator.com.example.org").ok, true, "a list entry inside a longer name is not a parent");
  assert.equal(sync("x@xmailinator-co.example.org").ok, true, "a suffix of the label is not a parent domain");
  assert.equal(sync("X@GUERRILLAMAIL.COM").reason, "disposable", "case-insensitive");
  assert.equal(policy.emailLists().disposableSource, "snapshot");
  assert.ok(policy.emailLists().disposable.size > 5_000);
});

test("downloaded list replaces the snapshot only when it validates; owner allow/deny win and reload on change", () => {
  mkdirSync(listDir, { recursive: true });
  const later = (ms) => policy.emailLists(Date.now() + ms);
  const base = [...policy.SURELY_DISPOSABLE, ...Array.from({ length: 1_200 }, (_, i) => `throwaway${i}.example.net`)];
  writeFileSync(join(listDir, "disposable.txt"), `# comment\n${[...base, "gmail.com"].join("\n")}\n`);
  assert.equal(later(10_000).disposableSource, "snapshot", "a list that blocks gmail.com is refused");
  writeFileSync(join(listDir, "disposable.txt"), `${base.join("\n")}\n`);
  utimesSync(join(listDir, "disposable.txt"), new Date(), new Date(Date.now() + 2_000));
  assert.equal(later(20_000).disposableSource, "download");
  assert.equal(policy.checkEmailPolicySync("x@throwaway7.example.net").reason, "disposable");

  writeFileSync(join(listDir, "allow.txt"), "mailinator.com\n");
  writeFileSync(join(listDir, "deny.txt"), "# owner list\nspam-co.example.net\nbadguy@gmail.com\nsub.allowed.example.org\n");
  writeFileSync(join(listDir, "allow.txt"), "mailinator.com\nallowed.example.org\n");
  later(30_000);
  assert.equal(policy.checkEmailPolicySync("x@mailinator.com").ok, true, "owner allow beats the disposable list");
  assert.equal(policy.checkEmailPolicySync("x@deep.spam-co.example.net").reason, "denied", "deny covers subdomains");
  assert.equal(policy.checkEmailPolicySync("Bad.Guy+again@googlemail.com").reason, "denied", "a denied address matches canonically");
  assert.equal(policy.checkEmailPolicySync("x@sub.allowed.example.org").reason, "denied", "the more specific deny wins over a parent allow");
  assert.equal(policy.checkEmailPolicySync("x@other.allowed.example.org").ok, true);
  assert.equal(policy.checkEmailPolicySync("postmaster@allowed.example.org").reason, "reserved_local", "allow never lifts the static rules");

  rmSync(listDir, { recursive: true, force: true });
  later(40_000);
  assert.equal(policy.checkEmailPolicySync("x@mailinator.com").reason, "disposable", "files gone -> snapshot again");
});

test("disposableListProblem: too small, junk lines, poisoned, truncated, shrinking", () => {
  const list = (domains, invalid = 0) => ({ domains: new Set(domains), addresses: new Set(), invalid });
  const good = [...policy.SURELY_DISPOSABLE, ...Array.from({ length: 2_000 }, (_, i) => `d${i}.example.net`)];
  assert.equal(policy.disposableListProblem(list(good)), null);
  assert.match(policy.disposableListProblem(list(good.slice(0, 10))), /only/);
  assert.match(policy.disposableListProblem(list(good, 500)), /not domains/);
  assert.match(policy.disposableListProblem(list([...good, "outlook.com"])), /outlook.com/);
  assert.match(policy.disposableListProblem(list(good.slice(4))), /lacks/);
  assert.match(policy.disposableListProblem(list(good), 10_000), /shrank/);
});

test("MX check: MX ok, null MX, NXDOMAIN, implicit MX, no mail at all, private/loopback MX hosts, DNS failure = risk", async () => {
  const zones = {
    "ok.example.net": { mx: [{ exchange: "mx.ok.example.net", priority: 10 }] },
    "mx.ok.example.net": { a: ["198.51.200.10"] },
    "nullmx.example.net": { mx: [{ exchange: "", priority: 0 }] },
    "implicit.example.net": { mx: "NODATA", a: ["198.51.200.11"] },
    "nothing.example.net": { mx: "NODATA" },
    "private.example.net": { mx: [{ exchange: "mx1.private.example.net", priority: 10 }, { exchange: "mx2.private.example.net", priority: 20 }] },
    "mx1.private.example.net": { a: ["10.0.0.5"] },
    "mx2.private.example.net": { a: ["127.0.0.1"], aaaa: ["::1"] },
    "implicit-private.example.net": { mx: "NODATA", a: ["192.168.1.2"] },
    "dangling.example.net": { mx: [{ exchange: "gone.example.net", priority: 5 }] },
    "servfail.example.net": { mx: "SERVFAIL" },
    "mxfail.example.net": { mx: [{ exchange: "slow.example.net", priority: 5 }] },
    "slow.example.net": { a: "TIMEOUT", aaaa: "TIMEOUT" },
    "backup.example.net": { mx: [{ exchange: "mx1.private.example.net", priority: 1 }, { exchange: "mx.ok.example.net", priority: 50 }] },
  };
  const resolver = fakeResolver(zones);
  const check = (domain) => policy.checkMailDomain(domain, resolver);
  assert.deepEqual(await check("ok.example.net"), { status: "ok" });
  assert.deepEqual(await check("nullmx.example.net"), { status: "reject", reason: "null_mx" });
  assert.deepEqual(await check("missing.example.net"), { status: "reject", reason: "no_domain" });
  assert.deepEqual(await check("implicit.example.net"), { status: "ok" }, "no MX: the domain's own A record receives (RFC 5321)");
  assert.deepEqual(await check("nothing.example.net"), { status: "reject", reason: "no_mail" });
  assert.deepEqual(await check("private.example.net"), { status: "reject", reason: "private_mx" });
  assert.deepEqual(await check("implicit-private.example.net"), { status: "reject", reason: "private_mx" });
  assert.deepEqual(await check("dangling.example.net"), { status: "reject", reason: "no_mail" });
  assert.deepEqual(await check("servfail.example.net"), { status: "risk" });
  assert.deepEqual(await check("mxfail.example.net"), { status: "risk" });
  assert.deepEqual(await check("backup.example.net"), { status: "ok" }, "one public MX host is enough");
});

test("checkEmailPolicy: DNS verdicts, mailRisk on failure, cache (positive and negative), one lookup for parallel calls", async () => {
  const calls = [];
  policy.setMailResolverForTests(fakeResolver({
    "fine.example.net": { mx: [{ exchange: "mx.fine.example.net", priority: 1 }] },
    "mx.fine.example.net": { a: ["198.51.200.20"] },
    "nullmx.example.net": { mx: [{ exchange: "", priority: 0 }] },
    "flaky.example.net": { mx: "SERVFAIL" },
  }, calls));
  try {
    assert.deepEqual(await policy.checkEmailPolicy("Ann+x@Fine.example.net"), { ok: true, email: "ann+x@fine.example.net", canonical: "ann@fine.example.net", domain: "fine.example.net", mailRisk: false });
    assert.deepEqual(await policy.checkEmailPolicy("x@nullmx.example.net"), { ok: false, reason: "null_mx", domain: "nullmx.example.net" });
    const risky = await policy.checkEmailPolicy("x@flaky.example.net");
    assert.equal(risky.ok && risky.mailRisk, true, "DNS failure accepts, flagged");
    const before = calls.length;
    await policy.checkEmailPolicy("y@fine.example.net");
    await policy.checkEmailPolicy("y@nullmx.example.net");
    assert.equal(calls.length, before, "positive and negative answers are cached");
    assert.equal((await policy.checkEmailPolicy("x@mailinator.com")).reason, "disposable", "lists are checked before any DNS");
    assert.ok(!calls.some((c) => c.includes("mailinator")));

    policy.setMailResolverForTests(fakeResolver({ "par.example.net": { mx: "NODATA", a: ["198.51.200.30"] } }, calls));
    const n = calls.length;
    await Promise.all(Array.from({ length: 20 }, (_, i) => policy.checkEmailPolicy(`u${i}@par.example.net`)));
    assert.equal(calls.filter((c, i) => i >= n && c === "mx:par.example.net").length, 1, "parallel checks share one lookup");

    process.env.KNIFE_EMAIL_DNS = "off";
    assert.equal((await policy.checkEmailPolicy("x@unknown-domain.example.net")).ok, true, "KNIFE_EMAIL_DNS=off skips the MX check");
    delete process.env.KNIFE_EMAIL_DNS;
    assert.equal((await policy.checkEmailPolicy("x@unknown-domain.example.net")).reason, "no_domain");

    process.env.KNIFE_EMAIL_POLICY = "off";
    assert.equal((await policy.checkEmailPolicy("x@mailinator.com")).ok, true, "policy off: only the syntax");
    assert.equal((await policy.checkEmailPolicy("not-an-address")).ok, false);
    delete process.env.KNIFE_EMAIL_POLICY;
    assert.equal(policy.emailPolicyEnforced({ KNIFE_AUTH_MODE: "public" }), true);
    assert.equal(policy.emailPolicyEnforced({}), false, "private mode default: off");
    assert.equal(policy.emailPolicyEnforced({ KNIFE_EMAIL_POLICY: "enforce" }), true);
  } finally {
    policy.setMailResolverForTests(null);
  }
});

test("register, email change and GitHub sign-up refuse a disposable address with the generic message, before any work", async () => {
  process.env.KNIFE_EMAIL_DNS = "off";
  process.env.KNIFE_POW_BITS = "4";
  const flows = await import("../src/lib/accounts/flows.ts");
  const pow = await import("../src/lib/accounts/pow.ts");
  const solve = await import("../src/lib/pow/solve.ts");
  const solved = (form, ip) => {
    const { c, bits } = pow.issueChallenge(form, ip);
    return { c, nonce: solve.solvePow(c, bits) };
  };
  const store = await import("../src/lib/accounts/store.ts");
  const gaccounts = await import("../src/lib/github-app/accounts.ts");
  const mail = await import("../src/lib/mail/index.ts");
  const started = Date.now();
  const refused = await flows.register({ username: "temp1", email: "temp@sub.mailinator.com", password: "temp password 1" }, "203.0.113.50");
  assert.deepEqual(refused, { ok: false, status: 400, error: policy.EMAIL_POLICY_MESSAGE });
  assert.ok(Date.now() - started < 200, "refused before the password is hashed");
  // The list part needs no proof-of-work (it costs nothing), so a refused address is told so before solving one.
  assert.equal(store.getAccount("temp1"), undefined);
  const ip = await flows.register({ username: "temp2", email: "temp@[192.0.2.1]", password: "temp password 1" }, "203.0.113.51");
  assert.equal(ip.status, 400);

  const ok = await flows.register({ username: "real1", email: "real1@example.com", password: "real password 1" }, "203.0.113.52", solved("register", "203.0.113.52"));
  assert.equal(ok.ok, true);
  store.mutateStore((s) => { const a = s.accounts.find((x) => x.id === "real1"); a.status = "active"; a.emailVerifiedAt = new Date().toISOString(); });
  const change = await flows.changeEmail(store.getAccount("real1"), "real password 1", "moved@yopmail.com");
  assert.deepEqual(change, { ok: false, status: 400, error: policy.EMAIL_POLICY_MESSAGE });
  assert.equal(store.getAccount("real1").emailChange, undefined);

  const gh = gaccounts.signInWithGithub({ id: 4242, login: "tempgh", name: "Temp", verifiedEmail: "tempgh@guerrillamail.com" }, "203.0.113.53", true);
  assert.equal(gh.kind, "refused");
  assert.equal(gh.code, "email_refused");
  const ghOk = gaccounts.signInWithGithub({ id: 4243, login: "okgh", name: "Ok", verifiedEmail: "okgh@example.com" }, "203.0.113.54", true);
  assert.equal(ghOk.kind, "registered", "a GitHub-verified ordinary address signs up (no DNS lookup on this path)");

  await mail.flushMail();
  const outbox = join(dataDir, "mail-outbox");
  const names = existsSync(outbox) ? readdirSync(outbox) : [];
  assert.ok(!names.some((n) => /mailinator|yopmail|guerrilla|192\.0\.2/.test(n)), names.join(","));
  delete process.env.KNIFE_EMAIL_DNS;
});

test("register: the DNS part runs only after a paid proof-of-work (no outbound lookups for free)", async () => {
  const flows = await import("../src/lib/accounts/flows.ts");
  const pow = await import("../src/lib/accounts/pow.ts");
  const solve = await import("../src/lib/pow/solve.ts");
  const calls = [];
  policy.setMailResolverForTests(fakeResolver({ "nullmx.example.net": { mx: [{ exchange: "", priority: 0 }] } }, calls));
  const unpaid = await flows.register({ username: "dns1", email: "a@nullmx.example.net", password: "dns password 12" }, "203.0.113.60");
  assert.equal(unpaid.status, 428, "proof-of-work first");
  assert.equal(calls.length, 0, "no DNS lookup without a proof-of-work");
  const { c, bits } = pow.issueChallenge("register", "203.0.113.60");
  const paid = await flows.register({ username: "dns1", email: "a@nullmx.example.net", password: "dns password 12" }, "203.0.113.60", { c, nonce: solve.solvePow(c, bits) });
  assert.deepEqual(paid, { ok: false, status: 400, error: policy.EMAIL_POLICY_MESSAGE });
  assert.ok(calls.length > 0);
  policy.setMailResolverForTests(null);
  delete process.env.KNIFE_POW_BITS;
});

test("npm run email-lists -- update: validates, pins, refuses poisoned/shrunk lists and keeps the old one", async () => {
  const { updateDisposableList } = await import("../src/lib/accounts/email-lists/update.ts");
  const good = [...policy.SURELY_DISPOSABLE, ...Array.from({ length: 3_000 }, (_, i) => `drop${i}.example.net`)].join("\n");
  const urls = [];
  const serve = (text) => async (url) => { urls.push(url); return text; };
  const first = await updateDisposableList({ fetchText: serve(good), ref: "0123abc" });
  assert.equal(first.ok && first.domains, 3_004);
  assert.match(urls[0], /^https:\/\/raw\.githubusercontent\.com\/disposable-email-domains\/disposable-email-domains\/0123abc\//);
  assert.equal(policy.emailLists(Date.now() + 60_000).disposableSource, "download", "the server picks the file up by itself");
  assert.equal(policy.checkEmailPolicySync("x@drop42.example.net").reason, "disposable");

  assert.match((await updateDisposableList({ fetchText: serve(`${good}\ngmail.com`) })).error, /gmail\.com/);
  assert.match((await updateDisposableList({ fetchText: serve(good.split("\n").slice(0, 1_200).join("\n")) })).error, /shrank/);
  assert.equal((await updateDisposableList({ fetchText: serve(good.split("\n").slice(0, 1_200).join("\n")), force: true, dryRun: true })).ok, true);
  assert.match((await updateDisposableList({ fetchText: serve(good), sha256: "0".repeat(64) })).error, /sha256 mismatch/);
  assert.match((await updateDisposableList({ fetchText: async () => { throw new Error("boom"); } })).error, /download failed/);
  assert.match((await updateDisposableList({ ref: "../../evil" })).error, /invalid ref/);
  assert.equal(policy.checkEmailPolicySync("x@drop2999.example.net").reason, "disposable", "every refusal kept the previous list");
  rmSync(listDir, { recursive: true, force: true });
  policy.emailLists(Date.now() + 120_000);
});
