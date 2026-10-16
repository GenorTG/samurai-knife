# Deploying the public instance

How to run Samurai Knife for other people: a production build in `KNIFE_AUTH_MODE=public`, bound to an address only the
reverse proxy reaches, behind HTTPS. The private owner-only toolbox (`npm run dev` on a loopback/Tailscale bind) is a
different setup and stays as it is. Names below (`knife.example.org`, `office.example.org`) are placeholders.

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
KNIFE_SMTP_FROM="Samurai Knife <no-reply@knife.example.org>"
KNIFE_SSRF_DENY_CIDRS=<this server's public IPv4>/32,<the LAN's delegated IPv6 prefix>/56
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
on: streamed body limits, sealed provider keys, Python-lane rlimits and minimal child env.

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
`0.0.0.0` and unknown auth modes, and preloads the socket-peer stamp (trusted `X-Forwarded-*`) and the security headers.
A bare `next start` has neither.

## 4. Reverse proxy with HTTPS (nginx-proxy-manager)

One Proxy Host per name:

- **knife.example.org** → `http://<KNIFE_HOST>:<KNIFE_PORT>` (from a containerised proxy: an address of this machine the
  container can reach, e.g. the docker bridge gateway, with the app bound there instead of 127.0.0.1).
  - SSL: request a Let's Encrypt certificate, Force SSL, HTTP/2. Leave HSTS to the app (it sends it) or enable it here,
    not both with different values.
  - Websockets: not needed by the app itself.
  - Advanced (custom nginx config):

    ```nginx
    client_max_body_size 600m;          # >= KNIFE_PDF_UPLOAD_MAX_MB; the app streams uploads and enforces its own caps
    proxy_request_buffering off;        # stream uploads to the app instead of spooling them in the proxy
    proxy_read_timeout 300s;            # model rounds and PDF jobs
    proxy_set_header X-Forwarded-For $remote_addr;   # replace, do not append, what the client sent
    proxy_set_header X-Forwarded-Proto $scheme;
    ```

  - `KNIFE_TRUSTED_PROXIES` must match the address the proxy connects FROM, as seen by the app, or every client shares one
    rate-limit bucket and cookies are never `Secure` (docs/ACCOUNTS.md "Client address").
- **office.example.org** (only with the office sidecar) → `http://<sidecar bind address>:<sidecar port>`, SSL as above,
  **Websockets on** (the editor uses them), `client_max_body_size 100m`. Then in Sidecars → Office editor → Settings set
  the Public URL to `https://office.example.org` (the browser loads `api.js` from it; an http editor inside an https page
  is blocked as mixed content). The CSP picks the new origin up from the sidecar state within seconds.

Only 443 (and 80 for the certificate challenge) should be reachable from outside; check from another network with
`curl -sI https://knife.example.org` and a port scan of the public address.

## 5. Sidecars on a public host

- Only admins install, start, stop, update or configure them (docs/ACCOUNTS.md "Roles"); users may use a running one.
- The course database is published on 127.0.0.1 only. The office editor is published on `KNIFE_HOST` and must be reached
  by browsers through the proxy (above), never directly.
- The editor's request filter is on (docs/SIDECARS.md "Request filter"). Add network egress filtering for the sidecar
  networks, which compose cannot express: in `DOCKER-USER`, allow established traffic, DNS and the internet from the
  sidecar network, and drop its traffic to the host's own addresses, the LAN, the Tailscale range (100.64.0.0/10,
  fd7a:115c:a1e0::/48), other docker networks and 169.254.169.254, except the app's own port on the address in its app
  URL. Keep the rules in a script that runs after docker starts.
- Memory/CPU caps are in the definitions (office 3 GB / 2 CPUs, course DB 1 GB / 1 CPU).

## 6. Go-public checklist

- [ ] `npm run build` in the deploy checkout, process started via `serve.mjs start` with `KNIFE_AUTH_MODE=public`.
- [ ] Owner account: password, verified email, admin; `set-network private` only if needed.
- [ ] `KNIFE_PUBLIC_URL` (https), `KNIFE_TRUSTED_PROXIES`, SMTP, `KNIFE_SSRF_DENY_CIDRS` set.
- [ ] Proxy: HTTPS, forced; body size and streaming as above; office on its own HTTPS name with websockets.
- [ ] `tests/prod_smoke.py` against a scratch copy of this setup passes; `curl -sI` shows the CSP and HSTS.
- [ ] Data directory and `provider-keys.key` in the backup (the key opens the sealed provider keys in accounts.json).
- [ ] From outside: only 443/80 open; the app port, the sidecar ports and Postgres are not reachable.
