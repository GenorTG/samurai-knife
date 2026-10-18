# Accounts

The account contract: two modes, the store, sessions, the flows and their routes, roles, mail, rate limits, and what
deleting an account removes. Code: `src/lib/accounts/`, `src/lib/mail/`, `src/app/api/account/`, `src/app/api/admin/`,
pages `src/app/{login,register,verify,forgot-password,reset-password,account}/`, UI `src/components/account/`.

## Modes (`KNIFE_AUTH_MODE`)

| | `private` (default) | `public` |
| --- | --- | --- |
| Boundary | loopback/Tailscale bind (never `0.0.0.0`) | a reverse proxy in front of a loopback bind, HTTPS |
| Identity without a session | the default account when it has no password | none: every API answers 401 |
| New accounts | `npm run accounts -- add` only | self-registration with a verified email (+ the CLI) |
| Public-only routes and pages | 404 | on |
| Home `/` without a session | the launcher | the welcome page (`src/components/Greeter.tsx`: capabilities, privacy, register / log in) |
| Pages without a session | everything | only `/`, `/login`, `/register`, `/verify`, `/forgot-password`, `/reset-password`, in the public frame (`src/components/shell/PublicShell.tsx`: no sidebar, palette, assistant or UI bridge); `/tools/*` and `/account*` redirect to `/login?next=<path+query>` (`requireSignIn`, `src/lib/accounts/viewer.ts`, called by each page: layouts are not re-rendered on client navigation, so a layout can only pick the frame); a signed-in visitor on `/login` or `/register` goes straight on to `next` |
| Session cookie | `SameSite=Strict` | `SameSite=Lax` |
| Roles | every account may do everything | `admin` / `user` (see Roles) |
| MCP `POST /api/mcp` | default account without credentials; an MCP key selects its account | username + MCP key required (docs/MCP.md); none = 401 |
| Mail transport default | `outbox` | `smtp` |

`src/lib/accounts/mode.ts` fails closed: any value other than empty/`private` is public; `scripts/serve.mjs` refuses to
start with an unknown value. Before switching a live install to public, give the owner a password and an address:

```bash
KNIFE_AUTH_MODE=public npm run accounts -- set-password <id>     # 10+ characters in public mode
npm run accounts -- set-email <id> owner@example.com            # marked verified: you vouch for it
npm run accounts -- set-role <id> admin                         # v1 accounts are admins already
npm run accounts -- set-network <id> private                    # its provider may reach local models (LAN/loopback)
```

## Store (`$KNIFE_DATA_DIR/accounts.json`, format v2)

One JSON file (0600, atomic temp+rename). Per account: `id` (= username, `ACCOUNT_ID_PATTERN`), `displayName`,
`passwordHash` (scrypt N=2^17, format shared with the CLI; old hashes verify and are upgraded after successful login), `provider`, `createdAt`, `email` (unique, lowercased),
`emailVerifiedAt`, `role` (`admin`|`user`), `status` (`pending`|`active`|`disabled`), `storageQuotaBytes` (1 GiB for
registered users, `null` = unlimited; enforced, see Storage quota), `lastLoginAt`, `privateNetwork` (see "Outbound
requests"; default false), and the pending link tokens `verifyToken` / `resetToken` / `emailChange` (`{hash, expiresAt}`,
SHA-256 of the raw token only).

- Provider secrets at rest: `provider.apiKey` and every `provider.extraHeaders` value are stored sealed,
  `enc:v1:<iv>:<tag>:<ciphertext>` (AES-256-GCM, base64url) with the key in `$KNIFE_DATA_DIR/provider-keys.key` (64 hex
  chars, 0600, created by the first write that seals something). The additional data is `<id>:apiKey` /
  `<id>:header:<lower-cased name>`, so a value copied into another account or field does not open. `store.ts` opens them on
  read (everything above the store sees plaintext) and seals on write; a file with plaintext secrets (older installs,
  hand edits) is resealed by the first read. The CLI reads and writes the same format. A sealed file without the key file
  is an error, never an empty key. This protects a copy of `accounts.json` alone (a backup, one misdirected file read),
  not someone who can read the whole data directory. Back up `provider-keys.key` with `accounts.json`.

- Migration: a v1 file (no `version`) is migrated explicitly to v2 with legacy records active admins (no email). In v2, missing role defaults to `user` and missing status to `disabled`; malformed or unknown values fail closed. The next change writes `version: 2`. The CLI does the same, so either side may write first.
- Reads cache by mtime + size and return copies; changes still lock, re-read, validate and atomically write. A periodic sweeper removes expired pending registrations. Pending accounts are capped (defaults: 2,000 total, 50 per email domain, 5 per client IP prefix); at capacity new signups receive 429 + Retry-After.
- Concurrency: every change goes through `mutateStore` (lock, re-read, change, validate, write). It is synchronous, so two
  requests in the server cannot interleave (Node runs one at a time); the O_EXCL lock file `accounts.json.lock` (stale
  after 10 s) orders the server against the CLI. The CLI prompts between reading and writing, so it does a
  compare-and-swap under the lock instead of holding it (refuses when the server wrote meanwhile; run it again).
  Password hashing happens before the lock. Validation on every write: unique ids, unique emails, a valid default.
- Why one file: at this scale (hundreds of accounts) a whole-file rewrite is cheap, and the unique username/email checks
  need every record anyway; per-account files would need a separate index with the same locking problem.

## Sessions (`$KNIFE_DATA_DIR/sessions.json`)

Cookie `knife_session` = 32 random bytes (base64url), `HttpOnly`, `Path=/`, 30 days, `Secure` when the request is HTTPS
(seen directly or through `X-Forwarded-Proto` from a trusted proxy). The file stores only SHA-256 of the token with the
account, created/expires/last-seen times and a fingerprint of the password hash (a password set through the CLI ends
every session without touching this file). Login rotates (the browser's previous session is revoked). Revoked: one on
logout, all of an account's on password change/reset, disable, delete and "log out everywhere"
(`POST /api/account/sessions {action:"revoke-all"}`); `GET /api/account/sessions` counts them. A session of an account
that is disabled, deleted or (public mode) unverified resolves to nobody.

## Client address and HTTPS behind a proxy

Route handlers never see the socket, and Next keeps a client-sent `X-Forwarded-For`, so `scripts/serve.mjs` preloads
`scripts/peer-address.mjs`, which writes the TCP peer into `x-knife-peer` on every request (overwriting any client value).
`src/lib/accounts/network.ts` reads `X-Forwarded-For` / `X-Forwarded-Proto` only when that peer matches
`KNIFE_TRUSTED_PROXIES` (comma-separated IPs or CIDRs, e.g. `127.0.0.1,::1` for a proxy on the same host); the client
address is the right-most untrusted entry. Without a match every client is `local` (one shared bucket) and cookies are
not `Secure`. A server started without `serve.mjs` has no peer stamp and never trusts forwarded headers.

## Flows (public mode; 404 in private mode unless noted)

Every route is behind the Host/Origin guard and reads JSON through `readJsonBody`.

| Page | Route | Notes |
| --- | --- | --- |
| `/register` | `POST /api/account/register {username, email, password}` -> 202 | username = `ACCOUNT_ID_PATTERN`, not reserved; password 10..1024 chars. Always the same answer. New: pending account + verification mail. Address taken: mail to its owner ("someone tried to sign up"). Username taken/reserved: mail to the given address ("choose another username"). Pending accounts whose link expired more than 24 h after creation are dropped at the next registration (frees the name and address). |
| `/verify?token=` | `POST /api/account/verify {token}` | A button consumes the token (a mail scanner prefetching the link does not). Activates a pending account, or applies a confirmed address change (the old address gets a notice). 24 h, single use. |
| `/verify` (no token) | `POST /api/account/resend {email}` -> 202 | For pending accounts, cancels the unverified record and mails a registration link (M3); same answer for unknown addresses. Active accounts with unverified email can receive a new verification link. |
| `/login` (both modes) | `POST /api/account/login {id, password, pow?}` | `id` = username or (public) email, any case. Correct password but `pending` -> 403 `email_not_verified`, `disabled` -> 403 `account_disabled`; everything else 401 `invalid_credentials`. A successful login gets a signed known-device cookie and is capped at 30 successful logins/account/hour; each account has at most 20 sessions (oldest evicted). |
| `/forgot-password` | `POST /api/account/forgot {email}` -> 202 | Same answer always. Active account: reset link (1 h, single use, a newer one replaces it). Pending: the pending record is cancelled and the address receives a fresh registration link; an unverified signup cannot reserve an address (M3). |
| `/reset-password?token=` | `POST /api/account/reset {token, password}` | Checks the reset token before scrypt, sets the password, ends every session, revokes all MCP keys, and mails a notice. Reset/verify attempts have IP and token-hash limits. |
| `/account` | `POST /api/account/password {currentPassword, newPassword}` | Ends every session; this browser gets a new one; revokes every MCP key and mails a notice. |
| `/account` | `POST /api/account/email {password, email}` -> 202 | Link to the NEW address; the address changes when it is opened. Address in use: same answer, its owner is told. |
| `/account` (both modes) | `POST /api/account/sessions`, `POST /api/account/logout` | Log out everywhere / here; everywhere also has an explicit option to revoke MCP keys. The page (and the assistant's log out) first clears this account's browser storage: transcript, message queue, run lease, SQL lab schema/dialect, trust mode (`src/lib/client-account.ts`). |
| `/account` (both modes) | `GET /api/account/mcp-keys`, `POST /api/account/mcp-keys {action:"create", name}` / `{action:"revoke", id}` | MCP keys (docs/MCP.md): list without secrets, create (201, the key once; 20 per hour, 10 kept), revoke (404 for another account's id). |
| `/account` | `POST /api/account/delete {password}` | Removes the account and all its data (below); refused for the only active admin. Mails a notice. |
| `/account/admin` (both modes) | `GET /api/admin/users`, `POST /api/admin/users/<id> {action}` | Admins only. `disable` (ends sessions), `enable`, `delete`, `quota {bytes\|null}`, `role {admin\|user}`, `resend-verification`. An admin cannot disable, demote or delete themselves there, nor the last active admin. |

| `/account/admin` (both modes) | `POST /api/admin/users/<id> {action:"network", privateNetwork}` | Admins only; `true` is refused for a non-admin (409). |

Answers that never depend on whether a username or address exists: register, resend, forgot (and the email change). What
differs goes to the mailbox of the address concerned.

## Sign in with GitHub

With a GitHub App configured (docs/GITHUB.md), public mode offers "Continue with GitHub" on /login and /register: a
known GitHub user signs in; a new one registers with GitHub's verified primary email (role user, no password); an
existing account with that email is never taken over (it signs in with its password and links GitHub in Account
settings). A session is valid for an account with a password or a linked GitHub user; a GitHub-only account cannot
unlink until it sets a password, and deletes itself by typing its username. One account per GitHub user id.

## Data an account owns

Every per-account path is built by `accountScope(id)` (`src/lib/storage/scope.ts`): the id is checked once against
`ACCOUNT_ID_PATTERN` (no dot, slash or `..` possible), every further part must be one plain segment (`safeJoin` refuses
separators, `.`/`..`, NUL and anything that resolves outside its base) and a symlinked account directory is refused.
`src/lib/accounts/data.ts` lists the locations; account deletion (self or admin) removes all of it and returns what it
removed:

- `accounts.json` (the record), `sessions.json` (its sessions) and `mcp-keys.json` (its MCP keys)
- `cv/<id>.json`, `cv/<id>.snapshots/`, `cv/<id>.photo.jpg`, any other `cv/<id>.*` (CV studio)
- `conversations/<id>/` (assistant transcripts)
- `docs/<id>/` (office library: documents, `folders.json`, kept versions, trash)
- `learn/<id>.json` (course progress)
- `usage/<id>.json` (token ledger)
- `workspace/<id>.json.enc` (browser-tool drafts, see "Tool drafts" below)
- `site/<id>.json` (website studio: repository connection with its token, work branch, audit history; docs/WEBSITE-STUDIO.md)

### Tool drafts (`src/components/WorkspaceDraft.tsx`, `/api/workspace`)

Every browser tool is wrapped (`src/tools/registry-client.tsx`) except the ones with their own server data or secrets
(`NO_DRAFT`: CV studio tabs, office, course, sidecars, MCP keys, db-connect, password generator). Edits to its form
controls (text, selects, toggles; never password/file/hidden inputs, read-only or disabled outputs, or controls labelled
like a secret/token/key) autosave to the account 700 ms after the last edit. A visit starts from the tool's defaults:
when the saved draft differs from them, the bar above the tool offers "Restore saved draft" / "Discard" (DELETE); the
first edit instead makes the new work the draft. The tool renders at once and is never re-rendered by the wrapper. Fields
over 100k characters are not kept ("Large inputs are not kept in drafts"); an account keeps at most 2 MiB / 160 tools of
drafts, the least recently saved go first. Signed out: nothing is offered or saved. `GET /api/workspace?tool=<id>`,
`PATCH {tool, fields}`, `DELETE ?tool=<id>`; all per account, sealed at rest, counted by the quota.

### At rest

Every file above except the account-wide JSON files (`accounts.json`, `sessions.json`, `mcp-keys.json`) is written by
`writeAccountFile` and is sealed (`src/lib/storage/sealed.ts`): AES-256-GCM with a key derived for that account
(HKDF-SHA256 of the server storage key, info = account id) and the account id as additional data, so a file copied into
another account's directory does not open. Layout: `\0SKENC01` | iv (12) | tag (16) | ciphertext. Stores read through
`readAccountFile` / `readAccountText`; sizes shown to users (photo, document versions) are plaintext sizes, the quota
counts the bytes on disk (36 bytes more per file).

- Key: `$KNIFE_DATA_DIR/storage.key` (64 hex chars, 0600, created by the first sealed write), or the absolute path in
  `KNIFE_STORAGE_KEY_FILE`. Keep it OUTSIDE the data directory on a public host, so a copy of the data directory (a
  backup, a misdirected read) opens nothing; whoever can read both the key and the data can read everything. Back the key
  up separately: losing it loses every sealed file. A missing key is an error on read, never a new key.
- Upgrade: files written before sealing still read as plaintext and are sealed by their next write; files that are rarely
  rewritten (kept document versions, CV snapshots) stay plaintext until `npm run storage -- seal` (`--dry-run` first)
  seals them in place, keeping their mtimes. Run it with the server stopped and after a backup. Sealed files cannot be
  read by a build from before sealing: before rolling back, stop the server and run `npm run storage -- unseal`
  (`--dry-run` first), which opens every sealed file in place again.
- Not sealed: async job scratch dirs in the OS temp dir (0700, removed with the job), `.eml` files of the outbox
  transport, `mail-errors.log`.

Not on disk, so not removed: in-memory async jobs (their scratch dirs in the OS temp dir count toward the quota while
they live) and UI-bridge presence (they expire), rate-limit buckets, `.eml` files
in `mail-outbox/` (test/private transport) and `mail-errors.log` lines. A new per-account store must be added to `data.ts`.

## Storage quota (`src/lib/storage/quota.ts`)

- Limit: the account's `storageQuotaBytes` (registration and GitHub sign-up set `KNIFE_USER_QUOTA_MB`, default 1024 =
  1 GiB, read at startup; changing it never touches existing accounts; the admin page changes one, 0 in the field = unlimited);
  administrators are always unlimited, and so is every account in private mode. Accounts made with the CLI start without
  a quota until an admin sets one.
- Usage: every byte under the account's locations above (apparent file sizes, symlinks not followed) plus the scratch
  bytes of its live async jobs (`POST /api/pdf?async=1`). Counted by one walk, cached in memory, moved by the exact delta of
  every write and removal that goes through `writeAccountFile` / `removeAccountPath`; re-walked after
  `KNIFE_STORAGE_RECOUNT_SEC` (default 600) to catch changes made outside the server.
- Checked BEFORE writing, only the growth counts (overwriting with a smaller file always passes): office uploads, tool drafts, new and
  duplicated documents, restores, editor saves (the Document Server callback first drops that document's oldest kept
  versions; if it still does not fit it answers an error, the editor keeps the changes and warns, and the open editor
  page shows "The last save was refused"), CV saves (incl. its snapshot) and the photo, assistant transcript PUTs,
  async PDF jobs. A refusal is HTTP 507 `{error, code: "storage_quota_exceeded", usedBytes, quotaBytes, neededBytes}`;
  the message names what is needed, what is free and how to free space. MCP / assistant tools return the same message.
- Global free-space floor (`src/lib/storage/disk-floor.ts`): quotas bound one account, not many accounts together, so a
  non-admin write (the same checks as above, unlimited quotas included) that would leave the data dir's filesystem with
  less than max(`KNIFE_DISK_FLOOR_GB` 10, `KNIFE_DISK_FLOOR_PERCENT` 10 % of the filesystem) free is refused: HTTP 507
  `{error, code: "storage_full", neededBytes, retryAfterSec}` with a generic message (nothing about the server's disk).
  Administrators and private mode are never refused by it; 0 disables a part. statfs is cached
  `KNIFE_DISK_FLOOR_CACHE_SEC` (10) and bytes admitted inside a window are subtracted; an unreadable filesystem counts as
  full. The same floor guards the upload scratch dir (`os.tmpdir()`, docs/ARCHITECTURE.md "Server work": 503 there, for
  every account). The office save's "drop the oldest versions" step looks at the quota only (`canStore`): low disk never
  deletes a user's history.
- Never refused (bookkeeping, still counted): document metadata, folder list, CV snapshots of an accepted save, the
  token ledger, course progress, the assistant's continuation state. Deleting is never refused.
- Retention caps so nothing grows without bound: CV snapshots 40 and 20 MB per account, 5 conversation files (one per
  provider/model) per account, 25 kept versions per document, trash purged 30 days after trashing.
- Shown on `/account` (Storage panel, `GET /api/account/storage` -> `{usedBytes, quotaBytes, fraction, areas}`), in the
  office file browser (meter + files / versions / trash split) and on the admin users page.

## Roles

One rule, `src/lib/accounts/authz.ts` (`isAdmin`, `requireAdmin` -> 403 `{error: "An administrator has to …", code:
"admin_required"}`). Private mode: every account is an admin. Public mode, admin only: sidecar install/start/stop/update/
remove/configure and the lazy start (`ensure` of a stopped service), course data rebuild (`setup {force:true}`),
`GET /api/system/queue`, user management, and everything that reaches the server owner's own resources: the `admin`
scoped tools (GitHub through the host's `gh` login, git repos on the host's disk: docs/MCP.md "Tool scopes") and their
routes `/api/cv/showcase/{repo,rank,project,local}`. A non-admin may use a running sidecar (`ensure` while healthy,
`touch`), sees its status without configuration (`state`, memory, lock: `src/lib/services/view.ts`, `canManage: false`)
and a running op's progress without its log, pull details or hints (`opViewFor`, also `GET /api/services/ops/<id>`), and
the UI says "An administrator has to start/install <name>" instead of showing buttons (sidecar cards, Database course,
office) and that an administrator has to run the GitHub showcase (CV studio). A 401 in public mode names no account.

## Fair share between accounts

- Python lanes (`src/lib/work-queue.ts`): every job carries its account; one account may hold at most
  `KNIFE_PY_LIGHT_PER_ACCOUNT` (8) light and `KNIFE_PY_HEAVY_PER_ACCOUNT` (3) heavy jobs (running + queued; 429 beyond),
  and a free slot goes to the account with the fewest jobs running there, round-robin among equals. Those are the
  administrators' (and private mode's) caps. Public mode (`src/lib/python-admission.ts`): an ordinary account may hold
  `KNIFE_PY_LIGHT_PER_USER` (3) / `KNIFE_PY_HEAVY_PER_USER` (1), an account younger than `KNIFE_PY_NEW_ACCOUNT_HOURS` (24)
  at most 2 light; it may start `KNIFE_PY_LIGHT_PER_10MIN` (120) / `KNIFE_PY_HEAVY_PER_10MIN` (30) jobs per 10 minutes,
  a new account `..._PER_10MIN_NEW` (40 / 10) (429 + Retry-After "You started N … jobs in the last 10 minutes"; checked
  before an upload is read, counted only when the queue accepts the job). `KNIFE_PY_LIGHT_RESERVED` (2) /
  `KNIFE_PY_HEAVY_RESERVED` (1) places of each lane are kept for administrators, whose queued jobs start first and who
  have no job rate.
- Uploads streamed to disk (`/api/pdf`, `src/lib/upload-budget.ts`): public mode 2 in flight per account
  (`KNIFE_UPLOADS_PER_ACCOUNT`, 429), 6 on the server (`KNIFE_UPLOADS_MAX`, one kept for administrators, 503) and 512 MB
  reserved in flight (`KNIFE_UPLOADS_INFLIGHT_MAX_MB`, 503); private mode 8 / 16 / 4096 MB. The slot is taken before the
  first body byte and held until a synchronous run ends (an async job's files then count against the job store);
  `KNIFE_UPLOAD_IDLE_SEC` (30) without a byte answers 408 and frees it. `KNIFE_PDF_UPLOAD_MAX_MB` is 100 by default in
  public mode (512 private).
- Async jobs (`src/lib/jobs.ts`): per account at most `KNIFE_JOBS_PER_ACCOUNT` (50) live jobs and
  `KNIFE_JOBS_ACCOUNT_MAX_MB` (a quarter of `KNIFE_JOBS_MAX_MB`) of scratch (429); job ids are random.
- Website studio: 6 audits per hour and 600 GitHub API calls per 10 minutes per account (`outboundAudit`, `outboundGithub`); page reads of `knife_site_page` count against the page budget.
- Database course: one run in flight per account (`KNIFE_LEARN_RUNS_PER_ACCOUNT`, 429 "still running") and at most
  `KNIFE_LEARN_MAX_RUNS` (12) on the server, below the learner role's 20 connections (docs/LEARN.md).
- Child processes (Python lane, `gh`/`git`, docker compose) get an allow-listed environment (`src/lib/child-env.ts`),
  never the server's own variables.

## Outbound requests (`src/lib/net/`)

The provider base URL is the user's own choice, so every provider request (Test, chat, streamed chat, OpenClaw Responses)
and every page fetch (job posting, company website) goes through `safeFetch`: the host is resolved once, every address
must pass the policy, the connection is pinned to a checked address (no DNS rebinding), redirects are errors for
providers (re-checked per hop, max 5, for pages), and the time and size caps hold.

| | private mode | public mode, user | public mode, admin | admin with `privateNetwork` |
| --- | --- | --- | --- | --- |
| Provider addresses | any | public only | public only | any (loopback, LAN, Tailscale: the owner's local models) |
| Provider scheme | http(s) | https only | http(s) | http(s) |
| Extra headers | server-managed names refused | + strict list (below) | server-managed names refused | same |
| Upstream error text shown | raw | provider-shaped JSON error message only | raw | raw |
| Outbound budget | none | yes (below) | none | none |
| Job/company pages | public only (always) | public only | public only | public only |

"Public" = not loopback, private (10/8, 172.16/12, 192.168/16), CGNAT incl. Tailscale (100.64/10), link-local/metadata,
ULA (fc00::/7, incl. Tailscale's fd7a:115c:a1e0::/48), IPv4-mapped/compatible/NAT64/6to4/Teredo forms, multicast,
documentation ranges, and not in the deny list: `KNIFE_SSRF_DENY_CIDRS` (this server's public IPv4, the LAN's delegated
IPv6 prefix) plus the machine's own interface addresses and the /64 of each global IPv6 one. Names like `localhost`,
`*.local`, `*.internal`, `*.lan`, `*.home.arpa` are refused before DNS. The base URL is checked when it is saved
(`PUT /api/account/provider` answers 400 `{code: "address_not_allowed"}` with the reason) and again on every request.

Strict extra headers (non-admins in public mode): hop-by-hop and framing (`Connection`, `Keep-Alive`, `TE`, `Trailer`,
`Transfer-Encoding`, `Upgrade`, `Expect`, `Via`), proxy and client-address headers (`Forwarded`, `X-Forwarded-*`,
`X-Real-IP`, `X-Client-IP`, `True-Client-IP`, `CF-Connecting-IP`, `X-Original-*`, `X-Rewrite-*`, `Proxy-*`), method
overrides, `Origin`, `Referer`, `Set-Cookie`, `Sec-*`, `X-Envoy-*`, `X-Amzn-*` and the OpenClaw gateway's `X-OpenClaw-*`.
Always refused: `Authorization` (the stored key is the only one), `Host`, `Cookie`, `Content-Type`, `Content-Length`.

Admin opt-out: `npm run accounts -- set-network <id> private|public` or `POST /api/admin/users/<id> {action: "network",
privateNetwork}`. It only takes effect while the account is an admin.

## Mail (`src/lib/mail/`)

nodemailer. `KNIFE_MAIL_TRANSPORT=smtp` (default in public mode): `KNIFE_SMTP_HOST`, `KNIFE_SMTP_PORT` (587),
`KNIFE_SMTP_SECURE` (`1` = TLS from the start, else STARTTLS when offered), `KNIFE_SMTP_USER`, `KNIFE_SMTP_PASS`,
`KNIFE_SMTP_FROM`. `outbox` (default in private mode, used by the e2e suite): each message is an `.eml` file in
`$KNIFE_DATA_DIR/mail-outbox/`. Links are absolute from `KNIFE_PUBLIC_URL` (else the bind address), never from the Host
header. Sending never blocks a response; failures go to the server log and `$KNIFE_DATA_DIR/mail-errors.log`.
Templates (`templates.ts`): English, plain text + minimal HTML, every value escaped.

## Rate limits (`src/lib/accounts/rate-limit.ts`, in memory, per server process)

| Action | Buckets |
| --- | --- |
| login (failures only) | 5/min per identifier + client address; public unknown devices are hard-limited by 5/min per identifier+address and 50/15 min per address; 20/15 min and 200/day identifier buckets, and 3-failure signals, raise proof-of-work instead of locking the account; a known-device cookie uses its own 10/15 min failure bucket |
| register | 10/h per address, 3/h per email |
| resend | 10/h per address, 3/15 min per email |
| verify | 20/10 min per address, 5/10 min per token hash |
| reset | 20/10 min per address, 5/10 min per token hash |
| successful login | 30/h per account |
| forgot | 10/h per address, 3/15 min per email |
| password/email change, delete (wrong password) | 10/15 min per account |
| provider rounds (`/api/agent/chat`), public mode, non-admins | 300/10 min per account |
| provider Test, public mode, non-admins | 20/10 min per account |
| job posting / company page fetches, public mode, non-admins | 30/10 min per account |

Refusals are 429 with `retryAfterSeconds` and `Retry-After`. Unknown addresses count the same as known ones.

## Proof-of-work and password-hash budget

Public register, forgot, resend, reset, and login after failures require a browser-bound proof before rate-limit work,
store lookups, scrypt, or mail. `GET /api/account/challenge?form=...` issues an HMAC-signed ten-minute challenge bound to
the form and client IP prefix. The client solves SHA-256 in a Web Worker and reports progress as “Checking your browser…”.
Challenges are single-use and the replay set is bounded. Difficulty defaults to 18 bits (~2^18 hashes), increases under
prefix/register pressure, and is capped at 24 bits. Browser e2e uses the Worker-backed forms; direct API probes fetch
and solve the challenge too (see `Api.call` in `tests/functional/accounts_public_e2e.py`). Isolated e2e servers set a
lower `KNIFE_POW_BITS`, never disable the check. The signing key is `auth.key` (0600).

Every password hash and verify shares one asynchronous scrypt gate: `KNIFE_SCRYPT_CONCURRENCY=2`,
`KNIFE_SCRYPT_QUEUE=32`; excess work returns 503 with `Retry-After`. Scrypt uses N=2^17; unknown usernames perform a
dummy verification at current parameters for timing parity.

Environment controls (all have strict public-mode defaults): `KNIFE_POW_BITS` (18), `KNIFE_POW_MAX_BITS` (24),
`KNIFE_POW_REGISTER_SURGE` (20 registrations/hour), `KNIFE_SCRYPT_CONCURRENCY` (2),
`KNIFE_SCRYPT_QUEUE` (32), `KNIFE_PENDING_MAX` (2000), `KNIFE_PENDING_PER_DOMAIN` (50), `KNIFE_PENDING_PER_PREFIX` (5), and
`KNIFE_AUTH_KEY_FILE` (optional absolute path; default `$KNIFE_DATA_DIR/auth.key`).

## Hosts

The Host/Origin guard allows loopback, `KNIFE_HOST`, the host of `KNIFE_PUBLIC_URL` and `KNIFE_ALLOWED_HOSTS`
(`src/lib/hosts.ts`); the reverse proxy must pass the original `Host` header.

## Tests

`tests/accounts_store.test.mjs` (unit: migration, lock, unique emails, proxy rules, rate limits, flows, purge),
`tests/safe_net.test.mjs` (unit: key sealing and migration, CLI interop, outbound policy, SSRF matrix, header rules,
budget, body limits), `tests/functional/safe_net_e2e.py` (public-mode SSRF refusals, admin opt-out, budget, body
limits, sealed keys, security headers),
`tests/office_library.test.mjs` (unit: storage scope, quota, retention), `tests/office_files_e2e.py` (public mode, two users +
admin: isolation of every office route and `knife_doc_*` tool, quota 507 in the API and the browser) and
`tests/functional/accounts_public_e2e.py` (self-contained public-mode scratch server, outbox mail, every flow in the UI and
the API, roles on sidecar ops with a state-file-only sidecar, admin disable, deletion of every data location, then a
private-mode restart). Private mode is covered by `tests/accounts_api_e2e.py` and the widget suites.

## Deployment

Production build and public-mode deployment requirements are documented in [DEPLOY.md](DEPLOY.md). Remaining release
work is operational: configure the production environment, HTTPS/reverse proxy and mail delivery before exposing the
service.
