# Samurai Knife over MCP (agents outside the app)

The app has two agent surfaces that share one tool set:

1. **Built-in assistant** (the chat widget): uses the account's own provider/key, drives the page directly (open_tool,
   fill_field, click…) plus the `knife_*` tools.
2. **MCP** (`POST /api/mcp`, Streamable HTTP, stateless): any MCP client (OpenClaw, Claude Code, Cursor…) gets the same
   deterministic `knife_*` tools (CV studio, SQL/NoSQL, office documents, the Database course tutor, base tools) plus two MCP-only UI tools. The
   client brings its own model; the app needs no key for this.

Both can be used at the same time; edits are atomic per call and every CV save is undoable.

## Connecting
- URL: `http://<KNIFE_HOST>:<KNIFE_PORT>/api/mcp`, transport `streamable-http`.
- Auth: the Tailscale bind is the boundary (no token); the route checks Host (and Origin when a browser sends one).
  Account-scoped tools act on the **default account**.
- OpenClaw: `openclaw mcp add samurai-knife --url http://<KNIFE_HOST>:3210/api/mcp --transport streamable-http`, then
  `openclaw mcp doctor samurai-knife --probe`.

## Live view of the user's screen
- Data: the open pages refresh by themselves. CV studio polls every 2 s, highlights the changed field and shows a toast
  with Undo; nothing extra is needed after a `knife_cv_*` call.
- `knife_ui_state`: the user's open app tabs (path, title, visible, connected, last activity), most recently active first.
- `knife_ui_show {slug, tab?, job?, variant?, focus?, doc?, note?, clientId?}`: brings the most recently active
  **visible** tab to `/tools/<slug>?tab=…&<deep link>` and shows `note` ("MCP agent: …") for 7 s. Only registry slugs,
  their tabs and the four deep-link keys are accepted (retired slugs map to their tab), so it never leaves the app.
  Deep links: `job` (Job offers), `variant` (CV versions), `focus` (a profile id-path), `doc` (office document).
  Returns `shown:false` when no tab is visible (the change is still saved; the user sees it when they open the app).

## How it works (`src/lib/ui-bridge/`)
- Tabs report presence (`POST /api/ui/presence`, on navigation, focus/visibility change and every 20 s; id per tab in
  sessionStorage). A visible tab polls `GET /api/ui/poll?client=<id>` every 1.5 s; a tab that polled in the last 5 s is
  "connected". `knife_ui_show` queues one request for the target tab (a newer request replaces an unread one).
- In memory per account on `globalThis` (the MCP and UI routes may be bundled separately in dev); a restart forgets
  tabs until they report again.
- No server-sent events on purpose: a per-tab stream kept Chrome's `load` from firing, broke "network idle" for every
  Playwright suite and the assistant, and would hold one of HTTP/1.1's 6 connections per site per tab.

## Tests
`tests/ui_bridge.test.mjs` (store + path rules), `tests/ui_bridge_e2e.py` (real browser; the test acts only through
MCP: state, live CV edit, show with a version deep link and the note, refusals, idle network, hidden tab).
