import { projectSchema, type Profile } from "../schema";
import { mutateCv } from "../store";
import { factDigest, parseRepoRef, projectDraft } from "./draft";
import { listRepos, qualifyRepo, repoFacts } from "./github";
import { localRepoFacts, type LocalDeps } from "./local";
import { getRunner, type Runner } from "./runner";
import { isProfileRepo, preselectScore, rankEntry, showcaseChecklist, showcaseScore, type RankEntry } from "./score";
import { ShowcaseError, type CheckItem, type RepoFacts, type RepoSummary } from "./types";

/** SERVER-ONLY orchestration shared by the `knife_cv_*` tools and the `/api/cv/showcase/*` routes. */

export const RANK_CANDIDATES = 12;
export const RANK_TOP = 10;
const FETCH_CONCURRENCY = 3;

export type FactsWithChecklist = RepoFacts & { checklist: CheckItem[]; showcaseScore: number };

export function withChecklist(facts: RepoFacts, now: Date = new Date()): FactsWithChecklist {
  const checklist = showcaseChecklist(facts, now);
  return { ...facts, checklist, showcaseScore: showcaseScore(checklist) };
}

export async function githubRepos(owner?: string, runner: Runner = getRunner()): Promise<{ repos: RepoSummary[] }> {
  return { repos: await listRepos(runner, owner || undefined) };
}

export async function githubRepoFacts(repo: string, runner: Runner = getRunner(), now?: Date): Promise<FactsWithChecklist> {
  return withChecklist(await repoFacts(runner, await qualifyRepo(runner, repo)), now);
}

export async function localFacts(path: string, runner: Runner = getRunner(), deps?: LocalDeps, now?: Date): Promise<FactsWithChecklist> {
  return withChecklist(await localRepoFacts(runner, path, deps), now);
}

export interface RankResult {
  ranked: RankEntry[];
  considered: number;
  publicNonForkRepos: number;
  excluded: { forks: number; private: number; archived: number; profileReadmeRepo: number };
  skipped: { repo: string; error: string }[];
  note: string;
}

/** Top public non-fork repos by showcase value. List data pre-selects candidates so only `RANK_CANDIDATES` repos cost full `gh` fact fetches. */
export async function showcaseRank(owner?: string, runner: Runner = getRunner(), now: Date = new Date()): Promise<RankResult> {
  const repos = await listRepos(runner, owner || undefined);
  const mine = repos.filter((r) => !(r.isFork || r.isPrivate || r.isArchived || isProfileRepo(r)));
  const candidates = mine
    .map((r) => ({ r, pre: preselectScore(r, now) }))
    .sort((a, b) => b.pre - a.pre)
    .slice(0, RANK_CANDIDATES)
    .map((c) => c.r);

  const entries: RankEntry[] = [];
  const skipped: RankResult["skipped"] = [];
  for (let i = 0; i < candidates.length; i += FETCH_CONCURRENCY) {
    await Promise.all(
      candidates.slice(i, i + FETCH_CONCURRENCY).map(async (summary) => {
        try {
          const facts = await repoFacts(runner, summary.fullName);
          entries.push(rankEntry(summary, facts, showcaseChecklist(facts, now), now));
        } catch (error) {
          if (!(error instanceof ShowcaseError)) throw error;
          skipped.push({ repo: summary.fullName, error: error.message });
        }
      }),
    );
  }
  entries.sort((a, b) => b.score - a.score || a.repo.localeCompare(b.repo));
  return {
    ranked: entries.slice(0, RANK_TOP),
    considered: candidates.length,
    publicNonForkRepos: mine.length,
    excluded: {
      forks: repos.filter((r) => r.isFork).length,
      private: repos.filter((r) => r.isPrivate).length,
      archived: repos.filter((r) => r.isArchived).length,
      profileReadmeRepo: repos.filter(isProfileRepo).length,
    },
    skipped,
    note: "score 0-100 = stars 25 + recency 20 + commit count 15 + README/presentation checklist 40.",
  };
}

/**
 * Add (or refresh) a CV project from a GitHub repo link. A new project is a draft: name, link, technologies and the
 * repo description; a project already linked to that repo only gets its technologies and link refreshed (the user's
 * own wording is never overwritten). Returns the facts the prose may be written from.
 */
export async function addProjectFromGithub(accountId: string, repoInput: string, pinned = false, runner: Runner = getRunner()): Promise<{ project: Profile["projects"][number]; created: boolean; revision: number; facts: Record<string, unknown> }> {
  const ref = parseRepoRef(repoInput);
  if (!ref) throw new ShowcaseError(`'${repoInput.slice(0, 200)}' is not a GitHub repo link (https://github.com/owner/name) or 'owner/name'.`);
  const facts = await githubRepoFacts(ref, runner);
  const fullName = facts.url ? facts.url.replace(/^https?:\/\/github\.com\//i, "").replace(/\/$/, "") : ref;
  const { data, result } = mutateCv(accountId, (current) => {
    const p = current.profile;
    const sameRepo = (x: Profile["projects"][number]) => x.source === `github:${fullName}` || (facts.url !== null && x.url.replace(/\/$/, "").toLowerCase() === facts.url.replace(/\/$/, "").toLowerCase());
    const existing = p.projects.find(sameRepo);
    if (existing) {
      const draft = projectDraft(facts, fullName, p, existing.pinned || pinned);
      const tech = [...existing.tech, ...draft.tech.filter((t) => !existing.tech.some((e) => e.toLowerCase() === t.toLowerCase()))].slice(0, 40);
      const updated = { ...existing, url: existing.url || draft.url, tech, source: draft.source, pinned: existing.pinned || pinned, summary: existing.summary.en || existing.summary.pl ? existing.summary : draft.summary };
      return { data: { ...current, profile: { ...p, projects: p.projects.map((x) => (x.id === existing.id ? updated : x)) } }, result: { project: updated, created: false } };
    }
    const project = projectSchema.parse(projectDraft(facts, fullName, p, pinned));
    return { data: { ...current, profile: { ...p, projects: [...p.projects, project] } }, result: { project, created: true } };
  });
  return { ...result, revision: data.revision, facts: factDigest(facts) };
}
