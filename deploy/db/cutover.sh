#!/usr/bin/env bash
# Smart Knife core database — the CUT-OVER of the live server from files to the VPS Postgres primary
# (deploy/db/README.md steps 9-10, docs/DB-POSTGRES.md "Cut-over"). NOT run by anything in the repo: the owner runs it
# as root on genorbox1 after the tunnel (wg-knife), the schema (npm run db:migrate as knife_owner) and the CA file exist.
#
#   sudo DB_URL_FILE=/root/knife-db-app.url bash deploy/db/cutover.sh --check   # read-only: preflight + import dry run
#   sudo DB_URL_FILE=/root/knife-db-app.url bash deploy/db/cutover.sh           # the cut-over, asks before each step
#   sudo DB_URL_FILE=/root/knife-db-app.url bash deploy/db/cutover.sh --yes     # same, no questions
#   sudo bash deploy/db/cutover.sh --rollback <live.env backup>                 # back to files (while KNIFE_DB_VERIFY=1)
#
# DB_URL_FILE: one line, the knife_app URL (root 0600), e.g.
#   postgres://knife_app:<password>@10.77.0.1:5432/knife?sslmode=verify-full&sslrootcert=/etc/samurai-knife/knife-db-ca.crt
# The password never appears on a command line or in this script's output.
#
# Steps: preflight -> stop samurai-knife (and the updater timer) -> back up the data dir -> db:import --dry-run ->
# db:import (must end "verified: database matches the files") -> db:import --verify (counts + SHA-256 per record) ->
# live.env += KNIFE_DB_URL + KNIFE_DB_VERIFY=1 (old file kept) and a drop-in ordering the unit after wg-quick@wg-knife
# -> start -> the log must show "core store on Postgres" and "verify (start): database and files match" -> smoke
# (the knife-update health check URLs) -> updater timer back on. Any failure after the stop: the old live.env is put
# back and the server starts on files again (the files were never changed by the import).
set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/samurai-knife}"
APP="${APP:-$APP_ROOT/current}"
DATA="${DATA:-/var/lib/samurai-knife}"
ETC="${ETC:-/etc/samurai-knife}"
LIVE_ENV="$ETC/live.env"
CA_FILE="${CA_FILE:-$ETC/knife-db-ca.crt}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/samurai-knife}"
UNIT=samurai-knife.service
TUNNEL_PEER="${TUNNEL_PEER:-10.77.0.1}"
DROPIN="/etc/systemd/system/$UNIT.d/knife-db.conf"
MODE=run YES=""
case "${1:-}" in
  --check) MODE=check ;;
  --yes) YES=1 ;;
  --rollback) MODE=rollback; ROLLBACK_FROM="${2:?--rollback <live.env backup>}" ;;
  "") ;;
  *) echo "usage: cutover.sh [--check|--yes|--rollback <live.env backup>]" >&2; exit 64 ;;
esac
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
say() { printf '\n== %s\n' "$*"; }
die() { echo "cutover: $*" >&2; exit 1; }
ask() { [[ -n "$YES" ]] && return 0; read -r -p "$1 [y/N] " a; [[ "$a" == y || "$a" == Y ]] || die "stopped by the operator"; }
env_val() { sed -n "s/^$1=//p" "$LIVE_ENV" | tail -1; }
port() { local p; p="$(env_val KNIFE_PORT)"; echo "${p:-3210}"; }
host() { local h; h="$(env_val KNIFE_HOST)"; echo "${h:-127.0.0.1}"; }

[[ "$(id -u)" -eq 0 ]] || die "run as root"

if [[ "$MODE" == rollback ]]; then
  [[ -s "$ROLLBACK_FROM" ]] || die "$ROLLBACK_FROM is empty"
  grep -q '^KNIFE_DB_URL=' "$ROLLBACK_FROM" && die "$ROLLBACK_FROM still sets KNIFE_DB_URL: pick the backup taken before the cut-over"
  systemctl stop "$UNIT"
  install -o root -g knife -m 0640 "$ROLLBACK_FROM" "$LIVE_ENV"
  systemctl start "$UNIT"
  echo "rolled back: $UNIT runs on files again (valid while the cut-over ran with KNIFE_DB_VERIFY=1)"
  exit 0
fi

# Runs a db:import as the app user with the app's own settings (data dir, storage key) and the database URL.
db_import() {
  local url; url="$(head -n1 "$DB_URL_FILE")"
  ( cd "$APP" && runuser -u knife -- env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp NODE_ENV=production \
      KNIFE_DATA_DIR="$DATA" KNIFE_STORAGE_KEY_FILE="$ETC/storage.key" NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt \
      KNIFE_DB_URL="$url" npm run --silent db:import -- "$@" )
}

# ------------------------------------------------------------------------------------------------------------ preflight
say "preflight"
DB_URL_FILE="${DB_URL_FILE:?DB_URL_FILE = file holding the knife_app URL (root 0600)}"
[[ -s "$DB_URL_FILE" ]] || die "$DB_URL_FILE is empty"
[[ "$(stat -c %a "$DB_URL_FILE")" == 600 ]] || die "$DB_URL_FILE must be mode 0600"
url="$(head -n1 "$DB_URL_FILE")"
[[ "$url" == postgres://knife_app:* ]] || die "the URL must connect as knife_app (migrations alone use knife_owner)"
[[ "$url" == *sslmode=verify-full* ]] || die "the URL must use sslmode=verify-full"
[[ -s "$CA_FILE" ]] || die "$CA_FILE missing (README step 7)"
[[ "$(stat -c %G "$CA_FILE")" == knife ]] || die "$CA_FILE must be readable by group knife"
[[ -d "$APP/scripts" && -f "$APP/scripts/db-import.mjs" ]] || die "$APP has no scripts/db-import.mjs (a release with the Postgres backend)"
grep -q '^KNIFE_DB_URL=' "$LIVE_ENV" && die "$LIVE_ENV already sets KNIFE_DB_URL: the cut-over has been done"
systemctl is-active --quiet wg-quick@wg-knife || die "wg-quick@wg-knife is not active"
ping -c2 -W2 "$TUNNEL_PEER" >/dev/null || die "the VPS ($TUNNEL_PEER) does not answer through wg-knife"
for f in accounts.json provider-keys.key; do [[ -f "$DATA/$f" ]] || die "$DATA/$f missing"; done
UPDATER="${UPDATER:-/usr/local/libexec/samurai-knife/knife-update}"
grep -q 'env -i PATH' "$UPDATER" || die "$UPDATER does not start its preflight with env -i: it could inherit KNIFE_DB_URL"
grep -q 'KNIFE_DB_URL' "$UPDATER" && die "knife-update mentions KNIFE_DB_URL: check its preflight env first"
grep -q '^EnvironmentFile=.*live.env' /etc/systemd/system/knife-update.service 2>/dev/null && die "knife-update.service reads live.env: its preflight would take the writer lock"
echo "ok: URL file, CA, tunnel, release, data dir; knife-update's preflight runs with env -i (no KNIFE_DB_URL)"

if [[ "$MODE" == check ]]; then
  say "db:import --dry-run (server still running on files: a preview only)"
  db_import --dry-run
  echo; echo "check done: nothing changed."
  exit 0
fi

# ------------------------------------------------------------------------------------------------------------- cut-over
ask "stop $UNIT (and knife-update.timer) now?"
timer_was_active=""
systemctl is-active --quiet knife-update.timer && timer_was_active=1
systemctl stop knife-update.timer || true
systemctl is-active --quiet knife-update.service && die "knife-update is running right now; wait for it and run again"
systemctl stop "$UNIT"
ENV_BACKUP="$ETC/live.env.before-db-$STAMP"
install -o root -g root -m 0600 "$LIVE_ENV" "$ENV_BACKUP"

restore() {
  echo "cutover: FAILED at: $1 -> back to files" >&2
  install -o root -g knife -m 0640 "$ENV_BACKUP" "$LIVE_ENV"
  rm -f "$DROPIN"; systemctl daemon-reload
  systemctl start "$UNIT" || true
  [[ -n "$timer_was_active" ]] && systemctl start knife-update.timer || true
  echo "cutover: $UNIT restarted on files (live.env restored from $ENV_BACKUP)" >&2
  exit 1
}

say "backup of $DATA"
install -d -o root -g root -m 0700 "$BACKUP_DIR"
ARCHIVE="$BACKUP_DIR/data-before-db-$STAMP.tar.zst"
tar --zstd -C "$(dirname "$DATA")" -cpf "$ARCHIVE" "$(basename "$DATA")" || restore "backup"
sha256sum "$ARCHIVE" > "$ARCHIVE.sha256"
echo "$ARCHIVE ($(du -h "$ARCHIVE" | cut -f1)), live.env copy $ENV_BACKUP"

say "db:import --dry-run"
db_import --dry-run || restore "import dry run"
ask "write these rows into the database?"

say "db:import"
out="$(db_import 2>&1)" || { echo "$out"; restore "import"; }
echo "$out"
grep -q 'verified: database matches the files' <<<"$out" || restore "import did not end verified"

say "db:import --verify (counts + SHA-256 per record)"
db_import --verify || restore "verify"

say "live.env + unit ordering"
ask "switch $UNIT to Postgres (KNIFE_DB_URL + KNIFE_DB_VERIFY=1) and start it?"
tmp="$(mktemp)"
cat "$LIVE_ENV" > "$tmp"
printf '\n# Core tables on the VPS Postgres primary (deploy/db/cutover.sh %s); drop KNIFE_DB_VERIFY after a quiet week\nKNIFE_DB_URL=%s\nKNIFE_DB_VERIFY=1\n' "$STAMP" "$url" >> "$tmp"
install -o root -g knife -m 0640 "$tmp" "$LIVE_ENV"; rm -f "$tmp"
install -d -m 0755 "$(dirname "$DROPIN")"
printf '# deploy/db/cutover.sh: the database is reached through the WireGuard tunnel\n[Unit]\nWants=wg-quick@wg-knife.service\nAfter=wg-quick@wg-knife.service\n' > "$DROPIN"
systemctl daemon-reload

say "start"
since="$(date '+%Y-%m-%d %H:%M:%S')"
systemctl start "$UNIT" || restore "start"
base="http://$(host):$(port)"
ok=""
for _ in $(seq 120); do curl -s -o /dev/null --max-time 2 "$base/login" && { ok=1; break; }; sleep 1; done
[[ -n "$ok" ]] || restore "the server did not answer"
log="$(journalctl -u "$UNIT" --since "$since" --no-pager -o cat)"
grep -q '\[db\] core store on Postgres' <<<"$log" || restore "no 'core store on Postgres' line"
grep -q 'verify (start): database and files match' <<<"$log" || restore "no 'verify (start): database and files match' line"
grep -q 'MISMATCH' <<<"$log" && restore "verify MISMATCH at start"
grep -E '\[db\] (core store|verify)' <<<"$log"

say "smoke"
for u in / /login; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$base$u")"; [[ "$code" == 200 ]] || restore "$u -> $code"
done
for u in /tools/json /tools/cv-studio; do
  # \n: read fails at end of input without a newline, and set -e would then end the script here, updater timer still off.
  read -r code where < <(curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' --max-time 20 "$base$u")
  [[ "$code" == 200 || ( "$code" == 307 && "$where" == *"/login?next="* ) ]] || restore "$u -> $code"
done
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$base/api/account")"
[[ "$code" == 200 || "$code" == 401 ]] || restore "/api/account -> $code"
echo "pages, account API answer"
[[ -n "$timer_was_active" ]] && systemctl start knife-update.timer

say "done"
cat <<EOF
$UNIT runs on Postgres (verify mode). Now: sign in at the public URL, change a setting, sign out and in again.
Watch for a week:   journalctl -u $UNIT | grep -E '\[db\] verify .*MISMATCH'   (must stay empty)
Rollback meanwhile: sudo bash deploy/db/cutover.sh --rollback $ENV_BACKUP
Data backup:        $ARCHIVE
EOF
