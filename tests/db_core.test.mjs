// Core store on Postgres (docs/DB-POSTGRES.md): the CoreRepo contract run against BOTH implementations (files, Postgres),
// the authoritative cache (group commit, conflicts, recovery, background writes, NOTIFY reload), the migration runner,
// the writer lock, the connection TLS rules and the account/session/MCP-key modules running on Postgres.
// Needs Docker + postgres:18 (tests/pg_scratch.mjs); without them the Postgres half is skipped with the reason.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/db_core.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { available, startScratchPostgres } from "./pg_scratch.mjs";
import { startLatencyProxy } from "./latency_proxy.mjs";

const dataDir = mkdtempSync(join(tmpdir(), "knife-db-core-"));
process.env.KNIFE_DATA_DIR = dataDir;
delete process.env.KNIFE_DB_URL;
delete process.env.KNIFE_AUTH_MODE;

const store = await import("../src/lib/accounts/store.ts");
const { FileCoreRepo } = await import("../src/lib/db/core/file-repo.ts");
const { PgCoreRepo } = await import("../src/lib/db/core/pg-repo.ts");
const { CoreCache } = await import("../src/lib/db/core/cache.ts");
const { CoreConflictError } = await import("../src/lib/db/core/types.ts");
const { decodeLoad, digestSnapshot, diffDigests, manifest } = await import("../src/lib/db/core/compare.ts");
const { connectionOptions } = await import("../src/lib/db/connect.mjs");
const { migrate, migrationFiles } = await import("../scripts/db-migrate.mjs");
const codec = store.accountCodec;

const docker = available();
const pgSkip = docker.ok ? false : `Postgres half skipped: ${docker.reason}`;
let scratch = null;
let dbCounter = 0;

test.before(async () => {
  if (docker.ok) scratch = await startScratchPostgres();
});
test.after(() => {
  scratch?.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

async function freshDb(migrated = true) {
  dbCounter += 1;
  const url = await scratch.database(`core_${process.pid}_${dbCounter}`);
  const pool = new pg.Pool({ connectionString: url, max: 3 });
  if (migrated) {
    const client = await pool.connect();
    try {
      await migrate(client, { log: () => undefined });
    } finally {
      client.release();
    }
  }
  return { url, pool };
}

function account(id, extra = {}) {
  return store.newAccountRecord({ id, displayName: id.toUpperCase(), role: "user", status: "active", ...extra });
}

const withProfiles = (base, key) => ({
  ...base,
  provider: { baseUrl: "https://api.example.com/v1", apiKey: key, model: "m1" },
  providerProfiles: [
    { id: "aaa111", name: "First", config: { baseUrl: "https://api.example.com/v1", apiKey: key, model: "m1" } },
    { id: "bbb222", name: "Second", config: { baseUrl: "https://other.example.com/v1", apiKey: `${key}-2`, model: "m2", extraHeaders: { "x-secret": "hdr-value" } } },
  ],
  activeProviderProfile: "aaa111",
});

const session = (label, accountId, extra = {}) => ({
  hash: createHash("sha256").update(label).digest("hex"), accountId, pf: "abcdef123456",
  createdAt: "2026-11-01T10:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", lastSeenAt: "2026-11-01T10:00:00.000Z", ...extra,
});
const mcpKey = (id, accountId, hashChar) => ({
  id, accountId, name: `key ${id}`, hash: hashChar.repeat(64), hint: "skm_abcd…", createdAt: "2026-11-01T10:00:00.000Z", lastUsedAt: null, scope: "read-only",
});

// ---------------------------------------------------------------------------------------------------------------------
// The CoreRepo contract, once per implementation.
// ---------------------------------------------------------------------------------------------------------------------

const backends = [
  ["files", { skip: false, make: async () => {
    const dir = mkdtempSync(join(dataDir, "repo-"));
    return { repo: new FileCoreRepo(dir), dir, raw: () => readFileSync(join(dir, "accounts.json"), "utf8") };
  } }],
  ["postgres", { skip: pgSkip, make: async () => {
    const { pool } = await freshDb();
    return { repo: new PgCoreRepo(pool, true), raw: async () => JSON.stringify((await pool.query("SELECT doc FROM accounts UNION ALL SELECT config FROM provider_profiles")).rows) };
  } }],
];

for (const [name, backend] of backends) {
  test(`contract [${name}]: an empty store loads empty`, { skip: backend.skip }, async () => {
    const { repo } = await backend.make();
    const loaded = await repo.load();
    assert.equal(loaded.defaultAccountId, null);
    assert.deepEqual(loaded.accounts, []);
    assert.deepEqual(loaded.sessions, []);
    assert.deepEqual(loaded.keys, []);
    await repo.close();
  });

  test(`contract [${name}]: commit then load round-trips accounts, profiles (order), sessions and keys; secrets stay sealed`, { skip: backend.skip }, async () => {
    const { repo, raw } = await backend.make();
    const alice = withProfiles(account("alice", { email: "alice@example.com", github: { id: 42, login: "alice", linkedAt: "2026-01-01T00:00:00.000Z" } }), "sk-alice-secret-0001");
    const bob = account("bob");
    const result = await repo.commit({
      origin: "test", defaultAccountId: "alice",
      accounts: { upsert: [{ doc: codec.sealAccount(alice), expect: null }, { doc: codec.sealAccount(bob), expect: null }] },
      sessions: { upsert: [session("aa", "alice"), session("bb", "bob")] },
      keys: { upsert: [mcpKey("mk_1", "alice", "c"), { ...mcpKey("mk_2", "bob", "d"), scope: undefined }] },
    });
    assert.ok(result.versions.alice && result.versions.bob);
    const loaded = await repo.load();
    assert.equal(loaded.defaultAccountId, "alice");
    const snapshot = decodeLoad(loaded, codec);
    assert.deepEqual(snapshot.store.accounts.map((a) => a.id), ["alice", "bob"], "insertion order kept");
    const a = snapshot.store.accounts[0];
    assert.equal(a.provider.apiKey, "sk-alice-secret-0001", "opened on read");
    assert.deepEqual(a.providerProfiles.map((p) => p.id), ["aaa111", "bbb222"]);
    assert.equal(a.providerProfiles[1].config.extraHeaders["x-secret"], "hdr-value");
    assert.equal(a.github.id, 42);
    assert.equal(loaded.sessions.length, 2);
    assert.equal(loaded.keys.find((k) => k.id === "mk_2").scope, undefined, "a key without scope reads back without it");
    const stored = await raw();
    assert.doesNotMatch(stored, /sk-alice-secret-0001|hdr-value/, "no plaintext provider secret at rest");
    const expected = { store: { version: 2, defaultAccountId: "alice", accounts: [alice, bob].map((x) => codec.parse({ defaultAccountId: x.id, accounts: [x] }, false).accounts[0]) }, sessions: [session("aa", "alice"), session("bb", "bob")], keys: [mcpKey("mk_1", "alice", "c"), { ...mcpKey("mk_2", "bob", "d"), scope: undefined }] };
    assert.deepEqual(diffDigests(digestSnapshot(snapshot), digestSnapshot(expected)), []);
    await repo.close();
  });

  test(`contract [${name}]: optimistic versions — stale expect and duplicate insert conflict and write nothing`, { skip: backend.skip }, async () => {
    const { repo } = await backend.make();
    const first = await repo.commit({ origin: "t", defaultAccountId: "carol", accounts: { upsert: [{ doc: codec.sealAccount(account("carol")), expect: null }] } });
    const v1 = first.versions.carol;
    const second = await repo.commit({ origin: "t", accounts: { upsert: [{ doc: codec.sealAccount(account("carol", { displayName: "Carol 2" })), expect: v1 }] } });
    assert.notEqual(second.versions.carol, v1);
    await assert.rejects(repo.commit({ origin: "t", accounts: { upsert: [{ doc: codec.sealAccount(account("carol", { displayName: "Stale" })), expect: v1 }] }, sessions: { upsert: [session("ee", "carol")] } }), CoreConflictError);
    await assert.rejects(repo.commit({ origin: "t", accounts: { upsert: [{ doc: codec.sealAccount(account("carol")), expect: null }] } }), CoreConflictError);
    await assert.rejects(repo.commit({ origin: "t", accounts: { delete: [{ id: "carol", expect: v1 }] } }), CoreConflictError);
    const loaded = await repo.load();
    assert.equal(decodeLoad(loaded, codec).store.accounts[0].displayName, "Carol 2");
    assert.equal(loaded.sessions.length, 0, "the conflicting batch wrote nothing (all or nothing)");
    await repo.close();
  });

  test(`contract [${name}]: deleting an account removes its sessions and keys; an address can move between accounts in one batch`, { skip: backend.skip }, async () => {
    const { repo } = await backend.make();
    const r = await repo.commit({
      origin: "t", defaultAccountId: "dan",
      accounts: { upsert: [{ doc: codec.sealAccount(account("dan", { email: "x@example.com" })), expect: null }, { doc: codec.sealAccount(account("eve")), expect: null }] },
      sessions: { upsert: [session("d1", "dan"), session("e1", "eve")] },
      keys: { upsert: [mcpKey("mk_e", "eve", "e")] },
    });
    const moved = await repo.commit({
      origin: "t",
      accounts: { upsert: [{ doc: codec.sealAccount(account("eve", { email: "x@example.com" })), expect: r.versions.eve }, { doc: codec.sealAccount(account("dan", { email: "y@example.com" })), expect: r.versions.dan }] },
    });
    await repo.commit({ origin: "t", accounts: { delete: [{ id: "eve", expect: moved.versions.eve }] } });
    const loaded = await repo.load();
    assert.deepEqual(loaded.accounts.map((row) => row.doc.id), ["dan"]);
    assert.equal(decodeLoad(loaded, codec).store.accounts[0].email, "y@example.com");
    assert.deepEqual(loaded.sessions.map((s) => s.accountId), ["dan"]);
    assert.deepEqual(loaded.keys, []);
    await repo.close();
  });

  test(`contract [${name}]: the cache on top — reads from memory, one commit per tick, flushed() means durable`, { skip: backend.skip }, async () => {
    const { repo } = await backend.make();
    let committed = 0;
    const cache = new CoreCache(repo, { origin: "cache-test", codec, log: () => undefined, onSynced: () => { committed += 1; } });
    await cache.start();
    assert.equal(cache.accountsView().store.defaultAccountId, "genor", "an empty store gets the initial account");
    committed = 0;
    for (let i = 0; i < 5; i += 1) cache.mutateAccounts((s) => { s.accounts.push(account(`u${i}`)); });
    cache.setSessions([session("f1", "u0")]);
    assert.equal(cache.accountsView().byId.get("u4").displayName, "U4", "visible at once (synchronous)");
    await cache.flushed();
    assert.equal(committed, 1, "six changes in one tick = one batch");
    const loaded = decodeLoad(await repo.load(), codec);
    assert.equal(loaded.store.accounts.length, 6);
    assert.equal(loaded.sessions.length, 1);
    const rowsBefore = cache.stats().rows;
    cache.mutateAccounts((s) => { s.accounts.find((a) => a.id === "u3").displayName = "Only me"; });
    await cache.flushed();
    assert.equal(cache.stats().rows - rowsBefore, 1, "a change to one account sends that one row, not the whole store");
    assert.throws(() => cache.mutateAccounts((s) => { s.accounts.push(account("u0")); }), /share an id/, "validation still refuses (nothing changes)");
    assert.equal(cache.accountsView().store.accounts.length, 6);
    await repo.close();
  });

  test(`contract [${name}]: the cache recovers from a conflicting write by another writer`, { skip: backend.skip }, async () => {
    const { repo } = await backend.make();
    const cache = new CoreCache(repo, { origin: "cache-a", codec, log: () => undefined, retryMs: 10 });
    await cache.start();
    // Another writer (the CLI) changes genor behind the cache's back.
    const loaded = await repo.load();
    const genor = decodeLoad(loaded, codec).store.accounts[0];
    await repo.commit({ origin: "cli", accounts: { upsert: [{ doc: codec.sealAccount({ ...genor, displayName: "From CLI" }), expect: loaded.accounts[0].version }] } });
    cache.mutateAccounts((s) => { s.accounts[0].displayName = "From app"; });
    await assert.rejects(cache.flushed(), /not saved/);
    for (let i = 0; i < 100 && cache.stats().state !== "ready"; i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.equal(cache.stats().state, "ready");
    assert.equal(cache.stats().conflicts, 1);
    assert.equal(cache.accountsView().byId.get("genor").displayName, "From CLI", "the database wins; the app's change was refused");
    cache.mutateAccounts((s) => { s.accounts[0].displayName = "App again"; });
    await cache.flushed();
    assert.equal(decodeLoad(await repo.load(), codec).store.accounts[0].displayName, "App again");
    await repo.close();
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Postgres only: migrations, writer lock, NOTIFY reload, the modules on Postgres, latency.
// ---------------------------------------------------------------------------------------------------------------------

test("migrations: applied once, recorded with checksums, a changed applied file stops the runner", { skip: pgSkip }, async () => {
  const { pool } = await freshDb(false);
  const client = await pool.connect();
  try {
    const first = await migrate(client, { log: () => undefined });
    assert.deepEqual(first.done, migrationFiles().map((f) => f.id));
    const again = await migrate(client, { log: () => undefined });
    assert.deepEqual(again.done, []);
    const dir = mkdtempSync(join(dataDir, "mig-"));
    for (const file of migrationFiles()) writeFileSync(join(dir, `${file.id}.sql`), `${file.sql}\n-- edited`);
    await assert.rejects(migrate(client, { dir, log: () => undefined }), /changed after it was applied/);
    const status = await migrate(client, { statusOnly: true, log: () => undefined });
    assert.deepEqual(status.pending, []);
  } finally {
    client.release();
    await pool.end();
  }
});

test("connection rules: TLS required off loopback, verify-full keeps verification on", () => {
  assert.throws(() => connectionOptions({ KNIFE_DB_URL: "postgres://u:p@10.0.0.5:5432/knife" }), /without TLS/);
  assert.equal(connectionOptions({ KNIFE_DB_URL: "postgres://u:p@127.0.0.1:5432/knife" }).ssl, false);
  const remote = connectionOptions({ KNIFE_DB_URL: "postgres://u:p@db.example.net:5432/knife?sslmode=verify-full" });
  assert.deepEqual(remote.ssl, { rejectUnauthorized: true });
  assert.doesNotMatch(remote.connectionString, /sslmode/);
  assert.equal(remote.keepAlive, true);
  assert.equal(connectionOptions({ KNIFE_DB_URL: "postgres://u:p@db.example.net/k?sslmode=require" }).warnings.length, 1);
  assert.throws(() => connectionOptions({ KNIFE_DB_URL: "mysql://x" }), /postgres:\/\//);
});

test("the server on Postgres: modules unchanged, writer lock, CLI change reloaded via NOTIFY, empty-DB guard", { skip: pgSkip }, async () => {
  const { url, pool } = await freshDb();
  const serverDir = mkdtempSync(join(dataDir, "server-"));
  process.env.KNIFE_DATA_DIR = serverDir;
  process.env.KNIFE_DB_URL = url;
  const init = await import("../src/lib/db/core/init.ts");
  const session = await import("../src/lib/accounts/session.ts");
  const keys = await import("../src/lib/accounts/mcp-keys.ts");
  try {
    await init.initCoreStorage(process.env);
    assert.equal(store.getDefaultAccount().id, "genor");
    store.mutateStore((s) => { s.accounts.push(account("frank", { email: "frank@example.com" })); });
    const frank = store.getAccount("frank");
    const token = session.createSession(frank);
    const { key } = keys.createMcpKey("frank", "agent");
    const { coreState } = init;
    await coreState().cache.flushed();
    assert.equal(existsSync(join(serverDir, "accounts.json")), false, "no file is written in Postgres mode");
    const rows = await pool.query("SELECT (SELECT count(*) FROM accounts)::int AS a, (SELECT count(*) FROM sessions)::int AS s, (SELECT count(*) FROM mcp_keys)::int AS k");
    assert.deepEqual(rows.rows[0], { a: 2, s: 1, k: 1 });
    assert.equal(session.accountForSessionToken(token).id, "frank");
    assert.equal(keys.callerForMcpKey({ username: "frank", key }).account.id, "frank");
    assert.equal(store.findByEmail("FRANK@example.com").id, "frank");

    // A second writer is refused.
    const other = new pg.Client({ connectionString: url });
    await other.connect();
    assert.equal((await other.query("SELECT pg_try_advisory_lock(7355608002) AS ok")).rows[0].ok, false);
    await other.end();

    // The accounts CLI writes Postgres; the server reloads after the NOTIFY and acknowledges, and the CLI exits only
    // then: the change is visible at once (no polling), like the file store. Async spawn: this process IS the server.
    const runCli = (args, input = "") => new Promise((resolve) => {
      const child = spawn(process.execPath, ["scripts/accounts.mjs", ...args], { env: { ...process.env } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", (status) => resolve({ status, stdout, stderr }));
      child.stdin.end(input);
    });
    const cli = await runCli(["set-role", "frank", "admin"]);
    assert.equal(cli.status, 0, cli.stderr);
    assert.doesNotMatch(cli.stderr, /not confirmed/);
    assert.equal(store.getAccount("frank").role, "admin", "visible right after the CLI exits");
    const list = await runCli(["list"]);
    assert.match(list.stdout, /frank/);
    const reset = await runCli(["set-password", "frank", "--password-prompt"], "new-password-123\nnew-password-123\n");
    assert.equal(reset.status, 0, reset.stderr);
    assert.equal(keys.listMcpKeys("frank").length, 0, "set-password revoked the key in Postgres");
    assert.equal(session.accountForSessionToken(token), null, "the new password ended the session");
    // npm run storage reads the accounts from Postgres, read-only, while the server holds the writer lock.
    const storageRun = spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--disable-warning=ExperimentalWarning", "--import", "./tests/ts-resolve.mjs", "scripts/storage.ts", "seal", "--dry-run"], { env: { ...process.env }, encoding: "utf8" });
    assert.equal(storageRun.status, 0, storageRun.stderr);
    assert.match(storageRun.stdout, /frank: 0 to seal/);
    const rename = spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--import", "./tests/ts-resolve.mjs", "scripts/storage.ts", "rename-account", "frank", "fred"], { env: { ...process.env }, encoding: "utf8" });
    assert.equal(rename.status, 2);
  } finally {
    await init.stopCoreStorage();
    delete process.env.KNIFE_DB_URL;
    process.env.KNIFE_DATA_DIR = dataDir;
  }

  // Refuses an empty database when accounts.json exists (import first).
  const empty = await freshDb();
  const filesDir = mkdtempSync(join(dataDir, "files-"));
  writeFileSync(join(filesDir, "accounts.json"), JSON.stringify({ version: 2, defaultAccountId: "genor", accounts: [account("genor")] }));
  process.env.KNIFE_DATA_DIR = filesDir;
  process.env.KNIFE_DB_URL = empty.url;
  try {
    await assert.rejects(init.initCoreStorage(process.env), /import it first/);
  } finally {
    delete process.env.KNIFE_DB_URL;
    process.env.KNIFE_DATA_DIR = dataDir;
    await empty.pool.end();
    await pool.end();
  }
});

test("db-import: dry run, import, idempotent re-run, verify counts + checksums", { skip: pgSkip }, async () => {
  const { url, pool } = await freshDb(false);
  const source = mkdtempSync(join(dataDir, "import-"));
  // Build a realistic file store through the file repo (sealed secrets, v2, sessions, keys).
  const files = new FileCoreRepo(source);
  process.env.KNIFE_DATA_DIR = source;
  await files.commit({
    origin: "seed", defaultAccountId: "genor",
    accounts: { upsert: [{ doc: codec.sealAccount(account("genor", { role: "admin" })), expect: null }, { doc: codec.sealAccount(withProfiles(account("gina", { email: "gina@example.com" }), "sk-gina-0001")), expect: null }] },
    sessions: { upsert: [session("g1", "gina"), session("zz", "ghost")] },
    keys: { upsert: [mcpKey("mk_g", "gina", "9")] },
  });
  process.env.KNIFE_DATA_DIR = dataDir;
  const run = (...args) => spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--import", "./tests/ts-resolve.mjs", "scripts/db-import.mjs", ...args], {
    env: { ...process.env, KNIFE_DATA_DIR: source, KNIFE_DB_URL: url }, encoding: "utf8",
  });
  let r = run("--dry-run");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /would import 2 account\(s\)/);
  assert.match(r.stdout, /skipped 1 session\(s\) of missing accounts/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE tablename = 'accounts'")).rows[0].n, 0, "dry run creates nothing");
  r = run("--migrate");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /verified: database matches the files/);
  const first = (await pool.query("SELECT id, version FROM accounts ORDER BY id")).rows;
  r = run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /already imported/);
  assert.deepEqual((await pool.query("SELECT id, version FROM accounts ORDER BY id")).rows, first, "re-run writes nothing");
  r = run("--verify");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /accounts=2 profiles=2 sessions=1 keys=1/);
  await pool.query("UPDATE accounts SET doc = jsonb_set(doc, '{displayName}', '\"Tampered\"') WHERE id = 'gina'");
  r = run("--verify");
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /accounts\/gina: differs/);
  await pool.end();
});

test("latency: the cache answers reads with 0 round trips and commits a batch in ~1 RTT at 35 ms", { skip: pgSkip }, async () => {
  const { url, pool } = await freshDb();
  const target = new URL(url);
  const proxy = await startLatencyProxy({ targetHost: target.hostname, targetPort: Number(target.port), rttMs: 35 });
  const slow = new pg.Pool({ connectionString: url.replace(`:${target.port}/`, `:${proxy.port}/`), max: 2 });
  try {
    const repo = new PgCoreRepo(slow);
    const cache = new CoreCache(repo, { origin: "lat", codec, log: () => undefined });
    await cache.start();
    await cache.flushed();
    // warm the connection + prepared statements
    cache.mutateAccounts((s) => { s.accounts[0].displayName = "warm"; });
    await cache.flushed();
    let t = performance.now();
    for (let i = 0; i < 1000; i += 1) cache.accountsView().byId.get("genor");
    assert.ok(performance.now() - t < 50, "1000 cached reads take no network time");
    const times = [];
    for (let i = 0; i < 10; i += 1) {
      t = performance.now();
      cache.mutateAccounts((s) => { s.accounts[0].displayName = `n${i}`; });
      cache.setSessions([session(`s${i}`, "genor")]);
      await cache.flushed();
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    const p50 = times[5];
    assert.ok(p50 >= 34 && p50 < 70, `one batch = one round trip (p50 ${p50.toFixed(1)} ms at 35 ms RTT)`);
  } finally {
    await slow.end();
    await proxy.close();
    await pool.end();
  }
});

test("manifest: counts and one digest", () => {
  const m = manifest({ store: { version: 2, defaultAccountId: "a", accounts: [account("a")] }, sessions: [], keys: [] });
  assert.equal(m.accounts, 1);
  assert.match(m.sha256, /^[0-9a-f]{64}$/);
});
