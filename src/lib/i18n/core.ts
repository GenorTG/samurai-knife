import PL_CATALOG from "./pl.json" with { type: "json" };

/**
 * The app's interface languages (docs/I18N.md). Gettext style: the English text IS the key, so code reads
 * `t("Save changes")`; `pl.json` maps each English text to Polish (a plural: `[one, few, many]`). A text with no entry
 * falls back to English (tests/i18n.test.mjs keeps the catalogue complete and in step with the code).
 *
 * Interpolation: `t("Saved {name}", { name })`; plurals: `tn("{n} file", "{n} files", count)` (`{n}` is the count).
 * Pure and client-safe (no Node imports): the server (getT) and the browser (useT) share it.
 */

export const LOCALES = ["en", "pl"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
/** The cookie that carries the choice (also for guests). */
export const LOCALE_COOKIE = "knife_lang";
/** Native names for the switcher. */
export const LOCALE_NAMES: Record<Locale, string> = { en: "English", pl: "Polski" };
/** BCP-47 tags for Intl (numbers, dates): pinned, so server and browser render the same text. */
export const INTL_LOCALE: Record<Locale, string> = { en: "en-US", pl: "pl-PL" };

export const isLocale = (value: unknown): value is Locale => typeof value === "string" && (LOCALES as readonly string[]).includes(value);

type Entry = string | [string, string, string];
const CATALOGS: Record<Locale, Record<string, Entry>> = { en: {}, pl: PL_CATALOG as unknown as Record<string, Entry> };

export type Vars = Record<string, string | number | null | undefined>;

function fill(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => (key in vars ? String(vars[key] ?? "") : whole));
}

/** Pick an Accept-Language match: the first listed language we have ("pl-PL,pl;q=0.9,en;q=0.8" -> pl). */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const ranked = header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return { lang: tag.trim().toLowerCase().split("-")[0], q: q ? Number.parseFloat(q.slice(2)) || 0 : 1 };
    })
    .filter((item) => item.lang && item.q > 0)
    .sort((a, b) => b.q - a.q);
  return ranked.map((item) => item.lang).find(isLocale) ?? null;
}

export function translate(locale: Locale, text: string, vars?: Vars): string {
  const entry = locale === "en" ? undefined : CATALOGS[locale][text];
  return fill(typeof entry === "string" && entry ? entry : text, vars);
}

const PLURAL_RULES: Partial<Record<Locale, Intl.PluralRules>> = {};
function pluralCategory(locale: Locale, n: number): Intl.LDMLPluralRule {
  PLURAL_RULES[locale] ??= new Intl.PluralRules(INTL_LOCALE[locale]);
  return PLURAL_RULES[locale]!.select(n);
}

/**
 * Count-dependent text. English: `one` for 1, else `other`. Polish entry `[one, few, many]` (1 plik / 2 pliki / 5 plików,
 * 22 pliki, 25 plików, as Intl.PluralRules decides). Fractions (Intl "other") take `few`; UI counts are whole numbers.
 */
export function translatePlural(locale: Locale, one: string, other: string, n: number, vars?: Vars): string {
  const all = { n, ...vars };
  if (locale === "en") return fill(n === 1 ? one : other, all);
  const entry = CATALOGS[locale][one];
  if (!Array.isArray(entry)) return fill(n === 1 ? one : other, all);
  const category = pluralCategory(locale, n);
  const form = category === "one" ? entry[0] : category === "few" ? entry[1] : category === "many" ? entry[2] : entry[1];
  return fill(form, all);
}

/** `t(text)`; an optional text (undefined / null) passes through, so `placeholder={t(param.placeholder)}` stays unset. */
export interface TranslateFn {
  (text: string, vars?: Vars): string;
  (text: string | undefined, vars?: Vars): string | undefined;
  (text: string | null | undefined, vars?: Vars): string | null | undefined;
}

export interface Translator {
  locale: Locale;
  t: TranslateFn;
  tn: (one: string, other: string, n: number, vars?: Vars) => string;
  /** A message from the server or a library (exact text or a known template; else as it came): errors, notices. */
  m: (message: string) => string;
  /** Locale-pinned number formatting (never the runtime's locale: hydration). */
  num: (n: number, options?: Intl.NumberFormatOptions) => string;
  /** Locale-pinned date formatting in a fixed time zone (default UTC unless given). */
  date: (value: Date | string | number, options?: Intl.DateTimeFormatOptions) => string;
}

const translators: Partial<Record<Locale, Translator>> = {};

export function translator(locale: Locale): Translator {
  const cached = translators[locale];
  if (cached) return cached;
  const made: Translator = {
    locale,
    t: ((text: string | null | undefined, vars?: Vars) => (text == null ? text : translate(locale, text, vars))) as TranslateFn,
    tn: (one, other, n, vars) => translatePlural(locale, one, other, n, vars),
    m: (message) => translateMessage(locale, message),
    num: (n, options) => n.toLocaleString(INTL_LOCALE[locale], options),
    date: (value, options) => new Date(value).toLocaleString(INTL_LOCALE[locale], { timeZone: "UTC", ...options }),
  };
  translators[locale] = made;
  return made;
}

/* --------------------------------------------------------------------------------------- server messages */

interface Pattern {
  re: RegExp;
  names: string[];
  key: string;
}
const PATTERNS: Partial<Record<Locale, Pattern[]>> = {};

/** Catalogue templates with real wording around their placeholders ("Not enough storage: this needs {needed} …"). */
function patterns(locale: Locale): Pattern[] {
  const cached = PATTERNS[locale];
  if (cached) return cached;
  const out: Pattern[] = [];
  for (const [key, entry] of Object.entries(CATALOGS[locale])) {
    if (typeof entry !== "string" || !entry || !key.includes("{")) continue;
    const literal = key.replace(/\{\w+\}/g, "");
    if (literal.replace(/[^A-Za-z]/g, "").length < 12) continue;
    const names: string[] = [];
    const source = key
      .split(/(\{\w+\})/)
      .map((part) => {
        const m = /^\{(\w+)\}$/.exec(part);
        if (m) {
          names.push(m[1]);
          return "([\\s\\S]*?)";
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("");
    out.push({ re: new RegExp(`^${source}$`), names, key });
  }
  // longest templates first: the most specific wins
  out.sort((a, b) => b.key.length - a.key.length);
  PATTERNS[locale] = out;
  return out;
}

/**
 * A message from the server or a library (English, possibly with values in it) in `locale`: the exact catalogue entry,
 * else a template it matches (`msgf` on the server keeps those in the catalogue), else the message as it came.
 */
export function translateMessage(locale: Locale, message: string): string {
  if (locale === "en" || !message) return message;
  const exact = CATALOGS[locale][message];
  if (typeof exact === "string" && exact) return exact;
  if (message.length > 2_000) return message;
  for (const pattern of patterns(locale)) {
    const m = pattern.re.exec(message);
    if (!m) continue;
    const vars: Vars = {};
    pattern.names.forEach((name, i) => (vars[name] = m[i + 1]));
    return fill(CATALOGS[locale][pattern.key] as string, vars);
  }
  return message;
}
