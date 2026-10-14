import { uniqueId } from "../collections";
import { extractTerms } from "../jobs/match";
import type { Profile } from "../schema";
import type { RepoFacts } from "./types";

/**
 * A GitHub repo -> a DRAFT CV project built from verifiable facts only: name, link, technologies (languages by share,
 * topics and dependency names that are known technologies) and the repo's own one-line description. The prose (summary
 * in both languages, bullets) is left for the user or the assistant to write from the returned facts. Pure.
 */

const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const MIN_LANGUAGE_SHARE = 0.05;
const MAX_TECH = 12;

/** "https://github.com/owner/name(.git)(/tree/…)", "github.com/owner/name", "owner/name" or a bare "name" -> the ref `gh` takes. */
export function parseRepoRef(input: string): string | null {
  const raw = input.trim().replace(/[#?].*$/, "");
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/.*)?$/i.exec(raw);
  if (url) return REPO.test(url[1]) && REPO.test(url[2]) ? `${url[1]}/${url[2]}` : null;
  if (/^[^/\s]+\/[^/\s]+$/.test(raw)) {
    const [owner, name] = raw.split("/");
    return REPO.test(owner) && REPO.test(name.replace(/\.git$/, "")) ? `${owner}/${name.replace(/\.git$/, "")}` : null;
  }
  return REPO.test(raw) ? raw : null;
}

/** Languages with at least 5% of the code, biggest first. */
export function mainLanguages(languages: Record<string, number>): string[] {
  const total = Object.values(languages).reduce((n, v) => n + v, 0);
  if (!total) return [];
  return Object.entries(languages).filter(([, v]) => v / total >= MIN_LANGUAGE_SHARE).sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

/** Package names whose technology the dictionary cannot see from the bare name (lower-case package -> label). */
const PACKAGE_TECH: Record<string, string> = {
  next: "Next.js", express: "Express", torch: "PyTorch", "@nestjs/core": "NestJS", "@angular/core": "Angular", "@sveltejs/kit": "Svelte",
  "socket.io": "WebSocket", ws: "WebSocket", pg: "PostgreSQL", "better-sqlite3": "SQLite", ioredis: "Redis", mongoose: "MongoDB",
  prisma: "Prisma", "@prisma/client": "Prisma", electron: "Electron", transformers: "Transformers", tensorflow: "TensorFlow",
};

export function techFromFacts(facts: RepoFacts): string[] {
  const out: string[] = [];
  const push = (t: string) => {
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  };
  for (const lang of mainLanguages(facts.languages)) push(lang);
  for (const dep of facts.manifests.flatMap((m) => m.dependencies)) {
    const label = PACKAGE_TECH[dep.toLowerCase()];
    if (label) push(label);
  }
  // topics and dependency names that the matcher's technology dictionary knows (so the CV says "React", not "react-dom")
  const names = [...facts.topics, ...facts.manifests.flatMap((m) => m.dependencies)].join("\n").replace(/[-_]/g, " ");
  for (const term of extractTerms(names, "en", { keywords: false })) push(term.label);
  return out.slice(0, MAX_TECH);
}

export interface ProjectDraft {
  id: string;
  name: string;
  url: string;
  summary: { pl: string; en: string };
  tech: string[];
  bullets: never[];
  pinned: boolean;
  source: string;
}

export function projectDraft(facts: RepoFacts, fullName: string, profile: Profile, pinned = false): ProjectDraft {
  // `gh` facts name the repo "owner/name"; the CV shows the repo's own name
  const name = (facts.name || fullName).split("/").pop() || fullName;
  const description = (facts.description ?? "").trim().slice(0, 600);
  return {
    id: uniqueId(name, new Set(profile.projects.map((p) => p.id))),
    name: name.slice(0, 200),
    url: (facts.url ?? `https://github.com/${fullName}`).slice(0, 500),
    // GitHub descriptions are nearly always English; the Polish side is left for a translation, never guessed
    summary: { pl: "", en: description },
    tech: techFromFacts(facts),
    bullets: [],
    pinned,
    source: `github:${fullName}`.slice(0, 200),
  };
}

/** The facts the prose may be written from (what the assistant and the UI show next to the draft). */
export function factDigest(facts: RepoFacts): Record<string, unknown> {
  return {
    description: facts.description,
    readmeExcerpt: facts.readme.slice(0, 3_000),
    languages: mainLanguages(facts.languages),
    topics: facts.topics,
    dependencies: facts.manifests.flatMap((m) => m.dependencies).slice(0, 40),
    commits: facts.commitCount,
    firstCommit: facts.firstCommit,
    lastCommit: facts.lastCommit,
    contributors: facts.contributors,
    stars: facts.stars,
    latestRelease: facts.latestRelease,
    hasTests: facts.hasTests,
    hasCi: facts.hasCi,
    license: facts.license,
    isPrivate: facts.isPrivate,
  };
}
