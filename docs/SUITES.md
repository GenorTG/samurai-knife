# Tool suites

The first pass turned 100 registry entries into 36 (27 suites, 91 tabs, 9 standalone). Later additions (the database labs, CV studio, office documents and sidecars) bring it to 40 entries today: 30 suites with 106 tabs and 10 standalone tools. Every
folded slug is a permanent alias (`SLUG_ALIASES` in `src/lib/registry.ts`) that
the `/tools/[slug]` route redirects (308) to `/tools/<suite>?tab=<tab>`, so no
bookmark, favorite or recent entry breaks. Favorites and history stored in
localStorage are mapped through `canonicalSlug` on read.

## Method

All 100 tools were read for purpose, inputs and shared code, then grouped by
the job a person is doing, not by file similarity. A tool joined a suite only
when the same person, in the same sitting, would reach for the next tool with
roughly the same input (pasted CSV, an SVG, a date, an image, response
headers). Components are untouched: each tab renders the existing component.

Why 36 and not 60-70: the brief asked for roughly 60-70 but also said not to
merge unrelated tools to reduce the count. Cohesive clusters land at 36; the
9 standalone entries below are the ones where a merge would have been
cosmetic. If a higher count is preferred, split suites back out (for example
`image-resize` into export and privacy, or `epoch` into converters and range
math): it is a data change in `registry.ts` plus new aliases, no component work.

## True duplicates

There are none to delete. The closest case is `image-scrub` (re-encode to drop
metadata) versus `image-resize` (resize/convert/compress): the scrub is a
re-encode at original size, which resize also does, so scrub is a subset. It
stays as its own tab (`image-resize?tab=scrub`) because "remove EXIF" is what
people search for. `json` (lint/format) and `yaml-json` overlap on JSON
linting, but YAML conversion is the point of the latter, so they stay separate
tabs of different suites. No component was deleted.

## Suites

`*` marks the member that keeps the suite slug (no alias needed, it is the
default tab).

| Suite slug | Suite name | Tabs (component = old slug) |
| --- | --- | --- |
| `pdf` | PDF toolkit | `pdf`* (Tools), `pdf-editor` (Editor and OCR, full-width) |
| `csv` | CSV workbench | `csv`*, `csv-select-columns`, `csv-merge`, `csv-pivot`, `tsv-markdown`, `fixed-width` |
| `csv-profile` | Table inspector | `csv-profile`*, `duplicate-rows`, `delimiter-detect`, `table-compare` |
| `json` | JSON workbench | `json`*, `jsonpath`, `json-pointer`, `json-diagram`, `json-schema`, `ndjson` |
| `yaml-json` | Config formats | `yaml-json`*, `ini`, `xml-xpath` |
| `svg-optimize` | SVG workshop | `svg-optimize`*, `svg-sanitize`, `svg-viewbox`, `svg-paths`, `svg-symbol-sprite`, `svg-to-png` |
| `image-resize` | Image export | `image-resize`*, `image-scrub`, `responsive-images`, `favicon-packager`, `image-to-data-uri` |
| `image-crop` | Image crop and layout | `image-crop`*, `transparent-trim`, `contact-sheet` |
| `image-compare` | Image inspector | `image-compare`*, `alpha-inspector` |
| `epoch` | Dates and time | `epoch`*, `date-format`, `duration-math`, `iso-week`, `date-distribution` |
| `meeting-timezones` | Scheduling | `meeting-timezones`*, `business-overlap`, `dst-explorer`, `workday-calculator`, `cron`, `rrule-preview` (tab `recurrence`) |
| `heading-audit` | HTML accessibility audit | `heading-audit`*, `link-text-audit`, `form-label-audit`, `landmark-audit` (shared `html-audit.ts`) |
| `reading-grade` | Writing analysis | `reading-grade`*, `sentence-complexity`, `punctuation-check`, `word-frequency` |
| `text` | Text kit | `text`*, `line-wrap`, `smart-quotes` |
| `characters` | Character, encoding and binary inspector | `characters`*, `encoding-detect`, `hex-viewer` (tab `hex`) |
| `css-grid` | CSS layout and type | `css-grid`*, `css-clamp`, `type-scale` |
| `box-shadow` | CSS effects | `box-shadow`*, `border-radius`, `css-easing` |
| `css-var-resolver` | CSS variables and tokens | `css-var-resolver`*, `design-tokens` |
| `http-headers` | HTTP workbench | `http-headers`*, `csp-builder`, `curl-builder`, `multipart-decoder` |
| `robots-txt` | Crawler files | `robots-txt`*, `sitemap-xml` |
| `url` | URL workbench | `url`*, `idn-inspector` |
| `ids` | IDs and hashes | `ids`*, `snowflake-decode` |
| `semver` | Versions and packages | `semver`*, `npm-lockfile` |
| `markdown` | Markdown | `markdown`* (Preview), `markdown-organizer` (tab `organize`) |
| `jwt` | Security | `jwt`*, `password` |
| `stacktrace` | Logs and traces | `stacktrace`*, `ansi-strip` (tab `ansi`) |
| `batch-rename` | File names and manifests | `batch-rename`*, `filename-normalizer`, `file-manifest-diff` |
| `sql-lab` | SQL lab | `sql-format` (Format, was standalone), `sql-convert`, `sql-validate`, `sql-build`, `sql-schema`, `sql-run` (Run, full-width, sql.js), `db-connect` (Connection) |
| `nosql-lab` | NoSQL and vector lab | `nosql-mongo`, `nosql-chroma`, `nosql-redis` |

## Standalone (8) and why

| Slug | Reason |
| --- | --- |
| `regex` | A full lab of its own; nothing else shares its input. |
| `diff` | One big self-contained tool, two inputs. |
| `qr` | Output tool (SVG/PNG) with no sibling. |
| `color` | Already multi-mode (convert, contrast, ramp); merging adds nothing. |
| `file-compressor` | Binary in/out; its only neighbors are PDF (server) and image tools (different formats). |
| `placeholder-text` | Generator with no input; no neighbor. |
| `lottie-inspector` | Animation JSON; no sibling after `json` (it would hide in the JSON suite). |
| `mcp-connect` | Connection/setup page for the MCP server, not a working tool. |

## Mechanism

- `ToolMeta.tabs?: { id, label, component, wide? }[]`. First tab is the default.
  `component` is the key in `registry-client.tsx` (the member's old slug).
- `SLUG_ALIASES`, `resolveAlias`, `canonicalSlug`, `toolHref` in
  `src/lib/registry.ts`. `/tools/[slug]` calls `permanentRedirect` for aliases.
- `src/components/SuiteShell.tsx`: `role=tablist`, roving tabindex, arrow keys,
  Home/End, `?tab=` via the History API (no reload), horizontally scrolling tab
  strip contained in its own box.
- Components are loaded with `next/dynamic`, so a tab downloads only when opened.
- Search: a suite's keywords include each member's old name and keywords, so
  searching "snowflake", "favicon" or "NDJSON" still finds the suite.

## Database labs (2026-10)

Two suites for people who do not know the query languages and for the assistant. No live database connection exists anywhere:
`sql-lab` runs SQLite in the browser (sql.js) on a file you open, everything else generates, converts and checks text.
- Engine: `server/py/scripts/sql_tool.py` + `sqlkit/` (sqlglot) behind `POST /api/sql` (`src/lib/sql/types.ts` is the contract: QuerySpec, dialects, actions). `knife_sql_*` tools expose it to the assistant and MCP.
- NoSQL: pure TypeScript in `src/lib/nosql/` (Mongo, Chroma, Redis); `knife_mongo_*`, `knife_chroma_*`, `knife_redis_*`.
- Idea: the assistant states the request as a JSON spec and a deterministic compiler renders dialect/client syntax, then validates it (SQL is also checked against the user's schema) instead of writing syntax from memory.
