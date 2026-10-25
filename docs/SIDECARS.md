# Sidecars — optional docker services

Some tools need a real server program that cannot run in the browser or the Python lane (an office document editor, the
Database course's PostgreSQL), or files too big for the app's own bundle (the ArtCraft apps). Those programs run as **sidecars**: docker compose services the app installs, starts, stops, updates and
removes itself, from the web UI (launcher category **Sidecars** → *Sidecar services*) or the CLI. Nothing is installed until
the owner presses Install.

## Pieces

| Where | What |
| --- | --- |
| `src/lib/services/definitions.ts` | `SIDECARS`: id, pinned image, container port, health check (`health`), whether the container calls the app back (`callsBack`), generated secrets, env, named volumes, start timeout, idle stop default, `usedBy` slugs. Metadata only. |
| `src/lib/services/compose.ts` | Pure `renderCompose(def, {bindHost, hostPort, extraEnv})` → compose.yaml. Port published on **one** address (KNIFE_HOST, or 127.0.0.1 for `publish: "loopback"`); wildcard refused; `mem_limit`/`cpus` from the definition. Secrets via `env_file: secrets.env`, never inline. `restart: "no"` (the app owns the lifecycle). Labels `dev.samurai-knife.*`. |
| `src/lib/services/state.ts` | `$KNIFE_DATA_DIR/services/<id>/`: `state.json`, `compose.yaml`, `secrets.env` (600), `op.lock`. |
| `src/lib/services/runtime.ts` | `docker compose` first, then `podman compose`; exact install/permission hint when missing; **never sudo**. |
| `src/lib/services/manager.ts` | install / start / stop / remove / update / configure / status, health wait, app-reachability check, idle reaper, open-session registry. |
| `src/lib/services/ops.ts` | Server op store: background ops with phase, percent, pull bytes, log tail; polled by the browser. |
| `src/app/api/services/…` | `GET /api/services`, `GET|POST /api/services/<id>`, `GET /api/services/ops/<opId>`, `GET /api/services/ping`. |
| `scripts/services.ts` | `npm run services -- list|status|install|start|stop|update|remove|configure <id> | reap` (same lib, same lock). |
| `src/lib/services/assets.ts` | A definition's `assets` (files shipped in the repo, e.g. the editor plugin) -> `assets/<folder>-<hash>/`, mounted read-only. |
| `src/lib/services/sites.ts` | A definition's `sites` (release zips of static web apps): download, size + sha256 check, unpack into `releases/<app>-<version>-<sha12>/<app>/`, `.gz` twins, the active release of each app hard-linked into the content dir `services/<id>-content/<app>/` (`.knife-version` marker), the generated `assets/conf-<hash>/nginx.conf`, the static health check, pruning, moving the old layout's `assets/<app>-…` folders. |
| `src/lib/services/site-channel.ts` + `src/lib/craft/updates.ts` | The update channel (`services/<id>/channel.json`: active/previous/available release per app, hold, mode) and the Craft apps updater (GitHub releases, digest check, apply, rollback, daily schedule). |
| `src/tools/sidecars/` | `SidecarCard` (status + controls + progress), `SidecarsTool` (settings page), `OfficeTool`. |
| `src/tools/craft/`, `src/lib/craft/`, `src/app/api/craft/`, `scripts/craft-proxy.mjs` | The ArtCraft suite (one iframe tab per app), its launch URLs and the public-mode proxy. |

The compose project is `samurai-knife-<id>` (env `KNIFE_SIDECAR_PREFIX` overrides the prefix; tests use it so a scratch
server never takes over the live project). Every container, network and volume carries that project label; the app never
touches anything else on the host.

## Backend and host privilege boundary

`KNIFE_SIDECAR_BACKEND=docker` is the default for existing installs and development. It invokes the docker/compose CLI
as the app user, which therefore has Docker's host-root-equivalent authority; do not use this backend for an internet-
facing app unless that trade-off is deliberate. Public deployments should install the fixed-verb helper shipped under
`deploy/sidecar-helper/` and the socket/service units under `deploy/systemd/`, then set
`KNIFE_SIDECAR_BACKEND=helper` and `KNIFE_SIDECAR_HELPER_SOCKET=/run/knife-sidecar.sock`. The root helper accepts only
known sidecar ids and lifecycle verbs, reads root-owned compose bundles, and rejects any bundle that does not require
`cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, the definition's exact `cap_add`, and its bounded
`pids_limit`. Do not give the app account membership in the docker group. Installation and privilege separation are in
`docs/DEPLOY.md`.

## Lifecycle

- **Install** (`POST /api/services/<id> {action:"install"}` → 202 `{op}`): runtime check → pick a free port near KNIFE_PORT
  on KNIFE_HOST, or on 127.0.0.1 for app-only services (`publish: "loopback"`; stored; reused on reinstall) → generate
  secrets once (a secret added to a definition later is generated on the next compose write, for existing installs too) → write compose → `compose --progress json pull` (the
  JSON events are folded into one percentage and byte count) → `up -d` → wait for the health check → when `callsBack`, check from
  **inside** the container that the app is reachable (`GET /api/services/ping`); a failure there is a warning in the op log
  and status.
- **Prepare**: an optional per-definition command run with `compose exec` once per new container id, after the first
  health pass and before the op reports done (office: the font cache).
- **Start/Stop/Update**: `up -d` + health wait / `compose stop` / pull + recreate (reports whether the image changed).
- **Remove**: `compose down` keeps the named volumes and `secrets.env`; `purge` adds `--volumes` and deletes the state dir;
  `removeImage` adds `--rmi all`.
- **Lazy start**: a tool calls `{action:"ensure"}`: `{ready:true}` when healthy, else it starts (or joins the running start
  op) and returns 202 `{op}`; the tool polls and retries.
- **Who may** (docs/ACCOUNTS.md "Roles"): in public mode only an admin installs, starts, stops, updates, removes,
  configures or lazily starts a sidecar, and reads op logs. A user's `ensure` answers `{ready:true}` for a healthy sidecar,
  joins (progress only, no log) a start an admin already began, and is a 403 `admin_required` otherwise: a user request
  never starts a container. Pages then say "An administrator has to start <name>". Since an idle-stopped sidecar waits for
  an admin, a public install that users rely on turns on **Autostart** (below).
- **Environment**: docker/podman run with an allow-listed environment (`src/lib/child-env.ts`: PATH, HOME, locale,
  `DOCKER_*`, `XDG_RUNTIME_DIR`, …), never the app's own secrets.
- **Idle stop**: the server checks once a minute; a running sidecar with no open editing sessions and no use for
  `idleStopMinutes` (default 30, 0 = never, configurable per sidecar) is stopped. Use = editor heartbeat (`touch`, every
  60 s while a document is open), callbacks, starts.
- **Autostart** (`src/lib/services/autostart.ts`, state `autostart`; Settings "Start automatically", `configure <id>
  --autostart|--no-autostart`, install `--autostart`): the server (started by `src/instrumentation.ts`) starts it 15 s
  after the app starts and then checks once a minute: a sidecar that is not running (crash, docker restart, host reboot)
  gets the ordinary start op, so the page shows its progress. The idle stop never stops it. An administrator's Stop (UI
  or CLI) sets `heldStopped`, which the next start/install/update clears: autostart leaves a held sidecar stopped. A
  failed start waits 10 min before the next try (a helper bundle that needs `sudo knife-sidecar sync` must not loop).
  Containers keep `restart: "no"`: the app owns the lifecycle, and systemd starts the app at boot. The idle reaper now
  also starts with the server, not with the first sidecar API call.
- **Locking**: one op per service at a time, across the server and the CLI (`op.lock` with pid; a dead pid is stale).
- Ops are in memory: a server restart forgets the op record (the container keeps running; status is read live).

## Health checks

`health` in the definition, probed by the app on `bindHost:hostPort` (`probeHealth` in manager.ts):

- `{ kind: "http", path, body? }`: `GET <path>` answers 200 (and the body matches). Office: `/healthcheck` = `true`.
- `{ kind: "postgres" }`: the app sends a Postgres SSLRequest (8 bytes) and waits for the server's one-byte answer
  (`S`/`N`). A plain TCP connect is not enough: docker's port proxy accepts the connection before the container listens
  (and during `initdb` Postgres listens on its unix socket only). No client library, no credentials.

`callsBack: false` (a database) skips the container -> app reachability check and its app-URL warnings.

## Addresses (the part that bites)

Two URLs per sidecar, both shown and editable in its Settings:

- **Public URL** (browser → sidecar): default `http://<KNIFE_HOST>:<port>`. The editor's scripts and websocket load from it.
  `KNIFE_OFFICE_PUBLIC_URL` (the app proxies the editor, below) replaces it and publishes the sidecar on loopback;
  `KNIFE_CRAFT_PUBLIC_URL` does the same for the ArtCraft apps.
- **App URL** (container → app): default `http://<KNIFE_HOST>:<KNIFE_PORT>`. A container reaches the host's Tailscale/LAN
  address fine, but **not the host's loopback**. With `KNIFE_HOST=127.0.0.1` the derived URL is
  `http://host.docker.internal:<port>` (the compose file maps it with `host-gateway`) and the status carries a warning,
  because the app does not listen on the docker bridge. Fix: bind the app to the Tailscale/LAN address (the live setup),
  or set the app URL / `KNIFE_SIDECAR_APP_URL` to an address the container can reach.

## Office editor behind the app (`KNIFE_OFFICE_PUBLIC_URL`)

On a public host the browser must reach the editor over https, on an origin that is NOT the app's: the editor's scripts
(and whatever a document makes them do) must never run with the signed-in user's origin. With
`KNIFE_OFFICE_PUBLIC_URL=https://office.<app host>` the app serves the editor itself (`scripts/office-proxy.mjs`,
preloaded by `serve.mjs` through `peer-address.mjs`); the reverse proxy only has to send that name to the app's port with
websockets on (docs/DEPLOY.md §4).

- Every request and websocket upgrade whose `Host` is that name goes to the sidecar and never reaches Next; the app is
  never served on the office host. The sidecar is published on `127.0.0.1` only (an older install moves on its next
  start/update) and its Public URL setting is ignored while the variable is set.
- Gate: the editor config loads `api.js?knife_ticket=<ticket>` (`src/lib/office/proxy.ts`: HMAC ticket naming the account,
  6 h, key = HMAC of a fixed context under the sidecar's JWT secret). A valid ticket on `api.js` sets `knife_office`
  (HttpOnly, SameSite=Strict, Secure on https) on the office host; everything else needs that cookie. App and office host
  must be one site (same registrable domain) or the browser does not send it.
- Allow-list: editor files (`web-apps`, `sdkjs`, `sdkjs-plugins`, `fonts`, `dictionaries`, the service worker,
  `meta/formats`, `plugins.json`, `themes.json`), the document websocket/long-poll `doc/<id>/c/…`, `cache/files/…` and the
  editor's per-document `downloadas|savefile|printfile|downloadfile|upload|uploadold`, each after an optional version
  prefix. CommandService, ConvertService, converter/docbuilder, info, internal, admin, ai-proxy, welcome/example,
  healthcheck and WOPI answer 404; `..`, encoded dots/slashes/backslashes and control characters too. The editor itself
  asks for `sdkjs/slide/themes//themes.js`, so `//` is allowed.
- Hygiene: the browser's cookies, `X-Forwarded-*`, `Forwarded`, `X-Real-IP` and `x-knife-*` never reach the sidecar; it gets
  `X-Forwarded-Host` = the office host and `X-Forwarded-Proto` (its nginx builds absolute URLs from them). `Set-Cookie`,
  `Server` and `X-Powered-By` from the sidecar are dropped; responses get `frame-ancestors <app origin> <office origin>`,
  `nosniff`, a referrer policy and HSTS on https.
- Limits: 3000 requests/min and 64 at once per account, 16 websockets per account (512 in total), 60 refused requests/min
  per client address (then 429), 110 MB bodies, 5 min idle (15 min on websockets). No sidecar: 503.

## Office (`office`, slug `office`)

- **Image**: `ghcr.io/euro-office/documentserver:v9.3.5` — Euro-Office Document Server, the AGPL-3.0 fork of the ONLYOFFICE
  Document Server (https://github.com/Euro-Office/DocumentServer, docs https://euro-office.github.io/documentation/). On
  2026-10-13 `latest` and `v9.3.5` had the same digest in the ghcr.io registry. The docs show `:9.3.1`; the published
  release tags carry a `v`. Env: `JWT_ENABLED=true`, `JWT_SECRET` (generated, 64 hex), `SECURE_LINK_SECRET` (generated,
  48 hex: signs the `/cache/files/...` links; without it the image makes one per data volume),
  `ALLOW_PRIVATE_IP_ADDRESS=false`, `ALLOW_META_IP_ADDRESS=false` and a `NODE_CONFIG` override of the request filter
  (see "Request filter"), example/admin panel/WOPI off, `GENERATE_FONTS=false`; `mem_limit: 3g`, `cpus: 2`, capabilities and
  pids as in "Hardening". The font cache lives in the
  container filesystem (not a volume) and the editor never finishes loading without it, although `/healthcheck` answers
  `true`; so the definition's `prepare` step runs `documentserver-generate-allfonts.sh` once per new container (recorded as
  `preparedContainer` in state.json). Measured: new container 53 s to ready, stopped -> ready 11.7 s (was 45 s when every
  start regenerated the cache), RAM ~1.1-1.5 GiB. Volumes: `/var/lib/euro-office/documentserver`,
  `/var/www/euro-office/Data`.
- **Library** (per account, path from `accountScope`, counted by the storage quota: docs/ACCOUNTS.md "Storage quota"):
  `$KNIFE_DATA_DIR/docs/<account>/` with `folders.json` (the folder tree) and one directory per document
  `<docId>/` (`meta.json`, `current.<fmt>`, `history/v<N>.<fmt>`). Blank docx/xlsx/pptx/odt/ods/odp are generated in TS
  (`src/lib/office/templates.ts`, minimal ZIP writer on `node:zlib`). Upload is JSON base64 (≤ 50 MB per file).
  Everything except editing works without the sidecar.
  - Folders (`src/lib/office/folders.ts`): metadata only (a document names its `folderId`; moving never touches bytes),
    unique sibling names (case-insensitive), at most 12 levels and 2000 folders, no moves into the own subtree.
  - Versions: every save (editor callback 2 and 6, a restore) keeps the previous bytes as a version with when, who and
    how (`editor`, `upload`, `restore` from vN, `copy`…); at most 25 per document (oldest dropped). Restore = the old bytes
    become a NEW version (nothing lost; the key rotates, so an editor still open on the old session saves its next change
    as "(edited copy)"). Prune keeps the newest N. Preview = plain text (`knife_doc_read`'s extraction,
    `src/lib/office/extract.ts`: run in the isolate pool with a timeout, output capped while it is built; a full pool
    answers 503/429 + Retry-After).
  - Trash: `trashedAt` + `trashedWith` (the item the user trashed: a document, or a folder with its whole subtree).
    Restore puts things back (root when the parent folder is gone); only the trashed item itself can be restored or deleted
    for good; purged 30 days after trashing. A trashed document cannot be opened, moved or copied (409).
  - Routes: `GET /api/office/docs` (library + trash + storage in one read), `POST /api/office/docs` (create/upload with
    `folderId`), `GET|POST|DELETE /api/office/docs/<id>` (details + versions; rename, move, duplicate, trash, restore,
    restore_version, prune_versions, forcesave; DELETE = trash, `?permanent=1` = for good),
    `GET /api/office/docs/<id>/versions/<n>` (text preview, `?download=1`), `POST /api/office/folders`,
    `POST|DELETE /api/office/folders/<id>` (rename, move, trash, restore; DELETE = a trashed folder for good),
    `POST /api/office/trash {action:"empty"}`. Another account's ids answer 404 exactly like missing ones.
  - File browser (`src/tools/sidecars/OfficeTool.tsx`): breadcrumbs, folders first, sortable columns (`aria-sort`),
    search across folders (with the folder path), per-row Open / Download / Versions / Actions (rename, move, duplicate) /
    Trash with Undo, a Trash view (restore, delete forever, empty), the storage meter, role=status progress for uploads and
    every change; Escape closes an open row. Uploads are checked against the free space before they are sent. The page
    re-reads the library every 10 s while visible (changes from the assistant or MCP show up).
  - Editor not available: when the sidecar is not installed, Open shows a clean "not installed" state (download, back);
    a stopped sidecar is lazy-started (or, for non-admins in public mode, the "An administrator has to …" message).
- **Editor**: `GET /api/office/docs/<id>/editor` returns the DocsAPI script URL and a config signed server-side with the
  sidecar's JWT secret (the browser never sees the secret). The page loads `api.js` from the public URL and mounts
  `DocsAPI.DocEditor` (an iframe). `forcesave: true`: Ctrl+S / the Save button saves at once.
- **Document Server → app**: `GET /api/office/ds/file?t=…` and `POST /api/office/ds/callback?t=…`. **These two are the only
  routes without the Origin/Host guard** (the container sends no Origin and its Host may be `host.docker.internal`). They
  authenticate with JWT twice: the `t` capability token (account + document + purpose, 24 h / 30 d) and the server's own
  `Authorization: Bearer` token (or `token` in the callback body); the status fields are read from the signed token only.
  Token kinds (`src/lib/office/ds-auth.ts`, one check `authorizeDsRequest` for both routes): capabilities are signed
  with HMAC(JWT secret, capability context), never the raw secret, so no Document Server token is a capability and no
  capability is a Document Server token; they carry an account epoch (id + creation time) and are refused, with a
  generic 403, once the account is disabled, unusable (`accountUsable`), deleted or registered again. The editor
  config (the one token the browser sees that is signed with the raw secret, because the Document Server verifies it)
  expires after 24 h (a session left open longer reloads) and is refused as either Document Server form: the header
  token must wrap the request in `payload` and carry `exp`, the body token must carry `key`, `status` and `exp` (the
  shapes the 9.3.5 image signs). The save download is read chunk by chunk and dropped past `MAX_DOC_BYTES` even when
  `Content-Length` is missing.
- **Closing**: the editor batches a single user's changes for ~2 s before sending them (autosave gap), and destroying it
  drops what is unsent. "Close editor" therefore waits for `onDocumentStateChange(false)` ("all changes sent", max 15 s)
  before destroying it; leaving the page another way (navigation) does not wait.
- **Save rules**: status 2 (all editors closed) → save + new `key`; 6 (force-save) → save, same key (the session goes on);
  4 (closed, no changes) → new key; 1 → session open/closed bookkeeping; 3/7 → logged, nothing saved. The save URL must be
  on the sidecar's own origin (no SSRF). A callback for an outdated key saves "<name> (edited copy)" (same folder) instead
  of overwriting. Over the storage quota the save first drops that document's oldest kept versions; if it still does not
  fit the callback answers `{error: 1}` (the editor warns and keeps the changes) and the document records `lastSaveError`,
  which the open editor page shows.
  If the server returns another format (`filetype`), the document takes that format.
- **Assistant**: the editor iframe is cross-origin, so UI tools cannot click or type in it. The `docs` tool group
  (`knife_doc_list`, `knife_doc_read`, `knife_doc_create`, `knife_doc_folder_create`, `knife_doc_move`,
  `knife_doc_versions`, `knife_doc_restore_version`; docs/MCP.md) works on the SAVED library server-side (widget and MCP); the
  document OPEN in the editor is read and edited live through the editor plugin below (`doc_live_*`). Both groups are
  preloaded on `/tools/office`.
- **Force-save**: `POST /api/office/docs/<id> {action:"forcesave"}` asks the Document Server's command service
  (`/coauthoring/CommandService.ashx`, `c: "forcesave"`, JWT in the body and the `Authorization` header) to save the open
  session now; the new version arrives through the callback (status 6) a second or two later. Answers `saving`,
  `unchanged` (error 4: nothing sent since the last save; right after an edit it just means the editor has not sent it
  yet, so callers retry for a few seconds) or `not_open` (error 1).

## Request filter (office)

The Document Server downloads URLs itself. Two kinds, verified against the 9.3.5 image:

- URLs inside the JWT-signed editor config and command requests (the document download from `/api/office/ds/file`, the
  save callback) are trusted by the server and are **not** filtered. A signed ConvertService request fetched even a
  loopback URL with the filter on.
- URLs a user brings into an editing session (Insert → Image → From URL, compare/merge sources; reproduced with
  `editor.AddImageUrl([url])` in the editor frame) go through `request-filtering-agent`.

So the definition keeps the filter on: `ALLOW_PRIVATE_IP_ADDRESS=false`, `ALLOW_META_IP_ADDRESS=false`, and the manager
renders the filter config explicitly as `NODE_CONFIG` (`onlyofficeFilterEnv` in compose.ts; node-config applies it after
the image's local.json, supervisord passes the container env to docservice and converter) with `allowIPAddressList` =
`KNIFE_SIDECAR_ALLOW_IPS` only (empty by default). Measured with the office e2e: open, Ctrl+S, close save, every format
and the lazy start pass with an empty list, while an image URL to the app's own IP or to the docker gateway is never
fetched (with the app's IP listed, that fetch went through: the list is per IP, every port). A changed allow list changes
the compose hash, so the next idle `ensure` recreates the container.

What compose cannot do: filter the container's egress by destination. The request filter covers the user-URL paths the
Document Server knows about; for defence in depth on a public host, use the per-definition `DOCKER-USER` policy in
`deploy/sbin/knife-docker-user`: office gets DNS and public internet, learn-db has no new egress, and both are blocked
from host, LAN, Tailscale, other Docker networks, link-local and metadata ranges. `KNIFE_SIDECAR_ALLOW_IPS` entries
matching the app host's interface addresses, `KNIFE_HOST`, or loopback are ignored and reported in logs and Sidecars
status. This is deliberate: the list is IP-wide, not port-specific, and would let user-controlled editor URLs probe
every port on that host. Signed document/callback URLs do not need this exception.

## Course database (`learn-db`, slug `db-course`)

- **Image**: `postgis/postgis:16-3.4` (PostgreSQL 16 + PostGIS 3.4, Debian), port 5432 published on **127.0.0.1** only
  (`publish: "loopback"`: the app is the only client; an install from before moves there at its next start/update), volume
  `pgdata` (`/var/lib/postgresql/data`), `mem_limit: 1g`, `cpus: 1`, capabilities and pids as in "Hardening",
  `POSTGRES_DB=learn`. Secrets: `POSTGRES_PASSWORD`
  (superuser, used by the app to seed) and `LEARNER_PASSWORD` (set on the low-privilege `knife_learner` role by the seed).
  Health `postgres`, `callsBack: false`. Measured: install with a cached image -> healthy + seeded in ~10 s; stopped ->
  ready ~3 s; RAM ~100 MiB after the seed and a lesson sweep.
- The app is the only client: browsers never talk to Postgres. The seed, the learner sandbox and the privileges are in
  [docs/LEARN.md](LEARN.md).

## Live editing plugin (assistant ↔ open document)

The Automation API (`createConnector`) is not in Euro-Office's `api.js`, but the plugin API (`callCommand` with the
builder `Api`, `executeMethod`) is. So the assistant edits the open document through a plugin of our own, verified
against the code in the image (sdkjs/web-apps 9.3.5: `/plugins.json`, `parsePlugins`, `CPluginsManager`, `plugin_init`).

- **Files**: `sidecars/office/plugins/knife-bridge/` — `config.json` (guid `asc.{6AF2FF69-9582-4CD7-A71D-9C3A6940B8F5}`,
  one variation: `isSystem: true`, `isVisual: false`, `EditorsSupport` word/cell/slide, `isViewer: true`), `index.html`,
  `loader.js` (the plugin loader: `initialize` -> the editor answers `plugin_init` with its plugin runtime; the image
  ships no `plugins.js` and a plugin must not load code from the internet) and `bridge.js` (channel + command allowlist).
  A system plugin starts by itself in every editor and has no menu entry; without our options it stays idle.
- **Install = part of the sidecar**: the definition's `assets` (`src/lib/services/assets.ts`) copy every folder of
  `sidecars/office/plugins/` to `$KNIFE_DATA_DIR/services/office/assets/<folder>-<sha256 prefix>/` (dirs 755, files 644)
  and compose mounts that directory read-only at `/var/www/euro-office/documentserver/sdkjs-plugins` (empty in the
  image). The Document Server lists every sub-folder with a `config.json` in its `/plugins.json`, which every editor
  loads. The content hash in the folder name matters: nginx serves `sdkjs-plugins` with `Cache-Control: immutable,
  max-age=1y`, so a changed plugin must get new URLs. Synced on install, start, update and every lazy start (`ensure`),
  so a changed plugin is served at once without a restart.
- **Existing installs**: `state.composeHash` records the compose file the container was created from. When it differs
  (an install from before the plugin mount), the next `ensure` with no open editor session runs a start op, and
  `compose up -d` recreates the container with the mount (one font-cache run, ~50 s). The status carries a warning
  until then; Start/Update on the Sidecars page do the same at once.
- **Channel** (`src/lib/office/live-protocol.ts`, `live-bridge.ts`, plugin `bridge.js`):
  1. `GET /api/office/docs/<id>/editor?origin=<page origin>` (the origin must name the request's own host, else 400)
     mints a random per-session token and puts `{token, appOrigin}` into `editorConfig.plugins.options[<guid>]` inside
     the JWT-signed config; the response's `live` carries the token and the sidecar origin to the page.
  2. The plugin reads its options (`Asc.plugin.info.options`) and posts `hello {token, editor, viewMode, commands}` to the
     app window (`window.parent.parent`) with **targetOrigin = appOrigin** (only that origin can read the token), every
     second until welcomed (max 2 min).
  3. The page (`OfficeLiveBridge`) accepts a hello only if `event.origin` is the sidecar's public origin, the token
     matches, and `event.source.parent` is the editor iframe this page created. It answers `welcome {token}` with a
     **MessagePort**; the plugin accepts it only from `window.parent.parent`, from `appOrigin`, with the token.
  4. All requests/responses then travel over that private port (ping/pong every 15 s when idle; a lost plugin flips the
     state back to connecting and its next hello reconnects).
  Why postMessage + MessagePort and not a server relay: the assistant loop already runs in this page, so the bridge
  needs no app endpoint, no CORS, no polling and no server state, and the browser enforces the origins. The token stops
  other pages/frames of the sidecar origin (any other document) from impersonating the plugin; the port means nothing
  after the handshake goes through window messaging. The editor's own messages are JSON strings; ours are objects, which
  `api.js` ignores. Macros are switched off in the config (`customization.macros: false`): a document macro runs in the
  sidecar origin, the same origin as the plugin.
- **Commands** (fixed allowlist; the channel never carries code): word `get_text`, `get_structure` (elements with index,
  style, heading level), `get_selection`, `insert_text` (end = new paragraphs, an empty last paragraph is filled first;
  cursor = at the user's cursor), `replace_text` (count, then `SearchAndReplace`), `insert_paragraphs` (at an index,
  styled), `set_paragraph_style`, `delete_range` (element indices, returns the removed text), `add_comment` (on a quote,
  a paragraph or the selection), `format_text` (bold/italic/underline/strikeout, colour, highlight, size, font on a quote
  (first or every match), element range or the selection), `insert_table` (rows of cell texts, a bordered table style
  when the document has one, bold header row), `insert_list` (bullets or numbers), `set_header_footer` (default
  header/footer of the last section, replaced), `track_changes` (on/off); cell `get_text`/`get_structure`/`get_selection`,
  `cells_read` (values + formulas, max 2000 cells), `cells_write` (block from a top-left cell, formulas as `=...`; refuses
  non-empty cells unless `overwrite`), `cells_format` (bold/italic/underline/wrap, font size and colour, fill, number
  format, horizontal alignment), `column_width` (characters), `sort_range` (by one column, header row kept),
  `add_chart` (`AddChart` on an absolute range, anchored at a cell, sized in EMU, optional title), `add_sheet`; slide
  `get_text`/`get_structure` (texts, text shapes by index, speaker notes), `add_slide` (title + body shapes, theme text
  colour), `set_slide_text` (one shape's text replaced, first paragraph's formatting kept), `set_slide_notes`,
  `delete_slide` (never the last one; returns its texts). The protocol (`toLiveCall`) checks and prepares every
  argument before it reaches the editor (colours to RGB, column letters to indexes, ranges to `$A$1:$B$6`). Each runs through
  `Asc.plugin.callCommand` with `Asc.scope` for the arguments, wrapped in try/catch so an exception comes back as an
  error, one at a time (the runtime has a single callback slot), 20 s timeout; edits recalculate, reads do not; a
  read-only editor refuses edits. Saving is NOT a plugin command (`Api.Save()` from a plugin does not reach the save path
  in 9.3.5): `doc_live_save` uses the force-save above.
- **Assistant tools** (`src/lib/agent-client/office-live-tools.ts`, group `office_live`, page-only: not offered by
  `load_tools`): `doc_live_read {what: text|structure|selection}`, `doc_live_insert_text`, `doc_live_insert_paragraphs`,
  `doc_live_replace`, `doc_live_set_style`, `doc_live_delete`, `doc_live_comment`, `doc_live_format`,
  `doc_live_insert_table`, `doc_live_insert_list`, `doc_live_header_footer`, `doc_live_track_changes`,
  `doc_live_cells_read`, `doc_live_cells_write`, `doc_live_cells_format`, `doc_live_column_width`, `doc_live_sort`,
  `doc_live_add_chart`, `doc_live_add_sheet`, `doc_live_add_slide`, `doc_live_slide_text`, `doc_live_slide_notes`,
  `doc_live_delete_slide`, `doc_live_save`. A tool is sent to the model only
  while the plugin is connected AND the editor type fits (word / cell / slide), so a page without an editor costs no
  tokens; a stray call explains how to connect. Trust: reads never ask; edits are acting calls (asked in All/Most);
  `doc_live_delete`, `doc_live_replace` (replaces every match), `doc_live_cells_write {overwrite:true}`,
  `doc_live_delete_slide`, `doc_live_slide_text` and `doc_live_header_footer` (both replace what is there) are destructive
  (asked in every mode except None, one by one). The user can undo any edit with Ctrl+Z in the editor (verified).
  `page_snapshot` carries `liveDocument {document, state, editor, read_only}` and a note; the office page shows
  "Assistant live editing: connected (word editor)." (`data-agent-region="office-live-status"`). Debug handle:
  `window.knifeOfficeLive` (the active bridge; `.state`, `.call(cmd, args)`).
- **MCP**: not offered. The editor session lives in the user's browser tab; an MCP client has no page to reach it
  through, and a server relay would add exactly the unauthenticated-ish command path this design avoids. MCP keeps
  `knife_doc_*` for the saved files.
- **Limits**: indices are element indices (a table counts as one element; table cells are not addressable); styles must
  exist in the document (`GetStyle` falls back to the default style for an unknown name, so the plugin compares the
  name and lists the known ones); `replace_text` is plain text, whole document; table cells are written once (no
  addressing after insert); images are not inserted yet; slides are added as plain text boxes, not layout placeholders; one live editor per page (the active bridge); an editor opened
  outside Smart Knife never connects (no options).

## ArtCraft (`craft`, slug `artcraft`)

Thirteen clean-room, pure-Rust creative and office apps by storytold (https://github.com/storytold, MIT OR Apache-2.0),
each shipped as a static WebAssembly web build: PhotoCraft (images), VectorCraft (vectors), FilmCraft (video), LightCraft
(photo library + raw), EffectCraft (motion graphics), DesignCraft (page layout), PdfCraft (PDF), FigCraft (interface
design), WordCraft (word processor), SoundCraft (audio workstation), DeckCraft (presentations), CADCraft (CAD), GridCraft
(spreadsheets). No server-side code: files are opened with the browser's picker, Save/Export are downloads, preferences
and LightCraft's library live in the browser's storage for the craft origin. Facts below come from each repo's
`packaging/web/README.md` (identical to the `HOSTING.md` inside each zip) and the `_headers` in the zips, read
2026-10-21.

- **Attribution** (rules in docs/LEGAL.md "Third-party components served to browsers"): the suite and the sidecar are
  named "Craft apps", never with the ArtCraft name (their brand terms); each tab links to `/credits` for attribution,
  source and licence information. That page exposes an expandable licence-and-notices section per app, fed by
  `GET /api/craft/notices?app=<id>` (public, read-only, src/lib/craft/notices.ts): the release's own
  `LICENSE-*`/`OFL-*`/`ATTRIBUTION*` files plus the repository's
  `NOTICE` and every licence file it names, fetched from `raw.githubusercontent.com/<repo>/v<version>/` (no redirects,
  512 KB per file, 24 files) and cached in `services/craft/notices/<app>-<version>.json` once complete (outside the
  bundle, so it never changes the helper hash). Most zips do not carry `NOTICE` (SoundCraft's does).

- **Pins** (`ARTCRAFT_APPS` in definitions.ts): version, release URL, zip size and sha256, verified 2026-10-21 (VectorCraft,
  FilmCraft and EffectCraft raised 2026-10-25 to the first releases whose `window.<app>` the assistant drives) against
  the GitHub API's asset digest and a local `sha256sum` (they agree):

  | App | Version | Zip sha256 | Zip / unpacked |
  | --- | --- | --- | --- |
  | photocraft | 0.11.1 | `f954c8096eeb5ab7ab20cd73445420097a4afde46f3d79547b3c9fe4f03d735f` | 11.6 / 11.8 MB |
  | vectorcraft | 0.17.0 | `71ddc4e71538ec1ce8467c21cb6ca47754042b222605a7de1851fbb1f3d6b37c` | 29.3 / 79.1 MB |
  | filmcraft | 0.13.0 | `c632afdcafc0cf185c01063471cf4a78eecb2d526787f3eb821047786c6482d5` | 13.5 / 42.1 MB |
  | lightcraft | 0.10.0 | `6f787f9cd28c0092672e06077c7b7f5b1c9c72f709c570b317fef99a1c0cd794` | 22.4 / 39.9 MB |
  | effectcraft | 0.17.0 | `95f93e7a8d7907616e219152272b7e0c1791030309be02eb9214ae4258fec783` | 19.5 / 64.7 MB |
  | designcraft | 0.10.0 | `88358c3f4bc169001bb7b4f8022a4a148ecae7534c17f2d8867c1bfaeab618a4` | 19.2 / 49.5 MB |
  | pdfcraft | 0.10.1 | `58a3e92a7bb61ed62d09376c96e71d65d0104495e629594fe52678d7579e68b9` | 14.5 / 39.4 MB |
  | figcraft | 0.8.0 | `75fd4821e0ef8793c82bc56d530764f8244a137e55745f49a745838028c9bb51` | 9.8 / 34.9 MB |
  | wordcraft | 0.9.0 | `710d2f4dd95ac6234a043d15d8e82232d20330199dbdbc94159324eeb02631c1` | 16.5 / 60.6 MB |
  | soundcraft | 0.10.0 | `834949ad6ef7df7c45fd28632b6eb94768c52134581b3778275a10a5451a6206` | 5.9 / 21.6 MB |
  | deckcraft | 0.7.0 | `4ab91994048c096fa356b7246c31098474d978ecd572e5b252dd825a287d1c40` | 9.4 / 35.1 MB |
  | cadcraft | 0.10.0 | `d86268e964ca91402439f4518d25057463db988d0145a48d3c65213957a1ced2` | 8.7 / 31.9 MB |
  | gridcraft | 0.9.0 | `f2327c09f176258143f7a5a78e4b40ae439be52e7cceca50fca1176dddcd11d8` | 7.1 / 26.3 MB |

  DeckCraft is pinned one step back on purpose: the 0.8.0 and 0.9.0 web builds panic before the first frame ("no pids
  on this platform": a `std::process` call on wasm32, https://github.com/storytold/deckcraft/issues/959, open on
  2026-10-21; reproduced here in Firefox for both); 0.7.0 starts and its hosting notes are identical. Bump it once a
  release fixes that issue (check that the tab draws, not just loads).
  Unpacked = the app's files plus their `.gz` twins; all thirteen: 626 MB on disk, 187 MB of zips to download (59 MB of it the six later apps).
  The six later apps (FigCraft … GridCraft) are plain trunk builds: `index.html` + `<app>-web-<16 hex>.js` /
  `_bg.wasm` (immutable, as their READMEs say) + licence files and an icon (revalidated).

  A version bump = new `version`, `sha256`, `bytes` (read the asset digest with `gh release view -R storytold/<app>
  --json assets`, download it and `sha256sum` it; re-read the app's README for changed headers or sandbox needs).
- **Install / update / start** (`sites.ts`, inside the op's lock, with download progress): every app whose ACTIVE
  release (the update channel, never below the pin) has no `releases/<app>-<version>-<sha12>` folder is downloaded
  (`fetch`, redirects followed, 15 min cap) to `services/craft/downloads/`, refused unless size and sha256 equal the
  release, unpacked with the in-repo ZIP reader (entries must sit under `<app>-web-<version>/`, segments
  `[A-Za-z0-9._-]`, no `..`, at most 8 levels, 5000 entries, 256 MB per entry; dotfiles skipped) into
  `releases/.tmp-…`, given `.gz` twins (wasm/js/html/css/svg/json/txt/fonts over 1 KB, unless the zip has one;
  PhotoCraft's parts are gzip already and are served byte for byte), and renamed into place. The zip is deleted.
  Nothing downloaded is ever in git. Then each app's active release is hard-linked into the content dir
  `services/craft-content/<app>/` (built as `.new-<app>-<pid>` and swapped in by rename; a `.knife-version` marker
  names the release) and, with the root helper, handed to root (`content` verb, below). After a healthy `up`, configs
  other than the current one and releases other than each app's active, previous and pinned one are removed
  (`pruneSites`). The first start of this layout moves the old `assets/<app>-<version>-<sha12>/` folders to
  `releases/` instead of downloading them again.
- **Config vs content** (why app updates need no `sync`): the container mounts two read-only folders: `assets/` at
  `/srv/craft` (only `conf-<hash>/nginx.conf`, which names no version) and the content dir at `/srv/craft-content`
  (`../craft-content` in compose, a sibling of the service dir, so a `sync` that replaces the bundle dir never pulls it
  out from under the running container). Switching a release touches only the content dir: compose, its hash and the
  bundle's asset folder names stay the same, so the container is neither recreated nor does the root helper's bundle
  check fail. With the helper, root copies the content dir into `/etc/samurai-knife/sidecars/craft-content/` on the
  app's request (`content craft`: only apps whose marker changed, regular files and directories only, names
  `[A-Za-z0-9._-]`, depth 8, 1.5 GB in all, each app swapped in by rename, apps no longer staged removed). The helper
  unit (`ProtectSystem=strict`) may write only there and in `/run/knife-sidecar` (`ReadWritePaths`; install.sh creates
  the folder), and reads the app's 0700 staging dir with its one capability, `CAP_DAC_READ_SEARCH` (root without
  capabilities is "other" there). Before 0.8.1 the write, and before 0.8.2 the read, failed: every Craft app on a helper
  install stopped with "content refresh failed" until the installer was re-run. A file-system error names the path
  (exit 73). That does not
  widen the host's trust boundary: the files are static, nginx (uid 101, no capabilities, read-only root, no egress)
  only serves them, and they only ever run in browsers on the separate craft origin, which the app's own origin never
  trusts; a compromised app could already serve anything on its own origin. What can hurt the host (image, ports,
  capabilities, mounts, secrets, nginx.conf) still needs the owner's `sudo knife-sidecar sync craft`.
- **Craft files** (account-synced work; src/lib/craft/files.ts, `sidecars/craft/knife-bridge/`, src/tools/craft/):
  - What the person sees: Save and Export in an app keep the file in their Smart Knife account ("My files" in every
    tab: list, Download, Delete; the "Saved … · Download" line after each save). Download is separate: it puts a copy
    on this computer. Open in an app shows Smart Knife's own chooser: the account's files that match the app's
    `accept` (this app's first, then the other Craft apps'), or "From this computer…". So work saved on one browser or
    device opens on any other. Files count against the account's quota (area `craft`, 1 GiB for registered users).
  - How (no change to any app): the page loads a hidden iframe of ours, `/knife-bridge/?app=<id>` on the craft origin
    (served from the content dir like an app, copied from the repo with a content-hash marker, so a change needs no
    `sync`), and talks to it over a MessagePort. Once the app frame loads, the bridge (same origin as the app, reaching
    it through `parent.frames`) patches the app window's `HTMLElement.prototype.click`, `showPicker` and
    `URL.createObjectURL`: every ArtCraft web build saves by clicking an `a[download]` with a blob URL and opens by
    clicking an `input[type=file]` (wasm-bindgen glue, checked 2026-10-21), so a save becomes a `save` message (the
    Blob kept from `createObjectURL`, since apps revoke the URL right after the click) and an open becomes an `open`
    message; the chosen files go back into the app's input as `File`s with `input`/`change` events, and the focus goes
    back to the element that had it (no scroll), so the app's next shortcut reaches it. Over 50 MB the browser
    downloads as before and the page says so. A browser with the File System Access API (Chromium) may let an app save
    through `showSaveFilePicker` instead, which the bridge does not see; Firefox has no such API.
  - Server: `GET /api/craft/files` (list + usage), `POST /api/craft/files {action:"save", app, name, mime, data}`
    (base64 in JSON like the office upload: `readJsonBody`, Origin guard; 50 MB per file, 500 files, 30 saves a minute
    per account; same app + same name replaces the file; 507 with the quota message when it does not fit),
    `GET /api/craft/files/<id>` (always `application/octet-stream` as an attachment, `nosniff`, `CSP: sandbox`: the
    content comes from third-party apps and is never rendered on the app's origin; the real type in `X-Craft-Type`),
    `DELETE /api/craft/files/<id>`. Stored sealed in `craft-files/<account>/`, removed with the account.
  - Shared browsers: all accounts on one browser share the craft origin's storage (LightCraft's library, recovery
    files, preferences). The launch answer carries an account tag (HMAC of the account id under a key derived from
    TICKET_SECRET); the bridge keeps it in the craft origin's `localStorage` (`knife:account`) and, when a different
    tag arrives, wipes local/session storage, IndexedDB, OPFS, Cache Storage and service workers BEFORE the page loads
    the app ("Another account used the Craft apps in this browser before you: their local data was cleared"). A
    browser that used the apps before account separation existed adopts the first account it sees. The app frame is
    rendered only after the bridge answered: no bridge (20 s), no app (fail closed, "Try again").
  - Trust: app code shares the craft origin with the bridge and can reach it, so it could send `save` messages too
    (bounded by the per-file cap, the save rate and the quota, into the account's own Craft files). It cannot read the
    account's files: a file only goes into an app after the person picked it in Smart Knife's chooser, which runs on
    the app's origin where app code has no access. Every message from the port is checked (types, sizes, names).
- **The assistant inside an app** (`craft_*` tools; src/lib/agent-client/craft-live-tools.ts, src/lib/craft/live.ts, the
  bridge's `agent` message):
  - Which apps: those whose web build defines `window.<app>` (the desktop control channel as promises): VectorCraft
    0.17, FilmCraft 0.13 and EffectCraft 0.17 (the pins), checked 2026-10-25 in Firefox. The other ten have no browser
    API; their tab says so in page snapshots and offers no `craft_*` tool.
  - Relay: page -> bridge `{type:"agent", id, method, args}` -> `window.<app>[method](...)` -> `{type:"agent-result",
    id, ok, result|error}`. Allowlist: request, execute, commands, inspect, screenshot, files, readFile, info and
    `import` (whichever the app has: `importFiles(File[])`, `openFile(name, bytes)`, `addFile(File)`). Results go back
    as JSON (16 MB cap), `readFile` as a transferred ArrayBuffer (50 MB), 60 s per call.
  - Ready: apps define the object before they run and reject calls until then ("FilmCraft is not running yet";
    VectorCraft defines it only after start), so the page probes after each load of the app frame: `inspect()` must
    answer within 5 s. "Assistant ready" shows in the toolbar; no object after 60 s = no API; an object that keeps
    refusing gets 5 minutes (EffectCraft's first start).
  - Tools (page-only group `craft_live`, offered only while connected and per function the app has):
    `craft_guide` (how to work in the open app, below), `craft_commands {query?}` (compact entries, id/label matches
    first, parameter docs clipped at 300 characters, shrunk to fit) or `{command}` (one command with its whole parameter
    doc and the app's reason when it is disabled; a typo lists the closest ids), `craft_inspect {what:ui|elements}`,
    `craft_execute {command, params}`, `craft_request {method, params}` (ui.click, ui.key, ui.type, ui.set…),
    `craft_screenshot` (PNG into the assistant's file chain; VectorCraft needs `data:true`, sent on a second try),
    `craft_files`, `craft_export {path}` (an app file into the chain), `craft_import {files}` (chain files into the app).
    File data an app returns inline (`dataBase64` / `pngBase64` / `png` of 512+ characters, e.g. VectorCraft's
    `document.export` without a path, which the web build requires) is filed in the chain and replaced by `{file}`, so an
    export never lands in the model's context.
  - Guides (src/lib/craft/guides.ts, `craft_guide`; a one-line `brief` in the snapshot note; the whole guide in
    `knife_ui_call {tool:"list_tools"}` for outside agents): per app its units and coordinates, how to read the document
    (VectorCraft `document.inspect`, FilmCraft `project.inspect` / `sequence.inspect`, EffectCraft `comp.info` /
    `prop.get`), the commands for common jobs with parameters, batching (`command.batch` / `engine.batch`), exporting
    from the in-browser file table, and pitfalls. Written from the apps' own docs (docs/agents.md, mcp.md, web.md of each
    release) and every recipe run against the pinned web build (2026-10-25). A guide records the version it was checked
    against (`verified` = the pin, enforced by tests/craft_guides.test.mjs, which also checks every command id it names
    against `tests/fixtures/craft-commands/<app>-<version>.json`, the ids of `window.<app>.commands()`); an app the
    update channel moved past it gets a note to confirm commands with `craft_commands {command}`. When a pin moves:
    dump the new catalogue's ids into a new fixture, re-run the recipes (`tests/craft_e2e.py` runs one per app through
    the assistant), update the guide and its `verified`.
  - Trust: reads never ask; execute, request (except ui.inspect/ui.elements/ui.menu.list/engine.commands/perf.stats)
    and import act; an id or method naming delete/remove/clear/reset/revert/discard/close/quit/exit/purge/wipe/erase/
    overwrite (also inside `ui.menu.invoke {command}`) is destructive. Every app answer counts as third-party text for
    the conversation's taint (`PAGE_READS`): app code and the files it opens are not ours.
- **Updates** (src/lib/craft/updates.ts, admin drawer "Updates" in every tab, `GET`/`POST /api/craft/updates`):
  - Source: each app's GitHub releases, one `GET /repos/storytold/<app>/releases?per_page=20` per app per check with
    `If-None-Match` (13 requests; GitHub allows 60 unauthenticated an hour per address). A 403/429 stops the check and
    records `retryAfter` (from `x-ratelimit-reset`); no check runs before it.
  - What qualifies: not a draft or pre-release, tag `v<x.y.z>` above the active version, not in the app's `knownBad`
    (DeckCraft 0.8.0 and 0.9.0 panic at startup, storytold/deckcraft#959), exactly the asset `<app>-web-<version>.zip`
    at `https://github.com/storytold/<app>/releases/download/v<version>/…`, a `sha256:` digest from the API and at most
    256 MB. The download is checked against that digest and size while it streams.
  - Health gate before the switch (no browser on the server): an `index.html`, WebAssembly (`.wasm` or PhotoCraft's
    `app/parts.txt`), and no file the nginx rules cache as `immutable` that kept its name but changed its bytes since
    the previous release (browsers would keep the old one for a year; FilmCraft keeps its file names in every release,
    so nothing of it is immutable). A release that fails is deleted again and the error shown on the app's row.
  - Switch: the channel's `active` moves, the old one becomes `previous`, the content dir is relinked and pushed: no
    restart, no `sync`; open tabs get the new version on their next load (index.html revalidates).
  - Modes (admin): **Automatic** (default: daily check, apply every app that is not held), **Notify only** (daily check,
    an admin presses "Update to x"), **Off** (no scheduled check; "Check now" still works). "Roll back to x" returns to
    the previous release (still unpacked) and holds the app, so the next automatic check does not undo it; "Release
    hold" lets it move again. The pins in definitions.ts stay the floor for fresh installs: an active release older than
    the pin is ignored.
  - Schedule: `startCraftUpdater()` from `src/instrumentation.ts`: first look 10-40 min after the server starts, then
    hourly, acting only when the sidecar is installed, the mode is not off and the last check is ~a day old.
    `KNIFE_CRAFT_UPDATES=off` disables the timer entirely (the scratch e2e does). Every check, skip, download, switch,
    rollback and error goes to `$KNIFE_LOG_DIR/sidecars/craft/ops-<day>.log` (`[updates] …`).
  - Tests: `KNIFE_CRAFT_RELEASES_API` and `KNIFE_CRAFT_DOWNLOAD_BASE` point the updater at a fake GitHub
    (tests/craft_e2e.py; `http://` only on loopback).
- **Container**: `nginxinc/nginx-unprivileged:1.31.7-alpine@sha256:b5047b9b…` (pinned by digest), uid 101, port 8080,
  `read_only: true` + `tmpfs /tmp` (64 MB), `cap_drop: [ALL]` and nothing added, `pids_limit: 64`, `mem_limit: 256m`,
  `cpus: 1`, entrypoint `nginx`, command `-c /srv/craft/conf-<hash>/nginx.conf`, a compose healthcheck (`wget /healthz`)
  and the app's own probe (`GET /healthz` = `ok`). One bind mount: `services/craft/assets` read-only at `/srv/craft`. No
  volumes, no call back to the app (`callsBack: false`), egress `none` in `knife-docker-user`. Measured with all thirteen apps
  (2026-10-21): install with a cached image 53 s from the click to the first app drawn (download + verify + unpack of
  187 MB), stopped -> app loaded 7.6 s, 3.3 MiB RAM in the container after every app was loaded once (nginx only
  serves files; the apps' memory is the browser's), 626 MB on disk.
- **nginx.conf** (`renderNginxConf`, rewritten on every compose write): own `types` (`application/wasm`, `text/javascript`,
  `application/manifest+json`, `font/ttf`…), `gzip_static on` and no on-the-fly gzip, GET/HEAD only (405), dotfiles and
  unknown paths 404, `absolute_redirect off` (`/<app>` -> `/<app>/` stays relative behind a port mapping or the proxy), no
  cookies. Caching per README: hash-named files `public, max-age=31536000, immutable` (PhotoCraft's parts and boot module,
  the `-<16 hex>` glue/wasm of VectorCraft, DesignCraft, PdfCraft and the six later apps, VectorCraft's `fonts/<hash>/`, FilmCraft's `.wasm`/`.js`
  which index.html loads with `?v=<build hash>`), everything else `no-cache` (revalidate by ETag): LightCraft and
  EffectCraft keep their file names across releases, PhotoCraft's `app/photocraft-web.js` and `app/parts.txt` too. Every
  answer: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy:
  same-origin` (and `Cross-Origin-Opener-Policy: same-origin` when the craft origin is https: on http browsers ignore it
  and Chromium logs an error), a `Permissions-Policy`, and the CSP `default-src 'self'; script-src 'self'
  'unsafe-inline' 'wasm-unsafe-eval'` (the apps boot from inline modules; no `'unsafe-eval'` needed), `worker-src 'self'
  blob:`, `connect-src 'self' data: blob:`, `img-src`/`media-src` `'self' data: blob:`, `frame-src 'none'`,
  `object-src 'none'`, `base-uri 'none'`, `form-action 'none'` and `frame-ancestors` = the app's page origins
  (`appOrigins()`: KNIFE_PUBLIC_URL's origin, else `http://<host>:<KNIFE_PORT>` for KNIFE_HOST and KNIFE_ALLOWED_HOSTS).
  No COOP/COEP isolation: none of the builds uses `SharedArrayBuffer` (each README says so; SoundCraft plays through
  WebAudio without it).
- **Own origin, always.** The apps never run on the app's origin. Private mode: the sidecar's own port on KNIFE_HOST
  (`http://<tailscale-ip>:<port>`, a different origin). Public mode: `KNIFE_CRAFT_PUBLIC_URL=https://craft.<app host>`;
  the app proxies that host itself (`scripts/craft-proxy.mjs`, preloaded after the office proxy) and the sidecar moves to
  loopback. The reverse proxy only has to send that name to the app's port (no websockets). The proxy: GET/HEAD on
  `/<app>/…` only (no `..`, encoded dots/slashes, `//` or control characters; websockets 404); `GET /api/craft` hands the
  page each app's URL with `?knife_ticket=` (HMAC ticket naming the account, 12 h, key = HMAC of a fixed context under the
  sidecar's `TICKET_SECRET`, `src/lib/craft/launch.ts`); a valid ticket answers **303 to the same URL without it** and sets
  `knife_craft` (HttpOnly, SameSite=Strict, Secure on https) on the craft host, so the ticket never stays in the address
  bar, history or a Referer; every other request needs that cookie (403 otherwise). Only `accept*`, `cache-control`,
  `pragma`, `if-*` and `range` reach nginx (no cookies, credentials or forwarding headers); `Set-Cookie`/`Server` from
  nginx are dropped; HSTS on https. Budgets: 1200 requests/min and 32 at once per account, 60 refused/min per client
  prefix (then 429), 2 min idle. The abuse guard leaves the craft host to the proxy (as the office host). App and craft
  host must share a registrable domain (SameSite=Strict cookie). The app's CSP lists the craft origin in `frame-src`
  only (never script/connect): public mode only an https KNIFE_CRAFT_PUBLIC_URL on a public name, private mode that
  variable, else the state file.
- **Page** (`/tools/artcraft`, suite `artcraft`, one `wide` tab per app, component `craft-<app>` -> `src/tools/craft/CraftApp.tsx`):
  the compact sidecar card until it is installed (non-admins in public mode: "An administrator has to …"), then the
  lazy start (`ensure`, following the op), `GET /api/craft`, and the app in an iframe with **exactly** the README's
  sandbox (`allow-scripts allow-same-origin allow-downloads allow-popups`, LightCraft also `allow-modals`, FigCraft
  only `allow-scripts allow-same-origin allow-popups` (its web build has no files, so no downloads), SoundCraft only
  `allow-scripts allow-same-origin`; with `allow-same-origin` that is safe only because the frame is cross-origin) and
  the README's `allow` (`fullscreen; clipboard-read; clipboard-write`, SoundCraft also `autoplay` so the first click
  starts sound; no app asks for the microphone or camera: SoundCraft's web build has no recording, and the craft
  origin's Permissions-Policy turns both off anyway), `referrerpolicy=no-referrer`. `role=status` says "Loading <App>…" until the frame loaded, then
  "<App> loaded from <origin>." The tab is a workspace: one toolbar row (name and version, status, the save note,
  Force WebGL2, My files, Updates for admins, Full screen, Open in new tab), the app filling the window below it
  (`100dvh` minus the top bar). On desktop the page is a workspace from its first paint (registry `workspace`,
  `main[data-workspace]`): no tool heading or suite tabs (the sidebar lists the apps), and while the server is checked
  or started the same toolbar and an empty app area stand in, so the app takes their place without a jump. Credits
  live on `/credits`, linked from the toolbar. **Full
  screen** is in the page (ui.tsx `usePageFullscreen`): the workspace covers the top bar, sidebar and assistant, the
  app frame is not reloaded, and the file chooser and My files open over it; Exit full screen or Esc (when no drawer is
  open) comes back. Never the browser's Fullscreen API, which would show the iframe alone without Smart Knife's
  drawers. **Open in new tab** opens this page (`/tools/artcraft?tab=<app>&full=1`, `rel=noopener noreferrer`) full
  screen in a new tab, so Save and Open still reach the account; the bare app URL is never offered (without the bridge
  a save would only download). The wgpu apps get a "Force WebGL2" checkbox (`?webgl`). A heartbeat (`touch`, 60 s)
  keeps the idle stop away while a tab is open. Craft apps (like Workflows) carry the registry's `beta` flag.
- **Secure context.** WebGPU, the async clipboard and OPFS need https (or localhost). Over the plain-http Tailscale
  address the page says so: the wgpu apps fall back to WebGL2 by themselves (verified in Firefox: every app starts),
  LightCraft keeps its library in IndexedDB instead of OPFS and EffectCraft has no OPFS disk cache or service worker.
  Public mode over https gets WebGPU where the browser has it.
- **Known limits.** All thirteen are young (0.8-0.14) and the vendor calls the web builds experimental (LightCraft
  explicitly: browser storage can be cleared; back up the library from its File menu). Everything runs on the client:
  EffectCraft is a 63 MB wasm (17 MB with gzip) and VectorCraft 74 MB (27 MB), so the first open of a tab downloads tens
  of MB and needs a few hundred MB of browser memory; later opens revalidate (304) or hit the immutable cache. All
  thirteen share one origin, so they share its storage quota, localStorage and OPFS root. The names checked in these releases do
  not collide (EffectCraft: OPFS dir and IndexedDB `effectcraft*`; LightCraft: OPFS `library/`, `originals/`, `thumbs/`;
  only PdfCraft uses eframe's generic `egui_memory_ron` key), but the apps do not promise it; one origin per app would
  need a host name (or port) per app. FigCraft's web build starts with one new document and has no file system (its
  "Export page as PNG" gives no file even top-level), and its live sessions (ws:// to a desktop host) are blocked by the
  craft CSP's `connect-src 'self'`; SoundCraft opens its synthesised demo session (no recording, no files) and plays
  only after a click in the frame; DeckCraft starts with its sample deck and keeps no preferences; GridCraft's README documents no `?webgl` flag (the
  build reads one; the Force WebGL2 box is harmless if a release drops it). Firefox logs "Skipping unsupported feature name clipboard-read/-write" for the
  iframe's `allow` (harmless). Headless Firefox has no WebGL2; the e2e runs headed under Xvfb (llvmpipe).
- **Licences**: the apps are MIT OR Apache-2.0; each unpacked release keeps its `LICENSE-MIT`, `LICENSE-APACHE` and,
  where present, `NOTICE`, `ATTRIBUTION.md` (SoundCraft) and the OFL-1.1 texts of FigCraft's embedded fonts
  (`OFL-*.txt`) next to the app and serves them (`/<app>/LICENSE-MIT`…); nginx is BSD-2-Clause. docs/LEGAL.md
  "Third-party components".

## Hardening (container privileges)

Every sidecar container runs with `cap_drop: [ALL]`, only its definition's `security.capAdd` given back,
`security_opt: [no-new-privileges:true]` and `pids_limit` (`security.pidsLimit`, default 512; `src/lib/services/compose.ts`
`securityOptions`, malformed or `ALL` capability names refused). The sets were verified on real containers with every
other capability dropped (2026-10-18):

| Sidecar | `cap_add` | `pids_limit` | Why |
| --- | --- | --- | --- |
| `office` (Euro-Office 9.3.5) | CHOWN, DAC_OVERRIDE, FOWNER, KILL, SETGID, SETUID | 1024 (~150 tasks idle) | the entrypoint chowns/chmods its dirs as root; supervisord/gosu switch to ds, postgres, rabbitmq, redis, www-data; supervisord signals the ds processes on stop and restart (without KILL: `PermissionError`, then a hard kill). Port 80 binds without NET_BIND_SERVICE (docker sets `ip_unprivileged_port_start=0`); FSETID is not needed. Checked: start, `/healthcheck`, the font `prepare`, graceful stop, restart, and `tests/office_e2e.py` (editor load, both saves, every blank format, idle stop, lazy start). |
| `learn-db` (postgis 16-3.4) | CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID | 256 | initdb on a fresh volume, chmod of the data and socket dirs, gosu to postgres. FOWNER without DAC_OVERRIDE fails (root cannot enter the 0700 data dir it no longer owns). Checked: fresh volume, restart on an existing one, `tests/learn_db_e2e.py`. |
| `craft` (nginx-unprivileged 1.31.7-alpine) | none | 64 | runs as uid 101 on port 8080 and writes only its tmpfs `/tmp` (pid, temp paths) under a read-only root. Checked: start, health, every app served and loaded, stop, lazy start, `tests/craft_e2e.py`. |

The compose hash covers these keys, so an existing install is recreated with them at its next start or `ensure` (when no
editor session is open). An image bump or a new sidecar repeats the check: drop one capability at a time and look for
`Operation not permitted` / `Permission denied` in `docker logs`, a container that exits, or a service missing from `ps`.

## Adding a sidecar

1. Add a `SIDECARS` entry (pin the image by tag or digest; check the registry, not a blog post). Static web apps: `sites`
   (pinned zips, sites.ts) + `container` (read-only root, tmpfs) instead of an image that bundles them. Pick `health` (`http` or
   `postgres`; add a kind to `probeHealth` for another protocol) and `callsBack`. State `security.capAdd` (see
   "Hardening": verified, minimal) and `pidsLimit`.
2. Build the tool; put `sidecar: "<id>"` on its registry entry and show `SidecarCard compact` until it is installed.
3. Anything the container calls back into must authenticate without the Origin guard: give it a signed token, document the
   exception here and in docs/ARCHITECTURE.md.
4. Extend `tests/services.test.mjs` (rendering) and add a real-docker e2e like `tests/office_e2e.py`.

## Tests

- Unit: `tests/services.test.mjs` (compose, secrets, state/lock, pull progress, ps parsing, URLs, JWT, templates/text, store,
  editor config, callback incl. SSRF and stale keys, office hardening: filter env, allow list, caps; learn-db on loopback;
  container hardening: cap_drop ALL + the verified cap_add per sidecar, no-new-privileges, pids_limit, refused cap names).
- Unit: `tests/craft_live.test.mjs` (the bridge's agent relay against a fake app window, readiness, bytes both ways;
  the craft_* tools' availability, trust verdicts, command listing, screenshot/export/import through the file chain).
- Unit: `tests/office_live.test.mjs` (protocol + argument checks, the browser bridge against a fake plugin frame, the
  real `bridge.js` in a sandbox with a fake editor `Api`, trust verdicts, tool visibility, asset sync + mount, editor
  config options).
- Real docker, live editing: `python3 tests/office_live_e2e.py` — install (plugin mounted and listed), a python-docx
  document: every word command checked in the editor (reads, Ctrl+A selection, Ctrl+Z undo) and in the force-saved file
  (python-docx: text, order, heading styles, comment); xlsx and pptx commands checked in the saved XML; the assistant with
  the mock provider (snapshot, read, insert, save, trust modes on delete/replace/insert, tools gone without an editor);
  a changed plugin served without a restart; an old container (no mount) recreated by `ensure`. ~6 min with a cached
  image; screenshots in `.tmp/office-live-e2e/`.
- Real docker: `python3 tests/learn_db_e2e.py` — the course database installed from the course page, seeded, every
  lesson checked, sandbox probes, lazy start, purge (docs/LEARN.md). ~1.5 min with a cached image.
- Unit: `tests/craft.test.mjs` (ArtCraft pins, sandboxes and `allow` lists, compose rendering, nginx.conf + caching rules against the
  real file names, download/verify/unpack/prune against a fake fetch incl. tampered and malformed zips, launch URLs and
  tickets, the craft proxy against a fake nginx, the app CSP's frame-src).
- Real docker + real releases: `python3 tests/craft_e2e.py --host <tailscale-ip>` — install from the ArtCraft page in
  Firefox (headed under `xvfb-run`, which the suite starts itself), container hardening, the craft origin's headers, all
  thirteen apps load in their tab (exact sandbox and `allow`, canvas drawn, no CSP/MIME/sandbox console message),
  PhotoCraft opens a PNG through the file input and Quick-Exports it (same pixels), PdfCraft opens a PDF and saves it
  (2 pages, text kept), WordCraft opens a .docx, gets a typed paragraph and saves it (all three paragraphs in the
  download), GridCraft opens a CSV, gets a formula and exports CSV (rows kept, value computed), unpacked size and
  container memory after all thirteen (metrics), in-page full screen (same frame, My files over it, Esc order), "Open
  in new tab" (this page full screen, My files reachable), stop -> lazy start, remove + purge. ~5 min with a
  cached image (downloads ~187 MB of zips); screenshots in `.tmp/craft-e2e/`. Last run 2026-10-21: 70/70.
- Unit: `tests/office_library.test.mjs` (storage scope, quota, folders, trash, versions, callback room-making,
  `knife_doc_*` isolation, retention).
- Real docker: `python3 tests/office_files_e2e.py --host <tailscale-ip>` — public mode, admin + two users: every office
  route and `knife_doc_*` tool (agent route + MCP) isolated between accounts, quota 507 in the API and the browser, the
  file browser in Chromium and Firefox (folders, upload, rename, move, duplicate, search, sort, download, trash + Undo,
  restore, delete forever, not-installed editor state), then the sidecar: edit + Ctrl+S = a version, preview/download/
  restore it, Firefox editor. `--skip-docker` for the browser part only. ~9 min with a cached image.
- Unit: `tests/office_proxy.test.mjs` (allow-list, tickets from `src/lib/office/proxy.ts` verified by the proxy, forged/
  expired tickets, cookie gate, header hygiene, websocket pass-through, budgets, sidecar down) against a fake sidecar.
- Real docker: `python3 tests/office_proxy_e2e.py --host <tailscale-ip>` — the editor through the proxy: app and office
  host as two names of one site (Chromium `--host-resolver-rules`), sidecar on loopback only, every service/admin path
  refused, ticket -> cookie, docx typed + Ctrl+S + close saves, xlsx/pptx open, the proxy refused nothing the editor
  asked for. ~3 min with a cached image.
- Real docker: `python3 tests/office_e2e.py` — scratch worktree server on the Tailscale address (own data dir, port and
  compose project), install via the API, Playwright typing into a docx, Ctrl+S save (status 6), close save (status 2),
  every blank format opens, knife_doc tools, stop → lazy start, idle stop, CLI status, purge. `--keep` leaves it running,
  `--hold` waits for Enter before cleaning up, `--remove-image` also drops the 4.4 GB image. Needs docker and ~2 GB free RAM; ~5 min with a cached image.
