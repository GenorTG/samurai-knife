/** Polish vs English detection for short texts (chat messages, job postings). Pure; relative imports only. */

export type DetectedLang = "pl" | "en" | "unknown";

const words = (text: string): ReadonlySet<string> => new Set(text.split(/\s+/).filter(Boolean));

const PL_STOP = words(
  "i w z na do się nie oraz jest dla że jako przez lub będzie od po przy są to jak co ma " +
    "czy też być oraz naszym nasz nasza naszej mamy szukamy wymagamy oferujemy",
);
const EN_STOP = words(
  "the and of to in for with is are you we our will be on as at by or an this that from " +
    "your have has their about experience team",
);
const PL_DIACRITICS = new Set("ąćęłńóśźżĄĆĘŁŃÓŚŹŻ");

/** Polish vs English by diacritics and stopwords. "unknown" when there is too little signal. */
export function detectLang(text: string): DetectedLang {
  const tokens = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  let plHits = 0;
  let enHits = 0;
  for (const w of tokens) {
    if (PL_STOP.has(w)) plHits += 1;
    if (EN_STOP.has(w)) enHits += 1;
  }
  let diacritics = 0;
  for (const c of text) if (PL_DIACRITICS.has(c)) diacritics += 1;
  const plScore = plHits + Math.min(diacritics, 20) / 2;
  if (plScore + enHits < 3) return "unknown";
  if (plScore > enHits) return "pl";
  return enHits > plScore ? "en" : "unknown";
}
