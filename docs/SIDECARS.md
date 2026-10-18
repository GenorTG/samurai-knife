# Sidecars — optional docker services

Some tools need a real server program that cannot run in the browser or the Python lane (an office document editor, the
Database course's PostgreSQL). Those programs run as **sidecars**: docker compose services the app installs, starts, stops, updates and
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
| `src/tools/sidecars/` | `SidecarCard` (status + controls + progress), `SidecarsTool` (settings page), `OfficeTool`. |

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
  an admin, a public install that users rely on wants `idleStopMinutes: 0` (configure).
- **Environment**: docker/podman run with an allow-listed environment (`src/lib/child-env.ts`: PATH, HOME, locale,
  `DOCKER_*`, `XDG_RUNTIME_DIR`, …), never the app's own secrets.
- **Idle stop**: the server checks once a minute; a running sidecar with no open editing sessions and no use for
  `idleStopMinutes` (default 30, 0 = never, configurable per sidecar) is stopped. Use = editor heartbeat (`touch`, every
  60 s while a document is open), callbacks, starts.
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
  `KNIFE_OFFICE_PUBLIC_URL` (the app proxies the editor, above) replaces it and publishes the sidecar on loopback.
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
  a paragraph or the selection); cell `get_text`/`get_structure`/`get_selection`, `cells_read` (values + formulas, max 2000
  cells), `cells_write` (block from a top-left cell, formulas as `=...`; refuses non-empty cells unless `overwrite`),
  `add_sheet`; slide `get_text`/`get_structure`, `add_slide` (title + body shapes, theme text colour). Each runs through
  `Asc.plugin.callCommand` with `Asc.scope` for the arguments, wrapped in try/catch so an exception comes back as an
  error, one at a time (the runtime has a single callback slot), 20 s timeout; edits recalculate, reads do not; a
  read-only editor refuses edits. Saving is NOT a plugin command (`Api.Save()` from a plugin does not reach the save path
  in 9.3.5): `doc_live_save` uses the force-save above.
- **Assistant tools** (`src/lib/agent-client/office-live-tools.ts`, group `office_live`, page-only: not offered by
  `load_tools`): `doc_live_read {what: text|structure|selection}`, `doc_live_insert_text`, `doc_live_insert_paragraphs`,
  `doc_live_replace`, `doc_live_set_style`, `doc_live_delete`, `doc_live_comment`, `doc_live_cells_read`,
  `doc_live_cells_write`, `doc_live_add_sheet`, `doc_live_add_slide`, `doc_live_save`. A tool is sent to the model only
  while the plugin is connected AND the editor type fits (word / cell / slide), so a page without an editor costs no
  tokens; a stray call explains how to connect. Trust: reads never ask; edits are acting calls (asked in All/Most);
  `doc_live_delete`, `doc_live_replace` (replaces every match) and `doc_live_cells_write {overwrite:true}` are destructive
  (asked in every mode except None, one by one). The user can undo any edit with Ctrl+Z in the editor (verified).
  `page_snapshot` carries `liveDocument {document, state, editor, read_only}` and a note; the office page shows
  "Assistant live editing: connected (word editor)." (`data-agent-region="office-live-status"`). Debug handle:
  `window.knifeOfficeLive` (the active bridge; `.state`, `.call(cmd, args)`).
- **MCP**: not offered. The editor session lives in the user's browser tab; an MCP client has no page to reach it
  through, and a server relay would add exactly the unauthenticated-ish command path this design avoids. MCP keeps
  `knife_doc_*` for the saved files.
- **Limits**: indices are element indices (a table counts as one element; table cells are not addressable); styles must
  exist in the document (`GetStyle` falls back to the default style for an unknown name, so the plugin compares the
  name and lists the known ones); `replace_text` is plain text, whole document; no tracked-changes mode; slides are
  added as plain text boxes, not layout placeholders; one live editor per page (the active bridge); an editor opened
  outside Smart Knife never connects (no options).

## Hardening (container privileges)

Every sidecar container runs with `cap_drop: [ALL]`, only its definition's `security.capAdd` given back,
`security_opt: [no-new-privileges:true]` and `pids_limit` (`security.pidsLimit`, default 512; `src/lib/services/compose.ts`
`securityOptions`, malformed or `ALL` capability names refused). The sets were verified on real containers with every
other capability dropped (2026-10-18):

| Sidecar | `cap_add` | `pids_limit` | Why |
| --- | --- | --- | --- |
| `office` (Euro-Office 9.3.5) | CHOWN, DAC_OVERRIDE, FOWNER, KILL, SETGID, SETUID | 1024 (~150 tasks idle) | the entrypoint chowns/chmods its dirs as root; supervisord/gosu switch to ds, postgres, rabbitmq, redis, www-data; supervisord signals the ds processes on stop and restart (without KILL: `PermissionError`, then a hard kill). Port 80 binds without NET_BIND_SERVICE (docker sets `ip_unprivileged_port_start=0`); FSETID is not needed. Checked: start, `/healthcheck`, the font `prepare`, graceful stop, restart, and `tests/office_e2e.py` (editor load, both saves, every blank format, idle stop, lazy start). |
| `learn-db` (postgis 16-3.4) | CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID | 256 | initdb on a fresh volume, chmod of the data and socket dirs, gosu to postgres. FOWNER without DAC_OVERRIDE fails (root cannot enter the 0700 data dir it no longer owns). Checked: fresh volume, restart on an existing one, `tests/learn_db_e2e.py`. |

The compose hash covers these keys, so an existing install is recreated with them at its next start or `ensure` (when no
editor session is open). An image bump or a new sidecar repeats the check: drop one capability at a time and look for
`Operation not permitted` / `Permission denied` in `docker logs`, a container that exits, or a service missing from `ps`.

## Adding a sidecar

1. Add a `SIDECARS` entry (pin the image by tag; check the registry, not a blog post). Pick `health` (`http` or
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
