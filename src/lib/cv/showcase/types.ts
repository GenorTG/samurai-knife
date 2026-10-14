/** Shapes shared by the GitHub and local fact gatherers, the checklist and the tools. Pure: dates are ISO-8601 strings. */

/** A failure with an HTTP status the routes can pass through (422 bad input, 403 fenced path, 404 unknown, 502 `gh`/git trouble). */
export class ShowcaseError extends Error {
  readonly status: 403 | 404 | 422 | 502;
  constructor(message: string, status: 403 | 404 | 422 | 502 = 422) {
    super(message);
    this.status = status;
    this.name = "ShowcaseError";
  }
}

export interface RepoSummary {
  name: string;
  fullName: string;
  description: string | null;
  language: string | null;
  stars: number;
  forks: number;
  topics: string[];
  pushedAt: string | null;
  isFork: boolean;
  isPrivate: boolean;
  isArchived: boolean;
  sizeKb: number;
  url: string;
}

export interface Release {
  tag: string;
  name: string | null;
  publishedAt: string | null;
}

/** Dependency manifest summary: names only, never versions, scripts or URLs. */
export interface Manifest {
  file: string;
  name: string | null;
  dependencies: string[];
}

export interface RepoFacts {
  source: "github" | "local";
  name: string;
  url: string | null;
  description: string | null;
  readme: string;
  languages: Record<string, number>;
  languageUnit: "bytes" | "loc";
  topics: string[];
  license: string | null;
  stars: number | null;
  forks: number | null;
  commitCount: number | null;
  firstCommit: string | null;
  lastCommit: string | null;
  contributors: number | null;
  authors: string[];
  topLevel: string[];
  latestRelease: Release | null;
  hasCi: boolean;
  hasTests: boolean;
  testFiles: number | null;
  openIssuesInclPrs: number | null;
  manifests: Manifest[];
  isFork: boolean;
  isPrivate: boolean;
}

export interface CheckItem {
  id: string;
  passed: boolean;
  weight: number;
  advice: string;
}

/** Facts with every optional field defaulted: gatherers spread their findings over this. */
export function emptyFacts(source: RepoFacts["source"], name: string): RepoFacts {
  return {
    source, name, url: null, description: null, readme: "", languages: {}, languageUnit: source === "github" ? "bytes" : "loc",
    topics: [], license: null, stars: null, forks: null, commitCount: null, firstCommit: null, lastCommit: null, contributors: null,
    authors: [], topLevel: [], latestRelease: null, hasCi: false, hasTests: false, testFiles: null, openIssuesInclPrs: null,
    manifests: [], isFork: false, isPrivate: false,
  };
}
