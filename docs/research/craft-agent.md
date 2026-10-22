# Can the assistant operate the Craft apps? (research, 2026-10-22)

Question: can Smart Knife's assistant (and workflows) work inside the ArtCraft apps the `craft` sidecar serves?
Sources: the apps' READMEs, `docs/control-protocol.md` and `docs/web.md` on GitHub (storytold/*, main branch), and the
JavaScript of the pinned web builds (PhotoCraft 0.11.1, FilmCraft 0.10.0, EffectCraft 0.13.0, WordCraft 0.9.0,
GridCraft 0.9.0; read, not run).

## Findings

- **No DOM to drive.** Each app's UI is egui drawn on a canvas. The assistant's page tools (snapshot, click, fill) see
  one `<canvas>`; clicking by screen coordinates from screenshots would be brittle and slow.
- **One command engine per app.** Every menu item, tool and dialog runs a command from one registry (PhotoCraft: 500+
  commands). The desktop app exposes it over an authenticated loopback JSON control channel (`--control <port>`,
  token file), a headless CLI (`<app>-cli run … --cmd <id> --params <json>`, `batch`) and an MCP server
  (`<app>-cli mcp`, headless or bridged to the running app). Methods: `engine.execute {command, params}`,
  `engine.commands`, `ui.inspect`, `ui.menu.invoke`, `ui.set`, `ui.pointer`, `ui.key`, `ui.screenshot`, …
- **Web builds: an "agent / test API" on `window.<app>`, app by app.**
  - EffectCraft 0.13.0 (the version we serve) ships `window.effectcraft`: `request(method, params)`, `execute(command,
    params)`, `commands()`, `inspect()`, `screenshot()`, `renderFrame()`, `files()`, `readFile(path)`, `addFile()`
    (the desktop control channel as promises, its page says).
  - FilmCraft documents `window.filmcraft` (execute, request, commands, inspect, screenshot, importFiles, openProject,
    files, readFile, info) on its main branch; the released 0.10.0 does not have it yet.
  - LightCraft's docs say the control channel and MCP are desktop-only. PhotoCraft, VectorCraft, DesignCraft, PdfCraft,
    FigCraft, WordCraft, SoundCraft, DeckCraft, CADCraft and GridCraft have no web API in their released builds.
- **We already have a way in.** The Craft files bridge (`sidecars/craft/knife-bridge/bridge.js`) runs inside each app's
  window on the craft origin and talks to the Smart Knife page over a MessagePort, so it can call `window.<app>` and
  relay results without loosening the iframe sandbox or the origin split.

## What this allows

1. **Assistant inside an open Craft app** (browser-side tools, like the office editor's `doc_live_*`): `craft_inspect`,
  `craft_commands {query}`, `craft_execute {command, params}`, `craft_screenshot` (the model sees the canvas),
  `craft_export` (a rendered or saved file into the assistant's file chain, `new_files`), `craft_import` (a file from the
  chain into the app). Offered only while an app with the API is open; detected at run time (`typeof
  window[app]?.request === "function"`), so FilmCraft and others light up when their releases ship it. Trust modes gate
  `craft_execute` like other acting tools. Works today for EffectCraft.
2. **Craft in workflows** (server side): a sidecar with the apps' Linux CLIs (`photocraft-cli run/batch`, …), no
  network, files in and out through a scratch directory, would give workflows a "Craft" node: open a PSD, apply
  commands, export, all headless. Needs a new sidecar definition (the current `craft` sidecar is a static,
  capability-free nginx and should stay one).

## Recommendation

Start with 1 (small: bridge relay + a browser tool group, feature-detected; useful at once in EffectCraft, then FilmCraft),
then 2 when there is a workflow use case for headless image or video edits.
