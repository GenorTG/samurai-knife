#!/usr/bin/env bash
# Smart Knife installer: runs the app as a dedicated `knife` system user under systemd (docs/DEPLOY.md "Install
# script"). Idempotent: run it again to update the installed units, the updater or the settings.
#
#   sudo deploy/install.sh --check                          # prerequisites only, changes nothing
#   sudo deploy/install.sh --env live.env [--start]         # fresh install
#   sudo deploy/install.sh --env live.env --storage-key old/storage.key --github-app old/github-app.json \
#        --migrate-data ~/.local/share/samurai-knife --start   # move an existing install (stop the old server first)
#
# What it sets up:
#   users      knife (runs the app: no login, no sudo, no docker) and knife-deploy (builds releases: no app data)
#   code       <app-root>/releases/<tag> + <app-root>/current, built by knife-update as knife-deploy
#   settings   /etc/samurai-knife/live.env and storage.key (root:knife 0640), update.conf (root:knife-deploy 0640)
#   state      /var/lib/samurai-knife (data), /var/lib/samurai-knife-secrets (GitHub App), /var/cache/samurai-knife
#   units      samurai-knife.service, knife-update.service + .timer (every 15 min), knife-email-lists.timer (weekly),
#              the polkit rule that lets knife-deploy restart the app, and with Docker the root sidecar helper
#   tools      /usr/local/sbin/knife-admin (accounts / storage / email-lists as knife), knife-sidecar (with Docker)
set -euo pipefail

SRC="$(cd "$(dirname "$(realpath "$0")")/.." && pwd)"   # the checkout this script is in
APP_ROOT=/opt/samurai-knife
REPO_URL=""; REF=""; ENV_IN=""; KEY_IN=""; GH_IN=""; DATA_IN=""
SIDECARS=auto; START=""; CHECK_ONLY=""; ASSUME_YES=""
SERVICE=samurai-knife.service
ETC=/etc/samurai-knife
DATA=/var/lib/samurai-knife
SECRETS=/var/lib/samurai-knife-secrets
CACHE=/var/cache/samurai-knife
LIBEXEC=/usr/local/libexec/samurai-knife
UNITS=/etc/systemd/system
MIN_NODE=22
MIN_PY=3.11
# Keys the unit sets itself; a copy in live.env would override them (EnvironmentFile wins over Environment=).
UNIT_KEYS="KNIFE_DATA_DIR KNIFE_STORAGE_KEY_FILE KNIFE_GITHUB_APP_FILE KNIFE_SIDECAR_BACKEND KNIFE_SIDECAR_HELPER_SOCKET KNIFE_PYTHON KNIFE_PY_HOME NODE_ENV PATH"

usage() { sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; cat <<'EOF'

Options:
  --check                only check prerequisites
  --env FILE             app settings (KNIFE_*) to install as /etc/samurai-knife/live.env
  --storage-key FILE     keep an existing storage key (64 hex chars); else one is generated
  --github-app FILE      existing GitHub App credentials (docs/GITHUB.md)
  --migrate-data DIR     copy an existing data directory into /var/lib/samurai-knife (old server stopped)
  --repo URL             git remote to deploy from (default: this checkout's origin)
  --ref REF              release to install first (default: the newest v* tag)
  --app-root DIR         where releases live (default /opt/samurai-knife; must not be under /home)
  --no-sidecars          skip the root sidecar helper even if Docker is installed
  --start                enable and start the app at the end
  --yes                  install missing system packages without asking
EOF
}
while (($#)); do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --env) ENV_IN="${2:?}"; shift ;;
    --storage-key) KEY_IN="${2:?}"; shift ;;
    --github-app) GH_IN="${2:?}"; shift ;;
    --migrate-data) DATA_IN="${2:?}"; shift ;;
    --repo) REPO_URL="${2:?}"; shift ;;
    --ref) REF="${2:?}"; shift ;;
    --app-root) APP_ROOT="${2:?}"; shift ;;
    --no-sidecars) SIDECARS=no ;;
    --start) START=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 64 ;;
  esac
  shift
done

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
[[ "$(id -u)" == 0 ]] || die "run as root (sudo $0 ...)"
umask 022

# ------------------------------------------------------------------------------------------------ prerequisites
problems=()
need_pkgs=()
[[ -d /run/systemd/system ]] || problems+=("systemd is not the init system")
case "$APP_ROOT" in /home/*|/root/*) problems+=("--app-root $APP_ROOT is under /home: the unit hides /home (ProtectHome)") ;; esac

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then problems+=("node $MIN_NODE+ not found (install Node.js system-wide, e.g. NodeSource)")
else
  NODE_BIN="$(realpath "$NODE_BIN")"
  case "$NODE_BIN" in /home/*) problems+=("node resolves to $NODE_BIN (under /home: invisible to the service); install it system-wide") ;; esac
  major="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  (( major >= MIN_NODE )) || problems+=("node $("$NODE_BIN" --version) is older than v$MIN_NODE")
  [[ -x "$(dirname "$NODE_BIN")/npm" ]] || problems+=("npm not found next to $NODE_BIN")
fi
PYTHON_BIN="$(command -v python3 || true)"
if [[ -z "$PYTHON_BIN" ]] || ! "$PYTHON_BIN" -c "import sys; sys.exit(sys.version_info < (${MIN_PY/./,}))" 2>/dev/null; then
  problems+=("python3 $MIN_PY+ not found in /usr/bin")
elif ! "$PYTHON_BIN" -c 'import ensurepip, venv' 2>/dev/null; then need_pkgs+=(python3-venv)
fi
for pair in git:git curl:curl rsync:rsync flock:util-linux bwrap:bubblewrap tesseract:tesseract-ocr qpdf:qpdf gs:ghostscript pkcheck:polkitd; do
  command -v "${pair%%:*}" >/dev/null 2>&1 || need_pkgs+=("${pair#*:}")
done
if command -v tesseract >/dev/null 2>&1; then
  langs="$(tesseract --list-langs 2>/dev/null || true)"
  for l in eng pol osd; do grep -qx "$l" <<<"$langs" || need_pkgs+=("tesseract-ocr-$l"); done
fi
userns="$(sysctl -n kernel.unprivileged_userns_clone 2>/dev/null || echo 1)"
maxns="$(sysctl -n user.max_user_namespaces 2>/dev/null || echo 1)"
[[ "$userns" == 1 && "$maxns" != 0 ]] || problems+=("unprivileged user namespaces are off (the Python parser sandbox needs kernel.unprivileged_userns_clone=1)")
if [[ "$SIDECARS" == auto ]]; then command -v docker >/dev/null 2>&1 && SIDECARS=yes || SIDECARS=no; fi
if [[ -z "$REPO_URL" ]]; then REPO_URL="$(git -C "$SRC" remote get-url origin 2>/dev/null || true)"; fi
[[ -n "$REPO_URL" ]] || problems+=("no --repo given and $SRC has no origin remote")
case "$REPO_URL" in git@*|ssh://*) problems+=("--repo $REPO_URL needs SSH keys knife-deploy does not have: use the https URL") ;; esac
for f in "$ENV_IN" "$KEY_IN" "$GH_IN"; do [[ -z "$f" || -r "$f" ]] || problems+=("cannot read $f"); done
[[ -z "$DATA_IN" || -d "$DATA_IN" ]] || problems+=("--migrate-data $DATA_IN is not a directory")

say "prerequisites"
echo "  node     ${NODE_BIN:-missing}"
echo "  python   ${PYTHON_BIN:-missing}"
echo "  repo     ${REPO_URL:-missing}"
echo "  sidecars $SIDECARS"
if ((${#need_pkgs[@]})); then
  mapfile -t need_pkgs < <(printf '%s\n' "${need_pkgs[@]}" | sort -u)
  echo "  missing packages: ${need_pkgs[*]}"
fi
if ((${#problems[@]})); then printf '  \033[31mproblem:\033[0m %s\n' "${problems[@]}"; die "fix the problems above first"; fi
if [[ -n "$CHECK_ONLY" ]]; then echo "  ok"; exit 0; fi

if ((${#need_pkgs[@]})); then
  command -v apt-get >/dev/null || die "install these packages with your package manager: ${need_pkgs[*]}"
  if [[ -z "$ASSUME_YES" ]]; then read -r -p "Install ${need_pkgs[*]} with apt-get? [y/N] " a; [[ "$a" == [yY]* ]] || die "cancelled"; fi
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${need_pkgs[@]}"
fi

# ------------------------------------------------------------------------------------------------ users and dirs
say "users"
getent group knife >/dev/null || groupadd --system knife
getent passwd knife >/dev/null || useradd --system --gid knife --home-dir "$DATA" --no-create-home --shell /usr/sbin/nologin knife
getent group knife-deploy >/dev/null || groupadd --system knife-deploy
getent passwd knife-deploy >/dev/null || useradd --system --gid knife-deploy --home-dir /var/lib/knife-deploy --no-create-home --shell /usr/sbin/nologin knife-deploy
for g in docker sudo adm; do
  id -nG knife 2>/dev/null | tr ' ' '\n' | grep -qx "$g" && die "user knife is in group $g: remove it (it must not reach docker or root)"
done

say "directories"
install -d -o knife-deploy -g knife-deploy -m 0755 "$APP_ROOT" "$APP_ROOT/releases"
install -d -o root -g root -m 0751 "$ETC"
install -d -o knife -g knife -m 0700 "$DATA" "$SECRETS" "$CACHE"
install -d -o knife-deploy -g knife-deploy -m 0750 /var/lib/knife-deploy
install -d -o root -g root -m 0755 "$LIBEXEC"

# ------------------------------------------------------------------------------------------------ settings and secrets
env_host="127.0.0.1"; env_port="3210"
if [[ -n "$ENV_IN" ]]; then
  say "settings -> $ETC/live.env"
  tmp="$(mktemp)"
  drop_re="^($(tr ' ' '|' <<<"$UNIT_KEYS"))="
  grep -vE "$drop_re" "$ENV_IN" >"$tmp" || true
  dropped="$(grep -oE "$drop_re" "$ENV_IN" | tr -d '=' | tr '\n' ' ' || true)"
  [[ -n "$dropped" ]] && echo "  left out (the unit sets them): $dropped"
  # Extra sandbox roots under /home can never work (ProtectHome) and make public mode refuse to start: drop them.
  ro_line="$(grep -E '^KNIFE_PY_SANDBOX_RO=' "$tmp" | tail -1 || true)"
  if [[ -n "$ro_line" ]]; then
    kept_ro="$(tr ':' '\n' <<<"${ro_line#*=}" | tr -d '"' | grep -vE '^(/home|/root)(/|$)' | paste -sd: || true)"
    grep -vE '^KNIFE_PY_SANDBOX_RO=' "$tmp" >"$tmp.2" || true; mv "$tmp.2" "$tmp"
    [[ -n "$kept_ro" ]] && echo "KNIFE_PY_SANDBOX_RO=$kept_ro" >>"$tmp"
    [[ "$kept_ro" != "${ro_line#*=}" ]] && echo "  left out of KNIFE_PY_SANDBOX_RO: paths under /home (OCR tools must come from /usr)"
  fi
  { grep -nE '^[A-Z_]+=.*/home/' "$tmp" || true; } | sed -E 's/=.*//' | while read -r l; do warn "live.env line $l points under /home, which the service cannot see"; done
  install -o root -g knife -m 0640 "$tmp" "$ETC/live.env"; rm -f "$tmp"
elif [[ ! -f "$ETC/live.env" ]]; then
  say "settings: writing a template to $ETC/live.env (edit it before --start)"
  cat >"$ETC/live.env" <<'EOF'
# KNIFE_UNCONFIGURED: delete this line once the values below are set (docs/DEPLOY.md section 2, .env.example).
KNIFE_AUTH_MODE=public
KNIFE_HOST=127.0.0.1
KNIFE_PORT=3220
KNIFE_PUBLIC_URL=https://knife.example.org
KNIFE_TRUSTED_PROXIES=127.0.0.1/32
KNIFE_MAIL_TRANSPORT=smtp
KNIFE_SMTP_HOST=
KNIFE_SMTP_FROM="Smart Knife <no-reply@knife.example.org>"
EOF
  chown root:knife "$ETC/live.env"; chmod 0640 "$ETC/live.env"
fi
env_val() { sed -n "s/^$1=//p" "$ETC/live.env" | tail -1 | sed -e 's/^"\(.*\)"$/\1/'; }
env_host="$(env_val KNIFE_HOST)"; env_host="${env_host:-127.0.0.1}"
env_port="$(env_val KNIFE_PORT)"; env_port="${env_port:-3210}"
[[ "$env_host" == *:* ]] && live_url="http://[$env_host]:$env_port" || live_url="http://$env_host:$env_port"

if [[ -z "$KEY_IN" && -n "$DATA_IN" && -f "$DATA_IN/storage.key" ]]; then KEY_IN="$DATA_IN/storage.key"; fi
if [[ -n "$KEY_IN" ]]; then
  grep -qE '^[0-9a-f]{64}$' <(tr -d '[:space:]' <"$KEY_IN"; echo) || die "$KEY_IN is not a storage key (64 hex characters)"
  if [[ -f "$ETC/storage.key" ]] && ! cmp -s <(tr -d '[:space:]' <"$KEY_IN") <(tr -d '[:space:]' <"$ETC/storage.key"); then
    die "$ETC/storage.key already holds a different key: refusing to replace it (sealed data would become unreadable)"
  fi
  say "storage key -> $ETC/storage.key (kept byte for byte)"
  install -o root -g knife -m 0640 "$KEY_IN" "$ETC/storage.key"
elif [[ ! -f "$ETC/storage.key" ]]; then
  say "storage key: generating $ETC/storage.key (back it up apart from the data)"
  ( umask 077; "$PYTHON_BIN" -c 'import secrets; print(secrets.token_hex(32))' >"$ETC/storage.key" )
  chown root:knife "$ETC/storage.key"; chmod 0640 "$ETC/storage.key"
fi
if [[ -n "$GH_IN" ]]; then
  say "GitHub App credentials -> $SECRETS/github-app.json"
  install -o knife -g knife -m 0600 "$GH_IN" "$SECRETS/github-app.json"
fi

# ------------------------------------------------------------------------------------------------ data
port_busy() { (exec 3<>"/dev/tcp/${env_host}/${env_port}") 2>/dev/null; }
if [[ -n "$DATA_IN" ]]; then
  systemctl is-active --quiet "$SERVICE" && die "$SERVICE is running: stop it before migrating data"
  port_busy && die "something listens on $env_host:$env_port: stop the old server first (never two servers on one data set)"
  if [[ -n "$(ls -A "$DATA" 2>/dev/null)" && -z "$ASSUME_YES" ]]; then
    read -r -p "$DATA is not empty; replace its contents with $DATA_IN? [y/N] " a; [[ "$a" == [yY]* ]] || die "cancelled"
  fi
  say "data: $DATA_IN -> $DATA"
  rsync -a --delete --exclude=storage.key --chown=knife:knife "$DATA_IN"/ "$DATA"/
  chmod 0700 "$DATA"
fi

# ------------------------------------------------------------------------------------------------ units
say "updater and units"
install -o root -g root -m 0755 "$SRC/deploy/bin/knife-update" "$LIBEXEC/knife-update"
cat >"$ETC/update.conf.new" <<EOF
# Written by deploy/install.sh; read by knife-update (KEY=VALUE, never sourced).
APP_ROOT=$APP_ROOT
REPO_URL=$REPO_URL
SERVICE=$SERVICE
LIVE_URL=$live_url
NODE_BIN=$NODE_BIN
PYTHON_BIN=$PYTHON_BIN
CACHE_DIR=$CACHE
KEEP=3
EOF
install -o root -g knife-deploy -m 0640 "$ETC/update.conf.new" "$ETC/update.conf"; rm -f "$ETC/update.conf.new"
sub() { sed -e "s|@NODE@|$NODE_BIN|g" -e "s|@NPM@|$(dirname "$NODE_BIN")/npm|g" -e "s|@APP_ROOT@|$APP_ROOT|g" -e "s|@UPDATER@|$LIBEXEC/knife-update|g" \
  -e "s|@HELPER@|$LIBEXEC/knife-sidecar-helper|g" -e "s|@SERVICE@|$SERVICE|g" "$1"; }
put() { sub "$1" >"$2.new" && chmod 0644 "$2.new" && chown root:root "$2.new" && mv -f "$2.new" "$2"; }
put "$SRC/deploy/systemd/samurai-knife.service" "$UNITS/samurai-knife.service"
put "$SRC/deploy/systemd/knife-update.service" "$UNITS/knife-update.service"
put "$SRC/deploy/systemd/knife-update.timer" "$UNITS/knife-update.timer"
put "$SRC/deploy/systemd/knife-email-lists.service" "$UNITS/knife-email-lists.service"
put "$SRC/deploy/systemd/knife-email-lists.timer" "$UNITS/knife-email-lists.timer"
put "$SRC/deploy/bin/knife-admin" /usr/local/sbin/knife-admin && chmod 0755 /usr/local/sbin/knife-admin
put "$SRC/deploy/polkit/50-samurai-knife-deploy.rules" /etc/polkit-1/rules.d/50-samurai-knife-deploy.rules
if [[ "$SIDECARS" == yes ]]; then
  install -o root -g root -m 0755 "$SRC/deploy/sidecar-helper/knife-sidecar-helper" "$LIBEXEC/knife-sidecar-helper"
  ln -sfn "$LIBEXEC/knife-sidecar-helper" /usr/local/sbin/knife-sidecar
  put "$SRC/deploy/systemd/knife-sidecar.socket" "$UNITS/knife-sidecar.socket"
  put "$SRC/deploy/systemd/knife-sidecar@.service" "$UNITS/knife-sidecar@.service"
fi
systemctl daemon-reload
[[ "$SIDECARS" == yes ]] && systemctl enable --now knife-sidecar.socket >/dev/null
if [[ "$SIDECARS" == yes && -d "$DATA/services" ]]; then
  for d in "$DATA"/services/*/; do
    id="$(basename "$d")"; [[ -f "$d/compose.yaml" ]] || continue
    say "sidecar bundle: $id"
    knife-sidecar sync "$id" || warn "knife-sidecar sync $id failed; run it again after fixing the message above"
  done
fi

# ------------------------------------------------------------------------------------------------ first release
if [[ ! -e "$APP_ROOT/current" ]]; then
  say "building the first release as knife-deploy (npm ci, build, Python venv, preflight: several minutes)"
  runuser -u knife-deploy -- env -i PATH=/usr/bin:/bin HOME=/var/lib/knife-deploy STATE_DIRECTORY=/var/lib/knife-deploy \
    TMPDIR=/var/lib/knife-deploy "$LIBEXEC/knife-update" --install ${REF:+"$REF"} || die "first build failed (logs in $APP_ROOT/releases/<tag>/.deploy-*.log)"
fi
systemctl enable --now knife-update.timer knife-email-lists.timer >/dev/null
# Enabled for boot only with --start: a reboot between the build and a data migration must never start a second server
# (with an empty data dir) next to the old one.

# ------------------------------------------------------------------------------------------------ start
if [[ -n "$START" ]]; then
  grep -q KNIFE_UNCONFIGURED "$ETC/live.env" && die "$ETC/live.env is still the template: edit it, then: systemctl start $SERVICE"
  port_busy && ! systemctl is-active --quiet "$SERVICE" && die "something else listens on $env_host:$env_port: stop it first"
  say "starting $SERVICE"
  systemctl enable "$SERVICE" >/dev/null
  systemctl reset-failed "$SERVICE" 2>/dev/null || true
  systemctl restart "$SERVICE"
  up=""
  for _ in $(seq 90); do curl -s -o /dev/null --max-time 2 "$live_url/" && { up=1; break; }; sleep 0.5; done
  [[ -n "$up" ]] || die "no answer at $live_url: journalctl -u $SERVICE -n 50"
  echo "  $live_url answers"
fi

say "done"
cat <<EOF
  release:   $(readlink -f "$APP_ROOT/current")
  status:    systemctl status $SERVICE ; journalctl -u $SERVICE -f
  updates:   systemctl list-timers knife-update.timer ; sudo -u knife-deploy $LIBEXEC/knife-update --check
  settings:  sudoedit $ETC/live.env, then systemctl restart $SERVICE
  accounts:  sudo knife-admin accounts list   (also: storage, email-lists; runs as knife with the service's settings)
  backup:    $DATA, $ETC/storage.key and $SECRETS (storage.key apart from the data)
EOF
[[ -z "$START" ]] && echo "  start:     rerun with --start (enables the service at boot and starts it)"
exit 0
