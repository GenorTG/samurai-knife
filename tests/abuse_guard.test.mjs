// Abuse guard (src/lib/security/guard.mjs + the scripts/abuse-guard.mjs preload): a heavy real user never trips a budget,
// floods and scanners do, blocks escalate 15 min -> 1 h -> 24 h, IPv6 /64 rotation inside a /48 ends in a /48 block,
// administrators are budgeted but never blocked, a full client table evicts instead of refusing (the reproduced
// table_full lockout), office Document Server calls are never scored, blocks survive a restart, private mode never blocks, and the installed preload answers 429 + Retry-After + a tiny body and hardens the Node server.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/abuse_guard.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "knife-guard-"));
process.env.KNIFE_DATA_DIR = dataDir;
process.env.KNIFE_ABUSE_GUARD_INSTALL = "0";
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const { AbuseGuard, guardPolicy, credentialHash, routeClass } = await import("../src/lib/security/guard.mjs");
const events = await import("../src/lib/security/events-core.mjs");

const MIN = 60_000;

function clock(start = 1_800_000_000_000) {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

function guardAt(c, mode = "public", extra = {}) {
  return new AbuseGuard({ policy: { ...guardPolicy({ mode }), ...extra }, now: c.now, persist: false });
}

/** One request through check + observe; returns the final status. */
function hit(guard, req, appStatus = 200) {
  const verdict = guard.check(req);
  const status = verdict.ok ? appStatus : verdict.status;
  guard.observe(verdict.ctx, status);
  return { status, verdict };
}

test("route classes", () => {
  assert.equal(routeClass("/api/account/login"), "auth");
  assert.equal(routeClass("/api/account/register"), "auth");
  assert.equal(routeClass("/api/account"), "api");
  assert.equal(routeClass("/api/github/start"), "github");
  assert.equal(routeClass("/api/mcp"), "tool");
  assert.equal(routeClass("/api/agent/tool"), "tool");
  assert.equal(routeClass("/api/ui/poll"), "api");
  assert.equal(routeClass("/tools/json"), "page");
  assert.equal(routeClass("/_next/static/chunks/a.js"), "page");
  assert.equal(routeClass("/api/office/ds/file"), "ds");
  assert.equal(routeClass("/api/office/ds/callback"), "ds");
});

test("calibration: a heavy real user (3 tabs, UI poll 1.5 s, CV poll 2 s, assistant, page loads) never trips, 30 minutes", () => {
  const c = clock();
  const guard = guardAt(c);
  const cred = credentialHash({ cookie: "knife_session=heavy-user-token" });
  const address = "2001:db8:aa:1::10";
  const refused = [];
  const send = (path, method = "GET", status = 200) => {
    const r = hit(guard, { address, path, method, credHash: cred }, status);
    if (r.status === 429) refused.push(`${path} @${c.now()}`);
  };
  // 100 ms ticks for 30 minutes.
  for (let tick = 0; tick < 30 * 600; tick++) {
    const t = tick * 100;
    for (let tab = 0; tab < 3; tab++) {
      if ((t + tab * 500) % 1_500 === 0) send("/api/ui/poll"); // every visible-or-not tab, worst case
      if ((t + tab * 700) % 2_000 === 0) send("/api/cv/profile"); // CV studio poll
      if ((t + tab * 900) % 10_000 === 0) send("/api/ui/presence", "POST");
      if ((t + tab * 1_100) % 30_000 === 0) send("/api/account");
    }
    // The assistant: a model round every 3 s, and every 30 s a burst of 12 server tools within ~1 s.
    if (t % 3_000 === 0) send("/api/agent/chat", "POST");
    if (t % 30_000 < 1_200 && t % 100 === 0) send("/api/agent/tool", "POST");
    // A page load (document + ~120 assets in one go) every 20 s; a signed-out-looking 401 on a poll now and then.
    if (t % 20_000 === 0) for (let i = 0; i < 120; i++) send(`/_next/static/chunks/${i}.js`);
    if (t % 45_000 === 0) send("/api/workspace", "GET", 401);
    c.advance(100);
  }
  assert.deepEqual(refused.slice(0, 5), [], `${refused.length} refused`);
  assert.equal(guard.blocks.size, 0);
});

test("a signed-out tab polling every 1.5 s (401 each time) is never scored into a block", () => {
  const c = clock();
  const guard = guardAt(c);
  for (let i = 0; i < 2_000; i++) {
    assert.equal(hit(guard, { address: "198.51.100.20", path: "/api/ui/poll" }, 401).status, 401);
    assert.equal(hit(guard, { address: "198.51.100.20", path: "/api/account" }, 401).status, 401);
    c.advance(1_500);
  }
  assert.equal(guard.blocks.size, 0);
});

test("scanner: probe paths are answered 404 at once and block the prefix; blocks escalate 15 min -> 1 h -> 24 h", () => {
  events.resetSecurityEventsForTests();
  const c = clock();
  const guard = guardAt(c);
  const scan = () => {
    const paths = ["/.env", "/.git/config", "/wp-login.php", "/phpmyadmin/", "/cgi-bin/test", "/actuator/health"];
    let i = 0;
    while (true) {
      const { status, verdict } = hit(guard, { address: "203.0.113.66", path: paths[i++ % paths.length] }, 404);
      if (verdict.reason === "blocked") return status;
      assert.equal(status, 404);
      if (i > 50) throw new Error("never blocked");
    }
  };
  for (const [level, ms] of [[1, 15 * MIN], [2, 60 * MIN], [3, 24 * 60 * MIN]]) {
    assert.equal(scan(), 429);
    const block = guard.snapshot().blocks.find((b) => b.key === "203.0.113.66");
    assert.equal(block.level, level);
    assert.equal(Date.parse(block.until) - c.now(), ms);
    c.advance(ms + 1);
    assert.equal(hit(guard, { address: "203.0.113.66", path: "/" }).status, 200, "free again after the block");
  }
  const kinds = events.recentSecurityEvents().filter((e) => e.kind === "scanner_block").map((e) => e.detail);
  assert.ok(kinds.some((d) => /24h/.test(d)), kinds.join("|"));
});

test("an LLM agent probing every API endpoint (distinct 404/401/405/400s) is blocked within a minute", () => {
  const c = clock();
  const guard = guardAt(c);
  const statuses = [404, 401, 405, 400, 415, 403];
  let blockedAt = -1;
  for (let i = 0; i < 200 && blockedAt < 0; i++) {
    const { verdict } = hit(guard, { address: "192.0.2.77", path: `/api/endpoint-${i}`, method: i % 2 ? "POST" : "GET" }, statuses[i % statuses.length]);
    if (!verdict.ok && verdict.reason === "blocked") blockedAt = i;
    c.advance(200);
  }
  assert.ok(blockedAt > 0 && blockedAt <= 40, `blocked after ${blockedAt}`);
});

test("login flood: the auth budget refuses, the failures score, the prefix is blocked", () => {
  const c = clock();
  const guard = guardAt(c);
  const seen = new Set();
  for (let i = 0; i < 100; i++) {
    const { verdict, status } = hit(guard, { address: "198.51.100.99", path: "/api/account/login", method: "POST" }, 401);
    seen.add(verdict.ok ? status : verdict.reason.split(":")[0]);
    c.advance(100);
  }
  assert.ok(seen.has(401) && seen.has("blocked"), [...seen].join(","));
  assert.ok(guard.blocks.has("198.51.100.99"));
});

test("IPv6 /64 rotation inside one /48: per-/64 budgets refuse, then the /48 budget, then the /48 is blocked", () => {
  const c = clock();
  const guard = guardAt(c);
  let wideRefusals = 0;
  for (let n = 0; n < 40 && !guard.blocks.has("2001:0db8:0077::/48"); n++) {
    const address = `2001:db8:77:${n.toString(16)}::1`;
    for (let i = 0; i < 80; i++) {
      const { verdict } = hit(guard, { address, path: "/api/account/forgot", method: "POST" }, 202);
      if (!verdict.ok && String(verdict.reason).endsWith("/48")) wideRefusals += 1;
    }
    c.advance(1_000);
  }
  assert.ok(wideRefusals > 0, "the /48 budget refused requests from fresh /64s");
  assert.ok(guard.blocks.has("2001:0db8:0077::/48"), JSON.stringify(guard.snapshot().blocks));
  assert.equal(hit(guard, { address: "2001:db8:77:ffff::1", path: "/" }).verdict.reason, "blocked", "a brand-new /64 in the /48 is blocked");
  assert.equal(hit(guard, { address: "2001:db8:78::1", path: "/" }).status, 200, "the neighbour /48 is not");
});

test("credential budgets: one session cookie from many addresses still hits 400/min API and 120/min tools", () => {
  const c = clock();
  const guard = guardAt(c);
  const cred = credentialHash({ cookie: "a=b; knife_session=stolen" });
  let refused = 0;
  for (let i = 0; i < 200; i++) {
    const { status } = hit(guard, { address: `198.18.${i}.1`, path: "/api/mcp", method: "POST", credHash: cred });
    if (status === 429) refused += 1;
  }
  assert.equal(refused, 80);
  const bearer = credentialHash({ authorization: "Bearer skm_x" });
  assert.notEqual(bearer, cred);
  assert.equal(credentialHash({ cookie: "other=1" }), null);
});

test("administrators are never blocked but stay budgeted (4x)", () => {
  const c = clock();
  const guard = guardAt(c);
  const cred = credentialHash({ cookie: "knife_session=admin-token" });
  guard.markAdmin(cred);
  for (const path of ["/.env", "/.git/config", "/wp-admin", "/.env", "/.aws/x"]) hit(guard, { address: "203.0.113.5", path, credHash: cred }, 404);
  assert.equal(guard.blocks.size, 0);
  guard.block("203.0.113.5", "test");
  assert.equal(hit(guard, { address: "203.0.113.5", path: "/api/account", credHash: cred }).status, 200, "a blocked prefix still serves its admin");
  let refused = 0;
  for (let i = 0; i < 590; i++) if (hit(guard, { address: "203.0.113.5", path: "/api/x", credHash: cred }).status === 429) refused += 1;
  assert.equal(refused, 0, "admin API burst budget is 4x 150 per 10 s");
  for (let i = 0; i < 100; i++) if (hit(guard, { address: "203.0.113.5", path: "/api/x", credHash: cred }).status === 429) refused += 1;
  assert.ok(refused > 0, "but it is a budget");
});

test("regression: idle clients with a score are swept; a full table evicts and never answers 429 table_full", () => {
  const c = clock();
  const guard = guardAt(c, "public", { maxClients: 100 });
  // 100 clients that each failed once (score > 0) and went away: the old sweep kept them forever (score !== 0), so
  // every later visitor got 429 table_full until a restart.
  for (let i = 0; i < 100; i++) assert.equal(hit(guard, { address: `10.9.${i}.1`, path: "/api/missing" }, 404).status, 404);
  assert.ok([...guard.clients.values()].every((entry) => entry.score > 0));
  c.advance(11 * MIN);
  const after = hit(guard, { address: "10.10.0.1", path: "/" });
  assert.equal(after.status, 200, "idle scored clients were swept");
  assert.ok(guard.clients.size <= 2, `${guard.clients.size} left`);
  // Still full of ACTIVE clients: the least recently seen goes, newcomers are served.
  for (let i = 0; i < 100; i++) hit(guard, { address: `10.11.${i}.1`, path: "/" });
  for (let i = 0; i < 50; i++) assert.equal(hit(guard, { address: `10.12.${i}.1`, path: "/" }).status, 200, "never table_full");
  assert.equal(guard.clients.size, 100, "bounded");
  assert.ok(guard.snapshot().counters.evicted >= 50);
  assert.equal(guard.clients.has("10.11.99.1"), true, "recently seen clients stay");
  assert.equal(guard.clients.has("10.11.0.1"), false, "the least recently seen went first");
});

test("eviction prefers clients without a live score, so a flood of fresh prefixes cannot wash out a scanner's score", () => {
  const c = clock();
  const guard = guardAt(c, "public", { maxClients: 50 });
  for (let i = 0; i < 20; i++) hit(guard, { address: "203.0.113.150", path: `/api/probe-${i}` }, 404);
  const score = guard.clients.get("203.0.113.150").score;
  assert.ok(score >= 20);
  for (let i = 0; i < 60; i++) hit(guard, { address: `10.20.${i}.1`, path: "/" });
  assert.equal(guard.clients.get("203.0.113.150")?.score, score, "the scored client survived the flood");
});

test("office Document Server calls (/api/office/ds/*, JWT-checked) are never scored and have their own budget", () => {
  const c = clock();
  const guard = guardAt(c);
  // The container's address fetches files and posts callbacks for every open document; some answer 4xx (expired token).
  for (let i = 0; i < 500; i++) {
    const { status } = hit(guard, { address: "172.18.0.5", path: i % 2 ? "/api/office/ds/file" : "/api/office/ds/callback", method: i % 2 ? "GET" : "POST" }, i % 3 ? 200 : 403);
    assert.notEqual(status, 429, `request ${i}`);
  }
  assert.equal(guard.blocks.size, 0);
  assert.equal(guard.clients.get("172.18.0.5").score, 0);
});

test("private mode: budgets 10x, never blocks (the owner is never locked out)", () => {
  const c = clock();
  const guard = guardAt(c, "private");
  for (let i = 0; i < 200; i++) assert.equal(hit(guard, { address: "100.100.1.2", path: "/.env" }, 404).status, 404);
  for (let i = 0; i < 300; i++) hit(guard, { address: "100.100.1.2", path: `/api/x${i}` }, 404);
  assert.equal(guard.blocks.size, 0);
  assert.equal(hit(guard, { address: "100.100.1.2", path: "/api/account" }).status, 200);
});

test("blocks and strikes survive a restart (security/blocks.json, 0600)", () => {
  const c = clock(Date.now());
  const dir = join(dataDir, "persist");
  const first = new AbuseGuard({ policy: guardPolicy({ mode: "public" }), dataDir: dir, now: c.now });
  first.block("203.0.113.200", "scanner");
  first.saveNow();
  const file = join(dir, "blocks.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(readFileSync(file, "utf8").includes("203.0.113.200"));
  const second = new AbuseGuard({ policy: guardPolicy({ mode: "public" }), dataDir: dir, now: c.now });
  assert.equal(hit(second, { address: "203.0.113.200", path: "/" }).verdict.reason, "blocked");
  c.advance(15 * MIN + 1);
  second.block("203.0.113.200", "scanner");
  assert.equal(second.snapshot().blocks[0].level, 2, "the strike count was restored: next block escalates");
  assert.equal(second.unblock("203.0.113.200"), true);
  assert.equal(hit(second, { address: "203.0.113.200", path: "/" }).status, 200);
});

// -- the installed preload -----------------------------------------------------------------------------------------------

function rawRequest(port, lines, body = "") {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let data = "";
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("end", () => resolve(data));
    socket.on("close", () => resolve(data));
    socket.on("error", reject);
    socket.write(`${lines.join("\r\n")}\r\n\r\n${body}`);
  });
}

test("installed preload: 429 + Retry-After + tiny body, hardened timeouts, slow bodies cut at their deadline", async () => {
  const { installAbuseGuard } = await import("../scripts/abuse-guard.mjs");
  const guard = installAbuseGuard({ KNIFE_AUTH_MODE: "public", KNIFE_DATA_DIR: dataDir, KNIFE_BODY_TIMEOUT_MS: "300", KNIFE_TRUSTED_PROXIES: "127.0.0.1" });
  assert.ok(guard);
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => res.end("ok"));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/`, { headers: { "x-forwarded-for": "192.0.2.10" } });
    assert.equal(ok.status, 200);
    assert.equal(server.headersTimeout, 20_000);
    assert.equal(server.maxConnections, 1_024);
    assert.ok(server.keepAliveTimeout < server.headersTimeout);
    const probe = await fetch(`http://127.0.0.1:${port}/.env`, { headers: { "x-forwarded-for": "192.0.2.11" } });
    assert.equal(probe.status, 404);
    let last;
    for (let i = 0; i < 10; i++) last = await fetch(`http://127.0.0.1:${port}/.git/config`, { headers: { "x-forwarded-for": "192.0.2.11" } });
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers.get("retry-after")) > 800, last.headers.get("retry-after"));
    assert.equal(await last.text(), "Too many requests.\n");
    assert.equal(last.headers.get("connection"), "close");
    const other = await fetch(`http://127.0.0.1:${port}/`, { headers: { "x-forwarded-for": "192.0.2.12" } });
    assert.equal(other.status, 200, "only that client is blocked");
    // A body announced but never sent: 408 after the (test-sized) deadline.
    const started = Date.now();
    const answer = await rawRequest(port, ["POST /api/account/login HTTP/1.1", "Host: x", "Content-Type: application/json", "Content-Length: 100", "X-Forwarded-For: 192.0.2.13"], "{");
    assert.match(answer, /^HTTP\/1\.1 408/);
    assert.ok(Date.now() - started < 5_000);
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
});
