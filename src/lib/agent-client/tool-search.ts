import { SLUG_ALIASES, TOOLS, familyLabel, type ToolMeta, type ToolTab } from "@/lib/registry";

/**
 * Tab-aware search for the agent. Suites hold their tabs, and the words a user
 * would say ("base64", "csv merge", "cron") often name a tab or a retired slug
 * rather than the suite, so every tab is a separate candidate. Ranking favours
 * words that name the tab itself over words that only match the suite.
 */

export interface ToolTarget {
  slug: string;
  tab?: string;
  /** "Suite › Tab" or the tool name. */
  label: string;
  summary: string;
  /** Tool keywords, those matching the query first, so the model can confirm the fit. */
  keywords: string[];
  score: number;
}

const STOPWORDS = new Set([
  "the", "a", "an", "to", "for", "me", "my", "of", "in", "on", "and", "or", "with", "tool", "tab", "open", "use", "please", "page", "can", "you", "this", "that", "it", "is",
]);

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export function queryTerms(query: string): string[] {
  const terms = words(query).filter((t) => !STOPWORDS.has(t));
  return terms.length > 0 ? terms : words(query);
}

function matchScore(terms: string[], hay: string[], exact: number, prefix: number, sub: number): number {
  let score = 0;
  for (const t of terms) {
    if (hay.includes(t)) score += exact;
    else if (hay.some((h) => h.startsWith(t))) score += prefix;
    else if (t.length >= 3 && hay.some((h) => h.includes(t))) score += sub;
  }
  return score;
}

function aliasWordsByTab(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [oldSlug, target] of Object.entries(SLUG_ALIASES)) {
    if (!target.tab) continue;
    const key = `${target.slug}:${target.tab}`;
    map.set(key, [...(map.get(key) ?? []), ...words(oldSlug)]);
  }
  return map;
}

let aliasIndex: Map<string, string[]> | null = null;

function scoreTarget(terms: string[], tool: ToolMeta, tab: ToolTab | undefined): number {
  const own = tab ? [...words(tab.id), ...words(tab.label), ...words(tab.component)] : [];
  if (tab) {
    aliasIndex ??= aliasWordsByTab();
    own.push(...(aliasIndex.get(`${tool.slug}:${tab.id}`) ?? []));
  }
  const suiteName = [...words(tool.name), ...words(tool.slug)];
  const keywords = tool.keywords.flatMap(words);
  const tagline = words(tool.tagline);
  const family = words(familyLabel(tool.family));

  let score = 0;
  let matched = 0;
  for (const term of terms) {
    const one = [term];
    const s =
      matchScore(one, own, 60, 36, 18) +
      matchScore(one, suiteName, 30, 18, 10) +
      matchScore(one, keywords, 20, 12, 6) +
      matchScore(one, tagline, 12, 7, 0) +
      matchScore(one, family, 8, 4, 0);
    if (s > 0) matched += 1;
    score += s;
  }
  if (matched === 0) return 0;
  return score * (0.5 + matched / terms.length);
}

function showKeywords(terms: string[], tool: ToolMeta): string[] {
  const hit = (k: string): boolean => words(k).some((w) => terms.some((t) => w === t || w.startsWith(t)));
  return [...tool.keywords.filter(hit), ...tool.keywords.filter((k) => !hit(k))].slice(0, 8);
}

/** Ranked, flat list of everything openable that matches the query. */
export function searchTargets(query: string, pool: readonly ToolMeta[] = TOOLS, limit = 8): ToolTarget[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const out: ToolTarget[] = [];
  for (const tool of pool) {
    if (!tool.tabs) {
      const score = scoreTarget(terms, tool, undefined);
      if (score > 0) out.push({ slug: tool.slug, label: tool.name, summary: tool.tagline, keywords: showKeywords(terms, tool), score });
      continue;
    }
    tool.tabs.forEach((tab, index) => {
      // The first tab is what the suite opens on, so it wins ties.
      const score = scoreTarget(terms, tool, tab) + (index === 0 ? 0.5 : 0);
      if (score > 0.5 || (score > 0 && index !== 0)) {
        out.push({ slug: tool.slug, tab: tab.id, label: `${tool.name} › ${tab.label}`, summary: tool.tagline, keywords: showKeywords(terms, tool), score });
      }
    });
  }
  return out.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label)).slice(0, limit);
}
