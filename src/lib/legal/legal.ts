import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Marked, type Tokens } from "marked";
import { dataDir } from "@/lib/accounts/store";

/**
 * The instance's legal pages: Terms of Service (`terms`) and the privacy notice (`privacy`), Polish and English
 * (docs/LEGAL.md). Every instance is run by someone else, so the texts are the operator's:
 *
 *   $KNIFE_LEGAL_DIR (default $KNIFE_DATA_DIR/legal; never in git)
 *     legal.json          the operator's details, filled into {{placeholders}} (legal/legal.example.json)
 *     terms.pl.md ...     a full replacement of one page (optional): copy legal/<doc>.<lang>.md and edit it
 *   legal/<doc>.<lang>.md  the defaults shipped in the repo, with {{placeholders}}
 *
 * A placeholder without a value renders as a visible gap and marks the page incomplete (the page shows a warning; the
 * server logs it at startup in public mode). The version that sign-up records is a hash of every rendered page, so any
 * change of text or details is a new version (`legal.json` "version" overrides it with a name of your choice).
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
  /** Where the text came from: the operator's own file or the repo default. */
  source: "instance" | "default";
  version: string;
  effectiveDate: string | null;
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;
const DEFAULT_VARS: Record<string, string> = { siteName: "Smart Knife", minimumAge: "16" };

export function legalDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.KNIFE_LEGAL_DIR?.trim() || join(dataDir(), "legal");
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

function template(doc: LegalDoc, lang: LegalLang, env: NodeJS.ProcessEnv): { text: string; source: LegalPage["source"] } {
  const own = readText(join(legalDir(env), `${doc}.${lang}.md`));
  if (own !== null) return { text: own, source: "instance" };
  const shipped = readText(join(process.cwd(), "legal", `${doc}.${lang}.md`));
  return { text: shipped ?? `# ${doc}\n\n{{${doc}TextMissing}}\n`, source: "default" };
}

export function fill(text: string, vars: Record<string, string>): { text: string; missing: string[] } {
  const missing = new Set<string>();
  const filled = text.replace(PLACEHOLDER, (_whole, name: string) => {
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

function rawPages(env: NodeJS.ProcessEnv): Array<{ doc: LegalDoc; lang: LegalLang; text: string; missing: string[]; source: LegalPage["source"] }> {
  const vars = legalVars(env);
  return LEGAL_DOCS.flatMap((doc) =>
    LEGAL_LANGS.map((lang) => {
      const { text, source } = template(doc, lang, env);
      return { doc, lang, source, ...fill(text, vars) };
    }),
  );
}

/** The version a sign-up accepts: legal.json "version", else a hash over every rendered page (both docs, both languages). */
export function legalVersion(env: NodeJS.ProcessEnv = process.env): string {
  const named = legalVars(env).version;
  if (named) return named.slice(0, 64);
  const hash = createHash("sha256");
  for (const page of rawPages(env)) hash.update(`${page.doc}.${page.lang}\0${page.text}\0`);
  return hash.digest("hex").slice(0, 12);
}

export function legalPage(doc: LegalDoc, lang: LegalLang, env: NodeJS.ProcessEnv = process.env): LegalPage {
  const page = rawPages(env).find((p) => p.doc === doc && p.lang === lang)!;
  return {
    doc,
    lang,
    markdown: page.text,
    html: renderLegalMarkdown(page.text),
    missing: page.missing,
    source: page.source,
    version: legalVersion(env),
    effectiveDate: legalVars(env).effectiveDate ?? null,
  };
}

/** Placeholders without a value on any page (empty = complete). */
export function legalGaps(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set(rawPages(env).flatMap((page) => page.missing))].sort();
}

/** `pl` for a Polish browser, else English. */
export function pickLang(requested: string | undefined | null, acceptLanguage: string | null): LegalLang {
  if (requested === "pl" || requested === "en") return requested;
  const first = (acceptLanguage ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
  return first.startsWith("pl") ? "pl" : "en";
}
