import { detectLang } from "../langdetect";
import { parseHtml, readableText } from "./html";
import { FetchError, MAX_TEXT_CHARS, PASTE_HINT, type FetchedPosting } from "./posting";
import { postingSections } from "./sections";

/**
 * nofluffjobs.com offers. The page's JSON-LD has only the company/role blurb; the requirements live in the board's own
 * posting JSON (`/api/posting/<slug>`): must / nice skills, the requirement description (HTML, often with its own
 * "Mile widziane" part), daily tasks, salary, seniority, languages and the company website.
 * Pure: the caller downloads `nofluffApiUrl(slug)` through the SSRF-guarded fetcher. Relative imports only.
 */

const HOSTS = new Set(["nofluffjobs.com", "www.nofluffjobs.com"]);
// /pl/job/<slug>, /job/<slug>, also other locale prefixes (/en/job/<slug>, /hu/job/<slug>)
const OFFER_PATH = /^\/(?:[a-z]{2}\/)?job\/([a-z0-9][a-z0-9-]{2,300})\/?$/;

export function nofluffSlug(url: URL): string | null {
  if (!HOSTS.has(url.hostname.toLowerCase())) return null;
  const m = OFFER_PATH.exec(url.pathname);
  return m ? m[1] : null;
}

export function nofluffApiUrl(slug: string): URL {
  return new URL(`https://nofluffjobs.com/api/posting/${encodeURIComponent(slug)}`);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const html = (v: unknown): string => {
  const s = str(v);
  return s ? readableText(parseHtml(s)) : "";
};

function skills(value: unknown, required: boolean): { name: string; level: null; required: boolean }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((s) => {
    const name = isObj(s) ? str(s.value) : "";
    return name ? [{ name: name.slice(0, 120), level: null, required }] : [];
  });
}

/** "140-160 PLN/hour b2b; 18000-22000 PLN/month permanent": the offer's own currency and period. */
export function nofluffSalary(essentials: unknown): string {
  const salary = isObj(essentials) && isObj(essentials.originalSalary) ? essentials.originalSalary : null;
  if (!salary || !isObj(salary.types)) return "";
  const currency = str(salary.currency).toUpperCase();
  const parts: string[] = [];
  for (const [kind, t] of Object.entries(salary.types)) {
    if (!isObj(t) || !Array.isArray(t.range)) continue;
    const [from, to] = t.range.map((n) => (typeof n === "number" && Number.isFinite(n) ? String(Math.round(n)) : ""));
    const range = from && to && from !== to ? `${from}-${to}` : from || to;
    if (range) parts.push(`${range} ${currency}/${(str(t.period) || "month").toLowerCase()} ${kind}`);
  }
  return parts.join("; ").slice(0, 300);
}

function locationOf(offer: Obj): string {
  const loc = isObj(offer.location) ? offer.location : {};
  const places: string[] = [];
  if (Array.isArray(loc.places)) {
    for (const p of loc.places) {
      const city = isObj(p) ? str(p.city) : "";
      if (city && !places.includes(city)) places.push(city);
    }
  }
  return places.slice(0, 8).join("; ").slice(0, 300);
}

/** `location.remote` is remote days per week: 5 = remote, 1-4 = hybrid, 0 = office. */
export function nofluffWorkplace(location: unknown): string {
  if (!isObj(location) || typeof location.remote !== "number") return "";
  const days = location.remote;
  if (days >= 5) return "remote";
  if (days <= 0) return "office";
  return str(location.hybridDesc) || `hybrid (${days} ${days === 1 ? "day" : "days"} remote a week)`;
}

/** One nofluffjobs.com posting JSON -> a posting (board fields in `extra`). */
export function parseNofluffOffer(body: string, url: string): FetchedPosting {
  let offer: unknown;
  try {
    offer = JSON.parse(body);
  } catch {
    throw new FetchError(`nofluffjobs.com answered something that is not an offer. ${PASTE_HINT}`);
  }
  if (!isObj(offer) || !str(offer.title)) throw new FetchError(`nofluffjobs.com has no offer at ${url} (expired or removed?). ${PASTE_HINT}`);
  const req = isObj(offer.requirements) ? offer.requirements : {};
  const details = isObj(offer.details) ? offer.details : {};
  const specs = isObj(offer.specs) ? offer.specs : {};
  const company = isObj(offer.company) ? offer.company : {};
  const basics = isObj(offer.basics) ? offer.basics : {};

  const about = html(details.description);
  const requirementText = html(req.description);
  const tasks = Array.isArray(specs.dailyTasks) ? specs.dailyTasks.map(str).filter(Boolean) : [];
  // The requirement description is under a "Requirements" heading of our own, so its list lines count as requirements
  // until the description's own "Nice to have" heading (if any).
  const text = [
    about,
    requirementText ? `Wymagania:\n${requirementText}` : "",
    tasks.length ? `Zakres obowiązków:\n${tasks.map((t) => `- ${t}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n").slice(0, MAX_TEXT_CHARS);
  if (!text) throw new FetchError(`the nofluffjobs.com offer at ${url} has no description. ${PASTE_HINT}`);

  const sections = postingSections(text);
  // a requirement description written as plain paragraphs (no list): every non-empty line is a requirement
  const requirements = sections.requirements.length
    ? sections.requirements
    : requirementText.split("\n").map((l) => l.replace(/^-\s*/, "").trim()).filter((l) => l.length > 2 && l.length <= 300);
  const languages = Array.isArray(req.languages)
    ? req.languages.flatMap((l) => (isObj(l) && str(l.code) ? [`${str(l.code)}${str(l.level) ? ` ${str(l.level)}` : ""}`] : []))
    : [];
  const seniority = Array.isArray(basics.seniority) ? basics.seniority.map(str).filter(Boolean).join("/") : str(basics.seniority);
  const site = str(company.url);
  return {
    url,
    title: str(offer.title).slice(0, 300),
    company: str(company.name).slice(0, 300),
    location: locationOf(offer),
    lang: detectLang(text),
    text,
    requirements: requirements.slice(0, 80),
    source: "nofluffjobs",
    extra: {
      niceToHave: sections.niceToHave,
      skills: [...skills(req.musts, true), ...skills(req.nices, false)],
      seniority: seniority.toLowerCase().slice(0, 60),
      workplace: nofluffWorkplace(offer.location).slice(0, 60),
      salary: nofluffSalary(offer.essentials),
      languages: languages.slice(0, 10),
      applyUrl: "",
      companyUrl: /^https?:\/\//i.test(site) ? site.slice(0, 2000) : "",
    },
  };
}
