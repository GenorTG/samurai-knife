/**
 * The CV wizard's data (src/tools/cv/CvWizard.tsx): plain answers -> a CV profile, plus the small helpers that let people
 * type a date the way they write it and that fill in what can be read safely from a pasted CV. Pure, browser and server;
 * tests/cv_wizard.test.mjs checks the result against `profileSchema`.
 */

export type WizardLang = "pl" | "en";

export interface WizardJob {
  org: string;
  role: string;
  start: string;
  end: string;
  /** Still working there: `end` is ignored. */
  current: boolean;
  duties: string;
}

export interface WizardSchool {
  institution: string;
  detail: string;
  start: string;
  end: string;
}

export interface WizardSpoken {
  name: string;
  level: string;
}

export interface WizardAnswers {
  lang: WizardLang;
  name: string;
  email: string;
  phone: string;
  city: string;
  link: string;
  headline: string;
  jobs: WizardJob[];
  schools: WizardSchool[];
  skills: string;
  languages: WizardSpoken[];
  summary: string;
  consent: boolean;
}

export const EMPTY_JOB: WizardJob = { org: "", role: "", start: "", end: "", current: false, duties: "" };
export const EMPTY_SCHOOL: WizardSchool = { institution: "", detail: "", start: "", end: "" };

export function emptyAnswers(lang: WizardLang): WizardAnswers {
  return { lang, name: "", email: "", phone: "", city: "", link: "", headline: "", jobs: [{ ...EMPTY_JOB }], schools: [{ ...EMPTY_SCHOOL }], skills: "", languages: [], summary: "", consent: lang === "pl" };
}

/** The clause Polish employers expect at the bottom of a CV (same wording in both documents' languages). */
export const CONSENT_CLAUSE = {
  pl: "Wyrażam zgodę na przetwarzanie moich danych osobowych zawartych w niniejszym dokumencie w celu przeprowadzenia procesu rekrutacji, zgodnie z Rozporządzeniem Parlamentu Europejskiego i Rady (UE) 2016/679 z dnia 27 kwietnia 2016 r. (RODO).",
  en: "I consent to the processing of the personal data contained in this document for the purposes of the recruitment process, in accordance with Regulation (EU) 2016/679 of the European Parliament and of the Council of 27 April 2016 (GDPR).",
} as const;

/** "03.2022", "3/2022", "2022-3", "2022": stored as YYYY-MM or YYYY. Anything else stays "" (reported by `monthProblem`). */
export function normalizeMonth(input: string): string {
  const text = input.trim();
  let match = /^(\d{4})$/.exec(text);
  if (match) return match[1];
  match = /^(\d{4})[-./](\d{1,2})$/.exec(text);
  const [year, month] = match ? [match[1], match[2]] : (() => {
    const other = /^(\d{1,2})[-./](\d{4})$/.exec(text);
    return other ? [other[2], other[1]] : ["", ""];
  })();
  const number = Number(month);
  return year && number >= 1 && number <= 12 ? `${year}-${String(number).padStart(2, "0")}` : "";
}

/** True when something was typed that is not a date we can read. */
export function monthProblem(input: string): boolean {
  return Boolean(input.trim()) && !normalizeMonth(input);
}

export function splitLines(text: string): string[] {
  return text.split("\n").map((line) => line.replace(/^\s*[-•*–]\s*/, "").trim()).filter(Boolean);
}

export function splitSkills(text: string): string[] {
  return [...new Set(text.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean))];
}

function normalizeLink(link: string): { label: string; url: string } | null {
  const text = link.trim();
  if (!text) return null;
  return { label: text.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""), url: /^https?:\/\//i.test(text) ? text : `https://${text}` };
}

/** A first text for "about you", built only from what the person already answered. */
export function suggestSummary(a: WizardAnswers): string {
  const latest = a.jobs.find((job) => job.org.trim() && job.role.trim());
  const skills = splitSkills(a.skills).slice(0, 4).join(", ");
  const role = a.headline.trim() || latest?.role.trim() || "";
  if (a.lang === "pl") {
    return [
      role ? `${role}.` : "",
      latest ? `Ostatnio na stanowisku ${latest.role.trim()} w firmie ${latest.org.trim()}.` : "",
      skills ? `Moje mocne strony to: ${skills}.` : "",
    ].filter(Boolean).join(" ");
  }
  return [
    role ? `${role}.` : "",
    latest ? `Most recently ${latest.role.trim()} at ${latest.org.trim()}.` : "",
    skills ? `My strengths: ${skills}.` : "",
  ].filter(Boolean).join(" ");
}

/** The answers as a profile for `importCv`. Empty rows are dropped; only the language being written is filled in. */
export function answersToProfile(a: WizardAnswers): Record<string, unknown> {
  const bi = (text: string) => ({ pl: a.lang === "pl" ? text.trim() : "", en: a.lang === "en" ? text.trim() : "" });
  const link = normalizeLink(a.link);
  const skills = splitSkills(a.skills);
  return {
    contact: {
      name: a.name.trim(),
      headline: bi(a.headline),
      location: bi(a.city),
      email: a.email.trim(),
      phone: a.phone.trim(),
      links: link ? [link] : [],
    },
    summary: bi(a.summary),
    experience: a.jobs
      .filter((job) => job.org.trim() || job.role.trim())
      .map((job, i) => ({
        id: `job-${i + 1}`,
        org: job.org.trim(),
        role: bi(job.role),
        start: normalizeMonth(job.start),
        end: job.current ? null : normalizeMonth(job.end) || null,
        bullets: splitLines(job.duties).map((text, b) => ({ id: `job-${i + 1}-b${b + 1}`, text: bi(text), verified: true })),
      })),
    skills: skills.length ? [{ id: "skills", name: { pl: "Umiejętności", en: "Skills" }, items: skills }] : [],
    education: a.schools
      .filter((school) => school.institution.trim())
      .map((school, i) => ({ id: `edu-${i + 1}`, institution: school.institution.trim(), detail: bi(school.detail), start: normalizeMonth(school.start), end: normalizeMonth(school.end) || null })),
    languages: a.languages
      .filter((item) => item.name.trim())
      .map((item, i) => ({ id: `lang-${i + 1}`, name: bi(item.name), level: bi(item.level) })),
    consent: a.consent ? { pl: CONSENT_CLAUSE.pl, en: CONSENT_CLAUSE.en } : { pl: "", en: "" },
  };
}

/**
 * What can be read safely from a pasted CV without an AI model: email, phone, a profile link and the name (the first
 * short line of two to four capitalised words). Everything else stays for the person to fill in, with the text next to them.
 */
export function guessFromCvText(text: string): Partial<Pick<WizardAnswers, "name" | "email" | "phone" | "link">> {
  const found: Partial<Pick<WizardAnswers, "name" | "email" | "phone" | "link">> = {};
  const email = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(text);
  if (email) found.email = email[0];
  const phone = /(?<![\d/-])(?:\+\d{1,3}[ -]?)?(?:\(?\d{2,3}\)?[ -]?){2,4}\d{2,3}(?![\d/-])/.exec(text.replace(email?.[0] ?? "\0", " "));
  if (phone && phone[0].replace(/\D/g, "").length >= 9) found.phone = phone[0].trim();
  const link = /(?:https?:\/\/)?(?:www\.)?(?:linkedin\.com\/in\/|github\.com\/)[\w%./-]+/i.exec(text);
  if (link) found.link = link[0];
  for (const raw of text.split("\n").slice(0, 8)) {
    const line = raw.trim();
    if (/^\p{Lu}[\p{L}'’-]+(?: \p{Lu}[\p{L}'’-]+){1,3}$/u.test(line) && !/^(curriculum vitae|życiorys|resume)$/i.test(line)) {
      found.name = line;
      break;
    }
  }
  return found;
}
