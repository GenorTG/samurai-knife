# Core table data on PostgreSQL (phase 1: accounts, sessions, MCP keys)

Status: implemented on branch `feat/db-postgres`, off by default (`KNIFE_DB_URL` unset = files, behaviour unchanged).
Design background and the later areas: [DB-DECOUPLING.md](DB-DECOUPLING.md). This file is the contract of what exists.

## Topology (owner decisions)

- **Primary**: PostgreSQL 18 on the VPS (today 1 vCPU / 1 GB, shared with the mail relay and Headscale).
- **App**: stays on genorbox1 with its sidecars and the file/blob storage. Every database round trip costs **~35 ms**.
- **Replica**: an asynchronous, **delayed** (5 min apply delay) physical standby on genorbox1, also the pgBackRest
  backup source. It never slows a write (`synchronous_standby_names = ''`).

So the design never puts a WAN round trip on a read and puts exactly one on a write.

## What moved

| Data | Before | Postgres (`db/migrations/0001_core.sql`) |
|---|---|---|
| accounts (profile, role, status, quota, email, GitHub link, tokens, legal acceptance, language, settings) | `accounts.json` | `accounts` (plain columns for constraints: id, email UNIQUE DEFERRABLE, github_id UNIQUE DEFERRABLE, role, status, created_at, last_login_at; the record itself in `doc jsonb`; `version` for optimistic concurrency) |
| provider profiles | inside `accounts.json` | `provider_profiles` (account, id, position, name, `config jsonb` with the API key and header values **sealed** by `secret-box.ts`, exactly as on disk) |
| default account | `accounts.json` | `instance_settings` (`defaultAccountId`) |
| sessions | `sessions.json` | `sessions` (SHA-256 of the cookie only) |
| MCP keys | `mcp-keys.json` | `mcp_keys` (SHA-256 of the key only) |
| rate-limit counters | memory (+ security buckets file) | **unchanged**: memory, one process |

Keys never go into the database: `provider-keys.key`, `storage.key`, `auth.key` stay files on genorbox1, so the VPS,
its backups and the replica hold ciphertext for every provider secret.

## Code

- `src/lib/db/core/types.ts` — `CoreRepo` (async `load()` / `commit(batch)`), `CoreBatch`, records, errors, `AccountCodec`.
- `src/lib/db/core/file-repo.ts` — `FileCoreRepo` over the three files (contract tests, `db:import` source, verify mirror).
- `src/lib/db/core/pg-repo.ts` — `PgCoreRepo`: both calls are ONE prepared statement (`knife_load_core()`,
  `knife_apply_core($1::jsonb)`), so a load or a commit is one round trip whatever it carries.
- `src/lib/db/core/cache.ts` — `CoreCache`, the authoritative in-process cache (below).
- `src/lib/db/core/runtime.ts` — the globalThis hook `store.ts`, `session.ts`, `mcp-keys.ts` call; null in file mode.
- `src/lib/db/core/init.ts` — start-up (instrumentation.ts): pool, schema check, writer lock, LISTEN, load, warm-up.
- `src/lib/db/barrier.ts` + `scripts/db-barrier.mjs` — the commit barrier (below).
- `src/lib/db/connect.mjs` — connection settings and the TLS rule, shared by the app and the scripts.
- `scripts/db-migrate.mjs`, `scripts/db-import.mjs`, `scripts/accounts-pg.mjs` (the CLI's Postgres backend).

The callers did not change: `getAccount`, `mutateStore`, `createSession`, `callerForMcpKey`… keep their synchronous
signatures. Only the three modules' low-level read/write functions dispatch to the cache.

## Latency design (single writer, primary 35 ms away)

1. **Reads cost 0 round trips.** The whole core state (hundreds of accounts, their sessions and keys: a few MB at most)
   is loaded at start in one statement and kept in memory. Session check, account lookup, MCP key check: memory only.
2. **Write-through, one round trip per request.** A change updates memory synchronously (the old "no await between
   read and write" rule still serialises read-modify-writes), marks the row dirty, and a batch is sent after the
   current tick: every row a request changed travels as one jsonb parameter into `knife_apply_core()`, which runs as a
   single statement = one implicit transaction. One batch in flight at a time; what changes meanwhile goes in the next
   one (group commit under load).
3. **Commit before acknowledging.** `scripts/db-barrier.mjs` (preloaded) runs each HTTP request in an AsyncLocalStorage
   context; a write registers its commit there and the response's bytes are held on `OutgoingMessage#_writeRaw` (the
   one path below Next's compression and the security-header wrappers) until the commit is durable on the primary
   (`synchronous_commit = on`). A failed commit turns the response into `503 {"error":"storage_unavailable"}` without its
   Set-Cookie, so a client is never told "saved" or handed a session that is not in the database. Bookkeeping writes
   (`lastSeenAt`, an MCP key's `lastUsedAt`) are `background`: committed with the next batch, never waited for.
4. **Prepared statements, small warm pool.** `pg.Pool` max 4 (`KNIFE_DB_POOL_MAX`), never closes idle connections,
   TCP keepalive, a `SELECT 1` every minute; at start the two statements are prepared on two connections.
5. **TLS required** to any non-loopback host (`sslmode=verify-full`, `sslrootcert` or `KNIFE_DB_CA_FILE`); plaintext is
   refused at start unless `KNIFE_DB_ALLOW_PLAINTEXT=1` (tests only).
6. **One writer per database.** At start the server takes `pg_try_advisory_lock(7355608002)` on a dedicated connection
   (the same connection LISTENs). A second server against the same database refuses to start (exit 78). If that
   connection drops, writes pause (503) until the lock is held again; if another process took it meanwhile, this one
   stays read-only and says so. knife-update's preflight must therefore run WITHOUT `KNIFE_DB_URL` (empty data dir, files).
7. **Optimistic concurrency** for the other writer, the accounts CLI (it also waits for the server's reload, below): every account row has `version`; a batch updates
   only the versions it read, else SQLSTATE 40001 → `CoreConflictError` → the cache rejects the waiting responses (503),
   reloads from the database (the source of truth) and carries on. The CLI's commits `NOTIFY knife_core`; the server
   reloads when idle (it ignores its own notifications by origin).
8. **Failure** of a commit: waiting responses get 503, writes are refused while the state reloads (retry with backoff
   up to 30 s), reads keep being answered from memory.

### Measured

`python3 tests/db_e2e_matrix.py --bench-only --backends files,pg0,pg35` — production build, private mode, 100 rounds,
latency proxy `tests/latency_proxy.mjs` injecting the round trip. Numbers in HANDOFF.md / the branch report; the shape:
reads (session check, page load, MCP call) are the same on all three backends; a write (`PUT /api/account/seen`) and a
login cost one extra round trip (~35 ms) on pg35, never more.

## Migrations

Plain SQL in `db/migrations/NNNN_name.sql`, applied by `npm run db:migrate` (`--status`, `--dry-run`): each file once,
in its own transaction, under `pg_advisory_lock(7355608001)`, SHA-256 recorded in `schema_migrations`; an applied file
that changed stops the runner (forward-only, expand → migrate → contract). The app never migrates: it refuses to start
when `schema_migrations` lacks `REQUIRED_MIGRATION` (init.ts). Run migrations as the schema owner (`knife_owner`), the
app as `knife_app` (DML + EXECUTE only; `deploy/db/primary-setup.sql`).

## Cut-over

1. `npm run db:migrate` (as knife_owner) on the empty database.
2. Server stopped (or still on files): `npm run db:import -- --dry-run`, then `npm run db:import`. Idempotent; records
   compared OPENED (secrets decrypted), so a re-run writes nothing; rows re-sealed with the same key file; sessions/keys
   of accounts that no longer exist skipped and counted; ends with a verification (counts + SHA-256 per record).
3. Start the server with `KNIFE_DB_URL` and **`KNIFE_DB_VERIFY=1`**: Postgres is authoritative, but after every commit
   and reload the files are rewritten from the database state, and database ↔ files ↔ cache are compared at start and
   every `KNIFE_DB_VERIFY_EVERY_SEC` (300) s (`[db] verify … MISMATCH accounts/<id>` lines, ids only). Rollback in this
   phase = unset `KNIFE_DB_URL` and restart: the files are current.
4. After a quiet week (no mismatch lines): drop `KNIFE_DB_VERIFY`. The files then go stale; rollback means a reverse
   export (not written yet; `db:import --verify` shows the drift).
5. `npm run db:import -- --verify` any time: exit 1 and the differing ids when files and database differ.

The server refuses to start on an empty database while `accounts.json` exists (import first). `npm run storage --
rename-account` is file-only for now (it moves files; in Postgres mode run it before the cut-over or extend it).

## Accounts CLI

`npm run accounts -- …` / `knife-admin accounts …` with `KNIFE_DB_URL` set reads and writes Postgres
(`scripts/accounts-pg.mjs`): same commands and record format, sealing with the local `provider-keys.key`, only the
changed rows sent with their versions (a row the server changed meanwhile fails the command: run it again), MCP key
revocation as rows, and a NOTIFY that makes the running server reload. When a server holds the writer lock (seen in
`pg_locks`, never taken by the CLI), the CLI waits for the server's `knife_core_ack` with its origin before it exits
(`KNIFE_DB_ACK_TIMEOUT_MS`, 5 s, then a warning): like the file store, the change is visible to the very next request
(test suites set a password with the CLI and log in right after).

## Tests

- `tests/db_core.test.mjs` — the CoreRepo contract once per implementation (files, Postgres): empty load, round trip
  with profile order and sealed-at-rest secrets, optimistic versions (stale/duplicate → conflict, all or nothing),
  cascade on delete, an address moving between accounts in one batch, the cache on top (one commit per tick, reads
  from memory, validation), recovery after another writer's conflicting change; Postgres only: migrations + checksums,
  TLS rules, the real modules on Postgres (no file written), the writer lock, the CLI's change reloaded via NOTIFY,
  set-password revoking keys and ending sessions, the empty-database guard, db:import (dry run, import, idempotent
  re-run, verify, tamper detection), one batch ≈ one round trip at 35 ms.
- `tests/db_barrier.test.mjs` — held until committed, 503 without Set-Cookie on failure, reads never delayed, per request.
- `tests/pg_scratch.mjs` (throwaway `postgres:18` container `sk-dbtest-*`, port from `KNIFE_SCRATCH_PORTS`, removed with
  its volume; never another container) and `tests/latency_proxy.mjs` (in-order delayed TCP proxy).
- `tests/scratch_server.py`: with `KNIFE_TEST_PG_ADMIN_URL` every server start gets a fresh migrated database next to
  its fresh data dir (through `KNIFE_TEST_PG_VIA`, the proxy, when set).
- `tests/db_e2e_matrix.py` — accounts_api, accounts_public, roles_mcp, prod_smoke, security_probe, cv_security_probe on
  files / pg0 / pg35 (file-oracle suites with `KNIFE_DB_VERIFY=1`, `--pure` without), plus the latency bench.

## VPS (proposed, see deploy/db/README.md)

`deploy/db/`: `postgresql.knife.conf` (1 GB box: shared_buffers 128MB, effective_cache_size 384MB, work_mem 4MB,
max_connections 20, wal_compression zstd, synchronous_commit on, async replication, max_slot_wal_keep_size, archiving to
pgBackRest; bigger-VPS values in comments), `pg_hba.knife.conf` (hostssl + scram only, app and replica from genorbox1's
tunnel address), `primary-setup.sql` (roles knife_owner / knife_app / knife_replicator, database, default privileges,
replication slot), `replica-setup.sh` (pg_basebackup `--max-rate`, `primary_conninfo` verify-full,
`recovery_min_apply_delay = 5min`, hot standby), `pgbackrest.conf` (repo on genorbox1, backups taken from the standby,
async archive-push, encrypted repo). None of it is run by the repo.

## Next areas (same pattern)

Each area gets `src/lib/db/<area>/` with its Load/Batch types, a file and a pg repo through one contract suite, a
migration, import + verify, and either the same cached write-through (small, hot, single-writer data) or plain async
repository calls with one round trip per request (large or rarely read data). Order and shape: DB-DECOUPLING.md §4.5;
remaining: usage ledger, goals, learn progress, workspace drafts, CV projects/documents/snapshots (sealed bodies),
conversations (sealed body + `untrusted` column owned by the chat route), site connections/audits, office and Craft
metadata (blobs stay files), workflows + runs + trigger index (+ scheduler leader lock), mail budgets, security events.
