import { msgf } from "@/lib/i18n/msg";
import { missingTranslations } from "../ops";
import type { Bi, CvLang, Profile } from "../schema";
import { effectiveSectionOrder } from "../variant";
import { typeset } from "./typography";

/**
 * The ONE place that decides what a CV prints. The HTML document, the plain-text preview and the DOCX export all
 * consume this view, so titles, date ranges and "skip anything empty in this language" behave identically in every
 * format. No field is ever borrowed from the other language: a gap stays a gap and is reported in `warnings`.
 * Pure (no DOM, no Intl); the object is JSON-safe, the DOCX route sends it to Python as is.
 */

export const SECTION_TITLES = {
  summary: { en: "Profile", pl: "Profil" },
  experience: { en: "Experience", pl: "Doświadczenie" },
  projects: { en: "Selected projects", pl: "Wybrane projekty" },
  skills: { en: "Technology", pl: "Technologie" },
  education: { en: "Education", pl: "Edukacja" },
  languages: { en: "Languages", pl: "Języki" },
  extras: { en: "How I work", pl: "Sposób pracy" },
} as const satisfies Record<string, Record<CvLang, string>>;

export type CvSectionKey = keyof typeof SECTION_TITLES;
export type CvTitles = Record<CvSectionKey, string>;

const PRESENT: Record<CvLang, string> = { en: "present", pl: "obecnie" };
const DATE_SEP = "—";
const LANG_NAME: Record<CvLang, string> = { en: "English", pl: "Polish" };

export type CvContactKind = "place" | "email" | "phone" | "linkedin" | "github" | "web";
export interface CvContactItem {
  text: string;
  /** http(s), mailto: or tel: only; "" = plain text. */
  href: string;
  /** What it is (icons, DOCX hyperlinks). */
  kind: CvContactKind;
}
export interface CvExperienceView {
  /** "Role, Org" (or just Org / Role). */
  heading: string;
  role: string;
  org: string;
  dates: string;
  place: string;
  note: string;
  bullets: string[];
}
export interface CvProjectView {
  name: string;
  href: string;
  urlText: string;
  summary: string;
  tech: string;
  bullets: string[];
}
/** A project's showcase page (printed after the CV, or exported alone). */
export interface CvProjectPageView {
  name: string;
  href: string;
  urlText: string;
  summary: string;
  tech: string[];
  role: string;
  outcome: string;
  /** The story, one string per paragraph. */
  story: string[];
  bullets: string[];
}
export interface CvSkillView {
  name: string;
  items: string;
}
export interface CvEducationView {
  institution: string;
  detail: string;
  dates: string;
}

export interface CvCustomItemView {
  title: string;
  text: string;
  href: string;
  urlText: string;
  date: string;
}
export interface CvCustomSectionView {
  /** `custom:<id>`, the key used in `order` */
  key: string;
  title: string;
  items: CvCustomItemView[];
}

/** One printable section, in print order. Renderers iterate `order` and look the content up by key. */
export type CvOrderKey = CvSectionKey | `custom:${string}`;

export interface CvView {
  lang: CvLang;
  name: string;
  headline: string;
  contact: CvContactItem[];
  summary: string;
  experience: CvExperienceView[];
  projects: CvProjectView[];
  skills: CvSkillView[];
  education: CvEducationView[];
  languages: string[];
  extras: string;
  custom: CvCustomSectionView[];
  /** Print order of the non-empty sections (masthead first and consent last are fixed). */
  order: CvOrderKey[];
  /** RODO / GDPR clause; "" unless written in `lang`. */
  consent: string;
  /** Showcase pages of the projects this CV shows that have one (in project order). */
  pages: CvProjectPageView[];
  /** Labels the showcase pages print. */
  pageTitles: { role: string; outcome: string; highlights: string; tech: string; heading: string };
  titles: CvTitles;
  /** Sections with text in the other language but nothing in `lang` (human-readable, one per section). */
  warnings: string[];
  isEmpty: boolean;
}

export interface BuildCvViewOptions {
  /** false = plain spaces only (DOCX / ATS); dashes and quotes are still typeset. Default true. */
  nbsp?: boolean;
  /** Print links as full addresses (https://github.com/x) instead of the short form (github.com/x). */
  fullUrls?: boolean;
}

const PAGE_TITLES: Record<CvLang, CvView["pageTitles"]> = {
  en: { role: "My role", outcome: "Outcome", highlights: "Highlights", tech: "Technology", heading: "Project" },
  pl: { role: "Moja rola", outcome: "Efekt", highlights: "Najważniejsze", tech: "Technologie", heading: "Projekt" },
};

/** What a contact link is, from its address and label (icons, DOCX). */
export function contactKind(url: string, label = ""): CvContactKind {
  const u = url.toLowerCase();
  if (u.startsWith("mailto:")) return "email";
  if (u.startsWith("tel:")) return "phone";
  if (/linkedin\.com/.test(u) || /linkedin/i.test(label)) return "linkedin";
  if (/github\.com/.test(u) || /github/i.test(label)) return "github";
  return "web";
}

const MONTH = /^(\d{4})-(\d{2})$/;

/** '2024-05' -> '05.2024'. Anything else is passed through (still honest, never invented). */
export function formatMonth(value: string): string {
  const trimmed = value.trim();
  const m = MONTH.exec(trimmed);
  return m ? `${m[2]}.${m[1]}` : trimmed;
}

/** '05.2024 — present'. No start -> just the end date (or nothing). */
export function dateRange(start: string, end: string | null, lang: CvLang): string {
  const from = start ? formatMonth(start) : "";
  const to = end ? formatMonth(end) : "";
  if (!from) return to;
  return `${from} ${DATE_SEP} ${to || PRESENT[lang]}`;
}

export function urlDisplay(url: string): string {
  return url.trim().replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, "");
}

/** Only links a CV may carry. `javascript:` and friends become plain text. */
export function safeHref(url: string): string {
  const trimmed = url.trim();
  if (/^(https?:|mailto:|tel:)/i.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return "";
  return /^[\w-]+(\.[\w-]+)+(\/|$)/.test(trimmed) ? `https://${trimmed}` : "";
}

const SECTION_OF_PATH: Record<string, string> = {
  contact: "Header",
  summary: "Profile",
  experience: "Experience",
  projects: "Selected projects",
  skills: "Technology",
  education: "Education",
  languages: "Languages",
  extras: "How I work",
};

/** One warning per section; the consent clause is excluded (printing it only in Polish is the rule, not a gap). */
function translationWarnings(profile: Profile, lang: CvLang): string[] {
  const other: CvLang = lang === "pl" ? "en" : "pl";
  const bySection = new Map<string, string[]>();
  for (const path of missingTranslations(profile, lang)) {
    const section = SECTION_OF_PATH[path.split("/")[1] ?? ""];
    if (!section) continue;
    bySection.set(section, [...(bySection.get(section) ?? []), path]);
  }
  return [...bySection].map(([section, paths]) => {
    const shown = paths.slice(0, 3).join(", ") + (paths.length > 3 ? `, +${paths.length - 3} more` : "");
    return paths.length === 1 ? msgf("{section}: 1 field written in {from} but empty in {to} ({shown})", { section, from: LANG_NAME[other], to: LANG_NAME[lang], shown }) : msgf("{section}: {count} fields written in {from} but empty in {to} ({shown})", { section, count: paths.length, from: LANG_NAME[other], to: LANG_NAME[lang], shown });
  });
}

function contactItems(profile: Profile, lang: CvLang, prose: (value: string) => string, fullUrls: boolean): CvContactItem[] {
  const c = profile.contact;
  const items: CvContactItem[] = [];
  const seen = new Set<string>();
  const push = (text: string, href: string, key: string, kind: CvContactKind) => {
    if (!text || seen.has(key)) return;
    seen.add(key);
    items.push({ text, href, kind });
  };

  const place = prose(c.location[lang].trim());
  if (place) push(place, "", `text:${place.toLowerCase()}`, "place");
  const email = c.email.trim();
  if (email) push(email, `mailto:${email}`, `url:${email.toLowerCase()}`, "email");
  const phone = c.phone.trim();
  if (phone) push(phone, `tel:${phone.replace(/[^\d+]/g, "")}`, `url:${phone.replace(/[^\d+]/g, "")}`, "phone");

  for (const link of c.links) {
    const url = link.url.trim();
    if (!url) continue;
    const short = urlDisplay(url);
    const href = safeHref(url);
    const shown = fullUrls && /^https?:/i.test(href) ? href : short;
    const label = link.label.trim();
    const lower = label.toLowerCase();
    // "label: label" / "GitHub: github.com/x" -> say it once.
    const redundant = lower === short.toLowerCase() || lower === url.toLowerCase() || short.toLowerCase().includes(lower);
    const text = label && !redundant ? `${label}: ${shown}` : shown || label;
    push(text, href, `url:${short.toLowerCase().replace(/^mailto:/, "")}`, contactKind(href || url, label));
  }
  return items;
}

/** Resolve `profile` into printable, typeset strings for `lang`. Empty things are dropped. */
export function buildCvView(profile: Profile, lang: CvLang, options: BuildCvViewOptions = {}): CvView {
  const nbsp = options.nbsp ?? true;
  const fullUrls = options.fullUrls ?? false;
  const shownUrl = (url: string): string => {
    const href = url.trim() ? safeHref(url) : "";
    return fullUrls && /^https?:/i.test(href) ? href : urlDisplay(url);
  };
  const text = (raw: string): string => typeset(raw.trim(), lang, { nbsp });
  const prose = (value: Bi | string): string => text(typeof value === "string" ? value : value[lang]);
  const bullets = (items: Profile["experience"][number]["bullets"]): string[] => items.map((b) => prose(b.text)).filter(Boolean);
  const c = profile.contact;

  const experience: CvExperienceView[] = [];
  for (const e of profile.experience) {
    const role = prose(e.role);
    const org = e.org.trim();
    const heading = [role, org].filter(Boolean).join(", ");
    if (!heading) continue;
    experience.push({ heading, role, org, dates: dateRange(e.start, e.end, lang), place: e.location.trim(), note: prose(e.note), bullets: bullets(e.bullets) });
  }

  const projects: CvProjectView[] = [];
  for (const p of profile.projects) {
    const name = p.name.trim();
    if (!name) continue;
    projects.push({
      name,
      href: p.url.trim() ? safeHref(p.url) : "",
      urlText: shownUrl(p.url),
      summary: prose(p.summary),
      tech: p.tech.map((t) => t.trim()).filter(Boolean).join(", "),
      bullets: bullets(p.bullets),
    });
  }

  const pages: CvProjectPageView[] = [];
  for (const p of profile.projects) {
    const name = p.name.trim();
    if (!name || !p.page) continue;
    const story = (p.story?.[lang] ?? "").split(/\n\s*\n/).map((para) => text(para.replace(/\s*\n\s*/g, " "))).filter(Boolean);
    const page: CvProjectPageView = {
      name,
      href: p.url.trim() ? safeHref(p.url) : "",
      urlText: shownUrl(p.url),
      summary: prose(p.summary),
      tech: p.tech.map((t) => t.trim()).filter(Boolean),
      role: prose(p.role ?? { pl: "", en: "" }),
      outcome: prose(p.outcome ?? { pl: "", en: "" }),
      story,
      bullets: bullets(p.bullets),
    };
    // A page with nothing written in this language is not printed (never borrowed from the other language).
    if (page.summary || page.story.length || page.role || page.outcome || page.bullets.length) pages.push(page);
  }

  const skills: CvSkillView[] = [];
  for (const g of profile.skills) {
    const items = g.items.map((i) => i.trim()).filter(Boolean).join(", ");
    if (items) skills.push({ name: g.name[lang].trim(), items });
  }

  const education: CvEducationView[] = [];
  for (const ed of profile.education) {
    const institution = ed.institution.trim();
    if (institution) education.push({ institution, detail: prose(ed.detail), dates: dateRange(ed.start, ed.end, lang) });
  }

  const languages: string[] = [];
  for (const l of profile.languages) {
    const name = l.name[lang].trim();
    const level = l.level[lang].trim();
    if (name) languages.push(level ? `${name} ${DATE_SEP} ${level}` : name);
  }

  const custom: CvCustomSectionView[] = [];
  for (const section of profile.customSections) {
    const items: CvCustomItemView[] = [];
    for (const item of section.items) {
      const title = prose(item.title);
      const body = prose(item.text);
      if (!title && !body) continue;
      items.push({ title, text: body, href: item.url.trim() ? safeHref(item.url) : "", urlText: shownUrl(item.url), date: item.date.trim() });
    }
    const title = prose(section.title);
    if (items.length && title) custom.push({ key: `custom:${section.id}`, title, items });
  }

  const filled: Record<string, boolean> = {
    summary: Boolean(prose(profile.summary)),
    experience: experience.length > 0,
    projects: projects.length > 0,
    skills: skills.length > 0,
    education: education.length > 0,
    languages: languages.length > 0,
    extras: Boolean(prose(profile.extras)),
    ...Object.fromEntries(custom.map((s) => [s.key, true])),
  };
  const order = effectiveSectionOrder(profile).filter((key) => filled[key]) as CvOrderKey[];

  const view: Omit<CvView, "isEmpty"> = {
    lang,
    name: c.name.trim(),
    headline: prose(c.headline),
    contact: contactItems(profile, lang, text, fullUrls),
    summary: prose(profile.summary),
    experience,
    projects,
    skills,
    education,
    languages,
    extras: prose(profile.extras),
    custom,
    order,
    consent: prose(profile.consent),
    pages,
    pageTitles: PAGE_TITLES[lang],
    titles: Object.fromEntries(Object.entries(SECTION_TITLES).map(([key, names]) => [key, names[lang]])) as CvTitles,
    warnings: translationWarnings(profile, lang),
  };
  const isEmpty = !(view.name || view.headline || order.length);
  return { ...view, isEmpty };
}
