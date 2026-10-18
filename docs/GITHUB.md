# GitHub App and "Sign in with GitHub"

One GitHub App per server gives three things: **Sign in / register with GitHub** (public mode), **account linking**
(both modes), and **repository access without tokens** for the website studio (docs/WEBSITE-STUDIO.md). Personal tokens
stay as a fallback; admins may still use the server's `gh` login.

## Why an app (and what users see)

- Users pick the repositories on GitHub's own install screen and can uninstall at any time (GitHub Settings ->
  Applications). The app can only touch those repositories.
- The permissions are fixed and shown by GitHub: **Contents** and **Pull requests** read/write; **Metadata**, **Commit
  statuses**, **Deployments**, **Checks**, **Pages** read; account permission **Email addresses** read (sign-in). No
  webhooks. Pages read lets Connect verify a GitHub Pages domain as the repository's site (docs/WEBSITE-STUDIO.md); an
  app registered before it was added lacks it until the owner accepts the new permission, and its users then verify
  through the repository's Website field instead (or an admin approval).
- Nothing per user is stored as a secret: for each operation the server mints an **installation token** (one hour,
  limited to the one repository) with the app's private key. Commits and pull requests appear as the app's bot.
- Nothing is cloned or executed: the REST API reads the files the agent asks for and writes commits to a `knife/...`
  branch; only the user's Publish (or their own merge on GitHub) reaches the default branch. Users who want a hard
  guarantee protect their default branch on GitHub (pull requests required).

## Setup (admin, once per server)

Users page -> **GitHub App** -> name (unique on GitHub), optional organization -> **Create the GitHub App on GitHub**.
The browser POSTs a manifest to `github.com/settings/apps/new` (GitHub's manifest flow); you confirm the name on GitHub,
GitHub redirects to `/api/github/app-created?code&state`, and the server exchanges the one-time code (valid one hour,
state one-time and bound to the admin who started it) for the app id, client id/secret and private key.

- Credentials: `KNIFE_GITHUB_APP_FILE` (absolute path, 0600; share one file between the dev and the live server) or
  `$KNIFE_DATA_DIR/github-app.json`. It is a server secret like `.env.local`: back it up apart from the data dir.
  "Remove from this server" forgets the file; delete the app itself in its GitHub settings.
- **Only the public URL** (`KNIFE_PUBLIC_URL`, origin) is registered: redirect, callback and setup URLs all use it, and a
  server without one cannot create the app. No Tailscale/LAN address is ever sent to GitHub. Create the app from the
  public address (GitHub returns there); a flow started on another address first moves to the public one, so the state
  cookie and the callback share an origin. `KNIFE_GITHUB_EXTRA_BASES` (comma list, empty by default) adds callback bases
  for special setups. When the public address changes, edit the URLs in the app's settings on GitHub.
- The app's homepage (public on GitHub): `KNIFE_GITHUB_APP_HOMEPAGE`, else `KNIFE_PUBLIC_URL`, else this server.
- CSP (public mode): `form-action` allows the GitHub origin for the manifest POST (scripts/security-headers.mjs).
- `KNIFE_GITHUB_WEB_URL` / `KNIFE_GITHUB_API_URL`: GitHub Enterprise or test mocks (operator configuration: may be a
  private address in any mode).

## Flows (`src/lib/github-app/`, `src/app/api/github/`)

All OAuth flows use the web application flow with **PKCE S256** and a **one-time `state`** (10 minutes) that must come
back in the browser that started it (HttpOnly cookie `knife_gh_state`, `Path=/api/github`, SameSite=Lax). A callback
opened in another browser, a reused or forged state, or a session that changed meanwhile is refused.

| Start | What happens |
| --- | --- |
| `/api/github/start?purpose=login` (public mode) | GitHub sign-in -> the account linked to that GitHub user id is signed in (session rotation); a GitHub user without an account **registers**: username from the login (`-2`... on collisions, reserved names skipped), GitHub's **verified primary email**, role user, active, default quota, **no password**. An existing account with that email is **never taken over**: "sign in with your password, then link GitHub". No verified email -> refused. Disabled -> refused. |
| `purpose=link` (signed in) | Links the GitHub user to the current account (one account per GitHub id) and stores the app installations **GitHub lists for that user** (`GET /user/installations`). |
| `purpose=install` | GitHub's install page (choose repositories). GitHub then sends the browser to `/api/github/setup?installation_id=...`; that id proves nothing, so setup runs `link`, which records only installations the user can really reach. |

GitHub-only accounts (no password): a session is valid with a linked GitHub user instead of a password
(`accountUsable`); unlinking is refused until a password is set ("Forgot your password?"); self-deletion is confirmed by
typing the username.

## Website studio on the app

Connect -> **GitHub App (no token)** -> Connect with GitHub (link) -> Install on my repositories -> pick the repository.
The connection stores `{source: "app", installationId, login}`; connecting checks that the installation is linked to
the account and that the repository is in it. `GET /api/site/github` lists the linked installations and their
repositories.

## Tests

`tests/github_app.test.mjs` (unit, public mode, against `tests/mock_github_app.mjs`: manifest flow, JWT, PKCE,
state rules, sign-in/registration rules, linking, installation tokens, studio on an installation, a foreign installation
refused) and `tests/functional/github_app_e2e.py` (Chromium + Firefox: the admin creates the app, alice registers with
GitHub and connects a repository, an agent edits through the installation, mallory's claim of alice's installation is
refused, bob's account is not taken over by email, a forged state is refused, a GitHub-only account deletes itself).

GitHub App repo authorization is scoped to the linked GitHub USER, not merely the installation: link/refresh fetches
`GET /user/installations/{id}/repositories` with the user's OAuth token and retains only repositories whose
installation permissions include `push`. Connect, listings and every site operation require that exact repo to remain
in this list. The server revalidates against GitHub with a short TTL; unlinking or losing access drops the connection.
An organization's installation may contain repos the linking user cannot access; those repos are not connectable.
The server-held host `gh` login and GitHub App private key are never used to broaden a non-admin user's repository
authorization; personal-token connections use only the user's token and connected repo.
