#!/usr/bin/env node
// Applies the plain SQL migrations in db/migrations/ (NNNN_name.sql, sorted by name) to the database in KNIFE_DB_URL
// (docs/DB-POSTGRES.md "Migrations"). Each file runs once, inside its own transaction, under a session advisory lock, so two
// runners never interleave; its SHA-256 is recorded in schema_migrations and an applied file that changed afterwards
// stops the runner (forward-only: write a new migration instead). Run by the operator or knife-update before a release
// is activated, never by the app (the app only checks that the schema is new enough and refuses to start otherwise).
//
//   npm run db:migrate                 apply what is missing
//   npm run db:migrate -- --status     list applied / pending, change nothing
//   npm run db:migrate -- --dry-run    print what would run, change nothing
//
// Reads .env.local like scripts/serve.mjs. Uses `pg` (already a dependency: the database course).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pgConfig } from "../src/lib/db/connect.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const MIGRATIONS_DIR = join(ROOT, "db", "migrations");
/** Same key in src/lib/db/migrations.ts. */
const MIGRATE_LOCK = 7_355_608_001;

export function migrationFiles(dir = MIGRATIONS_DIR) {
  return readdirSync(dir)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name), "utf8");
      return { id: name.replace(/\.sql$/, ""), sql, checksum: createHash("sha256").update(sql).digest("hex") };
    });
}

/** Applies pending migrations with an already connected `pg` client; returns { applied, pending, done }. */
export async function migrate(client, { dryRun = false, statusOnly = false, dir = MIGRATIONS_DIR, log = console.log } = {}) {
  const files = migrationFiles(dir);
  await client.query("SELECT pg_advisory_lock($1)", [MIGRATE_LOCK]);
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await client.query("SELECT id, checksum FROM schema_migrations ORDER BY id");
    const applied = new Map(rows.map((row) => [row.id, row.checksum]));
    for (const [id, checksum] of applied) {
      const file = files.find((candidate) => candidate.id === id);
      if (!file) throw new Error(`schema_migrations has ${id}, which is not in ${dir} (database newer than this release?)`);
      if (file.checksum !== checksum) throw new Error(`${id}.sql changed after it was applied (checksum differs): write a new migration instead`);
    }
    const pending = files.filter((file) => !applied.has(file.id));
    if (statusOnly || dryRun) {
      for (const file of files) log(`${applied.has(file.id) ? "applied" : dryRun ? "would apply" : "pending"}  ${file.id}`);
      return { applied: [...applied.keys()], pending: pending.map((file) => file.id), done: [] };
    }
    const done = [];
    for (const file of pending) {
      await client.query("BEGIN");
      try {
        await client.query(file.sql);
        await client.query("INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)", [file.id, file.checksum]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new Error(`${file.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
      done.push(file.id);
      log(`applied  ${file.id}`);
    }
    if (!done.length) log("schema is up to date");
    return { applied: [...applied.keys(), ...done], pending: [], done };
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATE_LOCK]).catch(() => undefined);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.loadEnvFile(".env.local");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const args = process.argv.slice(2);
  const { default: pg } = await import("pg");
  const client = new pg.Client(pgConfig(process.env, { applicationName: "samurai-knife-migrate" }));
  await client.connect();
  try {
    await migrate(client, { dryRun: args.includes("--dry-run"), statusOnly: args.includes("--status") });
  } catch (error) {
    console.error(`[db-migrate] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
