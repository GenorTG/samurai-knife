import * as z from "zod/v4";
import { defineTool, type KnifeToolDefinition } from "./define";
import { githubRepoFacts, githubRepos, localFacts, showcaseRank } from "@/lib/cv/showcase/service";

/**
 * CV studio "showcase" tools: verifiable project facts (GitHub via the authenticated `gh` CLI, or a path-fenced local repo)
 * plus a deterministic README/presentation checklist. Facts only, nothing here calls an LLM; the assistant writes the prose.
 */

const owner = z.string().min(1).max(100).optional().describe("GitHub user/org login. Omit for the authenticated account.");

export const CV_SHOWCASE_TOOLS: KnifeToolDefinition[] = [
  defineTool({
    name: "knife_cv_github_repos",
    description:
      "List a GitHub account's repos (description, language, stars, topics, last push, fork/private/archived, size). Uses the host's authenticated `gh` CLI. Facts only.",
    schema: z.object({ owner }).strict(),
    run: ({ owner: login }) => githubRepos(login),
  }),
  defineTool({
    name: "knife_cv_github_repo_facts",
    description:
      "Verified facts about ONE GitHub repo: README excerpt, languages (bytes), commit count + first/last commit date, contributors, top-level tree, topics, license, latest release, CI/tests presence, open issues (incl. PRs), plus a deterministic README/presentation checklist (items with advice) and showcaseScore 0-100. Write project descriptions ONLY from these returned facts: never invent features, numbers, users or dates; say 'not found' when a fact is missing.",
    schema: z.object({ repo: z.string().min(1).max(200).describe("'owner/name', or just 'name' for the authenticated account.") }).strict(),
    run: ({ repo }) => githubRepoFacts(repo),
  }),
  defineTool({
    name: "knife_cv_local_repo_facts",
    description:
      "Same kind of facts for a PRIVATE/local git repo: commit stats, authors, lines of code by language (from file extensions), README head, test-file count, CI config, manifest names (never versions/scripts), plus the checklist and showcaseScore. The path must be a git repo root inside an allow-listed root (default ~/work, ~/projects, ~/godot-projects; env KNIFE_CV_REPO_ROOTS); anything else is refused. Secret-like files (.env*, keys, credentials) are never read or listed. Write descriptions ONLY from the returned facts.",
    schema: z.object({ path: z.string().min(1).max(1_000).describe("Absolute path of the git repo root.") }).strict(),
    run: ({ path }) => localFacts(path),
  }),
  defineTool({
    name: "knife_cv_showcase_rank",
    description:
      "Rank the account's public, non-fork, non-archived repos by showcase value (stars 25, recency 20, commit count 15, README/presentation checklist 40). Returns the top 10 with reasons, a score breakdown and what to improve first. Candidates are pre-selected from list data to cap `gh` calls. Use it to pick which projects to feature on the CV; then fetch facts per project.",
    schema: z.object({ owner }).strict(),
    run: ({ owner: login }) => showcaseRank(login),
  }),
];
