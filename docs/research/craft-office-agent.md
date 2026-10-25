# The assistant inside the Craft apps and the office editor (research, 2026-10-25)

Question: can the in-page assistant, and outside agents over MCP, work inside the embedded apps: the 13 Craft apps
(ArtCraft web builds in iframes on the craft origin) and the Euro-Office editor? Through what they expose, or through
bridges we build. Updates the 2026-10-22 note (branch feat/workflows, docs/research/craft-agent.md).

Sources: each app's latest GitHub release and its `docs/web.md`, `docs/control-protocol.md`, `docs/mcp.md`; the release
trees (`gh api repos/storytold/<app>/git/trees/<tag>`); this repo's `sidecars/craft/knife-bridge/bridge.js`,
`src/lib/agent-client/office-live-tools.ts`, `src/lib/office/live-protocol.ts`, `src/lib/mcp/tools-ui.ts`.

## Craft apps: what each exposes in the browser

All 13 draw their UI with egui on one `<canvas>`: no DOM for the assistant's page tools. Every app has one command engine
(hundreds of commands, the same ids on desktop, CLI and MCP). On the desktop that engine is reachable over a control
channel and an MCP server; in the browser only where the web build defines `window.<app>`.

| App | Pinned (definitions.ts) | Latest release | Browser API in the latest release |
|---|---|---|---|
| PhotoCraft | 0.11.1 (live auto-updated to 0.14.0) | 0.15.1 | none (desktop MCP only) |
| VectorCraft | 0.14.0 | 0.16.0 | **`window.vectorcraft`** (`apps/vectorcraft-web/src/api.rs`, documented 2026-10-18) |
| FilmCraft | 0.10.0 | 0.13.0 | **`window.filmcraft`** (`apps/filmcraft-web/src/api.rs`, docs/web.md) |
| LightCraft | 0.10.0 | 0.14.0 | none |
| EffectCraft | 0.13.0 | 0.16.0 | **`window.effectcraft`** (`apps/effectcraft-web/src/api.rs`) |
| DesignCraft | 0.10.0 | 0.13.0 | none |
| PdfCraft | 0.10.1 | 0.14.0 | none |
| FigCraft | 0.8.0 | 0.10.0 | none |
| WordCraft | 0.9.0 | 0.11.0 | none |
| SoundCraft | 0.10.0 | 0.13.1 | none |
| DeckCraft | 0.7.0 | 0.11.1 | none |
| CADCraft | 0.10.0 | 0.13.0 | none |
| GridCraft | 0.9.0 | 0.12.1 | none |

The three APIs share one shape (verified in FilmCraft's docs/web.md and VectorCraft's control-protocol.md):
`request(method, params)` (any control method: `ui.inspect`, `ui.click`, `ui.key`, `ui.menu.invoke`…),
`execute(command, params)` (`engine.execute`), `commands()`, `inspect()`, `screenshot()` → `{pngBase64, width, height}`,
plus app-specific file calls (FilmCraft: `importFiles`, `importUrl`, `openProject`, `files`, `readFile`, `info`).

## Office editor: what works today, what is missing

Already built (VERIFIED in this repo): an editor plugin (`knife-bridge-<sha>`, sdkjs plugin API) and 12 browser-side
tools, offered only while a document is open and the plugin is connected:

- all editors: `doc_live_read` (text / structure / selection, unsaved edits included), `doc_live_save`;
- documents: `doc_live_insert_text`, `doc_live_insert_paragraphs`, `doc_live_replace`, `doc_live_set_style`,
  `doc_live_delete`, `doc_live_comment`;
- spreadsheets: `doc_live_cells_read`, `doc_live_cells_write`, `doc_live_add_sheet`;
- presentations: `doc_live_add_slide`.

Gaps the plugin API can close (ONLYOFFICE Document Builder API through `Asc.plugin.callCommand`, which Euro-Office
inherits; ASSUMED to work the same in Euro-Office 9.3.5, to be checked against the pinned image):

- documents: character formatting (bold, italic, colour, size), lists, tables, images from the assistant's files,
  headers and footers, track changes on/off;
- spreadsheets: formulas (cells_write can already take `=…`; a read of formula vs value is missing), number formats,
  column widths, sorting and filters, charts (`ApiWorksheet.AddChart`);
- presentations: text on slides, layouts, shapes and images, speaker notes (only adding a slide exists today);
- PDF editor: forms and annotations are thin in the plugin API; leave for later.

## Design

### 1. Craft tools in the page (small, works now for 3 apps)

The bridge frame already runs on the craft origin next to the app window and finds it through `parent.frames`
(bridge.js `attach`). Add one relay message, so neither the origin split nor the iframe sandbox changes:

- page → bridge (MessagePort): `{type:"agent", id, method, params}`; bridge → app window: `window[APP].request(...)`
  (or `execute`, `commands`, `screenshot`); bridge → page: `{type:"agent-result", id, ok, result|error}` (size-capped).
- Browser-side tool group `craft_*`, offered only while a Craft app is open AND `typeof window[APP]?.request ===
  "function"` (checked by the bridge, reported in `hello`), like `doc_live_*`:
  `craft_commands {query?}` (filter the command list), `craft_inspect` (the UI tree), `craft_execute {command, params}`,
  `craft_screenshot` (the canvas as an image the model sees), `craft_import {file}` (a file from the assistant's file
  chain), `craft_export` (a saved file into the chain).
- Trust: `craft_inspect`/`commands`/`screenshot` read; `craft_execute` acts (asks in All/Most); commands whose id says
  delete/clear/close/revert ask in every mode but None, one by one. Results and screenshots are third-party content
  (prompt-injection surface): they set the conversation's `untrusted` flag like page text.
- Prerequisite: update the pinned releases (VectorCraft 0.16, FilmCraft 0.13, EffectCraft 0.16 at least).
- Effort: about 2 days (bridge relay, tool group, trust rules, e2e with a stub app on the craft origin + one real app).

### 2. The other ten Craft apps

They have no browser API yet. Options, best first:
1. Ask upstream (open an issue/PR per app): the API is a thin `api.rs` over the control channel every app already has;
   three apps show the pattern. Zero maintenance on our side once released.
2. Build the web bundles ourselves with that `api.rs` added (Rust, wasm-bindgen, their build scripts): works now, but we
   then own 10 builds, their hashes and updates. Only worth it for one or two apps you use a lot.
3. Screenshot + click by coordinates: brittle and slow; not recommended.

### 3. More office tools (medium)

Extend the plugin's command set and `LIVE_TOOL_DEFS` with the gaps above, per editor type, each with an e2e on a real
document (the office e2e already drives the editor). About 2–3 days for formatting + tables + slide text + charts.

### 4. Outside agents (MCP) driving an open app

Today MCP can show a page (`knife_ui_show`) and read where the user is (`knife_ui_state`) through the UI bridge (tabs
poll `/api/ui/poll`). Add `knife_ui_call {tool, args}`: the server queues a call for the user's visible tab, the tab
runs the browser-side tool (`doc_live_*` or `craft_*`) under the SAME trust mode and approval cards as the in-page
assistant, and posts the result back; the MCP call waits (bounded, about 60 s) or answers "no open tab / not
connected". Never runs without a visible tab, never bypasses an approval, results marked untrusted. About 2 days.

## Recommended order

1. Pin the newer Craft releases (needed anyway; check the sandbox/allow notes per app).
2. Craft relay + `craft_*` tools (VectorCraft, FilmCraft, EffectCraft).
3. Office tool gaps (formatting, tables, slide text, charts).
4. `knife_ui_call` for outside agents.
5. Upstream issues for the other ten apps; self-built bundles only for an app you really need now.

## Done: Craft (2026-10-25)

Built as designed in "1. Craft tools in the page" (docs/SIDECARS.md "The assistant inside an app"), with what the real
builds showed when loaded in Firefox:

- Pins raised to VectorCraft 0.17.0, FilmCraft 0.13.0, EffectCraft 0.17.0 (digests checked against the API and a local
  `sha256sum`).
- VectorCraft defines `window.vectorcraft` only after it starts; FilmCraft and EffectCraft define theirs at once and
  reject every call ("… is not running yet") until the app runs. Readiness is therefore "inspect() answers", not "the
  object exists".
- VectorCraft returns the screenshot inline only with `{data: true}`; it has no `ui.elements` (FilmCraft does) and
  imports through `openFile(name, bytes)`, EffectCraft through `addFile(File)`, FilmCraft through `importFiles(File[])`.
  `files()` is synchronous in VectorCraft and FilmCraft.
- `commands()` returns arrays of `{id, label, menu, params, enabled, shortcut}` (VectorCraft 1148, FilmCraft 710).
- EffectCraft 0.17 does not finish `start()` without a GPU (xvfb + llvmpipe); with one it is expected to connect.

## Done: office (2026-10-25)

"3. More office tools" built and checked in the real editor (tests/office_live_e2e.py): documents get character
formatting, tables, bulleted/numbered lists, header and footer, track changes; spreadsheets get cell formats (number
formats, fills, alignment), column widths, sorting and charts (formulas already worked through `cells_write`);
presentations get slide text by shape, speaker notes and deleting a slide. Not yet: images, layouts/placeholders,
PDF forms. "4. Outside agents (MCP) driving an open app" (`knife_ui_call`) is still open.
