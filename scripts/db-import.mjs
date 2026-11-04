#!/usr/bin/env node
// Copies the core file data (accounts.json, sessions.json, mcp-keys.json of KNIFE_DATA_DIR) into the Postgres database of
// KNIFE_DB_URL, and checks that both hold the same (docs/DB-POSTGRES.md "Cut-over"). Run it with the server STOPPED or
// still on files (no KNIFE_DB_URL in its settings): the files must not change while they are copied.
//
//   npm run db:import -- --dry-run        what would be written; changes nothing (not even the schema)
//   npm run db:import -- [--migrate]      write what differs (--migrate first applies db/migrations); then verify
//   npm run db:import -- --verify         compare only: counts + SHA-256 per record, exit 1 on any difference
//   npm run db:import -- --prune          also delete rows that exist only in the database
//   --source <dir>                        another data directory than KNIFE_DATA_DIR
//
// Idempotent: records are compared OPENED (provider secrets decrypted with provider-keys.key), so a re-run writes nothing;
// rows are re-sealed on the way in (new IVs, same key file, same AAD), never copied as plaintext. Sessions and keys of
// accounts that no longer exist are skipped and counted. Run through the TS resolver (npm script) so it uses the
// server's own parsing (src/lib/accounts/store.ts) and the CoreRepo implementations.
import { existsSync } from "node:fs";
import { join } from "node:path";

try {
  process.loadEnvFile(".env.local");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const sourceIndex = args.indexOf("--source");
if (sourceIndex >= 0) process.env.KNIFE_DATA_DIR = args[sourceIndex + 1];
const source = process.env.KNIFE_DATA_DIR?.trim();
const url = process.env.KNIFE_DB_URL?.trim();
if (!source || !url) {
  console.error("[db-import] set KNIFE_DATA_DIR (or --source) and KNIFE_DB_URL");
  process.exit(2);
}
if (!existsSync(join(source, "accounts.json"))) {
  console.error(`[db-import] ${join(source, "accounts.json")} does not exist`);
  process.exit(2);
}
// The store module must read the FILES here, never the (not loaded) Postgres cache.
const dbUrl = url;
delete process.env.KNIFE_DB_URL;

const { accountCodec } = await import("../src/lib/accounts/store.ts");
const { FileCoreRepo } = await import("../src/lib/db/core/file-repo.ts");
const { PgCoreRepo } = await import("../src/lib/db/core/pg-repo.ts");
const { decodeLoad, digestSnapshot, diffDigests, manifest } = await import("../src/lib/db/core/compare.ts");
const { pgConfig } = await import("../src/lib/db/connect.mjs");
const { migrate } = await import("./db-migrate.mjs");
const { default: pg } = await import("pg");

const files = decodeLoad(new FileCoreRepo(source).loadSync(), accountCodec);
const ids = new Set(files.store.accounts.map((account) => account.id));
const orphanSessions = files.sessions.filter((session) => !ids.has(session.accountId));
const orphanKeys = files.keys.filter((key) => !ids.has(key.accountId));
const wanted = { ...files, sessions: files.sessions.filter((s) => ids.has(s.accountId)), keys: files.keys.filter((k) => ids.has(k.accountId)) };
const show = (label, m) => console.log(`${label}: accounts=${m.accounts} profiles=${m.profiles} sessions=${m.sessions} keys=${m.keys} sha256=${m.sha256}`);

const pool = new pg.Pool({ ...pgConfig({ ...process.env, KNIFE_DB_URL: dbUrl }, { applicationName: "samurai-knife-import" }), max: 1 });
let exitCode = 0;
try {
  if (flag("--migrate") && !flag("--dry-run") && !flag("--verify")) {
    const client = await pool.connect();
    try {
      await migrate(client);
    } finally {
      client.release();
    }
  }
  const repo = new PgCoreRepo(pool);
  let dbLoad;
  try {
    dbLoad = await repo.load();
  } catch (error) {
    if (!flag("--dry-run")) throw new Error(`cannot read the database (${error.message}); run with --migrate to create the schema`);
    console.log("the database schema is not migrated yet (--migrate creates it)");
    dbLoad = { defaultAccountId: null, legacyV1: false, accounts: [], sessions: [], keys: [] };
  }
  const empty = dbLoad.defaultAccountId === null && dbLoad.accounts.length === 0;
  const db = empty ? { store: { version: 2, defaultAccountId: "", accounts: [] }, sessions: dbLoad.sessions, keys: dbLoad.keys } : decodeLoad(dbLoad, accountCodec);
  const fileDigests = digestSnapshot(wanted);
  const dbDigests = digestSnapshot(db);

  if (orphanSessions.length || orphanKeys.length) {
    console.log(`skipped ${orphanSessions.length} session(s) of missing accounts, ${orphanKeys.length} MCP key(s) of missing accounts`);
  }
  if (flag("--verify")) {
    show("files   ", manifest(wanted));
    show("database", manifest(db));
    const diff = diffDigests(fileDigests, dbDigests);
    for (const line of diff) console.log(`MISMATCH ${line.replace("only in the first", "only in the files").replace("only in the second", "only in the database")}`);
    if (diff.length) exitCode = 1;
    else console.log("verified: database matches the files");
  } else {
    const versions = new Map(dbLoad.accounts.map((row) => [row.doc.id, row.version]));
    const dbSessions = new Set(db.sessions.map((s) => s.hash));
    const dbKeys = new Set(db.keys.map((k) => k.id));
    const changed = (key) => fileDigests.get(key) !== dbDigests.get(key);
    const upsert = wanted.store.accounts.filter((account) => changed(`accounts/${account.id}`)).map((account) => ({ doc: accountCodec.sealAccount(account), expect: versions.get(account.id) ?? null }));
    const sessions = wanted.sessions.filter((s) => changed(`sessions/${s.hash.slice(0, 12)}`));
    const keys = wanted.keys.filter((k) => changed(`keys/${k.id}`));
    const prune = flag("--prune");
    const extraAccounts = db.store.accounts.filter((account) => !ids.has(account.id));
    const extraSessions = db.sessions.filter((s) => !wanted.sessions.some((w) => w.hash === s.hash));
    const extraKeys = db.keys.filter((k) => !wanted.keys.some((w) => w.id === k.id));
    const defaultChanged = db.store.defaultAccountId !== wanted.store.defaultAccountId;
    if ((extraAccounts.length || extraSessions.length || extraKeys.length) && !prune) {
      console.log(`the database also has ${extraAccounts.length} account(s), ${extraSessions.length} session(s), ${extraKeys.length} key(s) the files do not (kept; --prune deletes them)`);
    }
    const nothing = !upsert.length && !sessions.length && !keys.length && !defaultChanged && !(prune && (extraAccounts.length || extraSessions.length || extraKeys.length));
    if (nothing) {
      console.log("already imported: nothing to write");
    } else if (flag("--dry-run")) {
      console.log(`would import ${upsert.length} account(s) (${upsert.filter((u) => u.expect === null).length} new), ${sessions.length} session(s), ${keys.length} MCP key(s)${defaultChanged ? ", the default account" : ""}${prune ? `; would delete ${extraAccounts.length} account(s), ${extraSessions.length} session(s), ${extraKeys.length} key(s)` : ""}`);
    } else {
      await repo.commit({
        origin: "db-import",
        ...(defaultChanged ? { defaultAccountId: wanted.store.defaultAccountId } : {}),
        accounts: { upsert, delete: prune ? extraAccounts.map((account) => ({ id: account.id, expect: versions.get(account.id) })) : [] },
        sessions: { upsert: sessions, delete: prune ? extraSessions.filter((s) => dbSessions.has(s.hash)).map((s) => s.hash) : [] },
        keys: { upsert: keys, delete: prune ? extraKeys.filter((k) => dbKeys.has(k.id)).map((k) => k.id) : [] },
      });
      console.log(`imported ${upsert.length} account(s), ${sessions.length} session(s), ${keys.length} MCP key(s)`);
    }
    if (!flag("--dry-run")) {
      const after = digestSnapshot(decodeLoad(await repo.load(), accountCodec));
      const diff = diffDigests(fileDigests, after).filter((line) => prune || !line.endsWith("only in the second"));
      show("files   ", manifest(wanted));
      if (diff.length) {
        for (const line of diff) console.log(`MISMATCH ${line}`);
        exitCode = 1;
      } else {
        console.log("verified: database matches the files");
      }
    }
  }
} catch (error) {
  console.error(`[db-import] ${error instanceof Error ? error.message : String(error)}`);
  exitCode = 1;
} finally {
  await pool.end();
}
process.exit(exitCode);
