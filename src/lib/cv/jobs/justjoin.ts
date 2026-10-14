import { decodeEntities, parseHtml, readableText, tidyText } from "./html";
import { detectLang } from "../langdetect";
import { FetchError, MAX_TEXT_CHARS, PASTE_HINT, type FetchedPosting } from "./posting";
import { postingSections } from "./sections";

/**
 * justjoin.it offers. The offer page is a JavaScript app whose JSON-LD flattens the description (lists glued
 * together) and carries no skills; the site's own candidate API answers one offer as JSON with the HTML body,
 * required / nice-to-have skills with levels, seniority, workplace, salary, languages, company site and apply link.
 * Pure: the caller downloads `justjoinApiUrl(slug)` through the SSRF-guarded fetcher. Relative imports only.
 */

const HOSTS = new Set(["justjoin.it", "www.justjoin.it"]);
// /job-offer/<slug>, also with a locale prefix (/pl/job-offer/<slug>) or the older /offers/<slug>
const OFFER_PATH = /^\/(?:[a-z]{2}\/)?(?:job-offer|offers)\/([a-z0-9][a-z0-9-]{2,300})\/?$/;

export function justjoinSlug(url: URL): string | null {
  if (!HOSTS.has(url.hostname.toLowerCase())) return null;
  const m = OFFER_PATH.exec(url.pathname);
  return m ? m[1] : null;
}

export function justjoinApiUrl(slug: string): URL {
  return new URL(`https://justjoin.it/api/candidate-api/offers/${encodeURIComponent(slug)}`);
}

/** justjoin.it skill levels as the site names them. */
export const JUSTJOIN_LEVELS: Record<number, string> = { 1: "nice to have", 2: "junior", 3: "regular", 4: "advanced", 5: "master" };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const label = (v: unknown): string => (isObj(v) ? str(v.label) || str(v.value) : str(v));

function skillsOf(value: unknown, required: boolean): { name: string; level: number | null; required: boolean }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((s) => {
    const name = isObj(s) ? str(s.name) : "";
    if (!name) return [];
    const level = isObj(s) && typeof s.level === "number" && Number.isInteger(s.level) ? s.level : null;
    return [{ name: name.slice(0, 120), level, required }];
  });
}

function amount(n: unknown): string {
  return typeof n === "number" && Number.isFinite(n) ? String(Math.round(n)) : "";
}

/** "15000-20000 PLN/month b2b (net); 12000-16000 PLN/month permanent (gross)": the offer's own currency only. */
export function salaryText(employmentTypes: unknown): string {
  if (!Array.isArray(employmentTypes)) return "";
  const parts: string[] = [];
  for (const t of employmentTypes) {
    if (!isObj(t)) continue;
    if (t.currencySource !== undefined && t.currencySource !== "original") continue;
    const from = amount(t.from);
    const to = amount(t.to);
    const range = from && to && from !== to ? `${from}-${to}` : from || to;
    const rawKind = str(t.label) || str(t.type);
    const kind = rawKind === "any" ? "any contract" : rawKind;
    const net = typeof t.gross === "boolean" ? (t.gross ? " (gross)" : " (net)") : "";
    if (range) parts.push(`${range} ${str(t.currency).toUpperCase()}/${(str(t.unit) || "month").toLowerCase()} ${kind}${net}`.replace(/\s+/g, " ").trim());
    else if (kind) parts.push(`${kind}: salary not disclosed`);
  }
  return [...new Set(parts)].join("; ").slice(0, 300);
}

function locationOf(offer: Obj): string {
  const places: string[] = [];
  const city = str(offer.city);
  if (city) places.push(city);
  if (Array.isArray(offer.locations)) {
    for (const loc of offer.locations) {
      const c = isObj(loc) ? str(loc.city) : "";
      if (c && !places.includes(c)) places.push(c);
    }
  }
  const workplace = label(offer.workplaceType).toLowerCase();
  if (workplace === "remote" && !places.includes("Remote")) places.push("Remote");
  return places.join("; ").slice(0, 300);
}

/** One justjoin.it candidate-API offer -> a posting (with the board's structured fields in `extra`). */
export function parseJustjoinOffer(body: string, url: string): FetchedPosting {
  let offer: unknown;
  try {
    offer = JSON.parse(body);
  } catch {
    throw new FetchError(`justjoin.it answered something that is not an offer. ${PASTE_HINT}`);
  }
  if (!isObj(offer) || !str(offer.title)) throw new FetchError(`justjoin.it has no offer at ${url} (expired or removed?). ${PASTE_HINT}`);
  const html = str(offer.body);
  const text = (html.includes("<") ? readableText(parseHtml(html)) : tidyText(decodeEntities(html))).slice(0, MAX_TEXT_CHARS);
  if (!text) throw new FetchError(`the justjoin.it offer at ${url} has no description. ${PASTE_HINT}`);
  const sections = postingSections(text);
  const languages = Array.isArray(offer.languages)
    ? offer.languages.flatMap((l) => (isObj(l) && str(l.code) ? [`${str(l.code)}${str(l.level) ? ` ${str(l.level)}` : ""}`] : []))
    : [];
  const skills = [...skillsOf(offer.requiredSkills, true), ...skillsOf(offer.niceToHaveSkills, false)];
  return {
    url,
    title: str(offer.title).slice(0, 300),
    company: str(offer.companyName).slice(0, 300),
    location: locationOf(offer),
    lang: detectLang(text),
    text,
    requirements: sections.requirements,
    source: "justjoin",
    extra: {
      niceToHave: sections.niceToHave,
      skills,
      seniority: label(offer.experienceLevel).slice(0, 60),
      workplace: label(offer.workplaceType).slice(0, 60),
      salary: salaryText(offer.employmentTypes),
      languages: languages.slice(0, 10),
      applyUrl: /^https?:\/\//i.test(str(offer.applyUrl)) ? str(offer.applyUrl).slice(0, 2000) : "",
      companyUrl: /^https?:\/\//i.test(str(offer.companyUrl)) ? str(offer.companyUrl).slice(0, 2000) : "",
    },
  };
}
