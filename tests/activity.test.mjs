// Updates without breaking work (scripts/activity.mjs, src/app/api/system/activity, deploy/bin/knife-update, docs/DEPLOY.md):
// which requests count as work, the in-flight counter on a real server, and the updater waiting for a quiet moment
// before it restarts (against a fake activity endpoint, with the updater's own wait_for_quiet function).
// Run: node --test tests/activity.test.mjs
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import test from "node:test";
import { isWork } from "../scripts/activity.mjs";

const KEY = Symbol.for("samurai-knife.activity.v1");

test("work = an agent's MCP calls, the assistant, saves and job polls; never page loads or the tabs' background polls", () => {
  assert.equal(isWork("POST", "/api/mcp"), true);
  assert.equal(isWork("GET", "/api/mcp"), true, "MCP's SSE stream");
  assert.equal(isWork("POST", "/api/agent/chat"), true);
  assert.equal(isWork("PUT", "/api/cv/profile"), true);
  assert.equal(isWork("GET", "/api/jobs/abc?x=1"), true);
  assert.equal(isWork("GET", "/api/site/audit"), true);
  assert.equal(isWork("POST", "/api/ui/call"), true, "a tab answering an agent's knife_ui_call");
  assert.equal(isWork("POST", "/api/ui/presence"), false);
  assert.equal(isWork("GET", "/api/ui/poll?client=x"), false);
  assert.equal(isWork("GET", "/api/system/activity"), false);
  assert.equal(isWork("GET", "/tools/cv-studio"), false);
  assert.equal(isWork("GET", "/_next/static/chunks/a.js"), false);
  assert.equal(isWork("GET", "/api/account"), false);
});

test("the counter follows requests in flight and records the last work", async () => {
  const state = globalThis[KEY];
  let release;
  const held = new Promise((r) => (release = r));
  const server = http.createServer(async (req, res) => {
    if (req.url === "/api/mcp") await held;
    res.end("ok");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const before = state.inflight;
    const call = fetch(`http://127.0.0.1:${port}/api/mcp`, { method: "POST", body: "{}" });
    for (let i = 0; i < 50 && state.inflight === before; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(state.inflight, before + 1);
    await fetch(`http://127.0.0.1:${port}/api/ui/poll`).then((r) => r.text());
    assert.equal(state.inflight, before + 1, "a background poll is not work");
    const t0 = Date.now();
    release();
    await (await call).text();
    for (let i = 0; i < 50 && state.inflight !== before; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(state.inflight, before);
    assert.ok(state.lastWork >= t0);
  } finally {
    server.close();
  }
});

/** Runs the updater's own wait_for_quiet against `answers` (served in turn, the last one repeated). */
async function waitForQuiet(answers, { quiet = 60, waitMax = 0 } = {}) {
  let i = 0;
  const server = http.createServer((req, res) => {
    const a = answers[Math.min(i++, answers.length - 1)];
    res.statusCode = a.status ?? 200;
    res.end(JSON.stringify(a.body ?? {}));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const src = readFileSync("deploy/bin/knife-update", "utf8");
  const fn = src.slice(src.indexOf("wait_for_quiet() {"), src.indexOf("\n}\n", src.indexOf("wait_for_quiet() {")) + 3);
  const script = `log() { echo "LOG $*"; }\nsleep() { :; }\nLIVE_URL=http://127.0.0.1:${server.address().port}\nQUIET_SEC=${quiet}\nWAIT_MAX=${waitMax}\n${fn}\nif wait_for_quiet; then echo QUIET; else echo BUSY; fi\n`;
  try {
    return await new Promise((resolve, reject) => {
      execFile("bash", ["-c", script], { encoding: "utf8", timeout: 20_000 }, (error, out) => (error ? reject(error) : resolve({ out, calls: i })));
    });
  } finally {
    server.close();
  }
}

test("knife-update waits for a quiet moment and postpones while someone works", async () => {
  const quiet = await waitForQuiet([{ body: { busy: false, idleSeconds: 300, inflight: 0 } }]);
  assert.match(quiet.out, /QUIET/);
  const busy = await waitForQuiet([{ body: { busy: true, idleSeconds: 0, inflight: 1 } }]);
  assert.match(busy.out, /BUSY/);
  assert.match(busy.out, /LOG waiting for a quiet moment/);
  const recent = await waitForQuiet([{ body: { busy: false, idleSeconds: 5, inflight: 0 } }], { quiet: 60 });
  assert.match(recent.out, /BUSY/, "work a few seconds ago: an agent between two calls");
  const older = await waitForQuiet([{ status: 404, body: { error: "not_found" } }]);
  assert.match(older.out, /QUIET/, "a live release without the endpoint never blocks an update");
});

test("knife-update: the wait comes before the switch; the service gets time to drain", () => {
  const updater = readFileSync("deploy/bin/knife-update", "utf8");
  const live = updater.slice(updater.indexOf('[[ -n "$LIVE_URL" ]] || die'));
  assert.ok(live.indexOf("wait_for_quiet") >= 0 && live.indexOf("wait_for_quiet") < live.indexOf("point_current"));
  assert.match(updater, /postponed: the server is busy/);
  assert.match(updater, /POSTPONE_MAX/);
  const unit = readFileSync("deploy/systemd/samurai-knife.service", "utf8");
  assert.ok(Number(unit.match(/^TimeoutStopSec=(\d+)/m)?.[1]) >= 60);
});
