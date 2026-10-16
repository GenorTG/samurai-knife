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
| Session cookie | `SameSite=Strict` | `SameSite=Lax` |
| Roles | every account may do everything | `admin` / `user` (see Roles) |
| MCP `POST /api/mcp` | default account, unauthenticated beyond the host guard | the session's account; no session = 401 |
| Mail transport default | `outbox` | `smtp` |

`src/lib/accounts/mode.ts` fails closed: any value other than empty/`private` is public; `scripts/serve.mjs` refuses to
start with an unknown value. Before switching a live install to public, give the owner a password and an address:

```bash
KNIFE_AUTH_MODE=public npm run accounts -- set-password <id>     # 10+ characters in public mode
npm run accounts -- set-email <id> owner@example.com            # marked verified: you vouch for it
npm run accounts -- set-role <id> admin                         # v1 accounts are admins already
```

## Store (`$KNIFE_DATA_DIR/accounts.json`, format v2)

One JSON file (0600, atomic temp+rename). Per account: `id` (= username, `ACCOUNT_ID_PATTERN`), `displayName`,
`passwordHash` (scrypt, format shared with the CLI), `provider`, `createdAt`, `email` (unique, lowercased),
`emailVerifiedAt`, `role` (`admin`|`user`), `status` (`pending`|`active`|`disabled`), `storageQuotaBytes` (1 GiB for
registered users, `null` = unlimited; enforced, see Storage quota), `lastLoginAt`, and the pending link tokens
`verifyToken` / `resetToken` / `emailChange` (`{hash, expiresAt}`, SHA-256 of the raw token only).

- Migration: a v1 file (no `version`) is read with the v2 defaults (every account an active admin, no email) and written
  as `version: 2` by the next change. The CLI does the same, so either side may write first.
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
| `/verify` (no token) | `POST /api/account/resend {email}` -> 202 | New link for a pending account (old link stops working); same answer for unknown or verified addresses, no mail for them. |
| `/login` (both modes) | `POST /api/account/login {id, password}` | `id` = username or (public) email, any case. Correct password but `pending` -> 403 `email_not_verified`, `disabled` -> 403 `account_disabled`; everything else 401 `invalid_credentials`. |
| `/forgot-password` | `POST /api/account/forgot {email}` -> 202 | Same answer always. Active account: reset link (1 h, single use, a newer one replaces it). Pending: the verification link instead. |
| `/reset-password?token=` | `POST /api/account/reset {token, password}` | Sets the password, ends every session, mails a notice. |
| `/account` | `POST /api/account/password {currentPassword, newPassword}` | Ends every session; this browser gets a new one. |
| `/account` | `POST /api/account/email {password, email}` -> 202 | Link to the NEW address; the address changes when it is opened. Address in use: same answer, its owner is told. |
| `/account` (both modes) | `POST /api/account/sessions`, `POST /api/account/logout` | Log out everywhere / here. |
| `/account` | `POST /api/account/delete {password}` | Removes the account and all its data (below); refused for the only active admin. Mails a notice. |
| `/account/admin` (both modes) | `GET /api/admin/users`, `POST /api/admin/users/<id> {action}` | Admins only. `disable` (ends sessions), `enable`, `delete`, `quota {bytes\|null}`, `role {admin\|user}`, `resend-verification`. An admin cannot disable, demote or delete themselves there, nor the last active admin. |

Answers that never depend on whether a username or address exists: register, resend, forgot (and the email change). What
differs goes to the mailbox of the address concerned.

## Data an account owns

Every per-account path is built by `accountScope(id)` (`src/lib/storage/scope.ts`): the id is checked once against
`ACCOUNT_ID_PATTERN` (no dot, slash or `..` possible), every further part must be one plain segment (`safeJoin` refuses
separators, `.`/`..`, NUL and anything that resolves outside its base) and a symlinked account directory is refused.
`src/lib/accounts/data.ts` lists the locations; account deletion (self or admin) removes all of it and returns what it
removed:

- `accounts.json` (the record) and `sessions.json` (its sessions)
- `cv/<id>.json`, `cv/<id>.snapshots/`, `cv/<id>.photo.jpg`, any other `cv/<id>.*` (CV studio)
- `conversations/<id>/` (assistant transcripts)
- `docs/<id>/` (office library: documents, `folders.json`, kept versions, trash)
- `learn/<id>.json` (course progress)
- `usage/<id>.json` (token ledger)

Not on disk, so not removed: in-memory async jobs (their scratch dirs in the OS temp dir count toward the quota while
they live) and UI-bridge presence (they expire), rate-limit buckets, `.eml` files
in `mail-outbox/` (test/private transport) and `mail-errors.log` lines. A new per-account store must be added to `data.ts`.

## Storage quota (`src/lib/storage/quota.ts`)

- Limit: the account's `storageQuotaBytes` (registration sets 1 GiB; the admin page changes it, 0 in the field = unlimited);
  administrators are always unlimited, and so is every account in private mode. Accounts made with the CLI start without
  a quota until an admin sets one.
- Usage: every byte under the account's locations above (apparent file sizes, symlinks not followed) plus the scratch
  bytes of its live async jobs (`POST /api/pdf?async=1`). Counted by one walk, cached in memory, moved by the exact delta of
  every write and removal that goes through `writeAccountFile` / `removeAccountPath`; re-walked after
  `KNIFE_STORAGE_RECOUNT_SEC` (default 600) to catch changes made outside the server.
- Checked BEFORE writing, only the growth counts (overwriting with a smaller file always passes): office uploads, new and
  duplicated documents, restores, editor saves (the Document Server callback first drops that document's oldest kept
  versions; if it still does not fit it answers an error, the editor keeps the changes and warns, and the open editor
  page shows "The last save was refused"), CV saves (incl. its snapshot) and the photo, assistant transcript PUTs,
  async PDF jobs. A refusal is HTTP 507 `{error, code: "storage_quota_exceeded", usedBytes, quotaBytes, neededBytes}`;
  the message names what is needed, what is free and how to free space. MCP / assistant tools return the same message.
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
`GET /api/system/queue`, user management. A non-admin may use a running sidecar (`ensure` while healthy, `touch`), sees
its status without configuration (`state`, memory, lock: `src/lib/services/view.ts`, `canManage: false`), and the UI
says "An administrator has to start/install <name>" instead of showing buttons (sidecar cards, Database course, office).

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
| login (failures only) | 5/min per identifier + client address (both modes, as before); public mode also 20/15 min per identifier and 50/15 min per address |
| register | 10/h per address, 3/h per email |
| resend | 10/h per address, 3/15 min per email |
| forgot | 10/h per address, 3/15 min per email |
| password/email change, delete (wrong password) | 10/15 min per account |

Refusals are 429 with `retryAfterSeconds` and `Retry-After`. Unknown addresses count the same as known ones.

## Hosts

The Host/Origin guard allows loopback, `KNIFE_HOST`, the host of `KNIFE_PUBLIC_URL` and `KNIFE_ALLOWED_HOSTS`
(`src/lib/hosts.ts`); the reverse proxy must pass the original `Host` header.

## Tests

`tests/accounts_store.test.mjs` (unit: migration, lock, unique emails, proxy rules, rate limits, flows, purge),
`tests/office_library.test.mjs` (unit: storage scope, quota, retention), `tests/office_files_e2e.py` (public mode, two users +
admin: isolation of every office route and `knife_doc_*` tool, quota 507 in the API and the browser) and
`tests/functional/accounts_public_e2e.py` (self-contained public-mode scratch server, outbox mail, every flow in the UI and
the API, roles on sidecar ops with a state-file-only sidecar, admin disable, deletion of every data location, then a
private-mode restart). Private mode is covered by `tests/accounts_api_e2e.py` and the widget suites.

## Later phases (not done here)

SSRF guards for user-supplied URLs, per-account MCP credentials (public-mode MCP needs a browser session today),
deployment (reverse proxy, mail server). Done on `feat/office-files`: per-account storage scope, quota enforcement, the
office file browser.
