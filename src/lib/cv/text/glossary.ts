import { escapeRegex, pyRegex } from "./regex";

/**
 * Curated PL <-> EN CV/IT terminology. Used two ways: `glossaryPrompt()` is pasted into translation prompts so the
 * model renders terms consistently, and `glossaryMismatches()` flags pairs where the Polish side uses a term whose
 * accepted English rendering is absent from the English side.
 */

// [polish term, canonical english, accepted english renderings as '|' separated word-prefixes].
// Prefixes of 5+ letters also match inflections ("deploy" matches deployed/deployment); shorter ones must match a
// whole word (+ plural s).
const ROWS: readonly (readonly [string, string, string])[] = [
  ["lider zespołu", "team lead", "team lead|team leader|tech lead"],
  ["kierownik projektu", "project manager", "project manager|project lead|delivery manager"],
  ["kierownik", "manager", "manager|head of|lead"],
  ["doświadczenie", "experience", "experience"],
  ["wdrożenie", "deployment", "deploy|implement|rollout|roll out|rolled out|rolling out|launch|go-live"],
  ["utrzymanie", "maintenance", "maint|support|operat|sustain"],
  ["rozwój oprogramowania", "software development", "software development|software engineering"],
  ["programista", "developer", "developer|programmer|engineer"],
  ["inżynier oprogramowania", "software engineer", "software engineer|developer"],
  ["tester", "tester", "tester|qa|test engineer|quality"],
  ["testy automatyczne", "automated tests", "automated test|test automation|automatic test"],
  ["zespół", "team", "team|squad"],
  ["klient", "client", "client|customer"],
  ["projektowanie", "design", "design|architect"],
  ["architektura", "architecture", "architect"],
  ["baza danych", "database", "database|data store|datastore"],
  ["chmura", "cloud", "cloud"],
  ["konteneryzacja", "containerization", "container"],
  ["ciągła integracja", "continuous integration", "continuous integration|ci"],
  ["ciągłe dostarczanie", "continuous delivery", "continuous delivery|continuous deployment|cd"],
  ["integracja", "integration", "integrat"],
  ["optymalizacja", "optimization", "optimi"],
  ["wydajność", "performance", "performance|efficien|throughput"],
  ["skalowalność", "scalability", "scalab|scale"],
  ["bezpieczeństwo", "security", "security|safety"],
  ["monitorowanie", "monitoring", "monitor|observab"],
  ["automatyzacja", "automation", "automat"],
  ["migracja", "migration", "migrat"],
  ["refaktoryzacja", "refactoring", "refactor"],
  ["przegląd kodu", "code review", "code review|peer review|pull request review"],
  ["analiza wymagań", "requirements analysis", "requirements|requirement"],
  ["analiza", "analysis", "analy"],
  ["dokumentacja", "documentation", "documentation|docs"],
  ["wsparcie techniczne", "technical support", "technical support|tech support|support"],
  ["obsługa klienta", "customer service", "customer service|customer support|client support"],
  ["mentoring", "mentoring", "mentor|coach"],
  ["szkolenie", "training", "training|workshop|course"],
  ["wdrażanie nowych osób", "onboarding", "onboard"],
  ["współpraca", "collaboration", "collaborat|cooperat|partner"],
  ["odpowiedzialność", "responsibility", "responsib|ownership|accountab"],
  ["obowiązki", "responsibilities", "responsib|dut"],
  ["osiągnięcie", "achievement", "achiev|accomplish"],
  ["umiejętności", "skills", "skill|competenc"],
  ["wykształcenie", "education", "education"],
  ["studia", "studies", "stud|degree"],
  ["staż", "internship", "intern|placement|traineeship"],
  ["praktyki", "internship", "intern|apprentic|placement|traineeship"],
  ["praca zdalna", "remote work", "remote"],
  ["pełny etat", "full-time", "full-time|full time"],
  ["umowa o pracę", "employment contract", "employment contract|contract of employment"],
  ["stanowisko", "position", "position|role|post"],
  ["programowanie", "programming", "programming|coding|development"],
  ["oprogramowanie", "software", "software"],
  ["aplikacja", "application", "application|app"],
  ["usługa", "service", "service"],
  ["mikrousługi", "microservices", "microservice"],
  ["interfejs", "interface", "interface|ui"],
  ["przetwarzanie danych", "data processing", "data processing|processing"],
  ["potok danych", "data pipeline", "pipeline"],
  ["uczenie maszynowe", "machine learning", "machine learning|ml"],
  ["sztuczna inteligencja", "artificial intelligence", "artificial intelligence|ai"],
  ["zarządzanie projektami", "project management", "project management|manag"],
  ["zarządzanie", "management", "manag"],
  ["metodyki zwinne", "agile methodologies", "agile"],
  ["rekrutacja", "recruitment", "recruit|hiring"],
  ["rozwiązywanie problemów", "troubleshooting", "troubleshoot|problem-solving|problem solving"],
  ["debugowanie", "debugging", "debug"],
  ["awaria", "outage", "outage|failure|incident|downtime"],
  ["dostępność", "availability", "availab|uptime"],
  ["kontrola wersji", "version control", "version control|vcs"],
  ["doradztwo", "consulting", "consult|advis"],
];

/** Crude Polish inflection tolerance: drop the last 1-3 letters depending on word length. */
function stem(word: string): string {
  const n = word.length;
  const keep = n <= 3 ? n : n <= 5 ? n - 1 : n <= 7 ? n - 2 : n - 3;
  return word.slice(0, keep);
}

function plRegex(term: string): RegExp {
  const parts = term.toLowerCase().split(/\s+/).filter(Boolean).map((w) => String.raw`\b${escapeRegex(stem(w))}\w*`);
  return pyRegex(parts.join(String.raw`\W+(?:\w+\W+)?`), "i");
}

function enAltRegex(alt: string): string {
  const body = alt.trim().split(/[\s-]+/).map(escapeRegex).join(String.raw`[\s-]*`);
  return alt.length >= 5 ? String.raw`\b${body}\w*` : String.raw`\b${body}s?\b`;
}

function enRegex(accept: string): RegExp {
  return pyRegex(accept.split("|").map(enAltRegex).join("|"), "i");
}

export interface GlossaryEntry {
  pl: string;
  en: string;
  accept: string[];
  plRe: RegExp;
  enRe: RegExp;
}

export const GLOSSARY: readonly GlossaryEntry[] = ROWS.map(([pl, en, accept]) => ({ pl, en, accept: accept.split("|"), plRe: plRegex(pl), enRe: enRegex(accept) }));

/** Lowercase and strip diacritics so 'doswiadczenie' finds 'doświadczenie'. */
function fold(text: string): string {
  return text.toLowerCase().replace(/ł/g, "l").normalize("NFKD").replace(/\p{M}/gu, "");
}

/** Entries whose PL or EN term (or accepted rendering) contains `query`; all if empty. */
export function searchGlossary(query?: string | null): GlossaryEntry[] {
  if (!query || !query.trim()) return [...GLOSSARY];
  const q = fold(query.trim());
  return GLOSSARY.filter((e) => fold(e.pl).includes(q) || [e.en, ...e.accept].some((a) => fold(a).includes(q)));
}

/** Terminology block for translation prompts. */
export function glossaryPrompt(): string {
  const lines = [
    "CV terminology (PL <-> EN). Render these terms consistently; the first English form is preferred, alternatives in brackets are acceptable when the sentence needs them:",
  ];
  for (const e of GLOSSARY) {
    const alts = e.accept.filter((a) => a !== e.en);
    lines.push(`- ${e.pl} <-> ${e.en}${alts.length ? ` [${alts.join("; ")}]` : ""}`);
  }
  return lines.join("\n");
}

/**
 * Entries whose PL term occurs in `pl` while no accepted English rendering occurs in `en`.
 * Longer Polish terms win: 'analiza wymagań' suppresses a nested 'analiza'.
 */
export function glossaryMismatches(pl: string, en: string): GlossaryEntry[] {
  const hits: { entry: GlossaryEntry; a: number; b: number }[] = [];
  for (const entry of GLOSSARY) {
    const m = entry.plRe.exec(pl);
    if (m) hits.push({ entry, a: m.index, b: m.index + m[0].length });
  }
  hits.sort((x, y) => x.a - x.b - (y.a - y.b)); // longest span first
  const kept: typeof hits = [];
  for (const h of hits) {
    if (kept.some((k) => k.a <= h.a && h.b <= k.b)) continue;
    kept.push(h);
  }
  return kept.filter((k) => !k.entry.enRe.test(en)).map((k) => k.entry);
}
