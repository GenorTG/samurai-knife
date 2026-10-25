# Tool audit: what earns its place (2026-10-25)

33 tools, about 140 tabs. Every tool and tab was judged on four questions:

1. **Real use**: would a person of this app (developer, job seeker, office worker, the owner) reach for it in real work?
2. **Already covered**: does another tab here, the assistant, the browser or the OS already do it as well or better?
3. **Real input**: does it work on the real thing (a URL, a file, a document), or only on text pasted for the occasion?
   A check that needs a live site (headers, accessibility) belongs in a tool that visits the site.
4. **Cost**: parsers and libraries to keep patched, tests to keep green, menu space.

Verdicts: **Keep**; **Merge** (fold into another tab: one place instead of two); **Replace** (the need is real, the
tool is the wrong shape); **Remove**. Removing a tool keeps its slug as a redirect (slugs are bookmarks), and the
matching `knife_*` MCP tools can stay for agents even when the page goes.

## Remove whole tools (7)

| Tool | Tabs | Why |
|---|---|---|
| Logs and traces (`stacktrace`) | Stack traces, ANSI stripper | Line-joining pasted traces and stripping colour codes: a one-off, the assistant does it in one message. |
| HTML accessibility audit (`heading-audit`) | Headings, Links, Form labels, Landmarks | Checks pasted HTML snippets; the real need is auditing a live page. Website studio already runs Lighthouse (accessibility included) on your site; see "Replace" for a URL check. |
| Writing analysis (`reading-grade`) | Reading grade, Sentences, Punctuation, Word frequency | Readability formulas and word counts: academic, rarely acted on; the assistant gives better feedback on a text. |
| Versions and packages (`semver`) | Semver, Lockfile | Comparing semver ranges and npm lockfile duplicates: `npm` itself does both. |
| File names and manifests (`batch-rename`) | Batch rename, Normalize, Manifest diff | A preview of renames it cannot perform, and manifest diffs: niche. |
| NoSQL and vector lab (`nosql-lab`) | MongoDB, Chroma, Redis | Turns a JSON query spec into driver code: built for agents; the MCP tools (`knife_mongo_*`, `knife_chroma_*`, `knife_redis_*`) stay. |
| File compressor (`file-compressor`) | – | gzip/zlib of a single file in the browser: every OS and archiver does it. |

## Remove tabs (22)

| Tool | Tab | Why |
|---|---|---|
| Web workbench | Multipart | Decoding raw MIME multipart bodies: very rare. |
| Web workbench | IDN & Punycode | Rare; the URL tab can show the punycode host. |
| IDs, tokens and passwords | Snowflake | Discord/Twitter ID timestamps: niche. |
| Dates and scheduling | Date range | Spreading dates over a range: niche. |
| Dates and scheduling | DST | DST transition explorer: niche; Epoch & zones covers offsets. |
| JSON and config | Pointer | JSON Pointer: JSONPath covers lookups. |
| JSON and config | INI | INI files are rare now. |
| JSON and config | NDJSON | Fold the line-by-line check into Lint (detect NDJSON) instead of a tab. |
| Tables and CSV | Fixed width | Fixed-width columns: rare. |
| Tables and CSV | Delimiter | The converter detects the delimiter already. |
| SQL lab | Build | SQL from a JSON query spec: for agents; `knife_sql_compile` stays. |
| CSS studio | Resolver | Resolving CSS variables by hand: the playground shows the result live. |
| CSS studio | Tokens | Design-token JSON validation: niche. |
| SVG workshop | viewBox | Fixing viewBoxes: Optimize does the common case. |
| SVG workshop | Paths | Path inspector: niche. |
| SVG workshop | Sprite | Symbol sprites: niche. |
| Image inspector | Alpha | Alpha-channel viewer: niche. |
| Image inspector | Lottie JSON | Lottie file checker: niche. |
| Image export | Data URI | One line in the assistant, or the browser's devtools. |
| Image crop and layout | Contact sheet | Rare. |
| Characters and encoding | Hex viewer | Rare in a browser toolbox. |
| Markdown | Organize | Renumbering headings and TOCs: the assistant does it. |

## Merge (5)

| From | Into | How |
|---|---|---|
| Text kit: Line wrap, Smart quotes | Text kit: Transforms | Two more transforms in the list, not tabs. |
| Dates: ISO week | Dates: Date format | Show the ISO week with every date. |
| Dates: Hour overlap | Dates: Meeting planner | The overlap is the planner's main view. |
| Tables and CSV: TSV to Markdown | Tables and CSV: Convert | "Markdown table" as one more output format. |
| Image inspector (Compare only left) | – | Done as: the tool is now "Image compare", one page without tabs. |

## Replace (1)

| Now | Instead |
|---|---|
| Web workbench: Headers (paste headers to inspect them) | **Website check**: enter a URL; the server fetches it (the existing safe `knife_inspect_url` path: SSRF rules, size caps) and shows the redirect chain, status, security headers with fixes, robots.txt, the sitemap, and a quick accessibility and SEO pass on the fetched HTML (headings, link text, form labels, landmarks, title/description). One real-input tool instead of four pasted-snippet checks. |

## Keep

Office documents; PDF toolkit; Markdown (Preview & convert); Image export (Resize, Scrub metadata, Responsive set,
Favicons); Image crop (Crop, Trim); SVG workshop (Optimize, Sanitize, To PNG); Image inspector (Compare); QR codes; all
Craft apps; Tables and CSV (Convert, Columns, Merge, Pivot, Profile, Duplicates, Compare); JSON and config (Lint, JSONPath,
Diagram, Schema, YAML, XML); SQL lab (Format, Convert, Validate, Schema, Run, Connection); Text kit (Transforms,
Generate); Regex lab; Diff; Characters and encoding (Characters, File encoding); CSS studio (Playground and the builders);
Web workbench (URL, cURL, CSP, robots.txt, Sitemap); IDs, tokens and passwords (IDs & hashes, JWT, Passwords); Dates
(Epoch & zones, Date format, Durations, Meeting planner, Workdays, Cron, Recurrence); CV studio; Website studio;
Workflows; Database course; Services; MCP connect.

## Result

33 tools / ~140 tabs → 26 tools / ~95 tabs, and every page left either works on real input or builds something you take
away. Removal is mechanical per item: registry entry or tab, component, its tests and docs, the nav entry, a
`SLUG_ALIASES` redirect for a removed tool (to its closest neighbour, or the home page with a note).


## Done (2026-10-25)

Applied as listed, in v0.9.1: the removals, the merges (each merged tab renders both former tools on one page, with
unique field labels), the Website check (`src/tools/WebsiteCheck.tsx`, `POST /api/web/check`), and redirects for every
removed slug and tab alias (tests/nav.test.mjs).
