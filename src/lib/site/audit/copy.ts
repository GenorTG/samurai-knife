import { detectLang } from "@/lib/cv/langdetect";
import type { CopyMetrics, Issue, PageFacts } from "./types";

/**
 * Copywriting benchmarks of one page's visible text, Polish or English (pure). Each dimension scores 0-100 with the rule
 * spelled out next to it; the total is a weighted mean. These are heuristics that point at what to rewrite: the model
 * (assistant / MCP agent) does the writing.
 */

const VOWELS_PL = /[aąeęioóuy]+/gi;
/** Buzzwords that say nothing on a personal / company site (PL + EN, lower case, matched on word boundaries). */
export const BUZZWORDS = [
  "innowacyjn", "kompleksow", "synergi", "nowoczesne rozwiązania", "najwyższej jakości", "profesjonaln", "dynamiczn", "lider", "pasjonat", "holistyczn",
  "cutting-edge", "cutting edge", "innovative", "synergy", "world-class", "best-in-class", "passionate", "rockstar", "ninja", "guru", "next-generation", "game-changer", "game changer", "leverage", "seamless", "robust solutions", "state-of-the-art", "disruptive",
];
/** `\b` only knows ASCII letters: Polish words ending in ę/ń/ó would never match. These boundaries know every letter. */
export function words(alternation: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternation})(?![\\p{L}\\p{N}])`, "giu");
}
const YOU_EN = words("you|your|yours|you're");
const WE_EN = words("i|me|my|mine|we|our|ours|us|i'm|i've");
const YOU_PL = words("ty|ciebie|cię|tobie|twój|twoja|twoje|twoich|twoim|pan|pani|państwo|państwa|wasz|wasza|wasze|was|wam");
const WE_PL = words("ja|mnie|mi|mój|moja|moje|moich|moim|my|nas|nasz|nasza|nasze|naszych|naszym|nam");
/** Numbers that carry a claim: percentages, counts of things, years of experience, money, users. */
const PROOF = /(?<![\p{L}\p{N}])\d[\d\s.,]*\s?(?:%|\+|k(?!\p{L})|tys\.?|mln|lat(?!\p{L})|years?|projekt\p{L}*|projects?|klient\p{L}*|clients?|users?|użytkownik\p{L}*|godzin\p{L}*|hours?|zł|pln|eur|€|\$|x(?!\p{L}))/giu;
const PROOF_WORDS = words("case study|portfolio|wdrożon\\p{L}*|zrealizowan\\p{L}*|referencj\\p{L}*|opini\\p{L}*|testimonial\\p{L}*|wyniki|results?|delivered|built|launched|shipped|zbudowa\\p{L}*|uruchomi\\p{L}*");

function syllablesPl(word: string): number {
  // "i" before another vowel only softens the consonant (nie, się, cia): not a syllable of its own.
  const w = word.toLowerCase().replace(/i(?=[aąeęoóuy])/g, "");
  return Math.max(1, (w.match(VOWELS_PL) ?? []).length);
}

function syllablesEn(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length <= 3) return 1;
  const trimmed = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
  return Math.max(1, (trimmed.match(/[aeiouy]{1,2}/g) ?? []).length);
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => (s.match(/\p{L}+/gu) ?? []).length >= 3);
}

const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));
const lerp = (value: number, at0: number, at100: number): number => clamp(((value - at0) / (at100 - at0)) * 100);

export function analyzeCopy(facts: Pick<PageFacts, "text" | "headings" | "ctas" | "links">, now = new Date()): CopyMetrics {
  const text = facts.text;
  const detected = detectLang(text);
  const lang: CopyMetrics["lang"] = detected === "unknown" ? "unknown" : detected;
  const tokens = text.match(/\p{L}[\p{L}'’-]*/gu) ?? [];
  const sentences = splitSentences(text);
  const sentenceWords = sentences.map((s) => (s.match(/\p{L}+/gu) ?? []).length);
  const avg = sentenceWords.length ? sentenceWords.reduce((a, b) => a + b, 0) / sentenceWords.length : 0;
  const longLimit = lang === "pl" ? 20 : 25;
  const longShare = sentenceWords.length ? sentenceWords.filter((n) => n > longLimit).length / sentenceWords.length : 0;

  let readability: CopyMetrics["readability"] = { formula: "none", value: 0, label: "too little text" };
  let readabilityScore = 50;
  if (tokens.length >= 30 && sentences.length >= 2) {
    if (lang === "pl") {
      // FOG-PL (W. Pisarek): 0.4 x (words per sentence + 100 x share of words with 4+ syllables). ~7-9 easy, 10-12 secondary school, 13-15 university, 16+ hard.
      const hard = tokens.filter((w) => syllablesPl(w) >= 4).length / tokens.length;
      const fog = 0.4 * (tokens.length / sentences.length + 100 * hard);
      readability = { formula: "fog-pl", value: Math.round(fog * 10) / 10, label: fog <= 9 ? "easy" : fog <= 12 ? "secondary school" : fog <= 15 ? "university" : "hard" };
      readabilityScore = lerp(fog, 20, 9);
    } else {
      // Flesch reading ease: 206.835 - 1.015 (words/sentence) - 84.6 (syllables/word). 60-70 plain English, < 30 very hard.
      const syl = tokens.reduce((n, w) => n + syllablesEn(w), 0) / tokens.length;
      const fre = 206.835 - 1.015 * (tokens.length / sentences.length) - 84.6 * syl;
      readability = { formula: "flesch", value: Math.round(fre), label: fre >= 60 ? "plain" : fre >= 50 ? "fairly hard" : fre >= 30 ? "hard" : "very hard" };
      readabilityScore = lerp(fre, 20, 60);
    }
  }

  const h1 = facts.headings.find((h) => h.level === 1)?.text ?? "";
  const h1Words = (h1.match(/\p{L}+/gu) ?? []).length;
  // Hero: an H1 exists (40), says something in 3-12 words (30), and real copy follows it in the first 400 characters (30).
  const afterH1 = h1 ? text.slice(text.indexOf(h1) + h1.length, text.indexOf(h1) + h1.length + 400) : "";
  const hero = (h1 ? 40 : 0) + (h1Words >= 3 && h1Words <= 12 ? 30 : h1Words ? 10 : 0) + ((afterH1.match(/\p{L}+/gu) ?? []).length >= 8 ? 30 : 0);

  const contactChannels = facts.links.contacts.length;
  // CTA: none 0, one 60, two or more 85, +15 when a direct contact (mailto/tel) is on the page.
  const ctaCount = facts.ctas.length;
  const cta = clamp((ctaCount === 0 ? 0 : ctaCount === 1 ? 60 : 85) + (contactChannels ? 15 : 0));

  const proofSignals = (text.match(PROOF) ?? []).length + (text.match(PROOF_WORDS) ?? []).length + Math.min(3, facts.links.profiles.length);
  // Proof: concrete numbers, results and project links; 6+ signals = 100.
  const proof = clamp((proofSignals / 6) * 100);

  const you = (text.match(lang === "pl" ? YOU_PL : YOU_EN) ?? []).length;
  const we = (text.match(lang === "pl" ? WE_PL : WE_EN) ?? []).length;
  const youShare = you + we ? you / (you + we) : 0;
  // Reader focus: share of "you" words among you+I/we words; 40%+ = 100, all about "me" = 40 (a personal site may say "I").
  const focus = you + we ? clamp(40 + (Math.min(youShare, 0.4) / 0.4) * 60) : 60;

  const lower = text.toLowerCase();
  const buzz = BUZZWORDS.filter((b) => lower.includes(b));
  const buzzHits = BUZZWORDS.reduce((n, b) => n + (lower.split(b).length - 1), 0);
  // Buzzwords: -25 per hit per 100 words.
  const buzzwords = clamp(100 - (tokens.length ? (buzzHits / tokens.length) * 100 * 25 : 0));

  // Substance: enough words to say something (150 = 60, 400+ = 100) without a wall (> 3000 words = 80).
  const substance = tokens.length >= 3000 ? 80 : lerp(tokens.length, 0, 400) * 0.4 + (tokens.length >= 150 ? 60 : (tokens.length / 150) * 60);

  const years = (text.match(/\b(?:19|20)\d{2}\b/g) ?? []).map(Number).filter((y) => y <= now.getFullYear() + 1);
  const copyright = /(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/i.exec(text);

  const scores = {
    readability: readabilityScore,
    sentences: clamp(100 - longShare * 100 * 2),
    hero: clamp(hero),
    cta,
    proof,
    focus,
    buzzwords,
    substance: clamp(substance),
  };
  const weights: Record<keyof typeof scores, number> = { readability: 2, sentences: 1, hero: 2, cta: 2, proof: 2, focus: 1, buzzwords: 1, substance: 1 };
  const total = Object.entries(scores).reduce((n, [k, v]) => n + v * weights[k as keyof typeof scores], 0) / Object.values(weights).reduce((a, b) => a + b, 0);
  return {
    lang,
    words: tokens.length,
    sentences: sentences.length,
    avgSentenceWords: Math.round(avg * 10) / 10,
    longSentenceShare: Math.round(longShare * 100) / 100,
    readability,
    ctaCount,
    proofSignals,
    youShare: Math.round(youShare * 100) / 100,
    buzzwords: buzz,
    newestYear: years.length ? Math.max(...years) : null,
    copyrightYear: copyright ? Number(copyright[1]) : null,
    scores,
    score: clamp(total),
  };
}

export function copyIssues(copy: CopyMetrics, page: string, now = new Date()): Issue[] {
  const out: Issue[] = [];
  const add = (id: string, severity: Issue["severity"], title: string, detail: string, fix: string) => out.push({ id, severity, category: "copy", title, detail, page, fix });
  if (copy.words < 30) return out; // nothing to judge (thin content is reported by the page checks)
  if (copy.scores.readability < 50) {
    add("copy.readability", "medium", `Hard to read (${copy.readability.formula === "fog-pl" ? `FOG-PL ${copy.readability.value}` : `Flesch ${copy.readability.value}`}, ${copy.readability.label})`,
      `${copy.avgSentenceWords} words per sentence on average.`, copy.lang === "pl" ? "Krótsze zdania, mniej długich słów; cel FOG-PL około 9-10." : "Shorter sentences and plainer words; aim for Flesch 60+.");
  }
  if (copy.longSentenceShare > 0.2) add("copy.long-sentences", "low", `${Math.round(copy.longSentenceShare * 100)}% of sentences are long`, `Over ${copy.lang === "pl" ? 20 : 25} words each.`, "Split long sentences; one idea per sentence.");
  if (copy.scores.hero < 70) add("copy.hero", "high", "The first screen does not say clearly who you are and what you offer", "Missing or vague H1, or no supporting line right after it.", "State in one H1 (3-12 words) who you help and how, then one sentence of proof or detail under it.");
  if (copy.ctaCount === 0) add("copy.cta", "high", "No call to action", "Nothing on the page asks the visitor to contact you, book, or see your work.", "Add one primary CTA (e.g. \"Napisz do mnie\" / \"Let's talk\" with mailto or a contact form) near the top and at the end.");
  if (copy.scores.proof < 50) add("copy.proof", "medium", "Few concrete proofs", `${copy.proofSignals} numbers/results/project links found.`, "Back claims with numbers (years, projects shipped, users, % gains) and link real projects (GitHub, case studies).");
  if (copy.buzzwords.length) add("copy.buzzwords", "low", `Empty buzzwords: ${copy.buzzwords.slice(0, 6).join(", ")}`, "", "Replace each with the concrete thing you did or deliver.");
  if (copy.scores.focus < 55) add("copy.focus", "low", "The copy talks about you more than about the visitor", `${Math.round(copy.youShare * 100)}% "you" words.`, "Frame services as the visitor's outcome (\"you get...\", \"Twoja firma...\").");
  const year = now.getFullYear();
  if (copy.copyrightYear && copy.copyrightYear < year) add("content.copyright-year", "low", `Footer says © ${copy.copyrightYear}`, "Visitors read an old year as an abandoned site.", "Render the current year (or a range ending with it).");
  if (copy.newestYear && copy.newestYear < year - 1) add("content.stale", "medium", `The newest year mentioned is ${copy.newestYear}`, "The page may not show what you do now.", "Add your current work/projects and dates.");
  return out;
}
