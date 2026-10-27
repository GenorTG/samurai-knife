// "Sync needed" (src/lib/services/sync-check.ts, manager.checkSync, docs/DEPLOY.md "Sidecars without the docker group"):
// with the root helper, the app re-stages each installed sidecar's bundle at startup, compares it with root's copy and
// tells admins (Sidecar services page, /account/admin, one log line per change) instead of failing a start after the
// next reboot. Also: autostart skips a sidecar that needs a sync, non-admins never see the check, and stale Craft
// configs are pruned so they cannot keep a bundle "different" forever.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/sidecar_sync_check.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const work = mkdtempSync(join(tmpdir(), "knife-sync-check-"));
process.env.KNIFE_DATA_DIR = join(work, "data");
process.env.KNIFE_HOST = "100.64.0.7";
process.env.KNIFE_PORT = "3210";
delete process.env.KNIFE_SIDECAR_PREFIX;
delete process.env.KNIFE_OFFICE_PUBLIC_URL;
test.after(() => rmSync(work, { recursive: true, force: true }));

const { bundleHash, resetHelperCache } = await import("../src/lib/services/helper-backend.ts");
const { findSidecar } = await import("../src/lib/services/definitions.ts");
const manager = await import("../src/lib/services/manager.ts");
const state = await import("../src/lib/services/state.ts");
const sync = await import("../src/lib/services/sync-check.ts");
const { autostartPass } = await import("../src/lib/services/autostart.ts");
const { serviceViewFor } = await import("../src/lib/services/view.ts");
const { sitesConfig, writeSitesConf } = await import("../src/lib/services/sites.ts");

const learn = findSidecar("learn-db");
const craft = findSidecar("craft");

/** A fake helper on a unix socket: answers from `script(line)` -> {out, code}; records the request lines. */
async function fakeHelper(script) {
  const path = join(work, `fake-${Math.random().toString(36).slice(2)}.sock`);
  const requests = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const line = buffer.split("\n")[0];
      requests.push(line);
      const answer = script(line);
      for (const text of answer.out ?? []) socket.write(`o ${text}\n`);
      socket.end(`x ${answer.code ?? 0}\n`);
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(path, resolve));
  return { path, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

function captureConsole() {
  const lines = [];
  const warn = console.warn;
  const log = console.log;
  console.warn = (text) => lines.push(`warn ${text}`);
  console.log = (text) => lines.push(`log ${text}`);
  return { lines, restore: () => Object.assign(console, { warn, log }) };
}

test("checkSync: null on the docker backend and for a sidecar that is not installed", async () => {
  delete process.env.KNIFE_SIDECAR_BACKEND;
  assert.equal(await manager.checkSync("learn-db"), null);
  process.env.KNIFE_SIDECAR_BACKEND = "helper";
  try {
    assert.equal(await manager.checkSync("learn-db"), null);
    assert.deepEqual(await sync.refreshSyncChecks(), []);
  } finally {
    delete process.env.KNIFE_SIDECAR_BACKEND;
  }
});

test("helper backend: a release that changed the bundle is reported once, re-staged first, and clears after the sync", async () => {
  let installed = "absent";
  const fake = await fakeHelper((line) => {
    if (line === "version") return { out: [JSON.stringify({ engine: "29.0.0", compose: "2.36.0" })] };
    if (line === "hash learn-db") return { out: [installed] };
    if (line === "ps learn-db") return { out: [] };
    return { code: 0 };
  });
  process.env.KNIFE_SIDECAR_BACKEND = "helper";
  process.env.KNIFE_SIDECAR_HELPER_SOCKET = fake.path;
  resetHelperCache();
  sync.resetSyncChecks();
  const out = captureConsole();
  try {
    state.writeState({ id: "learn-db", image: learn.image, bindHost: "127.0.0.1", hostPort: 3299, idleStopMinutes: 30, installedAt: "x", updatedAt: "x", autostart: true });
    // Nothing staged yet: the first check writes compose.yaml + secrets.env (the data-dir copy root syncs from).
    assert.equal(existsSync(state.composeFile("learn-db")), false);
    const absent = await manager.checkSync("learn-db");
    assert.equal(existsSync(state.composeFile("learn-db")), true, "checkSync re-stages before it compares");
    assert.equal(absent.needed, true);
    assert.equal(absent.reason, "absent");
    assert.equal(absent.command, "sudo knife-sidecar sync learn-db");
    assert.match(absent.message, /^Sync needed: /);
    assert.match(absent.hint, /sudo knife-sidecar check learn-db shows what differs, then sudo knife-sidecar sync learn-db/);

    // Root holds an older bundle: "differs", logged exactly once however often it is checked.
    installed = "0".repeat(64);
    let notices = await sync.refreshSyncChecks();
    await sync.refreshSyncChecks();
    assert.deepEqual(notices.map((n) => [n.id, n.name, n.reason, n.needed]), [["learn-db", learn.name, "differs", true]]);
    assert.match(notices[0].message, /^Sync needed: the host's installed bundle for .* differs from what this release renders/);
    const warned = out.lines.filter((line) => line.startsWith("warn [sidecars] sync needed: learn-db"));
    assert.equal(warned.length, 1, out.lines.join("\n"));
    assert.match(warned[0], /^warn \[sidecars\] sync needed: learn-db: the host's installed bundle .* Run as root: sudo knife-sidecar check learn-db \(shows what differs\), then sudo knife-sidecar sync learn-db\.$/);

    // Autostart does not try a start that would only fail (no `up`), and keeps the notice.
    fake.requests.length = 0;
    assert.deepEqual(await autostartPass(), []);
    assert.ok(!fake.requests.some((line) => line.startsWith("up")), fake.requests.join(","));
    assert.equal(sync.syncNotices().length, 1);

    // The owner ran the sync: root's hash is now the staged one.
    installed = bundleHash(state.serviceDir("learn-db"));
    notices = await sync.refreshSyncChecks();
    assert.deepEqual(notices, []);
    assert.ok(out.lines.includes("log [sidecars] learn-db: the installed bundle matches this release again"), out.lines.join("\n"));

    // The Sidecars status carries the check for admins only; "sync needed" is not repeated as a plain warning.
    installed = "1".repeat(64);
    const status = await manager.status("learn-db");
    assert.equal(status.sync.needed, true);
    assert.deepEqual(status.warnings.filter((w) => /Sync needed/.test(w)), []);
    assert.equal(serviceViewFor({ id: "a", role: "admin" }, status).sync.needed, true);
    process.env.KNIFE_AUTH_MODE = "public";
    try {
      assert.equal(serviceViewFor({ id: "u", role: "user" }, { ...status, op: null }).sync, null, "public mode: a user never sees it");
      assert.equal(serviceViewFor({ id: "a", role: "admin" }, { ...status, op: null }).sync.needed, true);
    } finally {
      delete process.env.KNIFE_AUTH_MODE;
    }
  } finally {
    out.restore();
    sync.resetSyncChecks();
    state.removeState("learn-db", true);
    delete process.env.KNIFE_SIDECAR_BACKEND;
    delete process.env.KNIFE_SIDECAR_HELPER_SOCKET;
    resetHelperCache();
    await fake.close();
  }
});

test("a helper that does not answer is a plain warning, not a sync", async () => {
  process.env.KNIFE_SIDECAR_BACKEND = "helper";
  process.env.KNIFE_SIDECAR_HELPER_SOCKET = join(work, "missing.sock");
  resetHelperCache();
  try {
    state.writeState({ id: "learn-db", image: learn.image, bindHost: "127.0.0.1", hostPort: 3299, idleStopMinutes: 30, installedAt: "x", updatedAt: "x" });
    const check = await manager.checkSync("learn-db");
    assert.equal(check.needed, false);
    assert.equal(check.reason, "unavailable");
  } finally {
    delete process.env.KNIFE_SIDECAR_BACKEND;
    delete process.env.KNIFE_SIDECAR_HELPER_SOCKET;
    resetHelperCache();
  }
});

test("Craft: writing the current nginx config removes the configs of earlier renders (names are hashed into the bundle)", () => {
  const assets = join(state.serviceDir("craft"), "assets");
  mkdirSync(join(assets, "conf-0123456789ab"), { recursive: true });
  writeFileSync(join(assets, "conf-0123456789ab", "nginx.conf"), "old");
  mkdirSync(join(assets, "not-a-conf"), { recursive: true });
  writeSitesConf(craft);
  const current = sitesConfig(craft).folder;
  assert.deepEqual(readdirSync(assets).filter((name) => name.startsWith("conf-")), [current]);
  assert.ok(existsSync(join(assets, "not-a-conf")), "only conf-<hash> folders are pruned");
  writeSitesConf(craft);
  assert.deepEqual(readdirSync(assets).filter((name) => name.startsWith("conf-")), [current], "idempotent");
});
