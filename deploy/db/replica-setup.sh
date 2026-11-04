#!/usr/bin/env bash
# Smart Knife core database — the DELAYED READ/BACKUP REPLICA on genorbox1 (docs/DB-POSTGRES.md "Replica").
# A physical streaming standby of the VPS primary that RECEIVES WAL continuously (nothing is lost on the way) but
# APPLIES it 5 minutes late (recovery_min_apply_delay): "synced back with a delay, non-aggressively". The delay is also a
# safety net: a bad write on the primary can be stopped (pg_wal_replay_pause()) before the copy applies it.
# The first copy is rate-limited (pg_basebackup --max-rate) so it never saturates the tunnel or the 1-vCPU VPS.
# Asynchronous: the primary never waits for this host (synchronous_standby_names = '').
#
# NOT run by anything in the repo. Run by hand as root on genorbox1 after reading it, with Postgres 18 from PGDG
# (same major as the primary) installed and its default cluster stopped:
#   sudo PRIMARY_HOST=10.77.0.1 REPL_PASSWORD_FILE=/root/knife-repl.pass bash deploy/db/replica-setup.sh
set -euo pipefail

PRIMARY_HOST="${PRIMARY_HOST:?tunnel address of the VPS primary, e.g. 10.77.0.1}"
PRIMARY_PORT="${PRIMARY_PORT:-5432}"
REPL_PASSWORD_FILE="${REPL_PASSWORD_FILE:?file holding the knife_replicator password, mode 0600}"
CA_FILE="${CA_FILE:-/etc/postgresql/18/main/tls/knife-ca.crt}"   # the CA that signed the primary's server.crt
SLOT="${SLOT:-genorbox1_delayed}"
APPLY_DELAY="${APPLY_DELAY:-5min}"
MAX_RATE="${MAX_RATE:-8M}"                                        # initial copy bandwidth cap (bytes/s)
PGDATA="${PGDATA:-/var/lib/postgresql/18/main}"
CLUSTER_PORT="${CLUSTER_PORT:-5433}"                              # local port of the replica (5432 may be used)

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
command -v pg_basebackup >/dev/null || { echo "install postgresql-18 (PGDG) first" >&2; exit 1; }
[ -s "$REPL_PASSWORD_FILE" ] || { echo "$REPL_PASSWORD_FILE is empty" >&2; exit 1; }
[ -s "$CA_FILE" ] || { echo "copy the primary's CA certificate to $CA_FILE first" >&2; exit 1; }

systemctl stop postgresql@18-main || true
if [ -e "$PGDATA/PG_VERSION" ]; then
  echo "$PGDATA is not empty; move it away first (this script never deletes a data directory)" >&2
  exit 1
fi
install -d -o postgres -g postgres -m 0700 "$PGDATA"

# libpq password file for the postgres OS user (the standby reconnects with it).
PGPASS=/var/lib/postgresql/.pgpass
install -o postgres -g postgres -m 0600 /dev/null "$PGPASS"
printf '%s:%s:replication:knife_replicator:%s\n' "$PRIMARY_HOST" "$PRIMARY_PORT" "$(cat "$REPL_PASSWORD_FILE")" > "$PGPASS"

CONNINFO="host=$PRIMARY_HOST port=$PRIMARY_PORT user=knife_replicator sslmode=verify-full sslrootcert=$CA_FILE application_name=genorbox1_delayed"
sudo -u postgres pg_basebackup --pgdata="$PGDATA" --dbname="$CONNINFO" --slot="$SLOT" \
  --wal-method=stream --checkpoint=spread --max-rate="$MAX_RATE" --progress --verbose

# Standby settings (written into the cluster's conf.d so they survive pg_basebackup's own postgresql.auto.conf).
cat > /etc/postgresql/18/main/conf.d/knife-replica.conf <<CONF
# Smart Knife delayed replica (deploy/db/replica-setup.sh)
port = $CLUSTER_PORT
listen_addresses = 'localhost'
hot_standby = on                     # read-only queries (reports, restore checks) on the delayed copy
primary_conninfo = '$CONNINFO passfile=$PGPASS'
primary_slot_name = '$SLOT'
recovery_min_apply_delay = '$APPLY_DELAY'
hot_standby_feedback = off           # never hold back vacuum on the small primary
wal_receiver_status_interval = 10s
wal_retrieve_retry_interval = 30s    # back off gently when the tunnel is down
max_standby_streaming_delay = 5min
shared_buffers = 128MB
CONF
sudo -u postgres touch "$PGDATA/standby.signal"
systemctl start postgresql@18-main
echo "replica started; check with:"
echo "  sudo -u postgres psql -p $CLUSTER_PORT -c 'SELECT status, sender_host, latest_end_lsn FROM pg_stat_wal_receiver'"
echo "  (on the primary) SELECT application_name, state, write_lag, replay_lag FROM pg_stat_replication;"
