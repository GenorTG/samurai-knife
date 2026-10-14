/**
 * Requirement and nice-to-have lines from a posting's own section headings ("Wymagania", "Mile widziane",
 * "Requirements", "Nice to have", …). Works on the readable text the fetcher produces (list items are "- " lines).
 * A hint for matching, not a parser of record: the assistant can correct the lines with knife_cv_job_save.
 * Pure; relative imports only.
 */

export type SectionKind = "required" | "nice" | "other";

const NICE = [
  /mile widziane/i, /dodatkowym atutem/i, /atutem będzie/i, /\batut(?:y|em)?\b/i, /nice[- ]to[- ]have/i, /\bbonus\b/i, /\bplus(?:es)?\b/i,
  /preferred/i, /good to have/i, /would be a plus/i, /będzie plusem/i, /dodatkowo/i,
];
const REQUIRED = [
  /wymaga[nm]/i, /kompetencje/i, /sprawdzisz się/i, /ideal(?:ny|na)? (?:candidate|kandydat)/i, /you(?:['’]ll| will) thrive/i, /right person/i, /perfect (?:match|fit)/i, /you(?:['’]re| are) a (?:perfect|great|good) (?:match|fit)/i, /idealn[ya] kandyda/i,
  /(?:będziesz|jesteś) (?:idealn|dobr)/i, /odnajdziesz się/i, /oczekujemy/i, /oczekiwania/i, /czego (?:od ciebie )?oczekujemy/i, /szukamy (?:osoby|kogoś|ciebie)/i,
  /twoje (?:kompetencje|umiejętności|doświadczenie)/i, /profil kandydata/i, /kogo szukamy/i, /musisz/i, /powinieneś|powinnaś/i,
  /requirements/i, /requirement/i, /what we expect/i, /we expect/i, /what you(?:['’]ll| will)? need/i, /you(?:['’]ll| will) need/i, /to succeed/i,
  /you (?:have|bring|should have)/i, /qualifications/i, /required skills/i, /skills (?:and|&) experience/i, /must know/i,
  /must[- ]haves?/i, /your (?:skills|profile|experience)/i, /we are looking for/i, /who you are/i, /about you/i, /what we(?:'re| are) looking for/i,
];
const OTHER = [
  /oferujemy/i, /co oferujemy/i, /we offer/i, /what we offer/i, /benefit/i, /obowiązki/i, /zakres obowiązków/i, /twoje zadania/i,
  /czym będziesz/i, /będziesz odpowiedzialn/i, /responsibilit/i, /your tasks/i, /what you(?:'ll| will) do/i, /o nas/i, /o firmie/i,
  /about (?:us|the company|the role|the project)/i, /in this (?:position|role)/i, /you will\b/i, /perks/i, /discover our/i, /rekrutacj/i, /recruitment/i, /proces/i, /process/i, /technolog/i, /tech stack/i,
  /stack technologiczny/i, /projekt/i, /project/i, /zespół/i, /team/i, /klauzula/i, /rodo/i, /gdpr/i, /dlaczego/i, /why/i,
];

const MAX_HEADING = 90;
/** List item markers seen in postings: "- ", "* ", "• ", "– ", "1. ", "1) ". */
const ITEM = /^(?:[-*•·–—▪◦●○■□►▸➢➤✓✔✅]\s*|\d{1,2}[.)]\s+)(?=\S)/u;
const MAX_LINE = 500;

/** A short line that names a section; null if it is ordinary text. Nice wins over required ("Nice to have requirements"). */
/** Postings are often typed without Polish letters ("Obowiazki"): match on folded text as well. */
const fold = (text: string): string => text.replace(/ł/g, "l").replace(/Ł/g, "L").normalize("NFD").replace(/\p{Mn}/gu, "");
const any = (patterns: readonly RegExp[], text: string): boolean => patterns.some((re) => re.test(text) || re.test(fold(text)) || new RegExp(fold(re.source), re.flags).test(fold(text)));

export function headingKind(line: string): SectionKind | null {
  // drop leading emoji / bullets / markdown ("🎯 What you’ll need", "## Wymagania") and the trailing colon
  const text = line.trim().replace(/^[^\p{L}\p{N}]+/u, "").replace(/[:：]\s*$/, "").trim();
  if (!text || text.length > MAX_HEADING || ITEM.test(line.trim())) return null;
  // a sentence is not a heading
  if (/[.!]$/.test(text) || text.split(/\s+/).length > 9) return null;
  if (any(NICE, text)) return "nice";
  if (any(REQUIRED, text)) return "required";
  if (any(OTHER, text)) return "other";
  // any other short line that introduces something ("Other details:", "Co przekona kandydata?") ends the previous section
  return /[:：?]\s*$/.test(line.trim()) ? "other" : null;
}

export function postingSections(text: string): { requirements: string[]; niceToHave: string[] } {
  const requirements = new Set<string>();
  const niceToHave = new Set<string>();
  let current: SectionKind | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const kind = headingKind(line);
    if (kind) {
      current = kind;
      continue;
    }
    const marker = ITEM.exec(line);
    if (!marker || current === null || current === "other") continue;
    const item = line.slice(marker[0].length).trim().replace(/[;,.]$/, "").slice(0, MAX_LINE).trim();
    if (!item) continue;
    (current === "required" ? requirements : niceToHave).add(item);
  }
  return { requirements: [...requirements].slice(0, 80), niceToHave: [...niceToHave].slice(0, 80) };
}
