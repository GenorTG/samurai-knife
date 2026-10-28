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
#   logs       <app-root>/logs/{app,sidecars} (the app's) and logs/update (knife-update's), read by the admin log viewer
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
UNIT_KEYS="KNIFE_DATA_DIR KNIFE_STORAGE_KEY_FILE KNIFE_GITHUB_APP_FILE KNIFE_LEGAL_DIR KNIFE_LOG_DIR KNIFE_SIDECAR_BACKEND KNIFE_SIDECAR_HELPER_SOCKET KNIFE_PYTHON KNIFE_PY_HOME NODE_ENV PATH"

usage() { sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; cat <<'EOF'

Options:
  --check                only check prerequisites
  --env FILE             app settings (KNIFE_*) to install as /etc/samurai-knife/live.env
  --storage-key FILE     keep an existing storage key (64 hex chars); else one is generated
  --github-app FILE      existing GitHub App credentials (docs/GITHUB.md)
  --migrate-data DIR     copy an existing data directory into /var/lib/samurai-knife (old server stopped)
  --repo URL             git remote to deploy from (default: this checkout's origin, else the installed one, else package.json)
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

LOGS="$APP_ROOT/logs"   # log files (docs/DEPLOY.md "Log files")

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
[[ "$(id -u)" == 0 ]] || die "run as root (sudo $0 ...)"
umask 022

# ------------------------------------------------------------------------------------------------ prerequisites
problems=()
need=()   # logical tool names; pkg_name maps them to this distro's package
[[ -d /run/systemd/system ]] || problems+=("systemd is not the init system (the install is systemd units)")
case "$APP_ROOT" in /home/*|/root/*) problems+=("--app-root $APP_ROOT is under /home: the unit hides /home (ProtectHome)") ;; esac

PM=""
for candidate in apt-get dnf pacman zypper; do command -v "$candidate" >/dev/null 2>&1 && { PM="$candidate"; break; }; done
# Package names checked against each distro's repositories (Debian 12, Fedora, Arch, openSUSE Tumbleweed; 2026-10).
pkg_name() {
  case "$PM:$1" in
    *:git|*:curl|*:rsync|*:util-linux|*:bubblewrap|*:qpdf|*:ghostscript) echo "$1" ;;
    apt-get:tesseract|zypper:tesseract) echo tesseract-ocr ;;
    *:tesseract) echo tesseract ;;
    apt-get:tess-*) echo "tesseract-ocr-${1#tess-}" ;;
    dnf:tess-osd) echo tesseract-osd ;;
    dnf:tess-*) echo "tesseract-langpack-${1#tess-}" ;;
    pacman:tess-*) echo "tesseract-data-${1#tess-}" ;;
    zypper:tess-*) echo "tesseract-ocr-traineddata-${1#tess-}" ;;
    apt-get:polkit) echo polkitd ;;
    *:polkit) echo polkit ;;
    apt-get:venv) echo python3-venv ;;
    # WeasyPrint (the CV PDF export) loads Pango through cffi: the libraries its docs list per distribution (70.0).
    apt-get:pango) printf '%s\n' libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0 ;;
    zypper:pango) echo libpango-1_0-0 ;;
    *) echo "$1" ;;
  esac
}
pkg_install() {
  case "$PM" in
    apt-get) DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@" ;;
    dnf) dnf install -y "$@" ;;
    pacman) pacman -S --needed --noconfirm "$@" || die "pacman could not install $* (if it reported 404s, run pacman -Syu first)" ;;
    zypper) zypper --non-interactive install "$@" ;;
  esac
}
node_hint() {
  case "$PM" in
    apt-get) echo "e.g. NodeSource (https://github.com/nodesource/distributions)" ;;
    dnf) echo "dnf install nodejs (or a versioned nodejs22/nodejs24 package)" ;;
    pacman) echo "pacman -S nodejs npm" ;;
    zypper) echo "zypper install nodejs npm" ;;
    *) echo "from your distribution or nodejs.org, installed under /usr" ;;
  esac
}

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then problems+=("node $MIN_NODE+ not found: install Node.js system-wide, $(node_hint)")
else
  NODE_BIN="$(realpath "$NODE_BIN")"
  case "$NODE_BIN" in /home/*) problems+=("node resolves to $NODE_BIN (under /home: invisible to the service); install it system-wide, $(node_hint)") ;; esac
  major="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  (( major >= MIN_NODE )) || problems+=("node $("$NODE_BIN" --version) is older than v$MIN_NODE")
  [[ -x "$(dirname "$NODE_BIN")/npm" ]] || problems+=("npm not found next to $NODE_BIN (pacman/zypper: install npm)")
fi
PYTHON_BIN="$(command -v python3 || true)"
[[ -n "$PYTHON_BIN" ]] && PYTHON_BIN="$(realpath "$PYTHON_BIN")"
if [[ -z "$PYTHON_BIN" ]] || ! "$PYTHON_BIN" -c "import sys; sys.exit(sys.version_info < (${MIN_PY/./,}))" 2>/dev/null; then
  problems+=("python3 $MIN_PY+ not found")
else
  case "$PYTHON_BIN" in /home/*) problems+=("python3 resolves to $PYTHON_BIN (under /home: invisible to the service)") ;; esac
  if ! "$PYTHON_BIN" -c 'import ensurepip, venv' 2>/dev/null; then
    [[ "$PM" == apt-get ]] && need+=(venv) || problems+=("python3 has no venv/ensurepip module")
  fi
fi
for pair in git:git curl:curl rsync:rsync flock:util-linux runuser:util-linux bwrap:bubblewrap tesseract:tesseract qpdf:qpdf gs:ghostscript pkcheck:polkit; do
  command -v "${pair%%:*}" >/dev/null 2>&1 || need+=("${pair#*:}")
done
# Pango for the CV PDF export (a shared library, not a command).
if ! /sbin/ldconfig -p 2>/dev/null | grep -q 'libpangoft2-1\.0\.so\.0'; then need+=(pango); fi
if command -v tesseract >/dev/null 2>&1; then
  langs="$(tesseract --list-langs 2>/dev/null || true)"
  for l in eng pol osd; do grep -qx "$l" <<<"$langs" || need+=("tess-$l"); done
else
  need+=(tess-eng tess-pol tess-osd)
fi
if [[ "$SIDECARS" == auto ]]; then command -v docker >/dev/null 2>&1 && SIDECARS=yes || SIDECARS=no; fi
# The remote: --repo, else this checkout's origin, else the installed one (a re-run from <app-root>/current: releases are
# `git archive` exports without .git; keeps a fork or mirror chosen earlier), else package.json `repository.url`.
if [[ -z "$REPO_URL" ]]; then REPO_URL="$(git -C "$SRC" remote get-url origin 2>/dev/null || true)"; fi
if [[ -z "$REPO_URL" && -r "$ETC/update.conf" ]]; then REPO_URL="$(sed -n 's/^REPO_URL=//p' "$ETC/update.conf" | tail -1)"; fi
if [[ -z "$REPO_URL" ]]; then REPO_URL="$(sed -n '/"repository"/,/}/s/^ *"url": *"\([^"]*\)".*/\1/p' "$SRC/package.json" 2>/dev/null | head -1 || true)"; fi
[[ -n "$REPO_URL" ]] || problems+=("no --repo given and neither $SRC, an earlier install nor package.json names a repository")
case "$REPO_URL" in git@*|ssh://*) problems+=("--repo $REPO_URL needs SSH keys knife-deploy does not have: use the https URL") ;; esac
for f in "$ENV_IN" "$KEY_IN" "$GH_IN"; do [[ -z "$f" || -r "$f" ]] || problems+=("cannot read $f"); done
[[ -z "$DATA_IN" || -d "$DATA_IN" ]] || problems+=("--migrate-data $DATA_IN is not a directory")

pkgs=()
if ((${#need[@]})); then mapfile -t pkgs < <(for n in "${need[@]}"; do pkg_name "$n"; done | sort -u); fi
say "prerequisites"
echo "  system   $(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-unknown}"), packages via ${PM:-none}"
echo "  node     ${NODE_BIN:-missing}"
echo "  python   ${PYTHON_BIN:-missing}"
echo "  repo     ${REPO_URL:-missing}"
echo "  sidecars $SIDECARS"
((${#pkgs[@]})) && echo "  missing packages: ${pkgs[*]}"
if ((${#pkgs[@]})) && [[ -z "$PM" ]]; then problems+=("no supported package manager (apt-get, dnf, pacman, zypper): install ${need[*]} yourself"); fi
if ((${#problems[@]})); then printf '  \033[31mproblem:\033[0m %s\n' "${problems[@]}"; die "fix the problems above first"; fi
if [[ -n "$CHECK_ONLY" && ${#pkgs[@]} -gt 0 ]]; then echo "  (missing packages are installed by a real run)"; fi

if ((${#pkgs[@]})) && [[ -z "$CHECK_ONLY" ]]; then
  if [[ -z "$ASSUME_YES" ]]; then read -r -p "Install ${pkgs[*]} with $PM? [y/N] " a; [[ "$a" == [yY]* ]] || die "cancelled"; fi
  pkg_install "${pkgs[@]}"
fi

# The parser sandbox, for real: bubblewrap as an unprivileged user with the options the app uses. This catches user
# namespaces switched off by sysctl (kernel.unprivileged_userns_clone, user.max_user_namespaces) and by AppArmor
# (Ubuntu 24.04+: kernel.apparmor_restrict_unprivileged_userns) alike.
if command -v bwrap >/dev/null 2>&1; then
  if ! out="$(runuser -u nobody -- bwrap --unshare-user --unshare-pid --unshare-net --unshare-ipc --disable-userns \
      --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 --proc /proc --dev /dev \
      /usr/bin/true 2>&1)"; then
    hint="enable unprivileged user namespaces"
    [[ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null)" == 1 ]] && hint="AppArmor restricts unprivileged user namespaces: allow them for /usr/bin/bwrap (an AppArmor profile with 'userns,') or set kernel.apparmor_restrict_unprivileged_userns=0"
    die "the parser sandbox does not work here (bwrap: ${out:-failed}): $hint"
  fi
  echo "  sandbox  bubblewrap works for an unprivileged user"
fi
if [[ -n "$CHECK_ONLY" ]]; then echo "  ok"; exit 0; fi
NOLOGIN="$(command -v nologin || echo /usr/sbin/nologin)"

# ------------------------------------------------------------------------------------------------ users and dirs
say "users"
getent group knife >/dev/null || groupadd --system knife
getent passwd knife >/dev/null || useradd --system --gid knife --home-dir "$DATA" --no-create-home --shell "$NOLOGIN" knife
getent group knife-deploy >/dev/null || groupadd --system knife-deploy
getent passwd knife-deploy >/dev/null || useradd --system --gid knife-deploy --home-dir /var/lib/knife-deploy --no-create-home --shell "$NOLOGIN" knife-deploy
for g in docker sudo adm; do
  id -nG knife 2>/dev/null | tr ' ' '\n' | grep -qx "$g" && die "user knife is in group $g: remove it (it must not reach docker or root)"
done

say "directories"
install -d -o knife-deploy -g knife-deploy -m 0755 "$APP_ROOT" "$APP_ROOT/releases"
# Log files (docs/DEPLOY.md "Log files"): the root is not listable; app/ and sidecars/ belong to the app (the unit's only
# ReadWritePaths under the app root); update/ belongs to knife-update, setgid knife so the app's viewer can read its files
# (0640) and never change them.
install -d -o root -g root -m 0751 "$LOGS"
install -d -o knife -g knife -m 0750 "$LOGS/app" "$LOGS/sidecars"
install -d -o knife-deploy -g knife -m 2750 "$LOGS/update"
install -d -o root -g root -m 0751 "$ETC"
# Legal pages (legal/README.md): the operator's legal.json and page overrides, readable by the app only.
install -d -o root -g knife -m 0750 "$ETC/legal"
for f in "$ETC"/legal/*; do [[ -f "$f" ]] && { chown root:knife "$f"; chmod 0640 "$f"; }; done
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
# knife-update cannot read legal.json (root:knife), so its log retention is copied here: rerun the installer after
# changing logRetentionDays (the app's own logs follow legal.json by themselves).
log_days="$("$PYTHON_BIN" -I -c 'import json, sys
try:
    v = int(str(json.load(open(sys.argv[1])).get("logRetentionDays", 30)).strip())
except Exception:
    v = 30
print(v if 1 <= v <= 3650 else 30)' "$ETC/legal/legal.json" 2>/dev/null || echo 30)"
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
LOG_DIR=$LOGS/update
LOG_RETENTION_DAYS=$log_days
SIDECAR_BUNDLES=$ETC/sidecars
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
  # Root's copy of the Craft apps' content: the helper unit may write only here under /etc (its ReadWritePaths).
  install -d -o root -g root -m 0755 "$ETC/sidecars" "$ETC/sidecars/craft-content"
fi
systemctl daemon-reload
# The sandbox again, now under the service's own hardening: a copy of the installed unit with the probe as ExecStart.
# Hardening that hides /proc or filters syscalls breaks bwrap on some systemd/bubblewrap versions while a plain probe
# passes (tests/deploy_install.test.mjs lists the known ones).
probe_cmd="/usr/bin/bwrap --unshare-user --unshare-pid --unshare-net --unshare-ipc --disable-userns --ro-bind /usr /usr \
--symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 --proc /proc --dev /dev /usr/bin/true"
probe_unit=/run/systemd/system/samurai-knife-sandbox-probe.service
mkdir -p /run/systemd/system
sed -e "/^ExecStart=/c\\ExecStart=$probe_cmd" -e '/^Restart/d' -e '/^StartLimit/d' -e 's/^Type=simple/Type=oneshot/' \
  -e '/^EnvironmentFile=/d' -e '/^WorkingDirectory=/d' -e '/^ReadOnlyPaths=/d' -e '/^\[Install\]/,$d' "$UNITS/$SERVICE" >"$probe_unit"
systemctl daemon-reload
if systemctl start samurai-knife-sandbox-probe.service 2>/dev/null; then probe_ok=1; else probe_ok=""; fi
probe_log="$(journalctl -u samurai-knife-sandbox-probe.service -n 5 --no-pager -o cat 2>/dev/null | grep -m1 bwrap || true)"
rm -f "$probe_unit"; systemctl daemon-reload; systemctl reset-failed samurai-knife-sandbox-probe.service 2>/dev/null || true
[[ -n "$probe_ok" ]] || die "the parser sandbox fails under $SERVICE's hardening (${probe_log:-see journalctl -u samurai-knife-sandbox-probe}): report it with your systemd ($(systemctl --version | head -1)) and bubblewrap ($(bwrap --version 2>/dev/null)) versions"
echo "  sandbox  works under the service's hardening"
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
  ( cd / && runuser -u knife-deploy -- env -i PATH=/usr/bin:/bin HOME=/var/lib/knife-deploy STATE_DIRECTORY=/var/lib/knife-deploy \
    TMPDIR=/var/lib/knife-deploy "$LIBEXEC/knife-update" --install ${REF:+"$REF"} ) || die "first build failed (logs in $APP_ROOT/releases/<tag>/.deploy-*.log)"
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
  logs:      $LOGS/{app,update,sidecars/<id>} (UTC day files, kept $log_days days) or the admin page /account/admin/logs
  updates:   systemctl list-timers knife-update.timer ; sudo -u knife-deploy $LIBEXEC/knife-update --check
  settings:  sudoedit $ETC/live.env, then systemctl restart $SERVICE
  accounts:  sudo knife-admin accounts list   (also: storage, email-lists; runs as knife with the service's settings)
  backup:    $DATA, $ETC/storage.key and $SECRETS (storage.key apart from the data)
EOF
[[ -z "$START" ]] && echo "  start:     rerun with --start (enables the service at boot and starts it)"
exit 0
