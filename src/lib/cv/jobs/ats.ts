import { msg, msgf } from "@/lib/i18n/msg";
import { buildCvView } from "../render/view";
import { cvViewToText, estimatePages } from "../render/text";
import { priorityWarnings } from "../priorities";
import type { CvLang, Job, Profile, Variant } from "../schema";
import { profileCorpus } from "../text/guard";
import { analyze, extractTerms, jobForMatching, type JobInput, type Term } from "./match";
import { foldCase, spansOf, techPatterns } from "./terms";

/**
 * ATS check of ONE CV version against ONE saved offer. Applicant tracking systems parse the document into fields and
 * score it mostly by literal keyword hits against the posting, so this looks at what the version itself PRINTS
 * (not the master profile): which of the posting's terms appear, which the user has but this version dropped, which
 * are spelled differently from the posting, and the structural basics parsers trip over.
 * Deterministic, no LLM. Gaps (terms the user has nowhere) are reported as gaps: never to be invented. Pure.
 */

export type AtsLevel = "ok" | "warn" | "fail" | "info";
export type KeywordStatus = "present" | "dropped" | "missing";

export interface AtsKeyword {
  term: string;
  section: "required" | "nice" | "text";
  kind: "tech" | "keyword";
  /** present: the version prints it; dropped: the master profile has it, this version leaves it out; missing: a real gap */
  status: KeywordStatus;
  /** How the posting writes it, when that differs from what the version prints (ATS matching is often literal). */
  postingSpelling: string;
  /** The version mentions the term only in another spelling (e.g. "NestJS" vs the posting's "Nest.js"). */
  spellingDiffers: boolean;
  /** Where the master profile has it (for "dropped": the place to bring back). */
  evidence: string[];
}

export interface AtsCheck {
  id: string;
  level: AtsLevel;
  message: string;
}

export interface AtsReport {
  jobId: string;
  lang: CvLang;
  /** 0-100: required keywords 60, nice-to-have 15, structure 25. A guide, not what any particular ATS computes. */
  score: number;
  requiredCoveragePct: number | null;
  niceCoveragePct: number | null;
  keywords: AtsKeyword[];
  checks: AtsCheck[];
  pages: number;
  /** Everything worth doing, most valuable first (fixable items, then the gaps to tell the user about). */
  actions: string[];
  /** What can still be fixed truthfully in this version. Empty = done: stop editing and report. */
  fixable: string[];
  /** Asked for, not in the profile anywhere: tell the user, never add. */
  gaps: string[];
}

const MONTH = /^(\d{4})-(\d{2})$/;

function months(start: string, end: string | null, today: Date): number {
  const a = MONTH.exec(start.trim());
  if (!a) return 0;
  const b = end ? MONTH.exec(end.trim()) : null;
  const endY = b ? Number(b[1]) : today.getFullYear();
  const endM = b ? Number(b[2]) : today.getMonth() + 1;
  return Math.max(0, (endY - Number(a[1])) * 12 + (endM - Number(a[2])) + 1);
}

/** Calendar months covered by the roles (overlaps counted once). */
export function experienceMonths(profile: Profile, today = new Date()): number {
  const covered = new Set<number>();
  for (const e of profile.experience) {
    const a = MONTH.exec(e.start.trim());
    if (!a) continue;
    const start = Number(a[1]) * 12 + Number(a[2]) - 1;
    const n = months(e.start, e.end, today);
    for (let i = 0; i < n; i += 1) covered.add(start + i);
  }
  return covered.size;
}

/** "min. 4 lat", "4+ years", "at least 3 years", "3-5 lat": the largest minimum the requirement lines state. */
export function yearsAsked(lines: readonly string[]): number | null {
  let best: number | null = null;
  const re = /(\d{1,2})\s*(?:\+|-\s*\d{1,2})?\s*(?:\+\s*)?(?:years?|yrs?|lat[a]?|roku|rok)\b/giu;
  for (const line of lines) {
    for (const m of line.matchAll(re)) {
      const n = Number(m[1]);
      if (n > 0 && n < 30 && (best === null || n > best)) best = n;
    }
  }
  return best;
}

/** How the posting writes a tech term (its first literal occurrence), "" if not found literally. */
function postingSurface(term: Term, job: JobInput): string {
  if (term.kind !== "tech") return term.label;
  const text = [...job.requirements, ...job.niceToHave, job.text].join("\n");
  const cased = foldCase(text);
  const { ci, cs } = techPatterns(term.key, job.lang !== "en");
  const spans = [...spansOf(ci, cased.toLowerCase()), ...spansOf(cs, cased)].sort((x, y) => x[0] - y[0]);
  if (!spans.length) return term.label;
  const [s, e] = spans[0];
  // strip a Polish case ending the pattern tolerated ("TypeScriptu" -> "TypeScript")
  const raw = text.slice(s, e).trim();
  return raw.length > term.label.length && raw.toLowerCase().startsWith(term.label.toLowerCase()) ? text.slice(s, s + term.label.length) : raw;
}

const pct = (part: number, whole: number): number | null => (whole ? Math.round((1000 * part) / whole) / 10 : null);

export function atsCheck(master: Profile, version: Profile, rawJob: JobInput & Partial<Pick<Job, "languages">>, lang: CvLang, today = new Date(), variant?: Variant): AtsReport {
  const job = jobForMatching(rawJob);
  const inMaster = analyze(master, job, lang);
  // The version is checked in its own language only: what an ATS reads is what prints.
  const view = buildCvView(version, lang, { nbsp: false });
  const printed = cvViewToText(view);
  const printedLow = foldCase(printed).toLowerCase();
  const inVersion = analyze(version, job, lang);

  // What an ATS matches on: technologies (dictionary, with aliases) and the skills the board lists. Generic words from
  // requirement sentences ("experience", "clean", "hands-on") are not keywords anyone filters on: they are left out.
  const keywords: AtsKeyword[] = [];
  const seen = new Set<string>();
  for (const term of inMaster.terms) {
    if (term.kind !== "tech") continue;
    seen.add(term.label.toLowerCase());
    // only what prints in this language: tags are never printed, the other language is not this document
    const versionHits = (inVersion.hits.get(term.key) ?? []).filter((u) => !u.path.includes("/tags/") && !u.path.endsWith(`/${lang === "pl" ? "en" : "pl"}`));
    const masterHits = inMaster.hits.get(term.key) ?? [];
    const status: KeywordStatus = versionHits.length ? "present" : masterHits.length ? "dropped" : "missing";
    const surface = postingSurface(term, job);
    const spellingDiffers = status === "present" && !printedLow.includes(foldCase(surface).toLowerCase());
    keywords.push({
      term: term.label,
      section: term.section,
      kind: term.kind,
      status,
      postingSpelling: surface,
      spellingDiffers,
      evidence: status === "dropped" ? masterHits.slice(0, 3).map((u) => u.path) : [],
    });
  }
  // board skills the dictionary does not know ("Data Science", "Generative AI"): matched as literal phrases
  const corpus = foldCase(profileCorpus(master)).toLowerCase();
  for (const skill of rawJob.skills ?? []) {
    const name = skill.name.trim();
    const low = foldCase(name).toLowerCase();
    if (!name || seen.has(name.toLowerCase())) continue;
    if (extractTerms(name, "en", { keywords: false }).some((t) => seen.has(t.label.toLowerCase()))) continue;
    seen.add(name.toLowerCase());
    const status: KeywordStatus = printedLow.includes(low) ? "present" : corpus.includes(low) ? "dropped" : "missing";
    keywords.push({ term: name, section: skill.required ? "required" : "nice", kind: "keyword", status, postingSpelling: name, spellingDiffers: false, evidence: [] });
  }

  const required = keywords.filter((k) => k.section === "required");
  const nice = keywords.filter((k) => k.section === "nice");
  const requiredCoveragePct = pct(required.filter((k) => k.status === "present").length, required.length);
  const niceCoveragePct = pct(nice.filter((k) => k.status === "present").length, nice.length);

  const checks: AtsCheck[] = [];
  const add = (id: string, level: AtsLevel, message: string) => checks.push({ id, level, message });
  const c = version.contact;
  add("name", c.name.trim() ? "ok" : "fail", c.name.trim() ? "Name is set." : msg("No name: parsers file the CV under nothing."));
  add("email", c.email.trim() ? "ok" : "fail", c.email.trim() ? "E-mail is set." : "No e-mail address.");
  add("phone", c.phone.trim() ? "ok" : "warn", c.phone.trim() ? "Phone is set." : "No phone number: most Polish recruiters call first.");
  add("headline", view.headline ? "ok" : "warn", view.headline ? "Headline is set." : msgf("No headline in {lang}: a headline naming the role is the first thing a parser and a recruiter read.", { lang: lang.toUpperCase() }));
  const titleWords = (job.title ?? "").toLowerCase().match(/\p{L}{3,}/gu) ?? [];
  if (view.headline && titleWords.length && !titleWords.some((w) => foldCase(view.headline).toLowerCase().includes(foldCase(w)))) {
    add("headline-title", "info", msgf("The headline shares no word with the offer title “{title}”. If it is true of you, name the role the way the offer does.", { title: job.title }));
  }
  const summaryLen = view.summary.length;
  add("summary", !summaryLen ? "warn" : summaryLen > 1100 ? "warn" : "ok", !summaryLen ? msgf("No summary in {lang}.", { lang: lang.toUpperCase() }) : summaryLen > 1100 ? msgf("The summary is long ({summaryLen} characters): 3-5 sentences read and parse better.", { summaryLen }) : "Summary length is fine.");
  for (const w of view.warnings) add("translation", "warn", w);
  const undated = version.experience.filter((e) => !MONTH.test(e.start.trim()));
  add("dates", undated.length ? "warn" : "ok", undated.length ? `Roles without a YYYY-MM start date: ${undated.map((e) => e.org).join(", ")}. Parsers compute experience from dates.` : "Every role has a start date.");
  const thin = view.experience.filter((e) => e.bullets.length < 2);
  if (thin.length) add("bullets", "info", msgf("Roles with fewer than 2 bullets: {value}.", { value: thin.map((e) => e.org).join(", ") }));
  const longBullets = [...view.experience.flatMap((e) => e.bullets), ...view.projects.flatMap((p) => p.bullets)].filter((b) => b.length > 300).length;
  if (longBullets) add("bullet-length", "info", longBullets === 1 ? msg("1 bullet is over 300 characters: split or tighten.") : msgf("Bullets over 300 characters: {count}. Split or tighten them.", { count: longBullets }));
  const pages = estimatePages(view);
  add("length", pages > 2.2 ? "warn" : "ok", pages > 2.2 ? `About ${pages} pages: aim for 1-2.` : `About ${pages} page${pages === 1 ? "" : "s"}.`);
  if (lang === "pl" && !view.consent) add("consent", "warn", msg("No RODO consent clause in Polish: many Polish employers reject applications without it (Profile → Consent)."));
  for (const asked of rawJob.languages ?? []) {
    const code = asked.split(/\s+/)[0]?.toLowerCase() ?? "";
    const names: Record<string, string[]> = { en: ["english", "angielski"], pl: ["polish", "polski"], de: ["german", "niemiecki"], fr: ["french", "francuski"], es: ["spanish", "hiszpański"], uk: ["ukrainian", "ukraiński"] };
    const known = names[code];
    if (!known) continue;
    const has = master.languages.some((l) => known.some((n) => `${l.name.pl} ${l.name.en}`.toLowerCase().includes(n)));
    add(`language-${code}`, has ? (view.languages.length ? "ok" : "warn") : "info", has ? (view.languages.length ? msgf("The offer asks for {asked}; your languages section lists it.", { asked }) : msgf("The offer asks for {asked}, but this version prints no languages section.", { asked })) : msgf("The offer asks for {asked}; your profile lists no such language.", { asked }));
  }
  const asked = yearsAsked(job.requirements);
  if (asked !== null) {
    const have = Math.round((experienceMonths(master, today) / 12) * 10) / 10;
    add("years", have >= asked ? "ok" : "info", have >= asked
      ? msgf("The offer asks for {asked}+ years; your dated roles cover about {have}.", { asked, have })
      : msgf("The offer asks for {asked}+ years; your dated roles cover about {have}. Do not stretch dates: lead with projects that show the level instead (pin them, put projects first).", { asked, have }));
  }
  if (variant) for (const w of priorityWarnings(master, variant)) add("priority", "warn", w);
  add("layout", "info", msg("Upload the ATS layout (plain, one column, no photo) to job portals and application forms; the designed layouts are for e-mail and print."));

  const structural = checks.filter((x) => x.level !== "info");
  const structureScore = structural.length ? structural.filter((x) => x.level === "ok").length / structural.length : 1;
  const score = Math.round(((requiredCoveragePct ?? 100) / 100) * 60 + ((niceCoveragePct ?? 100) / 100) * 15 + structureScore * 25);

  const fixable: string[] = [];
  const dropped = keywords.filter((k) => k.status === "dropped");
  const droppedReq = dropped.filter((k) => k.section === "required");
  if (droppedReq.length) fixable.push(msgf("Bring back what you have but this version leaves out (required): {value}. Add the bullet/project/skill group that mentions it.", { value: droppedReq.map((k) => k.term).join(", ") }));
  const droppedNice = dropped.filter((k) => k.section !== "required");
  if (droppedNice.length) fixable.push(msgf("Also in your profile but not in this version: {value}.", { value: droppedNice.map((k) => k.term).join(", ") }));
  const spelled = keywords.filter((k) => k.spellingDiffers);
  if (spelled.length) fixable.push(msgf("Use the offer's spelling at least once (literal-match parsers): {value}.", { value: spelled.map((k) => `“${k.postingSpelling}”`).join(", ") }));
  // structural items the CV itself can fix (a missing phone or a short career are facts, not edits)
  const EDITABLE = new Set(["headline", "summary", "translation", "dates", "length", "priority"]);
  for (const c of checks) if ((c.level === "warn" || c.level === "fail") && EDITABLE.has(c.id)) fixable.push(c.message);
  const gaps = keywords.filter((k) => k.status === "missing" && k.section === "required").map((k) => k.term);
  const actions = [...fixable];
  for (const c of checks) if ((c.level === "warn" || c.level === "fail") && !EDITABLE.has(c.id)) actions.push(c.message);
  if (gaps.length) actions.push(msgf("Real gaps (not in your profile anywhere, do NOT add them unless true): {gaps}.", { gaps: gaps.join(", ") }));

  return { jobId: job.id, lang, score, requiredCoveragePct, niceCoveragePct, keywords, checks, pages, actions, fixable, gaps };
}

/** The exact text an ATS would read for this version (for the assistant). */
export function printedText(version: Profile, lang: CvLang): string {
  return cvViewToText(buildCvView(version, lang, { nbsp: false }));
}
