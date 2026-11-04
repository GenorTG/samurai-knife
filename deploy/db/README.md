# deploy/db — Postgres primary on the VPS, delayed replica on genorbox1

Files only: nothing in the repo runs them. Contract: [docs/DB-POSTGRES.md](../../docs/DB-POSTGRES.md).
Placeholders: `100.64.0.1` = the VPS's tunnel address (Headscale/WireGuard), `100.64.0.2` = genorbox1's. Debian 13 on
the VPS, Debian 12 on genorbox1, PostgreSQL **18 from PGDG on both** (same major is required for physical replication).

| File | Where | What |
|---|---|---|
| `postgresql.knife.conf` | VPS `/etc/postgresql/18/main/conf.d/knife.conf` | sizing for 1 vCPU / 1 GB, WAL, TLS, async replication, archiving |
| `pg_hba.knife.conf` | VPS `/etc/postgresql/18/main/pg_hba.conf` | hostssl + scram only; app + replica from genorbox1 |
| `primary-setup.sql` | VPS, once | roles `knife_owner` / `knife_app` / `knife_replicator`, database `knife`, grants, replication slot |
| `replica-setup.sh` | genorbox1, once | delayed standby (5 min apply delay, rate-limited first copy) |
| `pgbackrest.conf` | both | repository on genorbox1, backups from the standby, encrypted |

## Steps (proposed; run by the owner after review, in this order)

VPS (as root):
1. Disk: put `/var/lib/postgresql` on the LUKS-encrypted volume (or confirm the VPS disk is encrypted at the provider).
2. `apt install -y postgresql-common && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh && apt install -y postgresql-18 pgbackrest`
3. TLS: a small private CA (`openssl req -x509 -newkey ed25519 -days 3650 -nodes -keyout knife-ca.key -out knife-ca.crt -subj /CN=knife-db-ca`),
   a server certificate for the VPS tunnel name/address signed by it (SAN = `IP:100.64.0.1` and the tailnet DNS name),
   into `/etc/postgresql/18/main/tls/` (owner postgres, key 0600). Keep `knife-ca.key` offline.
4. Copy `postgresql.knife.conf` to `conf.d/knife.conf` (edit `listen_addresses`), with `archive_mode = off` for now;
   replace pg_hba.conf with `pg_hba.knife.conf` (edit the addresses); `systemctl restart postgresql@18-main`.
5. Firewall: 5432/tcp (and pgBackRest's 8432/tcp) accepted ONLY on the tunnel interface from 100.64.0.2; dropped elsewhere.
6. `sudo -u postgres psql -v app_password="'…'" -v owner_password="'…'" -v repl_password="'…'" -f primary-setup.sql`
   (three long random passwords, kept in the password manager).
7. Memory check on the shared 1 GB box: `free -m` with mail relay + Headscale running; Postgres should stay < ~350 MB.

genorbox1 (app host, as the deploy user, with the checkout of the release that contains this branch):
8. `KNIFE_DB_URL='postgres://knife_owner:…@100.64.0.1:5432/knife?sslmode=verify-full&sslrootcert=/etc/samurai-knife/knife-db-ca.crt' npm run db:migrate`
9. Stop the live server (`sudo systemctl stop samurai-knife`), back up `/var/lib/samurai-knife`, then as the `knife` user:
   `KNIFE_DATA_DIR=/var/lib/samurai-knife KNIFE_DB_URL='postgres://knife_app:…@100.64.0.1/knife?sslmode=verify-full&sslrootcert=…' npm run db:import -- --dry-run`,
   then the same without `--dry-run`; it must end with `verified: database matches the files`.
10. Add to `/etc/samurai-knife/live.env`: `KNIFE_DB_URL=…knife_app…` (0640 root:knife), `KNIFE_DB_VERIFY=1`; start the
    server. The log must show `[db] core store on Postgres: N account(s)…` and `verify (start): database and files match`.
    knife-update's preflight must NOT see `KNIFE_DB_URL` (it would be refused by the writer lock): check its env first.
11. A week without `[db] verify … MISMATCH`: remove `KNIFE_DB_VERIFY=1`, restart.

Replica + backups (after step 10 works):
12. genorbox1: install `postgresql-18 pgbackrest` (PGDG), stop/remove its default empty cluster, copy the CA to
    `/etc/postgresql/18/main/tls/knife-ca.crt`, then
    `sudo PRIMARY_HOST=100.64.0.1 REPL_PASSWORD_FILE=/root/knife-repl.pass bash deploy/db/replica-setup.sh`.
    Check: `SELECT application_name, state, write_lag, replay_lag FROM pg_stat_replication;` on the VPS (replay_lag ≈ 5 min).
13. pgBackRest: certificates for both hosts from the same CA, `pgbackrest.conf` on both, on the VPS
    `pgbackrest server` as a service, `pgbackrest --stanza=knife stanza-create` on genorbox1, then on the VPS set
    `archive_mode = on` (already `archive_command = pgbackrest … archive-push`) and restart, `pgbackrest --stanza=knife check`,
    first `--type=full backup` on genorbox1, timers for weekly full / daily diff.
14. Alerts (existing admin mail path, later): replication `write_lag` > 30 s, archive failing > 5 min, slot retained WAL
    > 50 % of `max_slot_wal_keep_size`.

Rollback at any step before 11: unset `KNIFE_DB_URL` (and restart): the files are current while `KNIFE_DB_VERIFY=1`.
When the bigger VPS comes: raise the values marked "later:" in `postgresql.knife.conf`, nothing else changes.
