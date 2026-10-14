import { CvCollectionError, upsertVariant } from "./collections";
import { readPath } from "./ops";
import { REWRITE_PATH, type Bi, type CvData, type Variant } from "./schema";
import { profileCorpus, rewriteWarnings } from "./text/guard";

/**
 * Per-version wording: set or drop rewrites of master texts on one variant (the master profile is never touched).
 * Every new wording is checked against the master text it replaces (facts dropped, facts invented). Pure.
 */

export interface RewriteInput {
  path: string;
  text: Partial<Bi>;
}

export function rewriteWarningsFor(data: CvData, rewrites: readonly { path: string; text: Bi }[]): string[] {
  const corpus = profileCorpus(data.profile);
  return rewrites.flatMap((rw) => {
    try {
      const master = readPath(data.profile, rw.path) as Bi;
      return rewriteWarnings(rw.path, master, rw.text, corpus);
    } catch {
      return [];
    }
  });
}

export function setRewrites(data: CvData, variantId: string, set: readonly RewriteInput[], remove: readonly string[] = []): { data: CvData; variant: Variant; warnings: string[] } {
  const current = data.variants.find((v) => v.id === variantId);
  if (!current) throw new CvCollectionError(`no variant '${variantId}' (have: ${data.variants.map((v) => v.id).join(", ") || "none"})`);
  const byPath = new Map(current.rewrites.map((rw) => [rw.path, rw]));
  for (const path of remove) byPath.delete(path);
  const changed: { path: string; text: Bi }[] = [];
  for (const rw of set) {
    if (!REWRITE_PATH.test(rw.path)) {
      throw new CvCollectionError(`cannot reword '${rw.path}': only bullet texts (/experience/id=x/bullets/id=y/text, /projects/id=p/bullets/id=b/text), project summaries (/projects/id=p/summary), experience notes (/experience/id=x/note) and custom item texts (/customSections/id=s/items/id=i/text). Headline and summary are set with knife_cv_variant_create.`);
    }
    const prev = byPath.get(rw.path)?.text ?? { pl: "", en: "" };
    const text: Bi = { pl: rw.text.pl ?? prev.pl, en: rw.text.en ?? prev.en };
    let master: Bi | null = null;
    try {
      master = readPath(data.profile, rw.path) as Bi;
    } catch {
      master = null; // upsertVariant reports the bad path
    }
    // a "rewrite" that says what the profile says is no rewrite (an empty side already means "the profile's text")
    const same = (lang: "pl" | "en") => !text[lang].trim() || (master !== null && text[lang].trim() === master[lang].trim());
    if (same("pl") && same("en")) {
      byPath.delete(rw.path);
      continue;
    }
    byPath.set(rw.path, { path: rw.path, text });
    changed.push({ path: rw.path, text });
  }
  const { data: next, variant } = upsertVariant(data, { ...current, rewrites: [...byPath.values()] });
  return { data: next, variant, warnings: rewriteWarningsFor(data, changed) };
}
