# Deploying the public instance

How to run Smart Knife for other people: a production build in `KNIFE_AUTH_MODE=public`, bound to an address only the
reverse proxy reaches, behind HTTPS. The private owner-only toolbox (private mode on a loopback/Tailscale bind) runs the same way
without the proxy: a production build in its own checkout, started with `serve.mjs start` (sections 1 and 3), never
from the checkout you develop in. Names below (`knife.example.org`, `office.example.org`) are placeholders.

## 1. A separate checkout

Build and run the public instance from its own checkout (or `git worktree`) and its own data directory, never from the
checkout a dev server runs in: `next build` writes `.next/`, which a running `next dev` in the same directory also uses.

```bash
git clone <repo> ~/srv/samurai-knife && cd ~/srv/samurai-knife
npm ci && npm install-scripts approve unrs-resolver
python3.12 -m venv ../samurai-knife-py/venv && ../samurai-knife-py/venv/bin/pip install -r server/py/requirements.txt
npm run build                       # also copies the OCR/SQL browser assets into public/
```

Update: `git pull && npm ci && npm run build`, then restart the process. `npm run start` refuses to run without a build.

## 2. Environment (`.env.local` in that checkout, mode 600)

```bash
KNIFE_AUTH_MODE=public
KNIFE_HOST=127.0.0.1                # or an address only the proxy reaches; never 0.0.0.0 (serve.mjs refuses it)
KNIFE_PORT=3220                     # any free port
KNIFE_DATA_DIR=/home/<user>/.local/share/samurai-knife-public
KNIFE_PUBLIC_URL=https://knife.example.org
KNIFE_TRUSTED_PROXIES=127.0.0.1,::1 # the proxy's address as the app sees it (a docker proxy: its bridge gateway or CIDR)
KNIFE_MAIL_TRANSPORT=smtp
KNIFE_SMTP_HOST=...                 # see docs/ACCOUNTS.md "Mail"
KNIFE_SMTP_FROM="Smart Knife <no-reply@knife.example.org>"
KNIFE_EMAIL_POLICY=enforce          # default in public mode; see docs/ACCOUNTS.md "Mail"
KNIFE_EMAIL_OWN_DOMAINS=knife.example.org,office.example.org
KNIFE_SSRF_DENY_CIDRS=<this server's public IPv4>/32,<the LAN's delegated IPv6 prefix>/56
KNIFE_STORAGE_KEY_FILE=/home/<user>/.config/samurai-knife/storage.key   # outside the data dir (docs/ACCOUNTS.md "At rest")
KNIFE_GITHUB_APP_FILE=/home/<user>/.config/samurai-knife/github-app.json # GitHub App credentials (docs/GITHUB.md)
KNIFE_PSI_API_KEY=...                                                     # PageSpeed Insights (website studio)
```

`KNIFE_SSRF_DENY_CIDRS` matters: a user's provider URL or job link pointing at your own public IP would otherwise reach
the router (hairpin NAT) and every port forward, and an IPv6 address inside your LAN prefix is "public" to the address
rules. The machine's own interface addresses are denied automatically. Everything else is in `.env.example`.

Then the owner account (docs/ACCOUNTS.md "Modes"):

```bash
KNIFE_DATA_DIR=... KNIFE_AUTH_MODE=public npm run accounts -- add owner --name "Owner" --password-prompt --email you@example.org --role admin
KNIFE_DATA_DIR=... npm run accounts -- set-network owner private   # only if the owner's provider is a local model server
```

What public mode turns on besides accounts: SSRF-safe outbound requests with per-account budgets (docs/ACCOUNTS.md
"Outbound requests"), the security headers (CSP with `frame-ancestors 'self'`, HSTS when `KNIFE_PUBLIC_URL` is https,
nosniff, Referrer-Policy, Permissions-Policy: `scripts/security-headers.mjs`), the stricter extra-header rules. Always
on: streamed body limits, sealed provider keys, sealed per-account files, Python-lane rlimits and minimal child env.

### Mail policy and mail-server controls

Public mode enforces the address policy by default and uses the bounded SMTP queue. Keep `KNIFE_MAIL_TRANSPORT=smtp`;
set the SMTP host, port/TLS server name, credentials and From address as described in [ACCOUNTS.md](ACCOUNTS.md#mail-src-libmail).
The app caps queue depth/concurrency and applies per-minute/hour/day, domain/provider and canonical-mailbox budgets;
recipient 5xx responses are suppressed for 30 days. Public-safe defaults are used when optional limits are omitted.
Never expose a queue inspection endpoint publicly.

Update the disposable-domain snapshot weekly with `npm run email-lists -- update` (for example, a systemd timer or cron
job running as the app user). The command validates the download and preserves the prior list on failure. Owner overrides
are `$KNIFE_DATA_DIR/email-policy/allow.txt` and `deny.txt`; keep changes reviewed and protected as operational data.

On the mail server, verify SPF, DKIM and DMARC alignment for the app's visible From and envelope sender. For a Stalwart
relay, use a dedicated authenticated submission credential, configure an outbound throttle per authenticated sender
(for example, 100 messages/hour) and a finite queue quota, independent of app-side limits. Require TLS and keep submission
private to the app's network. Treat the relay as the final containment layer: it must cap a compromised app credential
or another misbehaving SMTP client.

## 3. Process manager (PM2 example)

`ecosystem.config.cjs` next to the checkout (not in the repo; adjust the paths):

```js
module.exports = {
  apps: [{
    name: "samurai-knife-public",
    cwd: "/home/<user>/srv/samurai-knife",
    script: "scripts/serve.mjs",
    args: "start",
    interpreter: "node",
    env: { NODE_ENV: "production" },   // the rest comes from .env.local
    max_memory_restart: "2G",
    kill_timeout: 10000,
  }],
};
```

```bash
pm2 start ecosystem.config.cjs && pm2 save
pm2 logs samurai-knife-public
```

Always start through `scripts/serve.mjs` (`npm run start` or the config above): it resolves the bind address, refuses
`0.0.0.0` and unknown auth modes, runs the startup checks below, and preloads the socket-peer stamp (trusted
`X-Forwarded-*`), the security headers and the abuse guard with the Node server timeouts (docs/ACCOUNTS.md "Abuse
guard"). A bare `next start` has none of them.

### Startup checks (`scripts/deploy-config.mjs`)

A deploy that loses or mistypes one variable must not quietly become insecure, so `serve.mjs` exits with code 2 and a
one-line reason (`[serve] refusing to start: ...`) when:

- public mode has no `KNIFE_PUBLIC_URL`, or it is not https (plain http only on a loopback/Tailscale/LAN address literal,
  for test servers);
- public mode has no `KNIFE_TRUSTED_PROXIES`, an entry that is not an IP or CIDR, or one wider than IPv4 /16 or IPv6 /48
  (a network-wide entry narrower than that starts, with a warning: list the proxy's own address);
- public mode has `KNIFE_ABUSE_GUARD=off`;
- `KNIFE_AUTH_MODE` is empty but `KNIFE_PUBLIC_URL` is set. A public deploy that lost its mode would otherwise start
  private and make the passwordless default account everyone's identity. Private installs set `KNIFE_PUBLIC_URL` too,
  for the GitHub App (docs/GITHUB.md: GitHub only ever sees the public URL), so the rule is: say which one you are.
  `KNIFE_AUTH_MODE=public` for a public deploy; `KNIFE_AUTH_MODE=private` for a private install that only uses the URL
  for GitHub. The explicit private case starts with a warning: the Host guard accepts the public URL's name, so no proxy
  may route that name to a private install while its default account has no password. (A server started without
  `serve.mjs` treats the empty-mode case as public: `src/lib/accounts/mode.ts`.)
- private mode binds or allows a public host: every entry of `KNIFE_HOST`, `KNIFE_ALLOWED_HOSTS` and
  `KNIFE_MCP_ALLOWED_HOSTS` must be loopback, Tailscale, a private LAN address, or a private-network name (single-label
  names, `*.ts.net`, `*.local`, `*.lan`, `*.home.arpa`, `*.internal`).

Upgrading an existing install: if its environment sets `KNIFE_PUBLIC_URL` without `KNIFE_AUTH_MODE`, add the mode
explicitly before restarting, or the new build refuses to start (an updater that preflights the new release keeps the
old one running).

## Dedicated service account and systemd

For an internet-facing installation, run the app as a dedicated `knife` system user under systemd, not as the operator
or a Docker-group user. `deploy/install.sh` sets that up; the reviewed templates are in `deploy/systemd/`.

### Install script

```bash
sudo deploy/install.sh --check                      # prerequisites only, changes nothing
sudo deploy/install.sh --env my.env --start         # fresh install (my.env: section 2's settings)
sudo knife-admin accounts add owner --name "Owner" --password-prompt --email you@example.org --role admin
```

Requirements: a systemd distribution, Node.js 22+ and Python 3.11+ installed system-wide (not under `/home`: the unit
hides it), and unprivileged user namespaces for the parser sandbox. Missing tools (git, rsync, bubblewrap, Tesseract
with eng/pol/osd, qpdf, ghostscript, polkit, python3-venv on Debian) are installed after a prompt (`--yes` skips it) with
apt-get, dnf, pacman or zypper, using each distribution's package names; elsewhere the script lists what to install.
Verified end to end (install, sandbox, login, SQL, OCR, polkit restart, updates) in systemd containers on Debian 12
(systemd 252, bubblewrap 0.8, Python 3.11), Arch (systemd 262, bubblewrap 0.13, Python 3.14) and Fedora 44 (Node 24,
Python 3.14); openSUSE package names are checked but the install is not; SELinux enforcing was not tested (containers
cannot enable it). Before anything starts, the script runs bubblewrap twice: as an unprivileged user (catches user
namespaces switched off by sysctl or by AppArmor, Ubuntu 24.04+) and inside a copy of the installed unit (catches
hardening this systemd/bubblewrap pair does not tolerate). The script is idempotent: run it again from a newer checkout
to update the units, the updater and the settings (`--start` restarts the app so a changed unit takes effect).

What it creates:

| Thing | Where | Owner / mode |
|---|---|---|
| app user `knife` | runs the app: no login, no sudo, never in the docker group | |
| deploy user `knife-deploy` | builds releases; no app data, no secrets, no docker | |
| releases | `/opt/samurai-knife/releases/<tag>` + `current` symlink (`--app-root`) | knife-deploy, read-only to the app |
| settings | `/etc/samurai-knife/live.env` | root:knife 0640 |
| storage key | `/etc/samurai-knife/storage.key` (kept byte for byte with `--storage-key`, else generated) | root:knife 0640 |
| data | `/var/lib/samurai-knife` | knife 0700 |
| log files | `/opt/samurai-knife/logs/`: `app/` + `sidecars/` (the app writes), `update/` (knife-update writes, setgid knife) | root 0751; knife 0750; knife-deploy:knife 2750 |
| GitHub App credentials | `/var/lib/samurai-knife-secrets/github-app.json` (`--github-app`) | knife 0600 |
| units | `samurai-knife.service`, `knife-update.service` + `.timer` (15 min), `knife-email-lists.timer` (weekly) | root 0644 |
| restart permission | `/etc/polkit-1/rules.d/50-samurai-knife-deploy.rules`: knife-deploy may only *restart* the app | root 0644 |
| tools | `/usr/local/sbin/knife-admin` (accounts, storage, email-lists as knife with the service's settings); with Docker `knife-sidecar` | root 0755 |

`live.env` is filtered on the way in: keys the unit sets itself (`KNIFE_DATA_DIR`, `KNIFE_STORAGE_KEY_FILE`,
`KNIFE_GITHUB_APP_FILE`, `KNIFE_PYTHON`, the sidecar backend, `PATH`, `NODE_ENV`) are left out, because an
`EnvironmentFile=` value overrides `Environment=`; `KNIFE_PY_SANDBOX_RO` entries under `/home` are dropped (they can never
work under `ProtectHome` and make public mode refuse to start); any other value under `/home` is reported.

Releases: `knife-update` (installed root-owned in `/usr/local/libexec/samurai-knife/`, so a release can never change the
code that deploys it) keeps a mirror of the repo in `<app-root>/repo.git`, builds each new `v*` tag with `git archive`,
`npm ci`, `npm run build` and its own Python venv (`<release>/.py/venv`, so a rollback also rolls Python back), runs it
once in public mode on a spare loopback port with an empty data dir, links `.next/cache` to the service's cache dir,
moves `current`, restarts the service and checks it; on failure it moves `current` back. Forward only, one run at a
time, the newest three releases kept. `sudo -u knife-deploy /usr/local/libexec/samurai-knife/knife-update --check` shows
what it would do; `--deploy <tag>` deploys one by hand. The first install builds the newest tag (`--ref` for another).

Units that start the parser sandbox (the app, and the updater's preflight) leave out `ProtectKernelTunables`,
`ProtectKernelLogs`, `ProtectHostname` and `RestrictSUIDSGID`: the first three cover parts of `/proc` with mounts, after
which the kernel refuses bubblewrap a fresh `/proc` (systemd 262 covers more than 252), and the last answers `openat2`
with ENOSYS, which bubblewrap 0.11+ uses without a fallback. Any of them makes every sandbox start fail, so public mode
refuses to start. For a user with an empty capability set they add nothing (tunables and the hostname need
CAP_SYS_ADMIN, `/proc/kmsg` needs CAP_SYSLOG). `tests/deploy_install.test.mjs` pins this and the other invariants.

Sidecars: with Docker installed the root helper is installed too (`deploy/sidecar-helper/knife-sidecar-helper`,
`knife-sidecar.socket`, `knife-sidecar@.service`) and the unit uses `KNIFE_SIDECAR_BACKEND=helper`: the app reaches docker
only through a strict verb/id allow-list on root-owned compose bundles. The installer runs `knife-sidecar sync <id>` for
every staged bundle in the data dir; when a release changes a definition, secret, image or plugin asset, the app reports
the hash mismatch and `sudo knife-sidecar sync <id>` must be run again. `--no-sidecars` skips the helper.

### Moving an existing install

Back up the data dir, the storage key and the GitHub App file first. Then:

```bash
sudo deploy/install.sh --env <old live.env> --storage-key <old storage.key> --github-app <old github-app.json>
#   builds the first release; the old server keeps running
<stop the old server>                                 # e.g. pm2 stop samurai-knife
sudo deploy/install.sh --migrate-data <old data dir> --start
```

The second run refuses while anything listens on the app's address (never two servers on one data set), copies the data
(`rsync --delete`, without a `storage.key` in it), syncs the sidecar bundles and starts the service. Check the site, then
remove the old process manager entry and its updater. Rollback: `sudo systemctl disable --now samurai-knife.service
knife-update.timer` and start the old server again; it still has its own data dir, so only changes made after the move
are lost. Keep the old storage key until the new service has been verified, then remove the duplicate securely.

### Host firewall (optional)

`deploy/sbin/knife-firewall` (nftables input table `inet knife_host`) and `knife-docker-user` (`DOCKER-USER` chains) are
the reviewed firewall pieces for a dedicated host; a host that already runs firewalld can express the same policy with
zones and policies instead. They are not installed by `install.sh`. The examples contain placeholders and must not be
enabled as-is:

```bash
install -o root -g root -m 0755 deploy/sbin/knife-firewall /usr/local/sbin/knife-firewall
install -o root -g root -m 0755 deploy/sbin/knife-docker-user /usr/local/sbin/knife-docker-user
install -o root -g root -m 0600 deploy/firewall/firewall.conf.example /etc/samurai-knife/firewall.conf
install -o root -g root -m 0600 deploy/firewall/docker-user.conf.example /etc/samurai-knife/docker-user.conf
install -o root -g root -m 0644 deploy/systemd/knife-firewall.service /etc/systemd/system/knife-firewall.service
install -o root -g root -m 0644 deploy/systemd/knife-docker-user.service /etc/systemd/system/knife-docker-user.service
```

Edit the two configs to replace placeholders, run `knife-firewall preflight` and `knife-firewall check`, then use the
timed `knife-firewall apply` / fresh-session `confirm` flow described below. Only after successful confirmation run
`systemctl daemon-reload && systemctl enable --now knife-firewall.service knife-docker-user.service`.
Never enable or pull in Debian's stock `nftables.service` next to them: it loads `/etc/nftables.conf`, whose `flush
ruleset` wipes Docker's and Tailscale's rules (running containers keep working through docker-proxy, new ones fail to
start). `systemctl mask nftables.service` if nothing else needs it; the units only order themselves after it.

### Python parser sandbox

`KNIFE_PY_SANDBOX=auto` (default) requires a successful real bubblewrap probe in public mode and refuses startup if it
fails. Private mode remains unsandboxed by default for compatibility. `bwrap` requires sandboxing in either mode; `off`
explicitly disables it and warns in public mode. `KNIFE_PY_SANDBOX_RO` adds colon-separated read-only roots for tools
installed outside `/usr`. Prefer installing Tesseract/qpdf/ghostscript in `/usr` on the production host; `ProtectHome=yes`
in the systemd unit intentionally makes a Homebrew tree under `/home` unavailable. If using a separate tool tree, place it
outside `/home`, include it in `KNIFE_PY_SANDBOX_RO`, and ensure the service can read it. The sandbox unshares networking and user/PID/IPC namespaces; mounts the interpreter/venv,
scripts and required system libraries read-only; exposes staged uploads read-only and only job-owned output/scratch
directories writable. It does not mount `KNIFE_DATA_DIR`, `KNIFE_STORAGE_KEY_FILE`, GitHub credentials, host `/proc`, or
other jobs' directories. Tesseract, qpdf, ghostscript and OCR assets must be beneath `/usr` or an explicit read-only root.
The systemd unit retains only the namespace and syscall permissions bwrap needs inside its unprivileged user namespace.
Do not tighten it to `RestrictNamespaces=yes` or remove mount/capability syscalls without re-running the sandbox probe.
`run_limited.py` rlimits and process-group cancellation remain active.

### Log files

Besides the journal, the app keeps its own log files under one root, `KNIFE_LOG_DIR` (the systemd unit sets
`<app-root>/logs`, e.g. `/opt/samurai-knife/logs`; a checkout defaults to `<repo>/logs`, gitignored; `off` turns files off):

| Folder | What | Written by |
|---|---|---|
| `app/app-<day>.log` | the Next server's stdout/stderr and `serve.mjs`'s own lines (startup checks, warnings, errors); still also on stdout/stderr, so `journalctl -u samurai-knife` keeps working | the app (`scripts/serve.mjs`) |
| `sidecars/<id>/ops-<day>.log` | sidecar install/start/stop/update/remove runs: phases, output lines, outcome (container output only as far as an op reports it) | the app (`src/lib/services/ops.ts`) |
| `update/update-<day>.log` | `knife-update` runs: builds, preflights, switches, rollbacks, and the last 40 lines of a failed step's own log | knife-update as knife-deploy |

Format: one line per entry, `<UTC ISO time> <out|err> <text>`, ANSI colours and control characters removed, anything that
looks like a credential replaced by `[redacted]` (Authorization/Cookie values, `password=`/`token=`/`…_key=` values,
capability query parameters such as the office `t=`, `sk-…`/`ghp_…` keys, JWTs, URL user:password). The app never logs
mail bodies or passwords in the first place; the redaction is the safety net.

Rotation: one file per UTC day; a file that passes `KNIFE_LOG_MAX_BYTES` (default 10 MB) becomes `.1` (the previous `.1` becomes `.2`, up to `.9`, the
oldest dropped); past days are gzipped (`.log.gz`). Retention: a day file is deleted once its day is
`logRetentionDays` old (the instance's `legal.json`, docs/LEGAL.md; default 30), so the privacy notice stays true. The
app checks at startup and hourly; knife-update on every run, with the number `install.sh` copied into
`/etc/samurai-knife/update.conf` (knife-deploy cannot read `legal.json`: rerun the installer after changing it).
Security events stay where they are (`/var/lib/samurai-knife/security/events-<day>.jsonl`, 30 days).

Permissions: the log root is `root:root 0751` (not listable); `app/` and `sidecars/` are the app's (`knife 0750`, files
0600 under the unit's `UMask=0077`; they are the unit's only `ReadWritePaths` inside the app root, the release tree
stays read-only); `update/` is `knife-deploy:knife 2750` (files 0640: the app reads them, never changes them).

Reading them:

- In the app: **Users -> Server logs** (`/account/admin/logs`, admins only): sources, files (size, time), the tail of a
  file (up to 5000 lines) with a level and text filter, live refresh, download. Read-only: `GET /api/admin/logs` has no
  delete or write; sources and file names are allow-listed, symlinks are never followed, gzipped files are readable.
- On the box:

  ```bash
  sudo ls -l /opt/samurai-knife/logs/app /opt/samurai-knife/logs/update /opt/samurai-knife/logs/sidecars/*
  sudo tail -f /opt/samurai-knife/logs/app/app-$(date -u +%F).log
  sudo zless /opt/samurai-knife/logs/app/app-2026-10-20.log.gz
  sudo grep -h ' err ' /opt/samurai-knife/logs/app/app-*.log
  ```

Not in these files: the sidecar containers' own output (the app has no docker access; the root helper only gives the
last 30 lines on a failed start, which then lands in the op log), the reverse proxy and the mail server (they keep their
own logs; LEGAL.md "Operator duties" item 4 covers their retention).

## 4. Reverse proxy with HTTPS (nginx-proxy-manager)

One Proxy Host per name:

- **knife.example.org** → `http://<KNIFE_HOST>:<KNIFE_PORT>` (from a containerised proxy: an address of this machine the
  container can reach, e.g. the docker bridge gateway, with the app bound there instead of 127.0.0.1).
  - SSL: request a Let's Encrypt certificate, Force SSL, HTTP/2. Leave HSTS to the app (it sends it) or enable it here,
    not both with different values.
  - Websockets: not needed by the app itself.
  - Advanced (custom nginx config):

    ```nginx
    client_max_body_size 120m;          # >= KNIFE_PDF_UPLOAD_MAX_MB (public default 100) and office uploads; the app streams uploads and enforces its own caps
    proxy_request_buffering off;        # stream uploads to the app instead of spooling them in the proxy
    proxy_read_timeout 300s;            # model rounds and PDF jobs
    client_header_timeout 15s;
    client_body_timeout 30s;
    send_timeout 60s;
    limit_conn knife_conn 40;           # per client (zone below); the app also caps connections (KNIFE_MAX_CONNECTIONS)
    # The office Document Server reaches the app on its internal app URL (docs/SIDECARS.md "Addresses"), never through
    # this public name: its two JWT-authenticated routes need not be public.
    location ^~ /api/office/ds/ { return 404; }
    ```

    Forwarded headers: NPM's generated `location /` includes `conf.d/include/proxy.conf`, which sets its own
    `proxy_set_header` lines (`X-Forwarded-For $proxy_add_x_forwarded_for`, `X-Forwarded-Proto $scheme`, `Host`), and
    nginx then ignores any `proxy_set_header` from the server level, so do not add them here. Appending is safe: the app
    takes the right-most `X-Forwarded-For` entry that is not a trusted proxy, so whatever a client prepends is ignored.
    A `location` you add yourself must `include conf.d/include/proxy.conf;` too.

  - `KNIFE_TRUSTED_PROXIES` must match the address the proxy connects FROM, as seen by the app (startup refuses public
    mode without it, docs/ACCOUNTS.md "Client address"). Check that the proxy sees real client addresses, IPv6 included
    (Docker: `userland-proxy: false` with IPv6 enabled, or host networking): otherwise every IPv6 client arrives as the
    bridge gateway and shares one bucket.
  - Coarse per-client limits in nginx (`/data/nginx/custom/http_top.conf`, http context; the app's abuse guard and rate
    limits stay authoritative, nginx only drops floods early):

    ```nginx
    # IPv6 clients grouped by /64 (first 4 hextets of an uncompressed head); everything else by full address
    map $remote_addr $knife_client {
      "~^(?<p>[0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f]{1,4}):" $p;   # quoted: nginx reads a bare { as a block
      default $binary_remote_addr;
    }
    limit_conn_zone $knife_client zone=knife_conn:10m;
    limit_req_zone  $knife_client zone=knife_auth:10m rate=6r/m;
    limit_conn_status 429;
    limit_req_status 429;
    ```

    and in the proxy host's Advanced config, before the `location ^~ /api/office/ds/` line:

    ```nginx
    location ~ ^/api/account/(register|forgot|resend|reset|verify|login)$ {
      limit_req zone=knife_auth burst=10 nodelay;
      include conf.d/include/proxy.conf;
    }
    location = /api/pdf {
      limit_conn knife_conn 3;
      proxy_read_timeout 300s;
      include conf.d/include/proxy.conf;
    }
    ```
- **office.knife.example.org** (only with the office sidecar) → the SAME `http://<KNIFE_HOST>:<KNIFE_PORT>` as the app,
  SSL as above, **Websockets Support on**, the same advanced config with `client_max_body_size 110m`. Set
  `KNIFE_OFFICE_PUBLIC_URL=https://office.knife.example.org` in the app's environment: the app proxies the editor itself
  (docs/SIDECARS.md "Office editor behind the app"), the sidecar is published on loopback only, and the CSP picks the
  origin up. The name must be on the same registrable domain as the app (the editor's cookie is SameSite=Strict). In public
  mode the variable is required for the editor: the CSP trusts only an https `KNIFE_OFFICE_PUBLIC_URL` on a public host
  name, never the sidecar's state file (its `publicUrl` or `bindHost:hostPort` once put a dev server's Tailscale address
  into the live CSP), so without it the editor cannot load and the server logs `[security-headers] public mode without
  KNIFE_OFFICE_PUBLIC_URL` at startup. `KNIFE_CSP_FRAME_ORIGINS` entries that are not https on a public name are dropped
  with a warning too. Private mode keeps the state-file fallback.

Only 443 (and 80 for the certificate challenge) should be reachable from outside; check from another network with
`curl -sI https://knife.example.org` and a port scan of the public address.

## 5. Sidecars on a public host

- Only admins install, start, stop, update or configure them (docs/ACCOUNTS.md "Roles"); users may use a running one.
- The course database is published on 127.0.0.1 only, and so is the office editor when the app proxies it
  (`KNIFE_OFFICE_PUBLIC_URL`, above); browsers never reach a sidecar port directly.
- Install `deploy/sbin/knife-firewall` and `knife-docker-user` root-owned under `/usr/local/sbin`. Configure
  `/etc/samurai-knife/firewall.conf` from `deploy/firewall/firewall.conf.example` and
  `/etc/samurai-knife/docker-user.conf` from `deploy/firewall/docker-user.conf.example`; replace placeholders and set
  actual proxy, interface, DNS, and network details. The nftables `inet knife_host` input table permits the app port only
  from the fixed proxy address and declared callback sidecar networks. The `DOCKER-USER` chain restricts published ports
  and egress by definition: office may reach DNS/public internet, learn-db has no new egress, and neither may reach host,
  LAN, Tailscale, other Docker networks, link-local or metadata ranges. Run `knife-firewall preflight` and
  `knife-firewall check`; use its timed rollback apply and confirm only from a new SSH session before persisting.
- Install `deploy/systemd/knife-firewall.service` and `knife-docker-user.service` root-owned. Enable the firewall unit
  only after confirming a timed apply; enable the Docker policy unit after Docker. The Docker watcher refreshes policy
  after network changes and synchronizes active callback-sidecar subnets into the nftables set. These scripts manage
  only their dedicated table/chains and never flush the full ruleset.
- Memory/CPU caps are in the definitions (office 3 GB / 2 CPUs, course DB 1 GB / 1 CPU).

## 6. Releases and automatic updates

Version naming (the same scheme as Finetune Studio): the repo-root `VERSION` file is `MAJOR.MINOR.PATCH.BUILD`. The
versioned pre-commit hook (`npm run hooks` once per clone: `core.hooksPath=scripts/git-hooks`) adds 1 to BUILD in every
commit and the commit includes the bump; `KNIFE_NO_BUMP=1 git commit ...` skips it and a commit that only changes VERSION
is never bumped. MAJOR = a change that breaks existing data, URLs or the MCP contract; MINOR = a new tool, suite or
feature; PATCH = fixes only (BUILD keeps counting across them). Raise MAJOR/MINOR/PATCH by hand in a VERSION-only commit
(BUILD back to 0, e.g. `0.2.0.0`) and set package.json `version` to the first three parts in the same commit. The running
build is shown next to the logo and at `GET /api/system/version`. On a merge conflict in VERSION keep the higher one.

A release is the tag `v<VERSION>` on the commit whose VERSION file says exactly that (`v0.2.0.57`); a `-` suffix
(`v0.2.0.57-rc.1`) marks a pre-release. To cut one: merge to `main`, then `git tag "v$(cat VERSION)" && git push origin
main "v$(cat VERSION)"`.

With the install script (above) this is `knife-update` on a timer; the rest of this section describes the same flow
for a PM2 setup. To keep a server on the newest release without touching the checkout it serves from, build every release in its own
directory (a `git worktree` per tag, its own `npm ci`, `.env.local` copied in) and serve through a `current` symlink: the
PM2 app's `cwd` is `.../current`. An update is then: fetch tags; build the newest tag in a new directory while the old
one keeps serving; start the new build once on a spare loopback port with an empty data dir and check a few pages,
`/api/account` and `/api/mcp`; move the symlink; start the app again from its config
(`pm2 delete` + `pm2 start`); check the live URL and move the symlink back on failure. Deploy only tags whose VERSION file matches the tag, and forward only (`git merge-base
--is-ancestor <deployed> <tag>`), so an older or unrelated tag never replaces newer code, and keep the previous release
directory for a rollback. Run it from a timer (systemd user timer or cron) with one run at a time (`flock -o`, so the
servers it starts never inherit the lock). Keep a separate `next dev` for development on another port with its own
`KNIFE_DATA_DIR` and `KNIFE_SIDECAR_PREFIX`, so it never shares data or containers with the served build.

## 7. Go-public checklist

- [ ] `npm run build` in the deploy checkout, process started via `serve.mjs start` with `KNIFE_AUTH_MODE=public`.
- [ ] Owner account: password, verified email, admin; `set-network private` only if needed.
- [ ] Legal pages: `legal.json` in `KNIFE_LEGAL_DIR` (systemd install: `/etc/samurai-knife/legal/`) with every
      placeholder filled, `/terms` and `/privacy` show no warning, and the operator duties in docs/LEGAL.md are done
      (record of processing, mail-relay DPA, true log/backup retention).
- [ ] `KNIFE_PUBLIC_URL` (https), `KNIFE_TRUSTED_PROXIES`, SMTP, `KNIFE_SSRF_DENY_CIDRS` set; `serve.mjs` starts without a
      `refusing to start` line (Startup checks).
- [ ] Proxy: `/api/office/ds/` answers 404 on the public name; NPM sees real client addresses (IPv6 too); `limit_conn` set.
- [ ] Proxy: HTTPS, forced; body size and streaming as above; the office name on the app's port with websockets, and
      `KNIFE_OFFICE_PUBLIC_URL` set (https); the startup log has no `[security-headers]` warning and `curl -sI` shows no
      private address in the CSP.
- [ ] Load budgets left at their public defaults or set on purpose (docs/ACCOUNTS.md "Fair share", "Storage quota"):
      `KNIFE_PDF_UPLOAD_MAX_MB` unset (100) or explicit, the disk floor (`KNIFE_DISK_FLOOR_GB` / `_PERCENT`) below the free
      space you keep on the data and `/tmp` filesystems; sidecars reinstalled or restarted once so their containers get the
      dropped capabilities (`docker inspect -f '{{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}} {{.HostConfig.PidsLimit}}'`).
- [ ] `tests/prod_smoke.py` against a scratch copy of this setup passes; `curl -sI` shows the CSP and HSTS.
- [ ] Data directory and `provider-keys.key` in the backup (the key opens the sealed provider keys in accounts.json).
- [ ] GitHub App created (Users page) with the public domain among its callback URLs and as its setup URL; the
      credentials file (`KNIFE_GITHUB_APP_FILE`) backed up apart from the data.
- [ ] `KNIFE_STORAGE_KEY_FILE` points outside the data directory (0600, owned by the app user) and is backed up apart from
      the data; existing data sealed once with `npm run storage -- seal` (server stopped, backup first; docs/ACCOUNTS.md
      "At rest").
- [ ] From outside: only 443/80 open; the app port, the sidecar ports and Postgres are not reachable.
