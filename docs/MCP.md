# Smart Knife over MCP (agents outside the app)

The app has two agent surfaces that share one tool set:

1. **Built-in assistant** (the chat widget): uses the account's own provider/key, drives the page directly (open_tool,
   fill_field, click…) plus the `knife_*` tools.
2. **MCP** (`POST /api/mcp`, Streamable HTTP, stateless): any MCP client (OpenClaw, Claude Code, Cursor…) gets the same
   deterministic `knife_*` tools (CV studio, SQL/NoSQL, office documents, the Database course tutor, base tools) plus two MCP-only UI tools. The
   client brings its own model; the app needs no key for this.

Both can be used at the same time; edits are atomic per call and every CV save is undoable.

## Connecting
- URL: `<app origin>/api/mcp`, transport `streamable-http`. The route checks Host (and Origin when a browser sends one).
- Credentials (per account): create a key on `/account` ("MCP keys": name, created, last used; the key is shown once and
  stored only as its SHA-256 in `$KNIFE_DATA_DIR/mcp-keys.json`; at most 10 per account; revoke any time). Send the
  username with it, either way:
  - `Authorization: Basic base64(<username>:<key>)`
  - `Authorization: Bearer <key>` plus `X-Knife-User: <username>`
- Every tool then runs as that account: its CV, documents, course progress, and `knife_ui_*` reach only its own open
  tabs. A key works only with its own username; a revoked key, a key of a disabled or deleted account, or a wrong
  username is a 401 (`WWW-Authenticate: Basic`); 30 failed attempts per client address per 15 min are a 429. Keys are
  independent of passwords and browser sessions ("log out everywhere" does not revoke them; deleting the account does).
- Modes (docs/ACCOUNTS.md): public mode requires a key (no key = 401, a session cookie is not accepted here). Private mode
  without an Authorization header acts on the **default account** as before (the Tailscale bind is the boundary); with
  one, the key decides the account, exactly as in public mode.
- Roles: the tool list and every call are filtered by the caller's role (tool scopes below). A user's `tools/list` never
  contains admin tools, and calling one is an error.
- OpenClaw: `openclaw mcp add samurai-knife --url <app origin>/api/mcp --transport streamable-http` with the
  Authorization header (Basic or Bearer + `X-Knife-User`), then `openclaw mcp doctor samurai-knife --probe`.

## Tool scopes (`src/lib/mcp/define.ts`)
Every `defineTool` declares `scope` (no default, so a new tool must choose):
- `pure`: input in, result out (base tools, `knife_sql_*`, `knife_mongo_*`/`chroma`/`redis`).
- `account`: the caller's own data (`knife_cv_*`, `knife_doc_*`, `knife_learn_*`, `knife_site_*`, `knife_ui_*`).
- `admin`: the server owner's resources: `knife_cv_github_repos`, `knife_cv_github_repo_facts`, `knife_cv_showcase_rank`,
  `knife_cv_project_from_github` (the host's `gh` login) and `knife_cv_local_repo_facts` (git repos on the host's disk).
`toolsFor(ctx)` (tools.ts) is the only list: `GET /api/agent/tools` (the widget), `POST /api/agent/tool` (403
`admin_required` for an admin tool) and the MCP server all use it, and `defineTool` refuses a call outside its scope a
second time. The matching routes (`/api/cv/showcase/*`) are admin-only too, and the CV studio shows non-admins that an
administrator has to run the GitHub showcase.

## Office documents (`knife_doc_*`, group `docs`)
`knife_doc_list {folderId?, query?}` (folders with paths + documents), `knife_doc_read {id, version?, maxChars?}` (plain text, at most
`maxChars` (default 20,000; `chars` is the length returned, `truncated` says there is more), parsed in the server's isolate
pool; an earlier kept version too), `knife_doc_create {format, name, folderId?, paragraphs|rows|slides}`,
`knife_doc_folder_create {name, parentId?}`, `knife_doc_move {id, folderId|null}`, `knife_doc_versions {id}`,
`knife_doc_restore_version {id, version}` (the old content becomes a NEW version; nothing is lost). Nothing deletes:
trash and permanent deletion stay with the user in the file browser. Every tool acts on the calling account only (another
account's ids answer "unknown document/folder"), and writes fail with the storage-quota message when the account is full.

## Website (`knife_site_*`, group `site`)
Score and improve the user's own website from its GitHub repository: `knife_site_status` (start here: connection, the
repo's own AGENTS.md / CONTENT_BRIEF.md, work branch, latest scores), `knife_site_audit` (SEO, copy PL/EN, CV fit,
security headers, Lighthouse via PageSpeed), `knife_site_audit_get`, `knife_site_page`, `knife_site_files`,
`knife_site_read`, `knife_site_search`, `knife_site_replace` / `knife_site_write` (commit to the `knife/...` work branch,
never the base branch), `knife_site_pr`, `knife_site_changes` (diff, checks, preview URL). Publishing and discarding are
the user's buttons in the studio. Contract: docs/WEBSITE-STUDIO.md.

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
- Bounded: at most 32 tabs per account (the oldest report is evicted). A poll from a client id with no presence is
  answered `{known: false, events: []}` and not recorded (the tab then reports at once and polls again: covers a first
  poll that raced the first report and a server restart), and removing
  a presence entry (TTL or the cap) removes its poll and pending request; stale polls are swept, empty accounts dropped.
- No server-sent events on purpose: a per-tab stream kept Chrome's `load` from firing, broke "network idle" for every
  Playwright suite and the assistant, and would hold one of HTTP/1.1's 6 connections per site per tab.

## Tests
`tests/ui_bridge.test.mjs` (store + path rules), `tests/ui_bridge_e2e.py` (real browser; the test acts only through
MCP: state, live CV edit, show with a version deep link and the note, refusals, idle network, hidden tab).
`tests/roles_mcp.test.mjs` (scopes, key store, credential parsing) and `tests/functional/roles_mcp_e2e.py` (public mode,
two accounts: keys good/revoked/wrong user, cross-account data, admin tools and admin routes refused to a user over the
widget route and MCP).
