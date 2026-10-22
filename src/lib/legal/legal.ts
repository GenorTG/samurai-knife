import { createHash, randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Marked, type Tokens } from "marked";
import { dataDir } from "@/lib/accounts/store";
import { appVersion } from "@/lib/version";

/**
 * The instance's legal pages: Terms of Service (`terms`) and the privacy notice (`privacy`), Polish and English
 * (docs/LEGAL.md). Every instance is run by someone else, so the texts are the operator's:
 *
 *   $KNIFE_LEGAL_DIR (default $KNIFE_DATA_DIR/legal; never in git)
 *     legal.json          the operator's details, filled into {{placeholders}} (legal/legal.example.json)
 *     terms.pl.md ...     a full replacement of one page (optional): copy legal/<doc>.<lang>.md and edit it
 *   legal/<doc>.<lang>.md  the defaults shipped in the repo, with {{placeholders}}
 *   legal/versions.json    the editions of the defaults (number, date, app version, digest of the four files) and what
 *                          the current edition covers (cookies, storage areas): tests/legal.test.mjs holds the repo to it
 *   legal/editions/<n>/    the default texts of every earlier edition
 *   $KNIFE_DATA_DIR/legal-history/   one record per version this instance has shown (the exact texts, when first shown)
 *
 * A placeholder without a value renders as a visible gap and marks the page incomplete (the page shows a warning; the
 * server logs it at startup in public mode). The version that sign-up records is a fingerprint (hash) of every rendered
 * page, so any change of text or details is a new version (`legal.json` "version" overrides it with a name of your
 * choice). The effective date is left out of the fingerprint: it is legal.json `effectiveDate` or the day this instance
 * first showed the version, whichever is later, so a new release's texts never claim an earlier date.
 */

export const LEGAL_DOCS = ["terms", "privacy"] as const;
export const LEGAL_LANGS = ["pl", "en"] as const;
export type LegalDoc = (typeof LEGAL_DOCS)[number];
export type LegalLang = (typeof LEGAL_LANGS)[number];

export interface LegalPage {
  doc: LegalDoc;
  lang: LegalLang;
  /** The text after placeholders were filled (Markdown). */
  markdown: string;
  /** Sanitized HTML of `markdown`. */
  html: string;
  /** Placeholders that had no value. */
  missing: string[];
  /** Where the text came from: the operator's own file, the repo default, the instance's history, or an earlier edition. */
  source: "instance" | "default" | "history" | "edition";
  version: string;
  effectiveDate: string | null;
  /** Edition of the default texts (legal/versions.json), null for an operator's own texts. */
  edition: number | null;
  /** When this instance first showed the version (ISO), null if not recorded yet. */
  publishedAt: string | null;
  /** The Smart Knife version that showed it first (the running one for the current version). */
  app: string;
  /** false: an earlier version, shown for the record. */
  current: boolean;
}

export interface LegalEdition {
  edition: number;
  published: string;
  app: string;
  digest: string;
}

/** One version as this instance showed it (legal-history/<key>.json). */
export interface LegalRecord {
  version: string;
  publishedAt: string;
  edition: number | null;
  app: string;
  /** legal.json effectiveDate at the time (raw), so the record's date is computed the same way later. */
  operatorEffectiveDate: string | null;
  /** Fingerprint of each document alone: tells whether the Terms changed between two versions. */
  digests: Record<LegalDoc, string>;
  /** Filled texts with {{effectiveDate}} still in place, keyed `<doc>.<lang>`. */
  pages: Record<string, string>;
}

export interface LegalHistoryEntry {
  version: string;
  edition: number | null;
  publishedAt: string;
  /** When the next version was first shown (ISO), null for the newest. */
  until: string | null;
  app: string;
  current: boolean;
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;
const DEFAULT_VARS: Record<string, string> = { siteName: "Smart Knife", minimumAge: "16" };
const DATE_VAR = "effectiveDate";
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RECORDS = 500;

export function legalDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.KNIFE_LEGAL_DIR?.trim() || join(dataDir(), "legal");
}

/** Where the instance keeps the versions it has shown (the data dir: KNIFE_LEGAL_DIR may be read-only to the app). */
export function legalHistoryDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.KNIFE_DATA_DIR?.trim() || dataDir(), "legal-history");
}

function readText(path: string): string | null {
  try {
    return existsSync(/*turbopackIgnore: true*/ path) ? readFileSync(/*turbopackIgnore: true*/ path, "utf8") : null;
  } catch {
    return null;
  }
}

/** legal.json: flat string values only; anything else is ignored (never a crash on a hand-edited file). */
export function legalVars(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const vars: Record<string, string> = { ...DEFAULT_VARS };
  const publicUrl = env.KNIFE_PUBLIC_URL?.trim();
  if (publicUrl) vars.siteUrl = publicUrl.replace(/\/+$/, "");
  const raw = readText(join(legalDir(env), "legal.json"));
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key) && (typeof value === "string" || typeof value === "number")) {
            const text = String(value).trim();
            if (text) vars[key] = text;
          }
        }
      }
    } catch {
      // Malformed JSON: the defaults stay and the placeholders show as missing.
    }
  }
  return vars;
}

const shippedPath = (doc: LegalDoc, lang: LegalLang, edition?: number): string =>
  edition === undefined ? join(process.cwd(), "legal", `${doc}.${lang}.md`) : join(process.cwd(), "legal", "editions", String(edition), `${doc}.${lang}.md`);

function template(doc: LegalDoc, lang: LegalLang, env: NodeJS.ProcessEnv): { text: string; source: "instance" | "default" } {
  const own = readText(join(legalDir(env), `${doc}.${lang}.md`));
  if (own !== null) return { text: own, source: "instance" };
  const shipped = readText(shippedPath(doc, lang));
  return { text: shipped ?? `# ${doc}\n\n{{${doc}TextMissing}}\n`, source: "default" };
}

/** Fills {{placeholders}}; names in `keep` stay as they are (the effective date is filled last, outside the fingerprint). */
export function fill(text: string, vars: Record<string, string>, keep: ReadonlySet<string> = new Set()): { text: string; missing: string[] } {
  const missing = new Set<string>();
  const filled = text.replace(PLACEHOLDER, (whole, name: string) => {
    if (keep.has(name)) return whole;
    const value = vars[name];
    if (value === undefined) {
      missing.add(name);
      return `[${name}?]`;
    }
    return value;
  });
  return { text: filled, missing: [...missing] };
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function safeHref(href: string): string | null {
  const value = href.trim();
  if (/^(https?:|mailto:)/i.test(value)) return value;
  if (/^(#|\/(?!\/))/.test(value)) return value;
  return null;
}

/**
 * Markdown to HTML without a DOM: raw HTML in the text is shown as text, links only to http(s), mailto, same-site paths
 * and anchors, no images. The texts are the operator's, but a hand-edited file must still never inject script.
 */
export function renderLegalMarkdown(markdown: string): string {
  return LEGAL_MARKED.parse(markdown, { async: false }) as string;
}

const LEGAL_MARKED = new Marked({
  gfm: true,
  renderer: {
    // `## Title {#id}` gives the heading a stable anchor (the assistant links to /terms#ai); nothing else gets an id.
    heading(token: Tokens.Heading) {
      const inner = this.parser.parseInline(token.tokens).replace(/\s*\{#[a-z0-9-]+\}\s*$/, "");
      const id = /\{#([a-z0-9-]+)\}\s*$/.exec(token.text)?.[1];
      return `<h${token.depth}${id ? ` id="${id}"` : ""}>${inner}</h${token.depth}>\n`;
    },
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(text);
    },
    image({ text }: Tokens.Image) {
      return escapeHtml(text);
    },
    link(token: Tokens.Link) {
      const label = this.parser.parseInline(token.tokens);
      const href = safeHref(token.href);
      if (!href) return label;
      const external = /^https?:/i.test(href);
      return `<a href="${escapeHtml(href)}"${external ? ' rel="noopener noreferrer"' : ""}>${label}</a>`;
    },
  },
});

/* ------------------------------------------------------------------------------------------- editions */

const pageKey = (doc: LegalDoc, lang: LegalLang): string => `${doc}.${lang}`;

/** Digest of the four default texts (the raw templates): legal/versions.json names one per edition. */
export function defaultTextsDigest(edition?: number): string {
  const hash = createHash("sha256");
  for (const doc of LEGAL_DOCS) {
    for (const lang of LEGAL_LANGS) hash.update(`${pageKey(doc, lang)}\0${readText(shippedPath(doc, lang, edition)) ?? ""}\0`);
  }
  return hash.digest("hex").slice(0, 16);
}

/** legal/versions.json editions, newest first; [] when the file is missing or unreadable. */
export function legalEditions(): LegalEdition[] {
  try {
    const parsed = JSON.parse(readText(join(process.cwd(), "legal", "versions.json")) ?? "{}") as { editions?: unknown };
    if (!Array.isArray(parsed.editions)) return [];
    return parsed.editions
      .filter((e): e is LegalEdition => !!e && typeof e === "object" && Number.isInteger((e as LegalEdition).edition) && typeof (e as LegalEdition).published === "string")
      .map((e) => ({ edition: e.edition, published: e.published, app: String(e.app ?? ""), digest: String(e.digest ?? "") }))
      .sort((a, b) => b.edition - a.edition);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------------------------------- current version */

interface Current {
  version: string;
  edition: number | null;
  /** Filled texts with {{effectiveDate}} still in place. */
  pages: Array<{ doc: LegalDoc; lang: LegalLang; text: string; missing: string[]; source: "instance" | "default" }>;
  digests: Record<LegalDoc, string>;
  vars: Record<string, string>;
}

function current(env: NodeJS.ProcessEnv): Current {
  const vars = legalVars(env);
  const keep = new Set([DATE_VAR]);
  const pages = LEGAL_DOCS.flatMap((doc) =>
    LEGAL_LANGS.map((lang) => {
      const { text, source } = template(doc, lang, env);
      return { doc, lang, source, ...fill(text, vars, keep) };
    }),
  );
  const docHash = (docs: readonly LegalDoc[]) => {
    const hash = createHash("sha256");
    for (const page of pages) if (docs.includes(page.doc)) hash.update(`${pageKey(page.doc, page.lang)}\0${page.text}\0`);
    return hash.digest("hex").slice(0, 12);
  };
  const digests = { terms: docHash(["terms"]), privacy: docHash(["privacy"]) };
  const version = vars.version ? vars.version.slice(0, 64) : docHash(LEGAL_DOCS);
  let edition: number | null = null;
  if (pages.every((page) => page.source === "default")) {
    const digest = defaultTextsDigest();
    edition = legalEditions().find((e) => e.digest === digest)?.edition ?? null;
  }
  return { version, edition, pages, digests, vars };
}

/** The version a sign-up accepts: legal.json "version", else a fingerprint over every rendered page (both docs, both languages). */
export function legalVersion(env: NodeJS.ProcessEnv = process.env): string {
  return current(env).version;
}

/** legal.json effectiveDate, unless the version was first shown later (then that day): a text never claims an earlier date. */
export function effectiveDateFor(operator: string | null | undefined, publishedAt: string | null, now = new Date()): string {
  const published = (publishedAt ?? now.toISOString()).slice(0, 10);
  if (!operator) return published;
  if (ISO_DAY.test(operator)) return operator > published ? operator : published;
  return operator;
}

/* ------------------------------------------------------------------------------------------- history */

const recordFile = (env: NodeJS.ProcessEnv, version: string): string =>
  join(legalHistoryDir(env), `${createHash("sha256").update(version).digest("hex").slice(0, 24)}.json`);

function parseRecord(raw: string | null): LegalRecord | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as LegalRecord;
    if (typeof value.version !== "string" || typeof value.publishedAt !== "string" || !value.pages || typeof value.pages !== "object") return null;
    return value;
  } catch {
    return null;
  }
}

export function legalRecord(version: string, env: NodeJS.ProcessEnv = process.env): LegalRecord | null {
  const record = parseRecord(readText(recordFile(env, version)));
  return record && record.version === version ? record : null;
}

let recordWarned = false;

/**
 * Keeps the current version's exact texts in the instance's history the first time it is shown or accepted (the legal
 * pages, the sign-up page, every sign-up), so what a person accepted stays readable after the texts change. First write
 * wins (link, not rename); a read-only data dir only logs once and never breaks a page.
 */
export function recordLegalVersion(env: NodeJS.ProcessEnv = process.env, now = new Date()): LegalRecord | null {
  const cur = current(env);
  const existing = legalRecord(cur.version, env);
  if (existing) return existing;
  const record: LegalRecord = {
    version: cur.version,
    publishedAt: now.toISOString(),
    edition: cur.edition,
    app: appVersion(),
    operatorEffectiveDate: cur.vars[DATE_VAR] ?? null,
    digests: cur.digests,
    pages: Object.fromEntries(cur.pages.map((page) => [pageKey(page.doc, page.lang), page.text])),
  };
  const path = recordFile(env, cur.version);
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    mkdirSync(legalHistoryDir(env), { recursive: true, mode: 0o700 });
    writeFileSync(temp, `${JSON.stringify(record, null, 1)}\n`, { mode: 0o600 });
    try {
      linkSync(temp, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return legalRecord(cur.version, env);
    }
    return record;
  } catch (error) {
    if (!recordWarned) {
      recordWarned = true;
      console.warn(`[legal] could not keep the legal version in ${legalHistoryDir(env)}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Every version this instance has shown, oldest first, with the period each was the newest. */
export function legalHistory(env: NodeJS.ProcessEnv = process.env): LegalHistoryEntry[] {
  let names: string[] = [];
  try {
    names = readdirSync(legalHistoryDir(env)).filter((name) => /^[0-9a-f]{24}\.json$/.test(name)).slice(0, MAX_RECORDS);
  } catch {
    return [];
  }
  const now = current(env).version;
  const records = names
    .map((name) => parseRecord(readText(join(legalHistoryDir(env), name))))
    .filter((record): record is LegalRecord => record !== null)
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
  return records.map((record, index) => ({
    version: record.version,
    edition: record.edition,
    publishedAt: record.publishedAt,
    until: records[index + 1]?.publishedAt ?? null,
    app: record.app,
    current: record.version === now,
  }));
}

/**
 * For the current Terms: if they differ from the previous version this instance showed, accounts created before the
 * change are bound from publication + changeNoticeDays (Terms § 15); null when nothing changed for them.
 */
export function termsTransition(env: NodeJS.ProcessEnv = process.env): { previous: string; publishedAt: string; existingAccountsFrom: string } | null {
  const cur = current(env);
  const mine = legalRecord(cur.version, env);
  if (!mine) return null;
  const history = legalHistory(env);
  const index = history.findIndex((entry) => entry.version === cur.version);
  const before = index > 0 ? legalRecord(history[index - 1].version, env) : null;
  if (!before || before.digests?.terms === mine.digests.terms) return null;
  const days = Number.parseInt(cur.vars.changeNoticeDays ?? "30", 10);
  const from = new Date(Date.parse(mine.publishedAt) + (Number.isFinite(days) && days > 0 ? days : 30) * 86_400_000);
  return { previous: before.version, publishedAt: mine.publishedAt, existingAccountsFrom: from.toISOString().slice(0, 10) };
}

/** The edition of the defaults in force on a day (an acceptance recorded before the instance kept its history). */
export function editionOn(day: string): LegalEdition | null {
  return legalEditions().find((e) => e.published.slice(0, 10) <= day.slice(0, 10)) ?? null;
}

/* ------------------------------------------------------------------------------------------- pages */

function page(doc: LegalDoc, lang: LegalLang, text: string, missing: string[], rest: Omit<LegalPage, "doc" | "lang" | "markdown" | "html" | "missing">): LegalPage {
  const filled = fill(text, { [DATE_VAR]: rest.effectiveDate ?? "" }, new Set());
  return { doc, lang, markdown: filled.text, html: renderLegalMarkdown(filled.text), missing, ...rest };
}

/**
 * A legal page: the current version, or with `version` an earlier one from the instance's history, or with `edition`
 * an earlier edition of the default texts filled with the current details. Unknown version/edition -> null.
 */
export function legalPage(doc: LegalDoc, lang: LegalLang, env: NodeJS.ProcessEnv = process.env, at: { version?: string; edition?: number } = {}): LegalPage {
  const cur = current(env);
  if (at.version && at.version !== cur.version) {
    const record = legalRecord(at.version, env);
    const text = record?.pages[pageKey(doc, lang)];
    if (record && typeof text === "string") {
      return page(doc, lang, text, [], {
        source: "history", version: record.version, edition: record.edition, publishedAt: record.publishedAt, app: record.app, current: false,
        effectiveDate: effectiveDateFor(record.operatorEffectiveDate, record.publishedAt),
      });
    }
  }
  const latest = legalEditions()[0];
  if (at.edition !== undefined && at.edition !== (cur.edition ?? latest?.edition)) {
    const edition = legalEditions().find((e) => e.edition === at.edition);
    const raw = edition ? readText(shippedPath(doc, lang, edition.edition)) : null;
    if (edition && raw !== null) {
      const filled = fill(raw, cur.vars, new Set([DATE_VAR]));
      return page(doc, lang, filled.text, filled.missing, {
        source: "edition", version: `edition-${edition.edition}`, edition: edition.edition, publishedAt: edition.published, app: edition.app, current: false,
        effectiveDate: edition.published.slice(0, 10),
      });
    }
  }
  const mine = cur.pages.find((p) => p.doc === doc && p.lang === lang)!;
  const record = legalRecord(cur.version, env);
  return page(doc, lang, mine.text, mine.missing, {
    source: mine.source, version: cur.version, edition: cur.edition, publishedAt: record?.publishedAt ?? null,
    app: appVersion(), current: true, effectiveDate: effectiveDateFor(cur.vars[DATE_VAR], record?.publishedAt ?? null),
  });
}

/** Placeholders without a value on any page (empty = complete). */
export function legalGaps(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set(current(env).pages.flatMap((page) => page.missing))].sort();
}

/** `pl` for a Polish browser, else English. */
export function pickLang(requested: string | undefined | null, acceptLanguage: string | null): LegalLang {
  if (requested === "pl" || requested === "en") return requested;
  const first = (acceptLanguage ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
  return first.startsWith("pl") ? "pl" : "en";
}
