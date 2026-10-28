# Website (CV studio)

The optional **Website** tab of the CV studio (steps: Your website, Check it, Compare with your CV, Improve it). It used to be the separate suite `site-studio`, which now redirects there (`/tools/site-studio?tab=X` -> `/tools/cv-studio?tab=website&step=X`). The website belongs to a CV project (docs/CV-STUDIO.md "Projects"); every signed-in user may use it.
The point: keep a personal or company website in line with what you do now and with your CV, score it on the usual
website benchmarks, and let the in-page assistant or any MCP agent improve it, without leaving the app. Nothing reaches
production until the user clicks Publish.

## Flow

1. **Connect** a GitHub repository: through the server's **GitHub App** (no token: the user installs the app on the
   repositories they choose, docs/GITHUB.md), or with a personal token; admins may use the server's own `gh` login. Plus
   the production URL and up to 9 more page paths.
2. **Score** (audit) the connected production site. In private mode and for admins, a pull-request preview or another
   URL may be audited too; public non-admin accounts are restricted to their connected production origin.
3. **Change**: the assistant or an MCP agent edits on a work branch `knife/<yyyymmdd>-<id>` (created from the base branch
   on the first change) and opens a pull request. Hosts like Vercel build a preview of it; the studio finds the
   preview URL in the commit's deployments and can score it.
4. **Publish** (Changes tab): the user reviews the files and the preview, ticks "I reviewed", and the pull request is
   squash-merged into the base branch, **only if its head is still the commit the user saw**; the work branch is deleted.
   **Discard** closes the pull request and deletes the branch. No tool can publish or discard.

## GitHub access (`src/lib/site/github.ts`)

REST API only, through the SSRF-guarded transport (`src/lib/site/net.ts`): no clone, no git binary, no code of the site
runs on the server. Changes use the Git Data API (base tree + entries -> tree -> commit -> fast-forward the ref, never
forced). A fine-grained token for the one repository needs **Contents** and **Pull requests** read/write; **Commit
statuses**, **Deployments** and **Checks** read show checks and previews. Refused writes: paths with `..` or `.git/`,
`.github/workflows/*` (they run code in CI and need another scope), real `.env*` files (`.env.example/.sample/.template`
are fine). At most 25 files per commit, 1 MB per file. `KNIFE_GITHUB_API_URL` overrides the API base (GitHub
Enterprise, tests).

## Audit (`src/lib/site/audit/`)

One run per account at a time; progress is readable while it runs (`GET /api/site/audit`). Stored runs: the newest 12.

- **Pages** (`page.ts`): status, redirects, time to first byte, title and description length, lang, viewport,
  canonical, robots meta, H1 count and heading order, images without alt, links without a name or with "read more"
  text, Open Graph, Twitter card, JSON-LD types, hreflang, favicon, visible words (header, nav, footer and buttons
  included: calls to action live there), calls to action, mailto/tel contacts, profile links (LinkedIn, GitHub...).
- **Site** (`site.ts`): robots.txt (blocks everything?), sitemap (URL count; relative Sitemap lines resolved), http ->
  https redirect, a real 404 for an unknown path, security headers (HSTS, CSP, nosniff, Referrer-Policy,
  Permissions-Policy, frame protection).
- **Copy** (`copy.ts`), Polish or English by detection: readability (FOG-PL by Pisarek for Polish, Flesch reading ease
  for English), long sentences, the first screen (H1 of 3-12 words with a line under it), calls to action and a direct
  contact, proof (numbers with units, results, project links), reader focus ("you" words vs "I/we"), buzzwords,
  substance (enough text), stale years and copyright. Word matching uses Unicode boundaries (`\b` misses ę/ń/ó).
- **CV fit** (`align.ts`): the CV studio profile against all audited text: name, headline, current roles (no end
  date), projects (name or URL), skills, LinkedIn/GitHub links, email; accent- and case-insensitive; plus tech words
  the site names that the CV does not list.
- **Lighthouse** (`lighthouse.ts`): PageSpeed Insights runs Lighthouse on Google's machines (mobile + desktop of the
  home page): the four category scores, Core Web Vitals lab metrics, the failing audits by weight. Google's anonymous
  quota is shared and often used up: set `KNIFE_PSI_API_KEY` (server) or the account's own key in Connect (a free key
  of the "PageSpeed Insights API" in Google Cloud). A failure is a note; the rest of the audit still runs.
- **Scores** (`run.ts`, 0-100): technical SEO (100 minus a penalty per distinct problem kind: high 15, medium 7, low
  3), copy (mean of pages with 30+ words), CV fit, security headers, and Lighthouse performance / accessibility / best
  practices / SEO (mobile). Overall = weighted mean (copy 1.5, security and best practices 0.5, the rest 1).

Where audits may go: private mode any address (a dev server on the LAN); public mode public addresses only (an admin
with `privateNetwork` excepted), every hop re-checked, 20 s and 4 MB per page. Budgets (public mode, non-admins): 6
audits an hour, 600 GitHub calls per 10 minutes, page reads count against the page budget.

In public mode, server-wide outbound-purpose and destination-host budgets additionally cap aggregate use across all
non-admin accounts, fair-share (`src/lib/net/outbound.ts`, `src/lib/net/budgets.ts`, `KNIFE_OUTBOUND_BUDGETS`); GitHub
and PageSpeed calls have no destination-host bucket (fixed services), the audited site has one. A server-configured `KNIFE_PSI_API_KEY` is
admin-only; a non-admin can use PageSpeed only with the key saved on their own site connection. Anonymous PageSpeed is
disabled for non-admins. Their audits and page reads are restricted to the connected site's production origin, and
only once it is VERIFIED (`src/lib/site/ownership.ts`): at Connect, with the user's own token or the app installation,
the production URL's host must be the repository's GitHub Website (`homepage`, editable by repository admins only) or
its GitHub Pages domain (`GET /repos/{repo}/pages`: custom CNAME or `<owner>.github.io`), `www.` ignored. Otherwise an
administrator approves the site for the account (`npm run accounts -- approve-site <id> <url>|none`, admin API
`POST /api/admin/users/<id> {action:"site-url", url}`). Verification is re-checked on every Connect; the view reports
`connection.productionVerified`. The production URL is user-typed: without this proof the audit would scan any site. GitHub App operations
must still pass the linked user's current repository-with-push authorization check.

## Storage

`site/<account>.json`, sealed at rest like every account file, counted by the quota, removed with the account: the
connection (the token or the `host-gh` marker, the PageSpeed key), the work branch and pull request number, the last
publish/discard, the newest 12 audit runs. The token and the key never leave the server: routes and tools answer
`siteView` (`hasPsiKey`, a token hint and login). The page polls `GET /api/site?revision=N` every 3 s, so an agent's
commits and audits show up by themselves.

## HTTP (`src/app/api/site/`)

| Route | |
| --- | --- |
| `GET /api/site[?revision=N]` | the view (`{changed:false}` when N is current) |
| `PUT /api/site` | connect / change settings `{repo, token?, tokenSource?, baseBranch?, productionUrl?, pages?, psiKey?}` |
| `DELETE /api/site` | disconnect (token, settings, work branch forgotten; audits stay) |
| `GET /api/site/status` | view + live repo info + the repo's instructions (AGENTS.md, CLAUDE.md, .github/copilot-instructions.md, CONTENT_BRIEF.md, README.md) |
| `GET /api/site/files?path=` / `?file=` | one directory level / one file (work branch when it exists) |
| `POST /api/site/audit` / `GET ?id=` / `GET ?run=<id or latest>` | start (202) / progress / a stored run |
| `GET /api/site/changes` | work branch vs base, pull request, checks, preview URL |
| `POST /api/site/changes` | `{action:"pr", title, body}` / `{action:"publish", head}` / `{action:"discard"}` |

## Tools (`src/lib/mcp/tools-site.ts`, group `site`, scope `account`)

`knife_site_status`, `knife_site_audit {url?, target?, pages?, lighthouse?}`, `knife_site_audit_get {id?, section}`,
`knife_site_page {url}`, `knife_site_files {path?, ref?}`, `knife_site_read {path, ref?}`, `knife_site_search {query}`,
`knife_site_replace {path, find, replace, message, all?}`, `knife_site_write {message, files, delete?}`,
`knife_site_pr {title, body}`, `knife_site_changes`. The assistant preloads the group on `site-studio` and
`cv-studio`; its system prompt has the workflow (status -> audit -> read -> replace/write -> pr -> audit the preview;
copy in the site's language, facts only from the CV). Its click guard treats buttons labelled publish/deploy as
destructive (confirmed in every trust mode but None).

## Tests

`tests/site_studio.test.mjs` (unit: analyzers, PageSpeed parsing, path rules, the whole GitHub flow and an audit
against `tests/mock_site_world.mjs`), `tests/functional/site_studio_e2e.py` (Chromium + Firefox, the mock world as
separate servers, an agent over MCP, publish).

## Without a repository (2026-10-27)
"Just its address" saves the site's URL (and extra paths) for the current CV project: enough for the check and the CV comparison; nothing is ever written to the site. `POST /api/site {action:"set-url", url, pages?}` / `{action:"verify-url"}` / `{action:"clear-url"}`; the view carries `siteUrl {url, pages, token, verified}` and `proofNeeded`.
- Private mode and admins: checked right away. Public mode, other users: only after the owner proves the site is theirs, so the check is never a free crawler aimed at a third party: the home page carries `<meta name="smart-knife-verification" content="<token>">`, or `/.well-known/smart-knife-verification.txt` holds exactly the token. Verify is one budgeted, SSRF-guarded read (public mode never reads private addresses for users); an admin-approved site (`approvedSiteUrl`) counts too. After that, checks and `knife_site_page` reach only that origin (`siteTargetProblem`).
- Tests: `tests/site_url_only.test.mjs`, `tests/functional/cv_projects_e2e.py`.
