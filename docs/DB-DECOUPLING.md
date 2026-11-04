# Moving the table data to a database (VPS primary, live local standby)

Status: design proposal, nothing implemented. Base commit: `77572d4` (0.13.0).
Scope: the *table-like* state (accounts, sessions, keys, CV data, conversations, goals, workflows, ledgers, indexes…).
Out of scope: documents, Craft files, photos, run binaries, exports and other blobs: they stay files (a blob store), see §1.3.

## 0. Recommendation in short

1. **PostgreSQL 18** (current major, supported until Nov 2030) as the one database. No distributed SQL, no SQLite.
2. **Move the app next to the database**: app instances + Postgres primary + PgBouncer on the VPS. A WAN hop
   (home ⇄ VPS, ~10–30 ms) on every query would make each request 5–20× slower; reads from a home standby while writing
   to the VPS break read-your-writes.
3. **Home server = hot standby** fed by **asynchronous streaming replication** over Tailscale (lag normally < 1 s),
   plus a **pgBackRest repository** on the home server (WAL archive + backups, PITR) and a second encrypted off-site repo.
4. **Async, not sync**: with one standby a synchronous commit stalls the whole app whenever the home link or server is
   down. If the owner needs RPO = 0, add a second small standby and use quorum `ANY 1 (home, vps2)`.
5. **Manual, scripted failover** (`pg_promote()` + fencing + `pg_rewind` to rejoin); no Patroni/repmgr for two nodes.
6. **Keep application-level sealing** (AES-256-GCM, per-account HKDF key) for personal and secret content: sealed bodies
   go into `bytea` columns; only ids, timestamps, status and sizes are plaintext columns. Add LUKS disk encryption on
   the VPS and encrypted backups. Keys (`storage.key`, `auth.key`, `provider-keys.key`) never go into the database.
7. **No new dependency needed**: `pg` (node-postgres) is already a dependency (DB course). Plain SQL migrations with a
   ~100-line runner; typed repositories with zod row parsing. Kysely is the one optional addition if hand SQL grows.
8. A **storage abstraction** (async repository interfaces) first, file backend behind it, then a Postgres backend,
   backfill, shadow reads, cut-over per area, file backend kept read-only for rollback.
9. Multi-instance readiness is a separate, mandatory step: today's in-memory state (rate limits, jobs, UI bridge,
   scheduler, quota cache) assumes one process; it moves to Postgres (rows, advisory locks, LISTEN/NOTIFY) or sticky routing.
10. Phased: local Postgres on the home server first (no WAN risk), then the VPS standby, then a planned switchover that
    makes the VPS primary. Rough total: 7–10 weeks of focused work.

## 1. Inventory of today's state

All paths are under `$KNIFE_DATA_DIR` (default `~/.local/share/samurai-knife`). "Sealed" = `writeAccountFile`
(`src/lib/storage/sealed.ts`: MAGIC | iv | tag | ciphertext, AES-256-GCM, key = HKDF(storage.key, account id), AAD =
account id). "Sync RMW" = synchronous read-modify-write on the single Node thread (no await between read and write),
which is today's only concurrency control.

### 1.1 Instance-wide stores

| State | Path / format | Growth | Pattern today | Concurrency / caching | At rest | Becomes |
|---|---|---|---|---|---|---|
| Accounts (profile, role, status, quota, email, GitHub link, tokens, legal acceptance, language, provider profiles) | `accounts.json`, one JSON, zod v2 schema (`src/lib/accounts/store.ts`) | a few KB/account; designed for "hundreds" | read on most requests, written on login/profile/admin changes | `mutateStore` sync RMW + `accounts.json.lock` (O_EXCL, 10 s stale) vs the CLI; parsed copy cached by inode/mtime/size | 0600; provider secrets sealed with `provider-keys.key` (`secret-box.ts`), rest plaintext | `accounts`, `provider_profiles`, `account_tokens` rows; unique email/username/github id become constraints |
| Pending sign-ups | inside `accounts.json` (`status: pending`, `pendingIpp`) | bounded (caps in `pending.ts`) | timer sweep + inline before registration | same lock | plaintext | rows in `accounts` + partial index `WHERE status='pending'` |
| Sessions | `sessions.json` (SHA-256 of cookie, password fingerprint, expiry) | ≤ MAX_SESSIONS_PER_ACCOUNT each | lookup on **every** request, write on login/logout | sync, server process only, cached by file identity | 0600, hashes only | `sessions` (PK token hash) |
| MCP keys | `mcp-keys.json` (key hashes, scope, prefix) | small | lookup on every MCP call | sync | hashes only | `mcp_keys` |
| Rate limits | in memory per namespace; security buckets saved every minute to `security/rate-limits.json` (HMAC names, ≤ 50k rows) | bounded by caps | every guarded request | **process memory**: per-instance limits multiply by the instance count | 0600 | `rate_buckets` (see §4.4); hot counters may stay in memory with sticky routing |
| Mail budgets / suppression | `mail/*.json` (HMAC keys), async debounced saves | small | per mail sent | in memory + file | hashed | `mail_budgets`, `mail_suppression` |
| Security events | `security/events-<UTC day>.jsonl`, 30 days | proportional to abuse | async append, bounded buffer (`events-core.mjs`, also used by the preload guard) | per process | 0600, no secrets | `security_events` partitioned by day (drop partition = retention); the `.mjs` preload keeps a file/queue fallback |
| Workflow trigger index | `workflow-triggers.json` (webhook token hashes, schedules, waiting runs) | per workflow | read by scheduler + webhook routes, sync writes | single process; the **scheduler is a per-process `setInterval`** | 0600, ids/hashes | `workflow_triggers`; scheduler leader via advisory lock |
| Legal history | `legal-history/<key>.json` (exact texts shown) | one per legal version | write-once | none needed | plaintext | `legal_versions` (also must exist on every instance) |
| Model capabilities | `model-capabilities.json` (endpoint+model → vision yes/no, 30 days) | small | read per provider round | sync | non-personal | `model_capabilities` |
| Email policy lists | `email-policy/*.txt` | static-ish | mtime-reloaded | file | public data | **stay files** (ship with deploy; or a table if edited at runtime) |
| Sidecar state | `services/<id>/` (compose, secrets.env, op.lock) | per sidecar | ops | lock file | 0600 | **stay files**: host-local by nature |
| Server keys | `storage.key`, `auth.key`, `provider-keys.key`, `github-app.json` | fixed | read once | cached | 0600 | **stay files / secret store, never in the DB**, identical on both sites |
| Logs | `$KNIFE_LOG_DIR` daily files | retention days | append | per process | redacted | stay files (or a log shipper); not in the DB |

### 1.2 Per-account stores (all sealed and counted by the quota, owned by `accountScope`, `src/lib/storage/scope.ts`)

| State | Path | Format / size | Pattern | Becomes |
|---|---|---|---|---|
| CV projects index | `cv/<id>.projects.json` | ≤ 30 projects | small RMW | `cv_projects` (account, project_id, name, created_at, is_active) |
| CV data (profile, variants ≤ 200, jobs ≤ 500, applications ≤ 1000) | `cv/<id>.json`, `cv/<id>.p-<proj>.json` | one JSON, tens–hundreds of KB | whole-document RMW on every edit; UI polls every 2 s | phase A: `cv_documents` (one sealed body + `version` for optimistic locking); phase B (optional): `cv_jobs`, `cv_applications`, `cv_variants` rows if queries need them |
| CV undo snapshots | `cv/<id>.snapshots/` ≤ 40 / 20 MB | full copies | write per save | `cv_snapshots` (sealed body, seq) with retention by DELETE |
| CV photo | `cv/<id>.photo.jpg` | image | rare | **blob** |
| Website studio state (repo connection + GitHub token, PageSpeed key, work branch, audit history) | `site/<id>.json`, `cv/<id>.p-<p>.site.json` | grows with audits | RMW | `site_connections` (sealed body: holds tokens) + `site_audits` (account, project, at, scores plaintext, findings sealed) |
| Conversations / transcripts + action journal + `untrusted` taint | `conversations/<id>/<chat>.json` (KEEP_CONVERSATIONS, archives) | can reach MBs | PUT from browser, taint written by `/api/agent/chat` | `conversations` (id, account, title, updated_at, archived, untrusted, sealed body); taint as its own column so only the chat route updates it |
| Goals / task checkpoints | `goals/<id>.json` | small | RMW | `goals`, `goal_checkpoints` |
| Course progress | `learn/<id>.json` | small | per run | `learn_progress` (account, course, lesson, …) |
| Usage ledger | `usage/<id>.json` daily buckets + per model, 90 days | small | write per model round (hot) | `usage_daily` (account, day, model, counters) with `INSERT … ON CONFLICT DO UPDATE`; retention by DELETE |
| Tool drafts | `workspace/<id>.json.enc` ≤ MAX_BYTES / 160 tools | small | debounced writes | `workspace_drafts` (account, tool, sealed body, saved_at) |
| Office library metadata | `docs/<id>/folders.json`, `<doc>/meta.json` (name, format, folder, version, DS key, kept versions, trash) | small | per save/rename/move | `office_folders`, `office_documents`, `office_versions` (metadata rows); bytes `current.<fmt>`, `history/v<N>` stay **blobs** |
| Craft files metadata | `craft-files/<id>/index.json` | small | per save | `craft_files` rows; `<file>.bin` stay **blobs** |
| Workflows | `workflows/<id>/wf/<wf>.json` | per workflow | edits | `workflows` (id, account, name, active, version, sealed definition) |
| Workflow runs | `runs/<wf>/<run>.json` + `index.json` | grows fast (history) | write per run/node | `workflow_runs` (id, workflow, status, mode, started/ended, last node, plaintext index columns, sealed body); large binaries → blobs |
| Workflow credentials, static data | `credentials.json`, `static.json` | small | rare / per run | `workflow_credentials` (sealed), `workflow_static` (sealed) |

### 1.3 What stays files (the blob store)

Office document bytes and versions, Craft `.bin` files, CV photos, workflow binary payloads, exports, async job scratch
(already `os.tmpdir()`), sidecar data, logs. They keep `writeAccountFile` sealing and quota accounting. When the app moves
to the VPS they move with it (same layout on the VPS disk) and are replicated to the home server **separately** from
Postgres (§2.6). Keeping them out of the database keeps WAL volume, backups and replication lag small.

### 1.4 In-memory and single-process assumptions that break with several app instances

| Assumption | Where | Multi-instance fix |
|---|---|---|
| Sync RMW = no interleaving | every store (`mutateStore` 31 call sites, `writeAccountFile` 24, `getAccount` 39; ~93 files import the store/sealed/quota modules) | transactions; `SELECT … FOR UPDATE` or optimistic `version` column; all repositories become **async** (the largest refactor) |
| File-identity read caches | `accounts.json`, `sessions.json` | drop or short TTL + `LISTEN/NOTIFY` invalidation |
| `accounts.json.lock` vs CLI | `scripts/accounts.mjs`, `knife-admin` | CLI talks to the DB (same repositories) |
| Rate limits in memory | `rate-limit.ts` | DB-backed buckets for security namespaces; sticky routing for the rest (§4.4) |
| Quota usage cache with exact deltas | `quota.ts` | `account_usage` row updated in the same transaction as the write (`bytes = bytes + delta`); periodic recount job |
| In-memory async jobs (PDF), MCP jobs, screenshots | `jobs.ts`, `mcp/jobs.ts`, `vision/images.ts` | sticky routing by account (consistent hash of session/key at the proxy); later a `jobs` table if needed |
| UI bridge presence / polls / calls | `ui-bridge/store.ts` (globalThis) | sticky routing by account (simplest) or rows + `NOTIFY` |
| Workflow scheduler `setInterval` | `workflows/server/scheduler.ts` | only the holder of `pg_try_advisory_lock(<scheduler>)` ticks (on a direct, non-pooled connection); due runs claimed with `FOR UPDATE SKIP LOCKED` |
| Consumed OAuth states set, PoW, hash gate, upload budget, Python work queue | `github-app/oauth.ts`, `pow.ts`, `hash-gate.ts`, `upload-budget.ts`, `work-queue.ts` | consumed states → table with expiry; the rest are per-host resource guards and may stay per instance |
| Python lane | `server/py`, gets plaintext scratch copies | unchanged: never touches the data dir or the DB |
| Workflow worker | spawned child, gets credentials/blobs over IPC from the parent | unchanged: only the parent talks to repositories |

## 2. Database options and the chosen setup

### 2.1 Why PostgreSQL 18 with physical streaming replication

- Mature built-in streaming replication with read-only hot standbys
  ([High Availability, Load Balancing, and Replication](https://www.postgresql.org/docs/18/high-availability.html),
  [Log-Shipping Standby Servers](https://www.postgresql.org/docs/18/warm-standby.html),
  [Hot Standby](https://www.postgresql.org/docs/18/hot-standby.html)).
- Per-transaction durability control: `synchronous_commit` can be set per transaction (`SET LOCAL`), values
  `remote_apply | on | remote_write | local | off`
  ([synchronous_commit](https://www.postgresql.org/docs/18/runtime-config-wal.html#GUC-SYNCHRONOUS-COMMIT),
  [synchronous_standby_names](https://www.postgresql.org/docs/18/runtime-config-replication.html#GUC-SYNCHRONOUS-STANDBY-NAMES)).
- PITR from base backup + WAL archive ([Continuous Archiving and PITR](https://www.postgresql.org/docs/18/continuous-archiving.html)).
- Failover primitives: `pg_promote()` / `pg_ctl promote` ([Failover](https://www.postgresql.org/docs/18/warm-standby-failover.html)),
  `pg_rewind` to turn an old primary into a standby ([pg_rewind](https://www.postgresql.org/docs/18/app-pgrewind.html)).
- The repo already uses `pg` and runs a Postgres sidecar for the course; the team knows it.
- Version: 18 is current (18.6, supported until 14 Nov 2030, [versioning policy](https://www.postgresql.org/support/versioning/)).
  17 is acceptable if the VPS distro packages only 17; both sides must run the **same major** for physical replication.

### 2.2 Sync vs async over the WAN

- Synchronous (`synchronous_standby_names = 'home'`, `synchronous_commit = on`): every commit waits one WAN round trip
  (+ standby fsync). With one standby, **if the home server or Tailscale is down, every write on the VPS blocks** until an
  operator clears `synchronous_standby_names`. Users would see the outage of the *backup* as an outage of the app.
- Asynchronous (default): commit latency = local fsync only; RPO on total VPS loss = replication lag (normally well under
  a second; bounded and alerted, §2.7) plus nothing from the archive that had not shipped.
- `remote_write` / `remote_apply` only change *how much* the commit waits; they do not remove the stall.
- **Decision proposed: async.** Option for RPO 0: a third node (small second VPS, other DC) with
  `synchronous_standby_names = 'ANY 1 (home, vps2)'` so one standby may be down without stalling writes; then critical
  transactions can wait while chatty ones (usage ledger, presence) `SET LOCAL synchronous_commit = local`.

### 2.3 Backups: pgBackRest

[pgBackRest user guide](https://pgbackrest.org/user-guide.html), [configuration](https://pgbackrest.org/configuration.html):
- `repo1` on the home server (pgBackRest over SSH/TLS through Tailscale), `repo2` off-site object storage (S3-compatible).
- `archive-async=y` + `archive_command = pgbackrest archive-push`, so a slow WAN never blocks WAL recycling for long.
- `repo-cipher-type=aes-256-cbc` with a passphrase kept outside both hosts' data dirs (password manager) → encrypted backups.
- Weekly full, daily differential, WAL continuous; retention e.g. 4 full / 30 days of PITR; monthly restore test to a scratch
  instance (automated: restore, `SELECT count(*)` per table, compare with the primary).
- The standby can be (re)built from repo1 (`pgbackrest restore --type=standby`), which avoids a full base backup over the WAN.

### 2.4 Failover

- **Manual promote with a runbook** (`scripts/db-failover.md` later): fence the old primary (stop app + Postgres on the
  VPS, or drop its Tailscale ACL), `SELECT pg_promote()` on home, point the app at home (start the home app instances or
  switch the DNS/Funnel/proxy), then rebuild the VPS as a standby with `pg_rewind` or from pgBackRest.
- Patroni needs a DCS (etcd/Consul) with a quorum of 3+ members ([Patroni docs](https://patroni.readthedocs.io/));
  repmgr needs a witness for safe automatic failover. With 2 sites over a WAN link an automatic failover is more likely
  to cause split-brain than to save minutes. Revisit with a third site.
- RTO target: 15–30 min manual; RPO: seconds (async).

### 2.5 Connection pooling and sizing

- **PgBouncer** in `pool_mode = transaction`, `max_prepared_statements` > 0 so node-postgres named statements work
  ([PgBouncer config](https://www.pgbouncer.org/config.html)). Transaction pooling never supports `LISTEN` or session-level
  advisory locks ([features](https://www.pgbouncer.org/features.html)): the scheduler leader and the NOTIFY listener use one
  **direct** connection per instance.
- node-postgres `Pool` per instance, `max` 10–20, `statement_timeout`/`idle_in_transaction_session_timeout` set per role
  ([pg Pool](https://node-postgres.com/apis/pool)).

Estimate for "thousands of users at once":
- 5,000 concurrently active users × 1 request / 3–5 s (UI polls: CV studio 2 s, UI bridge 1.5 s, presence 20 s) ≈
  1,000–2,500 HTTP req/s. Each request: session + account read (cacheable), 0–3 store queries → ~3,000–8,000 queries/s,
  of which ~10–20 % writes → 300–1,500 write transactions/s. Polls must become cheap conditional reads
  (`WHERE version > $1` / `updated_at` ETag) or LISTEN-driven, or they dominate.
- Postgres 18 on 8 vCPU / 32 GB / NVMe handles this with headroom (tens of thousands of simple indexed reads per second,
  thousands of small commits per second; group commit absorbs fsyncs). Verify with `pgbench` custom scripts on the
  actual VPS before buying bigger.
- Connections: 4–8 app instances × 15 = 60–120 client connections → PgBouncer → `default_pool_size` 30–40 server
  connections (≈ 4× cores). `max_connections` 100.
- The real bottleneck is Node: one process serves maybe 1–3k simple req/s; several instances are needed, hence §1.4.
- VPS starting point: 8 vCPU (dedicated), 32 GB RAM, 2× NVMe (RAID1) ≥ 400 GB (DB + blobs + local WAL), ≥ 1 Gbit,
  EU region close to Poland (e.g. a Warsaw/Frankfurt/Falkenstein/Helsinki DC). `shared_buffers` 8 GB,
  `effective_cache_size` 24 GB, `wal_compression = zstd`, `max_slot_wal_keep_size` set so a long home outage cannot fill
  the VPS disk (the standby then re-syncs from pgBackRest).

Latency the app sees:
- App on VPS, DB on VPS: < 1 ms per query (loopback/LAN). **Recommended.**
- App at home, DB on VPS: one WAN RTT (10–30 ms) per query, ×5–20 per request; transactions held open across RTTs
  multiply lock time. Not acceptable as the steady state.
- App at home reading the home standby: fast reads but stale by the lag; a user would not see their own write in the
  next poll. Only for read-only admin/report views, never for the user path.

### 2.6 Topology

```
VPS (primary site)                                   Home server (fallback + backup site)
┌──────────────────────────────────────┐             ┌──────────────────────────────────────┐
│ reverse proxy (TLS, sticky by account)│            │ app instances (stopped / maintenance) │
│ app ×N  ──► PgBouncer ──► Postgres 18 │── WAL ────► │ Postgres 18 hot standby (read-only)   │
│                         (primary)     │  stream     │ pgBackRest repo1 (backups + WAL)      │
│ blob store (data dir files, sealed)   │── rsync ──► │ blob mirror (restic/rsync, versioned) │
└──────────────────────────────────────┘ Tailscale   └──────────────────────────────────────┘
                 └─► pgBackRest repo2 (off-site object storage, encrypted)
```

Blobs: a periodic (e.g. 5 min) `rsync`/`restic` of the blob directories to the home server, plus inotify-triggered sync
for office saves if needed. A row may point at a blob that has not synced yet: on failover, rows whose blob is missing
are shown as "being restored"; the job reports them. (Later option: a replicated S3-compatible store such as Garage.)

### 2.7 Monitoring

`pg_stat_replication` (write/flush/replay lag), `pg_stat_wal_receiver` on home, pgBackRest `check`/`info`, disk free,
PgBouncer `SHOW POOLS`. Alerts (existing security-alert mail path): lag > 30 s, archive failing > 5 min, replication
slot retained WAL > 50 % of `max_slot_wal_keep_size`.

### 2.8 Alternatives considered

| Option | Why not (here) |
|---|---|
| SQLite + Litestream | single writer, async replication to object storage, no hot standby to fail over to (restore instead); multi-instance writes impossible ([litestream.io](https://litestream.io/)) |
| SQLite + LiteFS | FUSE + lease backend (Consul), single writer, tied to one platform's operational model; still one writer |
| libSQL / Turso self-hosted (sqld) | primary + read replicas, but single-writer, younger tooling, no pgBackRest-class backup story |
| CockroachDB / YugabyteDB | consensus needs ≥ 3 nodes; with a WAN member every write pays the WAN; CockroachDB's free tier is now under an enterprise licence with conditions; operationally heavy for this scale |
| MySQL Group Replication / InnoDB Cluster | needs 3 members for quorum; no advantage over Postgres; the repo already uses `pg` |
| Postgres logical replication | for selective/major-version-crossing copies; physical is simpler and complete for a standby. Useful later for a zero-downtime major upgrade |

## 3. Security

- **Sealing stays.** Bodies of CV data, conversations, site connections (tokens), workflow definitions, runs,
  credentials, static data, drafts and goals are stored as `bytea` produced by the existing `sealAccountBytes`
  (AES-256-GCM, per-account HKDF key, AAD = account id). Add the table name and row id to the AAD
  (`<account>|<table>|<id>`) so a sealed cell cannot be swapped between rows (new magic version `SKENC02`; old cells
  still open). The database (and its backups, standby and replication stream) then never holds these in plaintext.
- Provider keys: keep `secret-box.ts` sealing in `provider_profiles.config` (sealed column).
- Plaintext columns: ids, foreign keys, timestamps, status/role, sizes, counts, scores. Email stays plaintext as today
  (needed for unique/lookup; citext unique index). Option if wanted: store `email_hmac` (keyed with auth.key) for lookup
  and the address sealed.
- Community Postgres has no TDE: **LUKS** full-disk encryption on the VPS data volume (protects disks and snapshots at the
  provider), home already on own hardware (LUKS too if not yet).
- Keys outside the DB: `storage.key`, `auth.key`, `provider-keys.key` on both sites (same values), 0600, outside the
  data dir (`KNIFE_STORAGE_KEY_FILE`, `KNIFE_AUTH_KEY_FILE`), backed up separately from the data and from pgBackRest.
- Network: Postgres and PgBouncer listen on loopback + the Tailscale interface only; Tailscale ACL lets only the home
  node reach 5432 (replication) and pgBackRest; nothing on the public interface (host firewall drops it too).
  `pg_hba.conf`: `hostssl … scram-sha-256` only, replication entry limited to the home Tailscale IP
  ([pg_hba.conf](https://www.postgresql.org/docs/18/auth-pg-hba-conf.html), [SSL](https://www.postgresql.org/docs/18/ssl-tcp.html));
  TLS even inside Tailscale (defence in depth), `sslmode=verify-full` from the standby.
- Roles (least privilege): `knife_owner` (owns schema, migrations only), `knife_app` (DML on app tables, no DDL, no
  `TRUNCATE`), `knife_readonly` (reports), `knife_replicator` (REPLICATION only), `pgbackrest` (backup functions).
  The course database stays a separate cluster/sidecar with its own roles; the learner role never reaches the app cluster.
- Every app query is parameterised (node-postgres `$1`), no dynamic identifiers from input.
- Backups encrypted (pgBackRest cipher), passphrase not stored on either host in plaintext next to the repo.
- **RODO/GDPR**: the VPS provider becomes a processor (Art. 28 DPA with the provider; EU/EEA location to avoid
  transfers; record of processing updated). The privacy notice must name the hosting location/processor category and
  the backup retention → **new legal edition** (`legal/versions.json`, `legal/editions/<n>`, docs/LEGAL.md flow). Data
  subject deletion must also reach backups: document that backups age out within the retention (e.g. 30–35 days)
  and that a restore re-applies pending deletions (keep a `deleted_accounts` tombstone table that the restore runbook replays).

## 4. Migration plan

### 4.1 Storage abstraction

- `src/lib/db/` : `pool.ts` (one `pg.Pool`, env `KNIFE_DATABASE_URL`, `KNIFE_DATABASE_DIRECT_URL` for LISTEN/locks),
  `tx.ts` (`withTx(fn)`, retry on serialization/deadlock), `migrate.ts` (runner), `migrations/NNNN_name.sql`.
- `src/lib/repos/<area>.ts`: async interfaces per area (`AccountsRepo`, `SessionsRepo`, `CvRepo`, `ConversationsRepo`,
  `WorkflowsRepo`…), with two implementations: `files` (wraps today's modules unchanged) and `pg`. Selected by
  `KNIFE_STORE=files|dual|pg` (per area override, e.g. `KNIFE_STORE_SESSIONS=pg`).
- The sealing helpers move to a pure `seal(accountId, ctx, bytes)` / `open(...)` usable by both backends.
- Blob paths keep going through `accountScope`; blob writes and their metadata row are ordered "blob first, row second"
  (an orphan blob is cleaned by a sweeper; a row never points at a missing blob on the primary).
- Cost driver: the sync → async conversion of callers (≈ 93 importing files, ~250 call sites). Done area by area behind
  the interfaces, files backend first (behaviour unchanged, tests still green), which de-risks the rest.

### 4.2 Schema sketch (abridged)

```sql
CREATE TABLE accounts (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  display_name text NOT NULL, email citext UNIQUE, email_verified_at timestamptz,
  password_hash text, role text NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  status text NOT NULL DEFAULT 'disabled' CHECK (status IN ('pending','active','disabled')),
  storage_quota_bytes bigint, github_id bigint UNIQUE, github_login text,
  terms_accepted_at timestamptz, terms_version text, language text, settings jsonb NOT NULL DEFAULT '{}',  -- assistant, seen, network flags…
  pending_ipp text, created_at timestamptz NOT NULL, last_login_at timestamptz, version int NOT NULL DEFAULT 1);
CREATE INDEX ON accounts (created_at) WHERE status = 'pending';
CREATE TABLE account_tokens (account_id text REFERENCES accounts ON DELETE CASCADE, kind text, hash text, email citext,
  expires_at timestamptz NOT NULL, PRIMARY KEY (account_id, kind));
CREATE TABLE provider_profiles (account_id text REFERENCES accounts ON DELETE CASCADE, id text, name text NOT NULL,
  config_sealed bytea NOT NULL, is_active bool NOT NULL DEFAULT false, PRIMARY KEY (account_id, id));
CREATE TABLE sessions (token_hash bytea PRIMARY KEY, account_id text NOT NULL REFERENCES accounts ON DELETE CASCADE,
  pw_fingerprint text NOT NULL, created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, last_seen_at timestamptz);
CREATE INDEX ON sessions (account_id); CREATE INDEX ON sessions (expires_at);
CREATE TABLE mcp_keys (key_hash bytea PRIMARY KEY, account_id text NOT NULL REFERENCES accounts ON DELETE CASCADE,
  label text, scope text NOT NULL, prefix text NOT NULL, created_at timestamptz NOT NULL, last_used_at timestamptz);
CREATE TABLE account_usage (account_id text PRIMARY KEY REFERENCES accounts ON DELETE CASCADE, bytes bigint NOT NULL DEFAULT 0, recounted_at timestamptz);
CREATE TABLE usage_daily (account_id text REFERENCES accounts ON DELETE CASCADE, day date, model text,
  rounds int, input_tokens bigint, output_tokens bigint, PRIMARY KEY (account_id, day, model));
CREATE TABLE cv_projects (account_id text REFERENCES accounts ON DELETE CASCADE, id text, name text NOT NULL,
  created_at timestamptz NOT NULL, is_active bool NOT NULL DEFAULT false, PRIMARY KEY (account_id, id));
CREATE TABLE cv_documents (account_id text, project_id text, body_sealed bytea NOT NULL, version bigint NOT NULL,
  updated_at timestamptz NOT NULL, PRIMARY KEY (account_id, project_id), FOREIGN KEY (account_id, project_id) REFERENCES cv_projects ON DELETE CASCADE);
CREATE TABLE cv_snapshots (account_id text, project_id text, seq bigint, body_sealed bytea NOT NULL, at timestamptz NOT NULL,
  PRIMARY KEY (account_id, project_id, seq));
CREATE TABLE conversations (account_id text REFERENCES accounts ON DELETE CASCADE, id text, title text, archived bool NOT NULL DEFAULT false,
  untrusted bool NOT NULL DEFAULT false, body_sealed bytea NOT NULL, updated_at timestamptz NOT NULL, PRIMARY KEY (account_id, id));
CREATE INDEX ON conversations (account_id, updated_at DESC);
-- same pattern: goals, goal_checkpoints, learn_progress, workspace_drafts, site_connections, site_audits,
-- office_folders, office_documents, office_versions (blob_path), craft_files (blob_path),
-- workflows, workflow_runs (account_id, workflow_id, id, status, mode, started_at, ended_at, last_node, body_sealed;
--   index (account_id, workflow_id, started_at DESC)), workflow_credentials, workflow_static,
-- workflow_triggers (instance-wide: workflow_id, account_id, webhook_token_hash UNIQUE, schedule jsonb, next_due_at; index (next_due_at)),
-- rate_buckets (name_hmac bytea PK, window_start, count, limiting bool, expires_at), oauth_consumed (state_hash PK, expires_at),
-- mail_budgets, mail_suppression, legal_versions, model_capabilities, deleted_accounts (id, deleted_at),
-- security_events (at timestamptz, kind, …) PARTITION BY RANGE (at), one partition per day.
CREATE TABLE schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), checksum text NOT NULL);
```

Account rename (today a file move) becomes `ON UPDATE CASCADE` on the FKs or an immutable surrogate key; prefer an
immutable `id` and keep the username as a separate unique column if rename is a real feature.

### 4.3 Migrations tooling

- **Plain SQL files + small runner on `pg`** (already a dependency): ordered files, checksums in `schema_migrations`,
  run under `pg_advisory_lock` by `knife-update` before activating a release (as `knife_owner`), never by app startup in
  N instances at once. Forward-only; every migration additive first (expand → migrate → contract) so the previous release
  keeps running during a rollout.
- Query layer: hand-written SQL in repositories, rows parsed with the existing zod schemas. **Kysely** (type-safe builder,
  no runtime deps, works with `pg`) is the one dependency worth adding later if the SQL surface grows; Drizzle brings
  its own migration tool/CLI and schema DSL, more than needed. Either must be justified in the commit (repo rule).
- Node 24 / Next 16: `pg` runs in route handlers with `runtime = "nodejs"` (all API routes already are). Keep the pool on
  `globalThis` (dev hot reload). Code the workflows worker imports must stay erasable TS; it does not import the DB.

### 4.4 Rate limits and other per-process state

- Security-relevant namespaces (login, register, reset, MCP auth): `rate_buckets` with
  `INSERT … ON CONFLICT DO UPDATE SET count = …` in one statement (fixed windows of 1 min summed for the sliding window),
  keys HMAC'ed as today; `synchronous_commit = local/off` for these writes (losing a second of counters on crash is fine).
- High-churn signal buckets (PoW signals, outbound budgets): stay in memory per instance with sticky routing by account,
  limits divided by instance count where it matters.
- Proxy: sticky routing by session cookie / MCP account (consistent hash) so UI bridge, in-memory jobs and MCP jobs stay
  on one instance; an instance restart loses them exactly as a restart does today.

### 4.5 Backfill and cut-over (per area)

1. `files` backend behind the interface (no behaviour change).
2. Migration creates the tables. One-shot backfill script (`npm run db -- backfill <area>`, server stopped or area
   read-only for its duration; areas are small) reads via `readAccountFile`, re-seals with the new AAD, inserts, and
   writes a manifest (counts + SHA-256 of plaintext per record).
3. `dual` mode: writes go to files **and** Postgres (Postgres in the same request, failures logged, not fatal), reads from
   files; a shadow-read job compares random records daily → mismatch counter must stay 0 for a week.
4. `pg` mode for the area: reads and writes Postgres; files kept read-only for 2 weeks (rollback = flip the env back and
   replay the Postgres changes since cut-over from an `area_changes` journal, or accept them lost if none).
5. Remove the file implementation of that area after a release with no rollback.
Order (low risk → high): model_capabilities, legal_versions, security_events, usage_daily, learn_progress, goals,
workspace_drafts → mcp_keys, sessions → accounts (+ CLI `scripts/accounts.mjs`, `knife-admin`) → CV → conversations →
site → office/craft metadata → workflows + trigger index + scheduler leader → rate limits / mail budgets.

### 4.6 Testing

- Unit tests (`node --test`) for repositories against a **scratch Postgres in Docker** (`postgres:18`, random port, fresh
  database per test file, `DROP DATABASE` after), started by a helper like the existing scratch servers; skipped with a
  clear message when Docker is missing.
- e2e suites get `KNIFE_DATABASE_URL` to their own scratch database next to their fresh `KNIFE_DATA_DIR` (same isolation
  rule: never the live database).
- Contract tests run every repository suite against both `files` and `pg` backends.
- Replication drills in a two-container setup (primary + standby + pgBackRest): kill primary, promote, rewind, verify row
  counts; restore-from-backup test monthly on real infrastructure.
- Load: `pgbench` with custom scripts mirroring session lookup + CV poll + usage upsert; k6/autocannon against the app at
  1k/2k req/s with N instances; targets p95 < 50 ms for polls, < 150 ms for writes.

## 5. Phases

| Phase | Content | Exit criterion (measurable) | Effort |
|---|---|---|---|
| 0. Decisions + VPS | owner decisions (§6), order VPS, LUKS, Tailscale ACLs, Postgres 18 + PgBouncer + pgBackRest installed (empty) | `pgbench` baseline recorded; backup + restore of an empty cluster works | 2–3 days |
| 1. Abstraction | `src/lib/db/`, migration runner, async repo interfaces with `files` backend for all areas; callers converted to async | all unit/e2e suites green on `files`; no behaviour change | 2–3 weeks |
| 2. Local Postgres | Postgres 18 on the **home** server (app stays home), areas cut over in §4.5 order via dual → pg | each area: 7 days of 0 shadow mismatches; p95 latencies ≤ today's | 2–3 weeks |
| 3. Multi-instance | rate buckets, scheduler leader, OAuth states, quota row, sticky proxy; 2+ instances at home | 2 instances behind the proxy pass the full e2e suite; scheduler fires each due run once | 1 week |
| 4. VPS standby | VPS as an async standby of home (replication + pgBackRest repo2), blob mirror home → VPS | lag < 1 s p99 over a week; restore test from repo2 OK | 3–4 days |
| 5. Switchover | planned: maintenance window, final blob sync, promote VPS, home rebuilt as standby (`pg_rewind`), app instances on VPS, DNS/proxy switch; legal edition published before | downtime ≤ 15 min; post-switch smoke + e2e green; home standby lag < 1 s | 2 days + window |
| 6. Drills + load | failover drill to home and back, load test at target, runbook finalised, alerts wired | RTO ≤ 30 min measured; 2k req/s with p95 targets met | 3–4 days |

Total ≈ 7–10 weeks for one developer, most of it phases 1–2. Phases 2–3 already deliver value at home (transactions,
multi-instance) even if the VPS step is postponed.

Rollback at each phase: 1 → revert release; 2 → `KNIFE_STORE_<area>=files` (files read-only copies kept); 4 → drop the
standby; 5 → reverse switchover (the home standby is promoted, same runbook).

## 6. Decisions needed from the owner

1. VPS provider, region (EU/EEA; latency to Poland) and size (proposed 8 dedicated vCPU / 32 GB / 2× NVMe ≥ 400 GB).
2. Async replication (RPO = seconds) or RPO 0 with a third node (extra VPS, quorum sync).
3. Where the app runs in steady state (proposed: VPS) and whether the home app stays warm (ready) or cold.
4. Acceptable downtime window for the switchover (≤ 15 min proposed) and RTO for an unplanned failover (30 min manual).
5. Backup retention (proposed 30 days PITR) and off-site repo2 provider.
6. Email as plaintext column (as today) vs HMAC lookup + sealed address.
7. Whether account rename must stay a feature (affects the key design).
8. Approval of the new legal edition (processor, location, backup retention) and the provider DPA.

## 7. Risks

- **Sync → async refactor** touches ~93 files; subtle ordering bugs (the code relies on "no await between read and
  write"). Mitigation: interface first with the files backend, area by area, contract tests.
- **Split brain** on a manual failover if the old primary is not fenced. Mitigation: fencing step first in the runbook,
  Tailscale ACL kill switch.
- **Home link down for long**: replication slot retains WAL on the VPS → `max_slot_wal_keep_size` bound, standby re-sync
  from pgBackRest, alert.
- **Blob/row skew** after failover (rows newer than the last blob sync). Mitigation: blob-first writes, frequent sync,
  a "missing blob" report.
- **Key loss**: sealed columns are unreadable without `storage.key`; it must be on both sites and backed up offline.
- **Polling load**: 2 s / 1.5 s polls × thousands of users dominate the query rate; must become cheap conditional reads
  or NOTIFY-driven before load targets are met.
- **Per-instance limits** (rate limits, quotas, job caps) silently multiply with instances if not migrated.
- **Legal**: running user data at a new processor without updated notice/DPA.
- **Operational load**: two Postgres clusters, PgBouncer, pgBackRest, monitoring — a new on-call surface for one owner.
