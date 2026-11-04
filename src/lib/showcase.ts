import { msg } from "@/lib/i18n/msg";

/**
 * Tool showcases (docs/SHOWCASE.md): what each top-level tool of the registry is for, shown on `/tools/<slug>/about`
 * before the tool opens. Keyed by registry slug (tabs share their suite's showcase; the Craft apps share one that lists
 * the thirteen apps). Pure data, browser and server; every text is an English key translated through the catalogue.
 * `tests/showcase.test.mjs` requires an entry for every TOOLS slug and the image file of every entry that names one.
 */

/** Where the work happens: this browser tab, this app's server, or an optional docker service on the server. */
export type ShowcaseRuns = "browser" | "server" | "sidecar";

export interface ShowcaseImage {
  /** Public path, `/showcase/<slug>.webp` (1280x800, Polish UI), made by scripts/showcase_shots.py. */
  src: string;
  /** "screenshot" = the real page with demo data; "illustration" = a labelled picture made from the real UI. */
  kind: "screenshot" | "illustration";
}

export interface Showcase {
  /** One line: what it is for. */
  purpose: string;
  /** 3-6 things you can do. */
  points: string[];
  /** Who it is for. */
  audience: string;
  runs: ShowcaseRuns[];
  /** Plainly: do your files or data leave the device, and where to. */
  data: string;
  /** What the AI assistant can do there. */
  assistant: string;
  image: ShowcaseImage | null;
  /** Craft apps only: the apps in the collection with what each one is. */
  apps?: { name: string; what: string }[];
}

const shot = (slug: string): ShowcaseImage => ({ src: `/showcase/${slug}.webp`, kind: "screenshot" });

const BROWSER_ONLY = msg("Your files and text stay on your device: the tool runs in this browser tab and uploads nothing.");
const ASSISTANT_DRIVES = msg("The assistant can open the tool, fill in the fields from your request, run it and read you the result; it uses your own files only after you pick them.");
const ASSISTANT_MCP = msg("The assistant (and outside agents over MCP) can do the same work with deterministic tools and show you the result on this page.");

export const SHOWCASES: Readonly<Record<string, Showcase>> = {
  web: {
    purpose: msg("Check a live website and prepare the files and headers every site needs."),
    points: [
      msg("Check redirects, security headers, robots.txt, the sitemap, headings and links of a page."),
      msg("Build a Content Security Policy and a cURL command step by step."),
      msg("Take a URL apart, inspect international domain names and edit query parameters."),
      msg("Write robots.txt and sitemaps and test which addresses they allow."),
    ],
    audience: msg("Website owners, front-end developers and anyone checking a site before launch."),
    runs: ["browser", "server"],
    data: msg("The builders run in your browser; a website check asks this server to fetch the public page you typed, nothing else."),
    assistant: ASSISTANT_DRIVES,
    image: shot("web"),
  },
  css: {
    purpose: msg("Try HTML, CSS and JavaScript live and build the CSS values you keep looking up."),
    points: [
      msg("Edit HTML, CSS and JS/TS side by side with a live preview, effect presets and export."),
      msg("Build box shadows, border radii, easing curves and grids visually."),
      msg("Get fluid clamp() sizes, a type scale and accessible colours."),
    ],
    audience: msg("Front-end developers and designers who prototype in the browser."),
    runs: ["browser"],
    data: BROWSER_ONLY,
    assistant: ASSISTANT_DRIVES,
    image: shot("css"),
  },
  "sql-lab": {
    purpose: msg("Work with SQL without a database connection: tidy it, convert it, check it and run it on a file."),
    points: [
      msg("Format SQL and convert it between dialects (PostgreSQL, MySQL, SQLite, T-SQL and more), with a list of what does not convert exactly."),
      msg("Validate a query against your schema: unknown tables and columns with suggestions."),
      msg("Turn CREATE TABLE statements into a schema and a diagram."),
      msg("Run SQL on a SQLite file or a CSV in the browser."),
    ],
    audience: msg("Developers, analysts and students who write SQL by hand."),
    runs: ["browser", "server"],
    data: msg("Running SQL on a file happens in your browser. Formatting, converting and checking send only the SQL text to this server and keep nothing."),
    assistant: ASSISTANT_MCP,
    image: shot("sql-lab"),
  },
  "svg-optimize": {
    purpose: msg("Make SVG files smaller and safe, then export them as PNG."),
    points: [
      msg("Optimize an SVG and see how much smaller it got."),
      msg("Remove scripts and other risky parts from an SVG before you publish it."),
      msg("Fix the viewBox, inspect paths and export a PNG at any size."),
    ],
    audience: msg("Designers and developers who put icons and illustrations on the web."),
    runs: ["browser"],
    data: BROWSER_ONLY,
    assistant: ASSISTANT_DRIVES,
    image: shot("svg-optimize"),
  },
  "image-crop": {
    purpose: msg("Crop images to the right shape and trim empty margins."),
    points: [
      msg("Crop to a ratio such as 16:9 or 1:1, or freely."),
      msg("Trim transparent margins around a cut-out."),
      msg("Arrange several images into one contact sheet."),
    ],
    audience: msg("Anyone preparing pictures for a site, a post or a document."),
    runs: ["browser"],
    data: BROWSER_ONLY,
    assistant: ASSISTANT_DRIVES,
    image: shot("image-crop"),
  },
  "image-compare": {
    purpose: msg("See exactly what changed between two images."),
    points: [
      msg("Compare side by side, as an overlay with a slider, or as a pixel difference."),
      msg("Inspect the transparency of an image."),
      msg("Spot small changes between two versions of a screenshot or a design."),
    ],
    audience: msg("Designers, testers and developers checking visual changes."),
    runs: ["browser"],
    data: BROWSER_ONLY,
    assistant: ASSISTANT_DRIVES,
    image: shot("image-compare"),
  },
  "image-resize": {
    purpose: msg("Prepare images for the web: the right size, format and no hidden metadata."),
    points: [
      msg("Resize and convert to WebP, JPEG or PNG."),
      msg("Remove location and camera data before you share a photo."),
      msg("Build responsive srcset variants and a full favicon set."),
      msg("Turn a small image into a data URI."),
    ],
    audience: msg("Website owners, bloggers and developers."),
    runs: ["browser"],
    data: BROWSER_ONLY,
    assistant: ASSISTANT_DRIVES,
    image: shot("image-resize"),
  },
  pdf: {
    purpose: msg("Do everyday PDF work: edit, merge, split, compress, protect and read scans."),
    points: [
      msg("Merge, split, compress and password-protect PDF files."),
      msg("Rotate, reorder and redact pages and scans in the editor."),
      msg("Extract text in the browser, or make a scanned PDF searchable with OCR on this server."),
    ],
    audience: msg("Anyone who handles PDF documents at work or at home."),
    runs: ["browser", "server"],
    data: msg("Text extraction and the editor work in your browser. Merging, compressing, protecting and OCR send the file to this server, which deletes it when the job ends."),
    assistant: ASSISTANT_DRIVES,
    image: shot("pdf"),
  },
  json: {
    purpose: msg("Read, fix and convert JSON and configuration files."),
    points: [
      msg("Lint and format JSON and NDJSON with clear error positions."),
      msg("Query with JSONPath and draw the structure as a diagram."),
      msg("Validate against a JSON Schema."),
      msg("Convert YAML, INI and XML, and query XML with XPath."),
    ],
    audience: msg("Developers and administrators working with APIs and config files."),
    runs: ["browser"],
    data: BROWSER_ONLY,
    assistant: ASSISTANT_DRIVES,
    image: shot("json"),
  },
  csv: {
    purpose: msg("Clean up and reshape tables without a spreadsheet."),
    points: [
      msg("Convert CSV to JSON and back, and detect the delimiter."),
      msg("Select columns, merge files and build pivot tables."),
      msg("Profile the columns and find duplicate rows."),
      msg("Compare two tables row by row."),
    ],
    audience: msg("Analysts, office workers and developers handling exported data."),
    runs: ["browser"],
    data: BROWSER_ONLY,
    assistant: ASSISTANT_DRIVES,
    image: shot("csv"),
  },
  text: {
    purpose: msg("Transform text line by line and generate the text you need."),
    points: [
      msg("Change case, sort, remove duplicates and number lines."),
      msg("Encode and decode Base64, URLs and HTML entities."),
      msg("Generate placeholder text and normalise file names."),
    ],
    audience: msg("Writers, editors and developers who clean up text."),
    runs: ["browser"],
    data: BROWSER_ONLY,
    assistant: ASSISTANT_DRIVES,
    image: shot("text"),
  },
  regex: {
    purpose: msg("Write a regular expression and see what it matches before you use it."),
    points: [
      msg("Live matches with capture groups as you type."),
      msg("A replace preview with the exact result."),
      msg("Generate a pattern from examples that must and must not match, checked against them."),
    ],
    audience: msg("Developers and anyone who searches and replaces in bulk."),
    runs: ["browser"],
    data: BROWSER_ONLY,
    assistant: ASSISTANT_MCP,
    image: shot("regex"),
  },
  ids: {
    purpose: msg("Generate identifiers, hashes and strong passwords, and decode tokens."),
    points: [
      msg("Generate UUIDs, ULIDs and other IDs, and hash text."),
      msg("Decode Snowflake IDs and JWT tokens, and check a JWT signature."),
      msg("Make strong passwords and passphrases."),
    ],
    audience: msg("Developers and anyone who needs a secure password."),
    runs: ["browser"],
    data: msg("Everything is generated and decoded in your browser; tokens and passwords are never sent anywhere."),
    assistant: ASSISTANT_MCP,
    image: shot("ids"),
  },
  qr: {
    purpose: msg("Make a QR code for a link, a text or a Wi-Fi network."),
    points: [
      msg("Encode a link or any text, Wi-Fi settings included."),
      msg("Download it as SVG or PNG."),
      msg("Choose the size and the error correction level."),
    ],
    audience: msg("Anyone who prints a poster, a menu or a business card."),
    runs: ["browser"],
    data: BROWSER_ONLY,
    assistant: ASSISTANT_DRIVES,
    image: shot("qr"),
  },
  "mcp-connect": {
    purpose: msg("Connect outside AI agents (Claude Code, Cursor, OpenClaw) to your Smart Knife tools."),
    points: [
      msg("Copy the MCP address and a ready-made configuration for an agent."),
      msg("Create personal MCP keys, also read-only ones, in your account settings."),
      msg("Learn how the built-in assistant and outside agents share the same tools."),
    ],
    audience: msg("People who work with AI agents and want them to use these tools on their own account."),
    runs: ["browser", "server"],
    data: msg("An agent you connect works on your account's data through your key; you can revoke the key at any time."),
    assistant: msg("This page is about agents: the built-in assistant and outside agents use the same tools on your account."),
    image: shot("mcp-connect"),
  },
  dates: {
    purpose: msg("Answer every question about dates, time zones and schedules."),
    points: [
      msg("Convert Unix timestamps and time zones, and see daylight-saving changes."),
      msg("Format dates and count durations and working days."),
      msg("Plan a meeting across time zones."),
      msg("Read and build cron expressions and recurrence rules."),
    ],
    audience: msg("Developers, administrators and people working across time zones."),
    runs: ["browser"],
    data: BROWSER_ONLY,
    assistant: ASSISTANT_MCP,
    image: shot("dates"),
  },
  diff: {
    purpose: msg("Compare two texts line by line and word by word."),
    points: [
      msg("See every change highlighted, line and word level."),
      msg("Read the changes side by side or as one list."),
      msg("Copy a unified patch."),
    ],
    audience: msg("Developers, editors and anyone comparing two versions of a text."),
    runs: ["browser"],
    data: BROWSER_ONLY,
    assistant: ASSISTANT_MCP,
    image: shot("diff"),
  },
  markdown: {
    purpose: msg("Write and tidy Markdown with a safe live preview."),
    points: [
      msg("Preview Markdown live, with unsafe HTML removed."),
      msg("Convert HTML to Markdown."),
      msg("Tidy headings and lists and build a table of contents."),
    ],
    audience: msg("Writers of documentation, READMEs and notes."),
    runs: ["browser"],
    data: BROWSER_ONLY,
    assistant: ASSISTANT_DRIVES,
    image: shot("markdown"),
  },
  characters: {
    purpose: msg("Find invisible characters, wrong encodings and odd bytes in text."),
    points: [
      msg("See every character with its Unicode name, including invisible ones."),
      msg("Detect a file's text encoding."),
      msg("View the bytes of a file as hex."),
    ],
    audience: msg("Developers and editors chasing a character that breaks their text."),
    runs: ["browser"],
    data: BROWSER_ONLY,
    assistant: ASSISTANT_MCP,
    image: shot("characters"),
  },
  "cv-studio": {
    purpose: msg("Write your CV once in Polish and English, then tailor it to each job offer."),
    points: [
      msg("Keep one master profile in two languages, for several people or career directions."),
      msg("Save job offers and see which requirements your profile covers."),
      msg("Make a CV version per offer, check it like an ATS would and export PDF or DOCX."),
      msg("Track applications and their next steps."),
      msg("Present your GitHub projects and check your website against the CV."),
    ],
    audience: msg("Job seekers and people who keep their CV and portfolio up to date."),
    runs: ["server"],
    data: msg("Your CV, offers and applications are stored on this server in your account, encrypted; they are sent to an AI provider only when you ask the assistant."),
    assistant: msg("The assistant can import a pasted CV, translate it, tailor a version to an offer without inventing facts, run the ATS check and update your applications."),
    image: shot("cv-studio"),
  },
  workflows: {
    purpose: msg("Automate repeatable work with visual workflows, like in n8n."),
    points: [
      msg("Connect nodes on a canvas: HTTP requests, data steps, conditions, code and AI."),
      msg("Run a workflow by hand, on a schedule or from a webhook."),
      msg("Keep credentials encrypted and see the history of every run."),
    ],
    audience: msg("People who want to connect services and automate tasks without a separate server."),
    runs: ["server"],
    data: msg("Workflows, their runs and credentials are stored on this server in your account; a workflow sends data only to the addresses its nodes name."),
    assistant: msg("The assistant can build, edit and run workflows for you and explain why a run failed."),
    image: shot("workflows"),
  },
  office: {
    purpose: msg("Create and edit Word, Excel and PowerPoint files in your private office."),
    points: [
      msg("Create, upload and edit DOCX, XLSX and PPTX (also ODT, ODS and ODP)."),
      msg("Keep documents in folders, with earlier versions kept on every save."),
      msg("Download your files in their original format at any time."),
    ],
    audience: msg("Anyone who needs an office suite without installing one."),
    runs: ["sidecar"],
    data: msg("Documents are stored on this server in your account and edited in a self-hosted editor; they never go to an outside office service."),
    assistant: msg("The assistant can create documents, read them, and edit the open document live: text, formatting, tables, cells and slides."),
    image: null,
  },
  "db-course": {
    purpose: msg("Learn SQL and PostGIS step by step on a real PostgreSQL database."),
    points: [
      msg("Short lessons from the first SELECT to spatial queries."),
      msg("Write real queries and get an instant check with hints."),
      msg("Your progress is saved, so you can continue where you stopped."),
    ],
    audience: msg("Beginners and anyone refreshing SQL or learning GIS queries."),
    runs: ["sidecar"],
    data: msg("Your queries run on a practice database on this server and are always rolled back; only your progress is saved in your account."),
    assistant: msg("The assistant is a tutor here: it explains errors and gives hints without handing you the answer, unless you ask for it."),
    image: shot("db-course"),
  },
  artcraft: {
    purpose: msg("Thirteen open-source creative apps for images, video, sound, documents and design, in your browser."),
    points: [
      msg("Edit photos and raw files, draw vectors and design interfaces."),
      msg("Cut video, make motion graphics and record or mix audio."),
      msg("Lay out pages, write documents, make slides, spreadsheets, PDFs and CAD drawings."),
      msg("Save your work to Craft files in your account when you want it on the server."),
    ],
    audience: msg("Creators who want capable apps without installing or paying for them."),
    runs: ["sidecar", "browser"],
    data: msg("The apps run in your browser and keep your work in its storage; a file goes to the server only when you save it to Craft files."),
    assistant: msg("In VectorCraft, FilmCraft and EffectCraft the assistant can inspect the open project, run the app's commands, take screenshots and keep exports in your Craft files."),
    image: null,
    apps: [
      { name: "PhotoCraft", what: msg("image editor") },
      { name: "VectorCraft", what: msg("vector illustration") },
      { name: "FilmCraft", what: msg("video editor") },
      { name: "LightCraft", what: msg("photo library and raw developer") },
      { name: "EffectCraft", what: msg("motion graphics and effects") },
      { name: "DesignCraft", what: msg("page layout") },
      { name: "PdfCraft", what: msg("PDF workbench") },
      { name: "FigCraft", what: msg("interface design") },
      { name: "WordCraft", what: msg("word processor") },
      { name: "SoundCraft", what: msg("audio workstation") },
      { name: "DeckCraft", what: msg("presentations") },
      { name: "CADCraft", what: msg("CAD") },
      { name: "GridCraft", what: msg("spreadsheet") },
    ],
  },
  sidecars: {
    purpose: msg("Install and look after the optional services some tools need."),
    points: [
      msg("Install, start, stop, update and remove the office editor, the course database and the Craft apps."),
      msg("See each service's state, health and last operations."),
      msg("Services start when a tool needs them and stop when idle."),
    ],
    audience: msg("The administrator of this Smart Knife server."),
    runs: ["server", "sidecar"],
    data: msg("Services run as containers on this server; installing one downloads it from its publisher."),
    assistant: msg("The assistant can open this page and tell you which service a tool needs; installing stays your decision."),
    image: shot("sidecars"),
  },
};

export function showcaseFor(slug: string): Showcase | null {
  return Object.hasOwn(SHOWCASES, slug) ? SHOWCASES[slug] : null;
}

/** Where the "about" page of a tool lives (tabs share the suite's page; `tab` is carried to the Open button). */
export function showcaseHref(slug: string, tab?: string | null): string {
  return `/tools/${slug}/about${tab ? `?tab=${encodeURIComponent(tab)}` : ""}`;
}
