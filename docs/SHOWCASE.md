# Tool showcases

Every top-level tool of the registry (`TOOLS` in `src/lib/registry.ts`: suites and standalone tools, 25 today) has a
showcase page at `/tools/<slug>/about`: what it is for, 3-6 things you can do, who it is for, where it runs and whether
your files leave the device, what the AI assistant can do there, a screenshot, and an "Open the tool" button.

## Data

- `src/lib/showcase.ts` — `SHOWCASES`, keyed by registry slug. Pure data (browser and server); every text is an English
  key translated through `src/lib/i18n/pl.json` (`msg()`), so the extractor sees it. Fields: `purpose`, `points`,
  `audience`, `runs` (`browser` / `server` / `sidecar`), `data` (does anything leave the device, and where to),
  `assistant`, `image` (`{ src: "/showcase/<slug>.webp", kind: "screenshot" | "illustration" }` or `null`), and for the
  Craft apps `apps` (the thirteen apps with what each one is).
- Tabs have no showcase of their own: they share their suite's page (`?tab=` is carried to the Open button). A retired
  slug (`SLUG_ALIASES`) redirects to its suite's showcase. The Craft apps share one showcase that lists the apps.
- Be literal: every point must be something the tool really does today; the `data` line says plainly what goes to the
  server (or an AI provider) and when.
- `tests/showcase.test.mjs`: every `TOOLS` slug has an entry and nothing else does; the documented shape (3-6 points,
  a sidecar tool says `sidecar`, a server tool says `server`); the Craft showcase lists the registry's thirteen app tabs
  in order; every named image exists as a 1280x800 WebP of at most ~120 kB; the card-link rules below.

## Pictures

`python3 scripts/showcase_shots.py [--only slug,…] [--keep-png DIR] [--sidecar-host <Tailscale/LAN IP>]` writes
`public/showcase/<slug>.webp` for every showcase whose `image` is `shot(...)`: its own scratch server (fresh data dir,
private mode), Polish UI (`knife_lang=pl`), 1280x800, demo data only (the fictional CV in
`tests/fixtures/cv_sample_profile.json` and a demo workflow created over MCP, generated pictures, PDF and texts), WebP
quality stepped down until the file fits 120 kB. It is Python Playwright, the repo's test stack, so no npm dependency.

The course database is a sidecar: with `--sidecar-host` the script installs `learn-db` on a second scratch server bound to
that address (own compose project `sk-shots-<pid>`, `KNIFE_SCRATCH_PORTS` inside the firewall range, docs/SIDECARS.md),
runs a query in a real lesson, takes the shot and removes the project with its volume. The office editor and the Craft
apps are not shot (a multi-GB editor image or per-app bundles to download): their showcases are text-only (`image: null`)
until a real screenshot exists. Never fake a picture: a picture that is not a live screenshot must be `kind:
"illustration"`, which the page labels as such.

## Page and card links

- `src/app/tools/[slug]/about/page.tsx` — server-rendered, `generateMetadata` gives a Polish-first title ("{tool}: czym
  jest i co robi"), the purpose as description, a canonical URL and the image as Open Graph picture. It reads only the
  registry and `SHOWCASES`, never an account, so it is **public in both modes**: a signed-out visitor in public mode sees
  it in the welcome frame (marketing), while `/tools/<slug>` itself still redirects to `/login?next=`. The guest sees a
  line saying the button leads to sign-in. `tests/security_probe.py` checks both and that the page carries no account
  data. There is no sitemap in the app; add these pages if one is added.
- Cards open the showcase first: the launcher (`src/components/Launcher.tsx`) and the home page's feature cards
  (`ToolEntryLink`, `src/components/showcase/ShowcaseLinks.tsx`) go through `entryHref` (`src/lib/showcase-prefs.ts`).
  The sidebar, the command palette, links inside tools and the assistant's `open_tool` go straight to the tool.
- The choice lives in local storage `samurai-knife:showcase:v1` (`{ direct, skip[] }`), set on the showcase page:
  "Open tools straight away" (`direct`) or "Don't show this page again for this tool" (`skip`). The server render and
  hydration always use the showcase link (`useSyncExternalStore` server snapshot); the stored choice applies right
  after. The entry is in the privacy notice § 6 since legal edition 8.
- Every tool page's header has an "About this tool" link back to the showcase (`ToolShell`).
