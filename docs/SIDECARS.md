# Sidecars — optional docker services

Some tools need a real server program that cannot run in the browser or the Python lane (the first one: an office
document editor). Those programs run as **sidecars**: docker compose services the app installs, starts, stops, updates and
removes itself, from the web UI (launcher category **Sidecars** → *Sidecar services*) or the CLI. Nothing is installed until
the owner presses Install.

## Pieces

| Where | What |
| --- | --- |
| `src/lib/services/definitions.ts` | `SIDECARS`: id, pinned image, container port, health path, generated secrets, env, named volumes, start timeout, idle stop default, `usedBy` slugs. Metadata only. |
| `src/lib/services/compose.ts` | Pure `renderCompose(def, {bindHost, hostPort})` → compose.yaml. Port published on **one** address (KNIFE_HOST); wildcard refused. Secrets via `env_file: secrets.env`, never inline. `restart: "no"` (the app owns the lifecycle). Labels `dev.samurai-knife.*`. |
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

## Lifecycle

- **Install** (`POST /api/services/<id> {action:"install"}` → 202 `{op}`): runtime check → pick a free port near KNIFE_PORT
  on KNIFE_HOST (stored; reused on reinstall) → generate secrets once → write compose → `compose --progress json pull` (the
  JSON events are folded into one percentage and byte count) → `up -d` → wait for the health URL → check from **inside** the
  container that the app is reachable (`GET /api/services/ping`); a failure there is a warning in the op log and status.
- **Prepare**: an optional per-definition command run with `compose exec` once per new container id, after the first
  health pass and before the op reports done (office: the font cache).
- **Start/Stop/Update**: `up -d` + health wait / `compose stop` / pull + recreate (reports whether the image changed).
- **Remove**: `compose down` keeps the named volumes and `secrets.env`; `purge` adds `--volumes` and deletes the state dir;
  `removeImage` adds `--rmi all`.
- **Lazy start**: a tool calls `{action:"ensure"}`: `{ready:true}` when healthy, else it starts (or joins the running start
  op) and returns 202 `{op}`; the tool polls and retries.
- **Idle stop**: the server checks once a minute; a running sidecar with no open editing sessions and no use for
  `idleStopMinutes` (default 30, 0 = never, configurable per sidecar) is stopped. Use = editor heartbeat (`touch`, every
  60 s while a document is open), callbacks, starts.
- **Locking**: one op per service at a time, across the server and the CLI (`op.lock` with pid; a dead pid is stale).
- Ops are in memory: a server restart forgets the op record (the container keeps running; status is read live).

## Addresses (the part that bites)

Two URLs per sidecar, both shown and editable in its Settings:

- **Public URL** (browser → sidecar): default `http://<KNIFE_HOST>:<port>`. The editor's scripts and websocket load from it.
- **App URL** (container → app): default `http://<KNIFE_HOST>:<KNIFE_PORT>`. A container reaches the host's Tailscale/LAN
  address fine, but **not the host's loopback**. With `KNIFE_HOST=127.0.0.1` the derived URL is
  `http://host.docker.internal:<port>` (the compose file maps it with `host-gateway`) and the status carries a warning,
  because the app does not listen on the docker bridge. Fix: bind the app to the Tailscale/LAN address (the live setup),
  or set the app URL / `KNIFE_SIDECAR_APP_URL` to an address the container can reach.

## Office (`office`, slug `office`)

- **Image**: `ghcr.io/euro-office/documentserver:v9.3.5` — Euro-Office Document Server, the AGPL-3.0 fork of the ONLYOFFICE
  Document Server (https://github.com/Euro-Office/DocumentServer, docs https://euro-office.github.io/documentation/). On
  2026-10-13 `latest` and `v9.3.5` had the same digest in the ghcr.io registry. The docs show `:9.3.1`; the published
  release tags carry a `v`. Env: `JWT_ENABLED=true`, `JWT_SECRET` (generated, 64 hex), `ALLOW_PRIVATE_IP_ADDRESS=true`
  (the app is on a private address), example/admin panel/WOPI off, `GENERATE_FONTS=false`. The font cache lives in the
  container filesystem (not a volume) and the editor never finishes loading without it, although `/healthcheck` answers
  `true`; so the definition's `prepare` step runs `documentserver-generate-allfonts.sh` once per new container (recorded as
  `preparedContainer` in state.json). Measured: new container 53 s to ready, stopped -> ready 11.7 s (was 45 s when every
  start regenerated the cache), RAM ~1.1-1.5 GiB. Volumes: `/var/lib/euro-office/documentserver`,
  `/var/www/euro-office/Data`.
- **Library**: `$KNIFE_DATA_DIR/docs/<account>/<docId>/` (`meta.json`, `current.<fmt>`, `history/` = last 5 versions).
  Blank docx/xlsx/pptx/odt/ods/odp are generated in TS (`src/lib/office/templates.ts`, minimal ZIP writer on `node:zlib`).
  Upload is JSON base64 (≤ 50 MB). Create/upload/download/delete work without the sidecar; only editing needs it.
- **Editor**: `GET /api/office/docs/<id>/editor` returns the DocsAPI script URL and a config signed server-side with the
  sidecar's JWT secret (the browser never sees the secret). The page loads `api.js` from the public URL and mounts
  `DocsAPI.DocEditor` (an iframe). `forcesave: true`: Ctrl+S / the Save button saves at once.
- **Document Server → app**: `GET /api/office/ds/file?t=…` and `POST /api/office/ds/callback?t=…`. **These two are the only
  routes without the Origin/Host guard** (the container sends no Origin and its Host may be `host.docker.internal`). They
  authenticate with JWT twice: the `t` capability token (account + document + purpose, 24 h / 30 d) and the server's own
  `Authorization: Bearer` token (or `token` in the callback body); the status fields are read from the signed token only.
- **Closing**: the editor batches a single user's changes for ~2 s before sending them (autosave gap), and destroying it
  drops what is unsent. "Close editor" therefore waits for `onDocumentStateChange(false)` ("all changes sent", max 15 s)
  before destroying it; leaving the page another way (navigation) does not wait.
- **Save rules**: status 2 (all editors closed) → save + new `key`; 6 (force-save) → save, same key (the session goes on);
  4 (closed, no changes) → new key; 1 → session open/closed bookkeeping; 3/7 → logged, nothing saved. The save URL must be
  on the sidecar's own origin (no SSRF). A callback for an outdated key saves "<name> (edited copy)" instead of overwriting.
  If the server returns another format (`filetype`), the document takes that format.
- **Assistant**: the editor iframe is cross-origin, so UI tools cannot click or type in it. The `docs` tool group
  (`knife_doc_list`, `knife_doc_read`, `knife_doc_create`) works on the SAVED library server-side (widget and MCP); the
  document OPEN in the editor is read and edited live through the editor plugin below (`doc_live_*`). Both groups are
  preloaded on `/tools/office`.
- **Force-save**: `POST /api/office/docs/<id> {action:"forcesave"}` asks the Document Server's command service
  (`/coauthoring/CommandService.ashx`, `c: "forcesave"`, JWT in the body and the `Authorization` header) to save the open
  session now; the new version arrives through the callback (status 6) a second or two later. Answers `saving`,
  `unchanged` (error 4: nothing sent since the last save; right after an edit it just means the editor has not sent it
  yet, so callers retry for a few seconds) or `not_open` (error 1).

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
  outside Samurai Knife never connects (no options).

## Adding a sidecar

1. Add a `SIDECARS` entry (pin the image by tag; check the registry, not a blog post).
2. Build the tool; put `sidecar: "<id>"` on its registry entry and show `SidecarCard compact` until it is installed.
3. Anything the container calls back into must authenticate without the Origin guard: give it a signed token, document the
   exception here and in docs/ARCHITECTURE.md.
4. Extend `tests/services.test.mjs` (rendering) and add a real-docker e2e like `tests/office_e2e.py`.

## Tests

- Unit: `tests/services.test.mjs` (compose, secrets, state/lock, pull progress, ps parsing, URLs, JWT, templates/text, store,
  editor config, callback incl. SSRF and stale keys).
- Unit: `tests/office_live.test.mjs` (protocol + argument checks, the browser bridge against a fake plugin frame, the
  real `bridge.js` in a sandbox with a fake editor `Api`, trust verdicts, tool visibility, asset sync + mount, editor
  config options).
- Real docker, live editing: `python3 tests/office_live_e2e.py` — install (plugin mounted and listed), a python-docx
  document: every word command checked in the editor (reads, Ctrl+A selection, Ctrl+Z undo) and in the force-saved file
  (python-docx: text, order, heading styles, comment); xlsx and pptx commands checked in the saved XML; the assistant with
  the mock provider (snapshot, read, insert, save, trust modes on delete/replace/insert, tools gone without an editor);
  a changed plugin served without a restart; an old container (no mount) recreated by `ensure`. ~6 min with a cached
  image; screenshots in `.tmp/office-live-e2e/`.
- Real docker: `python3 tests/office_e2e.py` — scratch worktree server on the Tailscale address (own data dir, port and
  compose project), install via the API, Playwright typing into a docx, Ctrl+S save (status 6), close save (status 2),
  every blank format opens, knife_doc tools, stop → lazy start, idle stop, CLI status, purge. `--keep` leaves it running,
  `--hold` waits for Enter before cleaning up, `--remove-image` also drops the 4.4 GB image. Needs docker and ~2 GB free RAM; ~5 min with a cached image.
