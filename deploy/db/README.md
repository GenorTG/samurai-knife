# deploy/db — Postgres primary on the VPS, delayed replica on genorbox1

Files only: nothing in the repo runs them. Contract: [docs/DB-POSTGRES.md](../../docs/DB-POSTGRES.md).
VPS: Debian 13, 1 vCPU / 1 GB RAM / 30 GB, also running the Postfix relay, Headscale and Caddy. genorbox1: Debian 12,
the app host. PostgreSQL **18 from PGDG on both** (same major is required for physical replication).

| File | Where | What |
|---|---|---|
| `wg-knife.vps.conf` / `wg-knife.genorbox1.conf` | `/etc/wireguard/wg-knife.conf` on each | the point-to-point database tunnel (10.77.0.1 ⇄ 10.77.0.2) |
| `nftables-knife-db.nft` | VPS `/etc/nftables.d/knife-db.nft` | 5432/8432 only from genorbox1 through the tunnel; 51821/udp open |
| `postgresql.knife.conf` | VPS `/etc/postgresql/18/main/conf.d/knife.conf` | sizing for 1 vCPU / 1 GB (and 4/16, 8/32 in comments), WAL, TLS, async replication, archiving |
| `knife-db.override.conf` | VPS `/etc/systemd/system/postgresql@18-main.service.d/` | start after the tunnel; OOM protection of the postmaster; MemoryHigh |
| `pg_hba.knife.conf` | VPS `/etc/postgresql/18/main/pg_hba.conf` | hostssl + scram only; migrations, app and replica from genorbox1 |
| `primary-setup.sql` | VPS, once | roles `knife_owner` / `knife_app` / `knife_replicator`, database `knife`, grants, replication slot |
| `replica-setup.sh` | genorbox1, once | delayed standby (5 min apply delay, rate-limited first copy) |
| `pgbackrest.conf` | both | repository on genorbox1, backups from the standby, encrypted |
| `cutover.sh` | genorbox1, once | steps 9-10 as one checked script: stop, back up, import, verify, live.env, start, smoke; `--check` = read-only, `--rollback` |

## How genorbox1 reaches the VPS: a dedicated WireGuard link (decision)

| Option | Verdict |
|---|---|
| **WireGuard point-to-point** (`wg-knife`, 10.77.0.0/30, genorbox1 dials in, keepalive 25 s) | **chosen**. Kernel WireGuard on both (Debian 12/13), one UDP port, ~0 RAM, no control plane; the database path depends on nothing but the two hosts and their keys. Adds no extra round trip beyond the WAN RTT. |
| Join both hosts to the Headscale network that runs on the VPS | no. genorbox1's Tailscale is on another tailnet (tailscale.com): one `tailscaled` serves one tailnet, so this needs a second userspace instance with overlapping 100.64.0.0/10 routes, and the database would stop when Headscale (or its DERP/coordination on the same 1 GB box) is down or misconfigured; its ACLs become part of the database's security boundary. |
| TLS over the internet with client certificates | no. 5432 would face the internet (pre-authentication attack surface, scanners, logs full of attempts), genorbox1's home address changes so a source-IP allow-list is fragile, and pgBackRest's 8432 the other way would need a port forward at home. Keep it as the fallback if UDP is ever blocked. |

TLS (verify-full against the private CA) and SCRAM stay on INSIDE the tunnel: the tunnel is the network boundary, TLS
authenticates the server, SCRAM the role. Avoid 100.64.0.0/10 for the tunnel: Tailscale on genorbox1 drops packets from
that range that do not arrive on `tailscale0`.

## Commands (run by the owner, in this order)

Values to fill in: `VPS_PUBLIC` (the VPS's public IPv4 or DNS name). Secrets are generated on the host that uses them;
the CA key never leaves genorbox1's offline storage (`/root/knife-db-ca/`, then the password manager / a USB stick).

### A. Tunnel

genorbox1 (root):
```sh
apt install -y wireguard-tools
umask 077; cd /etc/wireguard
wg genkey | tee wg-knife.key | wg pubkey > wg-knife.pub
wg genpsk > wg-knife.psk                 # copy this file to the VPS (scp over SSH), same content on both ends
cat wg-knife.pub                         # -> the VPS's [Peer] PublicKey
```
VPS (root):
```sh
apt install -y wireguard-tools nftables
umask 077; cd /etc/wireguard
wg genkey | tee wg-knife.key | wg pubkey > wg-knife.pub
# wg-knife.conf = deploy/db/wg-knife.vps.conf with the key, genorbox1's public key and the psk filled in
systemctl enable --now wg-quick@wg-knife
install -d /etc/nftables.d && cp nftables-knife-db.nft /etc/nftables.d/knife-db.nft
grep -q 'nftables.d' /etc/nftables.conf || echo 'include "/etc/nftables.d/*.nft"' >> /etc/nftables.conf
nft -c -f /etc/nftables.conf && systemctl enable nftables && systemctl reload nftables   # (restart if it was not running)
```
When the existing `inet filter` input chain has `policy drop` (it does on this VPS), its own accepts are needed too —
an accept in `knife_db` does not skip another table — so add, next to the other port rules in `/etc/nftables.conf`:
```
    udp dport 51821 accept comment "Smart Knife DB WireGuard (wg-knife)"
    iifname "wg-knife" ip saddr 10.77.0.2 tcp dport { 5432, 8432 } accept comment "Smart Knife DB from genorbox1 via wg-knife"
```
and put the `include` AFTER the `flush ruleset` line (appending it at the end does that). Keep a second SSH session open
while you reload, check `nft list ruleset` (the 587 rule unchanged) and open a NEW SSH connection before closing it.
genorbox1 (root): `wg-knife.conf` = `wg-knife.genorbox1.conf` filled in (Endpoint = `VPS_PUBLIC:51821`), then
`systemctl enable --now wg-quick@wg-knife && ping -c3 10.77.0.1 && wg show wg-knife` (latest handshake < 30 s).
If the VPS provider has its own firewall (security group), open 51821/udp there too.

### B. PostgreSQL 18 on the VPS

1. Disk: `/var/lib/postgresql` is on a LUKS2 volume in a file (`/var/lib/knife-pg.img`, not in crypttab, so boot never waits for
   it). The key is not on the VPS: genorbox1's `knife-pg-unlock.timer` (user unit) sends it to `/usr/local/sbin/knife-pg-unlock`
   every minute, which opens the volume and starts Postgres if needed. Keep a second copy of the key off both machines' disks
   being the only copy: losing it loses the primary. Swap: a 1 GB swapfile
   (`fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`, plus fstab) and
   `sysctl vm.swappiness=10` (`/etc/sysctl.d/90-knife-db.conf`), so a burst never OOM-kills the mail relay.
2. PGDG and the packages:
   ```sh
   apt install -y postgresql-common ca-certificates
   /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
   apt install -y postgresql-18 pgbackrest
   pg_lsclusters                            # 18 main online on 5432 (localhost only until the config below)
   ```
3. TLS. On genorbox1 (root), the private CA and every certificate:
   ```sh
   umask 077; mkdir -p /root/knife-db-ca && cd /root/knife-db-ca
   openssl genpkey -algorithm ed25519 -out knife-ca.key
   openssl req -x509 -key knife-ca.key -days 3650 -subj /CN=knife-db-ca -out knife-ca.crt \
     -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign
   issue() {  # issue <name> <subjectAltName> <extendedKeyUsage>
     openssl genpkey -algorithm ed25519 -out "$1.key"
     openssl req -new -key "$1.key" -subj "/CN=$1" -out "$1.csr"
     openssl x509 -req -in "$1.csr" -CA knife-ca.crt -CAkey knife-ca.key -days 825 -out "$1.crt" \
       -extfile <(printf 'subjectAltName=%s\nextendedKeyUsage=%s\nkeyUsage=critical,digitalSignature\n' "$2" "$3")
   }
   issue server    "IP:10.77.0.1,DNS:knife-db,IP:127.0.0.1,DNS:localhost" serverAuth   # Postgres on the VPS (+ loopback: checks on the VPS, SSH port-forward)
   issue vps       "IP:10.77.0.1,DNS:vps"        serverAuth,clientAuth      # pgBackRest on the VPS
   issue genorbox1 "IP:10.77.0.2,DNS:genorbox1"  serverAuth,clientAuth      # pgBackRest on genorbox1
   ```
   Copy `knife-ca.crt server.crt server.key vps.crt vps.key` to the VPS (scp over the tunnel), then on the VPS:
   ```sh
   install -d -o postgres -g postgres -m 0700 /etc/postgresql/18/main/tls /etc/pgbackrest/tls
   install -o postgres -g postgres -m 0644 knife-ca.crt server.crt /etc/postgresql/18/main/tls/
   install -o postgres -g postgres -m 0600 server.key /etc/postgresql/18/main/tls/
   install -o postgres -g postgres -m 0644 knife-ca.crt vps.crt /etc/pgbackrest/tls/
   install -o postgres -g postgres -m 0600 vps.key /etc/pgbackrest/tls/
   shred -u server.key vps.key
   ```
4. Configuration (with `archive_mode = off` until step D):
   ```sh
   install -o postgres -g postgres -m 0644 postgresql.knife.conf /etc/postgresql/18/main/conf.d/knife.conf
   sed -i 's/^archive_mode = on/archive_mode = off/' /etc/postgresql/18/main/conf.d/knife.conf
   install -o postgres -g postgres -m 0640 pg_hba.knife.conf /etc/postgresql/18/main/pg_hba.conf
   install -D -m 0644 knife-db.override.conf /etc/systemd/system/postgresql@18-main.service.d/knife-db.override.conf
   systemctl daemon-reload && systemctl restart postgresql@18-main
   ss -ltnp | grep 5432                     # 127.0.0.1, ::1 and 10.77.0.1 only
   ```
5. Roles and database (three long random passwords into the password manager first, e.g. `openssl rand -base64 33`):
   ```sh
   sudo -u postgres psql -v app_password="'…'" -v owner_password="'…'" -v repl_password="'…'" -f primary-setup.sql
   ```
6. Checks: `free -m` with the relay, Headscale and Caddy running (Postgres ≈ 150-300 MB RSS idle/busy);
   from genorbox1 `psql "host=10.77.0.1 dbname=knife user=knife_app sslmode=verify-full sslrootcert=/root/knife-db-ca/knife-ca.crt" -c 'select 1'`;
   from anywhere else `nc -zv VPS_PUBLIC 5432` must time out.

### C. The app on genorbox1

7. CA for the app: `install -D -o root -g knife -m 0644 /root/knife-db-ca/knife-ca.crt /etc/samurai-knife/knife-db-ca.crt`.
8. Schema (as the deploy user, from the release checkout that contains this branch):
   `KNIFE_DB_URL='postgres://knife_owner:…@10.77.0.1:5432/knife?sslmode=verify-full&sslrootcert=/etc/samurai-knife/knife-db-ca.crt' npm run db:migrate`
   (`-- --status` shows applied/pending).
9. (`deploy/db/cutover.sh` does 9 and 10 with checks and an automatic return to files on any failure: run it with
   `--check` first, with the server still up.) Stop the live server (`sudo systemctl stop samurai-knife`), back up `/var/lib/samurai-knife`, then as the `knife` user:
   `KNIFE_DATA_DIR=/var/lib/samurai-knife KNIFE_DB_URL='postgres://knife_app:…@10.77.0.1/knife?sslmode=verify-full&sslrootcert=/etc/samurai-knife/knife-db-ca.crt' npm run db:import -- --dry-run`,
   then the same without `--dry-run`; it must end with `verified: database matches the files`.
10. Add to `/etc/samurai-knife/live.env`: `KNIFE_DB_URL=…knife_app…` (0640 root:knife), `KNIFE_DB_VERIFY=1`; start the
    server. The log must show `[db] core store on Postgres: N account(s)…` and `verify (start): database and files match`.
    knife-update's preflight must NOT see `KNIFE_DB_URL` (it would be refused by the writer lock): check its env first.
    The service must start after `wg-quick@wg-knife` (`systemctl edit samurai-knife`: `After=` + `Wants=` it).
11. A week without `[db] verify … MISMATCH`: remove `KNIFE_DB_VERIFY=1`, restart.

### D. Replica and backups (after step 10 works)

12. genorbox1: `apt install -y postgresql-common && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y && apt install -y postgresql-18 pgbackrest`;
    `systemctl stop postgresql@18-main && mv /var/lib/postgresql/18/main /var/lib/postgresql/18/main.empty`;
    `install -D -o postgres -g postgres -m 0644 /root/knife-db-ca/knife-ca.crt /etc/postgresql/18/main/tls/knife-ca.crt`;
    the replicator password into `/root/knife-repl.pass` (0600), then
    `sudo PRIMARY_HOST=10.77.0.1 REPL_PASSWORD_FILE=/root/knife-repl.pass bash deploy/db/replica-setup.sh`.
    Check on the VPS: `sudo -u postgres psql -c 'SELECT application_name, state, write_lag, replay_lag FROM pg_stat_replication'` (replay_lag ≈ 5 min).
13. pgBackRest: on genorbox1 copy `genorbox1.{crt,key}` + `knife-ca.crt` to `/etc/pgbackrest/tls/` (postgres, key 0600),
    `pgbackrest.conf` (genorbox1 block, a long random `repo1-cipher-pass`) to `/etc/pgbackrest/pgbackrest.conf`,
    `install -d -o postgres -g postgres -m 0750 /var/lib/pgbackrest`; on the VPS the VPS block to the same path and
    `install -d -o postgres -g postgres /var/spool/pgbackrest`. On BOTH: a `pgbackrest-server.service`
    (`ExecStart=/usr/bin/pgbackrest server`, `User=postgres`, `After=wg-quick@wg-knife.service`) enabled; on genorbox1
    allow 8432/tcp only from 10.77.0.1 on `wg-knife` (mirror of `nftables-knife-db.nft`).
    Then, as postgres on genorbox1: `pgbackrest --stanza=knife stanza-create`; on the VPS set `archive_mode = on` in
    `conf.d/knife.conf` and `systemctl restart postgresql@18-main`; `pgbackrest --stanza=knife check` (both hosts);
    first `pgbackrest --stanza=knife --type=full backup` on genorbox1; systemd timers for weekly full / daily diff.
14. Alerts (existing admin mail path, later): replication `write_lag` > 30 s, archive failing > 5 min, slot retained WAL
    > 50 % of `max_slot_wal_keep_size`, VPS `MemAvailable` < 100 MB.

Rollback at any step before 11: unset `KNIFE_DB_URL` (and restart): the files are current while `KNIFE_DB_VERIFY=1`.

## The bigger VPS later (4-8 vCPU / 16-32 GB)

Only `conf.d/knife.conf` changes (the "later:" values, 4 vCPU / 16 GB | 8 vCPU / 32 GB):

| Setting | today (1/1 GB) | 4 vCPU / 16 GB | 8 vCPU / 32 GB |
|---|---|---|---|
| `max_connections` | 20 | 50 | 100 (PgBouncer once there are several app instances) |
| `shared_buffers` | 128MB | 4GB | 8GB |
| `effective_cache_size` | 256MB | 12GB | 24GB |
| `work_mem` / `maintenance_work_mem` / `autovacuum_work_mem` | 4MB / 32MB / 16MB | 16MB / 512MB / 256MB | 32MB / 1GB / 512MB |
| `huge_pages` | off | try (+ `vm.nr_hugepages` ≈ 2200) | try (+ ≈ 4400) |
| `max_worker_processes` / `max_parallel_workers` / `_per_gather` | 4 / 1 / 0 | 8 / 4 / 2 | 16 / 8 / 4 |
| `io_workers` / `autovacuum_max_workers` | 2 / 2 | 4 / 3 | 8 / 4 |
| `max_wal_size` / `min_wal_size` / `wal_buffers` | 1GB / 128MB / 4MB | 4GB / 1GB / -1 | 8GB / 2GB / -1 |
| `max_slot_wal_keep_size` / `temp_file_limit` | 3GB / 1GB | 20GB / 10GB | 20GB / 10GB |
| `effective_io_concurrency` / `maintenance_io_concurrency` | 64 / 16 | 200 / 64 | 200 / 64 |

and the drop-in's `MemoryHigh` goes (or rises to ~75 % of RAM). The replica on genorbox1 needs `max_connections` and
`max_worker_processes` at least the primary's (its defaults, 100 and 8, cover the 4/16 column; raise them for 8/32).
