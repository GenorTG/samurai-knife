import type { Bi, CvLang, Job, Profile } from "../schema";
import { foldCase, hasMatch, isStop, spansOf, stem, TECH, techPatterns } from "./terms";

/**
 * Deterministic profile<->posting matching. No LLM: dictionary + word-boundary regexes + Polish-inflection-tolerant
 * stems. Every claimed match carries evidence (a profile id-path that `readPath` / `knife_cv_get` resolve), so the
 * model never has to guess where a skill lives. Pure; relative imports only.
 */

export type Section = "required" | "nice" | "text";
export type TermKind = "tech" | "keyword";

/** The slice of a saved job the engine reads. */
export type JobInput = Pick<Job, "id" | "lang" | "text" | "requirements" | "niceToHave"> & Partial<Pick<Job, "title" | "company" | "url" | "skills" | "notes">>;

/**
 * What matching reads from a saved job: the board's structured skills join the requirement lines they are not already
 * part of (required -> requirements, the rest -> nice to have), and the user's own notes join the posting prose.
 */
export function jobForMatching(job: JobInput): JobInput {
  const mentioned = (lines: readonly string[], name: string): boolean => {
    const low = name.toLowerCase();
    return lines.some((l) => l.toLowerCase().includes(low));
  };
  const skills = job.skills ?? [];
  const requirements = [...job.requirements];
  const niceToHave = [...job.niceToHave];
  for (const skill of skills) {
    const target = skill.required ? requirements : niceToHave;
    if (!mentioned([...requirements, ...niceToHave], skill.name)) target.push(skill.name);
  }
  const text = [job.text, job.notes ?? ""].filter((t) => t.trim()).join("\n\n");
  return { ...job, requirements, niceToHave, text };
}

export interface Term {
  /** tech: dictionary label; keyword: folded stem */
  key: string;
  /** as shown to the model */
  label: string;
  kind: TermKind;
  count: number;
  section: Section;
}

export interface Evidence {
  path: string;
  text: string;
}

export interface MatchedTerm {
  term: string;
  kind: TermKind;
  section: Section;
  evidence: Evidence[];
}

export interface RequirementHit {
  requirement: string;
  terms: string[];
  matchedTerms: string[];
  /** Best single place in the profile; null = nothing found. */
  evidence: Evidence | null;
}

export interface MatchReport {
  jobId: string;
  lang: CvLang;
  /** matched terms / all terms, unweighted, 0-100 */
  coveragePct: number;
  /** same over tech-dictionary terms only (more reliable); null if there are none */
  techCoveragePct: number | null;
  /** share of the saved requirement lines that have profile evidence, 0-100 (null when none are saved): the number to trust most */
  requirementCoveragePct: number | null;
  totalTerms: number;
  matched: MatchedTerm[];
  missing: string[];
  /** missing terms that occur in the saved requirement lines */
  missingRequired: string[];
  requirementHits: RequirementHit[];
  notes: string[];
}

export const MAX_KEYWORDS = 25;
export const MAX_EVIDENCE = 4;
const SNIPPET_CHARS = 200;
const SECTION_WEIGHT: Record<Section, number> = { required: 3, nice: 2, text: 1 };

/** How much a hit on this term should steer tailoring (required 3, nice 2, prose 1; keywords count half). */
export function termWeight(term: Term): number {
  return SECTION_WEIGHT[term.section] * (term.kind === "tech" ? 1 : 0.5);
}

// --- term extraction ------------------------------------------------------------------------

export interface ExtractOptions {
  keywords?: boolean;
  minKeywordCount?: number;
}

/**
 * Tech terms (dictionary + aliases) and, optionally, non-tech keywords from `text`.
 * `lang` is the language of `text`: "en" disables Polish case-ending tolerance.
 */
export function extractTerms(text: string, lang: Job["lang"] = "unknown", options: ExtractOptions = {}): Term[] {
  const { keywords = true, minKeywordCount = 2 } = options;
  const pl = lang !== "en";
  const cased = foldCase(text);
  const lowered = cased.toLowerCase();
  const found: { first: number; term: Term }[] = [];
  const blank = lowered.split("");
  for (const label of Object.keys(TECH)) {
    const { ci, cs } = techPatterns(label, pl);
    const spans = [...spansOf(ci, lowered), ...spansOf(cs, cased)];
    if (!spans.length) continue;
    found.push({ first: Math.min(...spans.map(([s]) => s)), term: { key: label, label, kind: "tech", count: spans.length, section: "text" } });
    for (const [start, end] of spans) for (let i = start; i < end && i < blank.length; i += 1) blank[i] = " ";
  }
  found.sort((a, b) => a.first - b.first);
  const terms = found.map((f) => f.term);
  if (keywords) terms.push(...keywordTerms(blank.join(""), text, minKeywordCount));
  return terms;
}

function keywordTerms(masked: string, original: string, minCount: number): Term[] {
  const counts = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  const surface = new Map<string, Map<string, number>>();
  const aligned = original.length === masked.length;
  for (const m of masked.matchAll(/\p{L}{5,}/gu)) {
    const word = m[0];
    if (isStop(word)) continue;
    const key = stem(word);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!firstSeen.has(key)) firstSeen.set(key, m.index);
    const shown = aligned ? original.slice(m.index, m.index + word.length).toLowerCase() : word;
    const forms = surface.get(key) ?? new Map<string, number>();
    forms.set(shown, (forms.get(shown) ?? 0) + 1);
    surface.set(key, forms);
  }
  const ranked = [...counts.keys()]
    .filter((k) => (counts.get(k) ?? 0) >= minCount)
    .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || (firstSeen.get(a) ?? 0) - (firstSeen.get(b) ?? 0));
  return ranked.slice(0, MAX_KEYWORDS).map((key) => ({
    key,
    label: mostCommon(surface.get(key)),
    kind: "keyword" as const,
    count: counts.get(key) ?? 0,
    section: "text" as const,
  }));
}

/** Highest count wins; ties go to the form seen first (Counter.most_common semantics). */
function mostCommon(forms: Map<string, number> | undefined): string {
  let best = "";
  let bestCount = -1;
  for (const [form, n] of forms ?? []) {
    if (n > bestCount) {
      best = form;
      bestCount = n;
    }
  }
  return best;
}

// --- profile index --------------------------------------------------------------------------

/** One searchable string in the profile, addressable by `path`. */
export interface Unit {
  path: string;
  text: string;
  /** path of the bullet / project / role / skill group it belongs to */
  owner: string;
  /** evidence preference: 0 bullet text, 1 role/summary/project text, 2 tags/skills */
  rank: number;
  low: string;
  cased: string;
  tokens: ReadonlySet<string>;
}

function makeUnit(path: string, text: string, owner: string, rank: number): Unit {
  const cased = foldCase(text);
  const low = cased.toLowerCase();
  return { path, text, owner, rank, low, cased, tokens: new Set(low.match(/\p{L}+/gu) ?? []) };
}

/** Text + path in `lang`, falling back to the other language when `lang` is empty. */
function biText(bi: Bi, lang: CvLang, path: string): { text: string; path: string } {
  if (bi[lang]) return { text: bi[lang], path: `${path}/${lang}` };
  const other: CvLang = lang === "pl" ? "en" : "pl";
  return { text: bi[other], path: `${path}/${other}` };
}

/** Every searchable string of the profile, in document order, with a path `readPath` can resolve. */
export function indexProfile(profile: Profile, lang: CvLang): Unit[] {
  const units: Unit[] = [];
  const addBi = (path: string, bi: Bi, owner: string, rank: number): void => {
    const { text, path: real } = biText(bi, lang, path);
    if (text.trim()) units.push(makeUnit(real, text, owner, rank));
  };
  const addList = (base: string, items: readonly string[], owner: string): void => {
    items.forEach((item, i) => units.push(makeUnit(`${base}/${i}`, item, owner, 2)));
  };

  addBi("/contact/headline", profile.contact.headline, "/contact/headline", 1);
  addBi("/summary", profile.summary, "/summary", 1);
  for (const exp of profile.experience) {
    const eo = `/experience/id=${exp.id}`;
    addBi(`${eo}/role`, exp.role, eo, 1);
    addBi(`${eo}/note`, exp.note, eo, 1);
    for (const b of exp.bullets) {
      const bo = `${eo}/bullets/id=${b.id}`;
      addBi(`${bo}/text`, b.text, bo, 0);
      addList(`${bo}/tags`, b.tags, bo);
    }
  }
  for (const proj of profile.projects) {
    const po = `/projects/id=${proj.id}`;
    units.push(makeUnit(`${po}/name`, proj.name, po, 1));
    addBi(`${po}/summary`, proj.summary, po, 1);
    addList(`${po}/tech`, proj.tech, po);
    for (const b of proj.bullets) {
      const bo = `${po}/bullets/id=${b.id}`;
      addBi(`${bo}/text`, b.text, bo, 0);
      addList(`${bo}/tags`, b.tags, bo);
    }
  }
  for (const group of profile.skills) {
    const so = `/skills/id=${group.id}`;
    addList(`${so}/items`, group.items, so);
  }
  for (const section of profile.customSections ?? []) {
    for (const item of section.items) {
      const io = `/customSections/id=${section.id}/items/id=${item.id}`;
      addBi(`${io}/title`, item.title, io, 1);
      addBi(`${io}/text`, item.text, io, 1);
    }
  }
  for (const edu of profile.education) addBi(`/education/id=${edu.id}/detail`, edu.detail, `/education/id=${edu.id}`, 3);
  for (const spoken of profile.languages) {
    const name = biText(spoken.name, lang, `/languages/id=${spoken.id}/name`);
    const level = biText(spoken.level, lang, `/languages/id=${spoken.id}/level`);
    // One searchable unit per spoken language: "Angielski — biegły (C2)"; the path points at the level (what a reader checks).
    if (name.text.trim()) units.push(makeUnit(level.text.trim() ? level.path : name.path, `${name.text} — ${level.text}`.trim(), `/languages/id=${spoken.id}`, 2));
  }
  return units;
}

function termHits(term: Term, units: readonly Unit[], pl: boolean): Unit[] {
  if (term.kind === "tech") {
    const { ci, cs } = techPatterns(term.key, pl);
    return units.filter((u) => hasMatch(ci, u.low) || hasMatch(cs, u.cased));
  }
  return units.filter((u) => {
    for (const tok of u.tokens) if (tok.startsWith(term.key)) return true;
    return false;
  });
}

/** Stable sort by evidence rank: best evidence first, document order within a rank. */
function byRank(units: Unit[]): Unit[] {
  return units.map((u, i) => ({ u, i })).sort((a, b) => a.u.rank - b.u.rank || a.i - b.i).map((x) => x.u);
}

// --- analysis -------------------------------------------------------------------------------

/** Everything `match` and the tailoring ranker need, computed once. */
export interface Analysis {
  terms: Term[];
  units: Unit[];
  /** term.key -> units that contain it (evidence-ranked) */
  hits: Map<string, Unit[]>;
  profilePl: boolean;
}

/** Terms to look for: requirement/nice lines first (they carry priority), then the rest of the posting. */
export function jobTerms(job: JobInput): Term[] {
  const terms = new Map<string, Term>();
  if (job.requirements.length || job.niceToHave.length) {
    const sections: [Section, readonly string[]][] = [["required", job.requirements], ["nice", job.niceToHave]];
    for (const [section, lines] of sections) {
      for (const t of extractTerms(lines.join("\n"), job.lang, { minKeywordCount: 1 })) if (!terms.has(t.key)) terms.set(t.key, { ...t, section });
    }
    // tech terms mentioned only in the prose
    for (const t of extractTerms(job.text, job.lang, { keywords: false })) if (!terms.has(t.key)) terms.set(t.key, t);
  } else {
    for (const t of extractTerms(job.text, job.lang, { minKeywordCount: 2 })) if (!terms.has(t.key)) terms.set(t.key, t);
  }
  return [...terms.values()];
}

export function analyze(profile: Profile, job: JobInput, lang: CvLang): Analysis {
  const units = indexProfile(profile, lang);
  const terms = jobTerms(job);
  const pl = lang === "pl";
  const hits = new Map(terms.map((t) => [t.key, byRank(termHits(t, units, pl))]));
  return { terms, units, hits, profilePl: pl };
}

function evidenceOf(unit: Unit): Evidence {
  const text = unit.text.trim();
  return { path: unit.path, text: text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS - 1).trimEnd()}…` : text };
}

function pct(part: number, whole: number): number {
  return whole ? Math.round((1000 * part) / whole) / 10 : 0;
}

/** Coverage of the posting's terms by the profile text in `lang` (the other language as fallback). */
export function match(profile: Profile, job: JobInput, lang: CvLang): MatchReport {
  const an = analyze(profile, job, lang);
  const hitsOf = (t: Term): Unit[] => an.hits.get(t.key) ?? [];
  const notes: string[] = [];
  if (!(job.requirements.length || job.niceToHave.length)) {
    notes.push(
      "No requirements saved for this job: terms were taken from the raw posting text, which is noisier. Extract the requirement lines and call knife_cv_job_save, then match again.",
    );
  }
  if (!an.terms.length) notes.push("No matchable terms found in the posting.");
  const matchedTerms = an.terms.filter((t) => hitsOf(t).length);
  const missingTerms = an.terms.filter((t) => !hitsOf(t).length);
  const tech = an.terms.filter((t) => t.kind === "tech");
  const reqHits = requirementHits(job, an);
  return {
    jobId: job.id,
    lang,
    coveragePct: pct(matchedTerms.length, an.terms.length),
    techCoveragePct: tech.length ? pct(tech.filter((t) => hitsOf(t).length).length, tech.length) : null,
    requirementCoveragePct: reqHits.length ? pct(reqHits.filter((h) => h.evidence).length, reqHits.length) : null,
    totalTerms: an.terms.length,
    matched: matchedTerms.map((t) => ({ term: t.label, kind: t.kind, section: t.section, evidence: hitsOf(t).slice(0, MAX_EVIDENCE).map(evidenceOf) })),
    missing: missingTerms.map((t) => t.label),
    missingRequired: missingTerms.filter((t) => t.section === "required").map((t) => t.label),
    requirementHits: reqHits,
    notes,
  };
}

function requirementHits(job: JobInput, an: Analysis): RequirementHit[] {
  return job.requirements.map((line) => {
    const lineTerms = extractTerms(line, job.lang, { minKeywordCount: 1 });
    const covered = new Map<string, Unit[]>();
    for (const t of lineTerms) {
      const units = an.hits.get(t.key) ?? byRank(termHits(t, an.units, an.profilePl));
      if (units.length) covered.set(t.label, units);
    }
    let best: Unit | null = null;
    if (covered.size) {
      const tally = new Map<string, number>();
      for (const units of covered.values()) for (const u of units) tally.set(u.path, (tally.get(u.path) ?? 0) + 1);
      const top = Math.max(...tally.values());
      // lowest rank among the most-hit units; document order breaks ties
      for (const u of an.units) if (tally.get(u.path) === top && (!best || u.rank < best.rank)) best = u;
    }
    return { requirement: line, terms: lineTerms.map((t) => t.label), matchedTerms: [...covered.keys()], evidence: best ? evidenceOf(best) : null };
  });
}
