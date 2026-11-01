/**
 * Plain-text search over repository files already in memory (knife_site_search on a work branch: GitHub's code index
 * covers the default branch only). Case-insensitive substring, no regex; runs in the isolate pool (tasks.ts) because
 * the file texts and the query come from outside. Pure.
 */

export interface TextSearchFile { path: string; text: string }
export interface TextSearchHit { path: string; fragments: string[]; matches: number }

export function searchTexts(files: TextSearchFile[], query: string, maxHits = 30, maxFragments = 3): TextSearchHit[] {
  const needle = query.toLowerCase();
  if (!needle) return [];
  const hits: TextSearchHit[] = [];
  for (const file of files) {
    if (hits.length >= maxHits) break;
    const hay = file.text.toLowerCase();
    let at = hay.indexOf(needle);
    if (at < 0) continue;
    const fragments: string[] = [];
    let matches = 0;
    while (at >= 0) {
      matches += 1;
      if (fragments.length < maxFragments) fragments.push(file.text.slice(Math.max(0, at - 60), at + needle.length + 60));
      at = hay.indexOf(needle, at + needle.length);
    }
    hits.push({ path: file.path, fragments, matches });
  }
  return hits;
}
