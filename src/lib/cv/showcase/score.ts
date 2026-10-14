import type { CheckItem, RepoFacts, RepoSummary } from "./types";

/** Deterministic showcase checks and ranking math. Pure (no node APIs). Advice is English; the assistant translates. */

export const RECENT_DAYS = 90;
const DAY_MS = 86_400_000;

const BADGE_HOSTS = ["shields.io", "badge", "travis-ci", "codecov", "coveralls", "/actions/workflows"];
const IMG_MD = /!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g;
const IMG_MD_LINE = /!\[[^\]]*\]\(([^)\s]+)[^)]*\)/;
const IMG_HTML = /<img[^>]+src=["']([^"']+)/gi;
const MEDIA = /\.(gif|mp4|webm|mov)\b|youtu\.?be|asciinema|loom\.com/i;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/gm;
const FENCE = /^\s*(```|~~~)/m;
const INSTALL = /install|setup|set up|getting started|quick ?start|build|requirements/i;
const USAGE = /usage|example|how to use|using|quick ?start|demo/i;
const TECH = /tech|built with|stack|technologies|tools|made with|powered by/i;
const LICENSE_HEAD = /licen[sc]e/i;

function matches(re: RegExp, text: string): string[] {
  return [...text.matchAll(re)].map((m) => m[1]);
}

function imageUrls(readme: string): string[] {
  return [...matches(IMG_MD, readme), ...matches(IMG_HTML, readme)];
}

function isBadge(url: string): boolean {
  const lower = url.toLowerCase();
  return BADGE_HOSTS.some((h) => lower.includes(h));
}

/** A plain prose line (>=4 words, <=200 chars) among the first 3 content lines. */
export function hasTagline(readme: string): boolean {
  const content = readme
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !IMG_MD_LINE.test(l) && !l.startsWith("<") && !l.startsWith("[!["));
  for (const line of content.slice(0, 3)) {
    if (/^(#|```|~~~|\||-|\*|>|=)/.test(line)) continue;
    if (line.split(/\s+/).length >= 4 && line.length <= 200) return true;
  }
  return false;
}

export function showcaseChecklist(facts: RepoFacts, now: Date = new Date()): CheckItem[] {
  const readme = facts.readme;
  const heads = matches(HEADING, readme);
  const images = imageUrls(readme);
  const hasCode = FENCE.test(readme);
  const items: CheckItem[] = [];
  const add = (id: string, passed: boolean, weight: number, advice: string): void => {
    items.push({ id, passed, weight, advice });
  };

  add("readme", readme.trim().length > 0, 3, "Add a README.md; it is the project's landing page.");
  add("tagline", hasTagline(readme), 3, "Open the README with a one-line tagline saying what the project is and who it is for.");
  add(
    "visual",
    images.some((u) => !isBadge(u)) || MEDIA.test(readme) || /screenshot|live demo/i.test(readme),
    3,
    "Add a screenshot, GIF or demo link near the top; visitors decide in seconds.",
  );
  add("install_run", heads.some((h) => INSTALL.test(h)) && hasCode, 3, "Add an Install/Getting started section with copy-pasteable commands to build and run it.");
  add("usage_example", heads.some((h) => USAGE.test(h)) && hasCode, 2, "Add a Usage section with at least one runnable code or command example.");
  add("tech_list", heads.some((h) => TECH.test(h)) || /built with|tech stack/i.test(readme), 2, "List the main technologies (a 'Built with' section) so skills show at a glance.");
  add("license", Boolean(facts.license) || heads.some((h) => LICENSE_HEAD.test(h)), 2, "Add a LICENSE file so others know how they may use the code.");
  if (facts.source === "github") {
    add("topics", facts.topics.length >= 3, 2, "Set at least 3 GitHub topics so the repo shows up in search and filters.");
    add("description", Boolean(facts.description), 2, "Set the repository description (the line shown in repo lists and search).");
  }
  add("tests", facts.hasTests, 2, "Add automated tests, or a tests/ directory, and mention how to run them.");
  add("ci", facts.hasCi, 2, "Add CI (e.g. a GitHub Actions workflow) that runs the tests on every push.");
  const age = daysSince(facts.lastCommit, now);
  add("recent_activity", age !== null && age < RECENT_DAYS, 2, `No commit in the last ${RECENT_DAYS} days; ship a small update to show it is alive.`);
  add("badges", images.some(isBadge), 1, "Optional: add status badges (CI, license, version).");
  return items;
}

/** Weighted share of passed checks, 0-100. */
export function showcaseScore(items: CheckItem[]): number {
  const total = items.reduce((sum, i) => sum + i.weight, 0);
  const passed = items.reduce((sum, i) => sum + (i.passed ? i.weight : 0), 0);
  return total ? Math.round((100 * passed) / total) : 0;
}

/** Failed checks, heaviest first (stable for equal weights). */
export function topImprovements(items: CheckItem[], n = 3): CheckItem[] {
  return items.filter((i) => !i.passed).sort((a, b) => b.weight - a.weight).slice(0, n);
}

// --- ranking ---------------------------------------------------------------------------------------------------------

export function daysSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((now.getTime() - t) / DAY_MS));
}

const starsPts = (stars: number): number => Math.min(25, 5 * Math.log2(1 + stars));
const commitsPts = (commits: number): number => Math.min(15, 3 * Math.log2(1 + commits));

function recencyPts(days: number | null): number {
  if (days === null) return 0;
  for (const [limit, pts] of [[30, 20], [90, 15], [180, 10], [365, 5]] as const) if (days <= limit) return pts;
  return 0;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Cheap pre-ranking from list data alone, to decide which repos deserve a full fact fetch. */
export function preselectScore(s: RepoSummary, now: Date): number {
  const size = Math.min(15, 3 * Math.log2(1 + s.sizeKb / 10));
  return starsPts(s.stars) + recencyPts(daysSince(s.pushedAt, now)) + size + (s.description ? 5 : 0);
}

export interface RankEntry {
  repo: string;
  url: string;
  score: number;
  breakdown: { stars: number; recency: number; commits: number; presentation: number };
  reasons: string[];
  improveFirst: string[];
}

/** Final showcase value (0-100): stars 25 + recency 20 + commit count 15 + README/presentation checklist 40. */
export function rankEntry(summary: RepoSummary, facts: RepoFacts, items: CheckItem[], now: Date): RankEntry {
  const days = daysSince(facts.lastCommit ?? summary.pushedAt, now);
  const quality = showcaseScore(items);
  const breakdown = {
    stars: round1(starsPts(summary.stars)),
    recency: recencyPts(days),
    commits: round1(commitsPts(facts.commitCount ?? 0)),
    presentation: round1(quality * 0.4),
  };
  return {
    repo: summary.fullName,
    url: summary.url,
    score: round1(breakdown.stars + breakdown.recency + breakdown.commits + breakdown.presentation),
    breakdown,
    reasons: [
      `${summary.stars} star(s), ${summary.forks} fork(s)`,
      days !== null ? `last commit ${days} day(s) ago` : "no commits found",
      `${facts.commitCount ?? 0} commit(s), ${facts.contributors ?? 0} contributor(s)`,
      `README/presentation checklist ${quality}/100`,
    ],
    improveFirst: topImprovements(items).map((i) => i.advice),
  };
}

/** The special `<owner>/<owner>` repo only renders the GitHub profile page, not a project. */
export function isProfileRepo(repo: Pick<RepoSummary, "fullName" | "name">): boolean {
  return repo.fullName.toLowerCase().split("/")[0] === repo.name.toLowerCase();
}
