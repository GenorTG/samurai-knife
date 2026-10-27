import { existsSync } from "node:fs";
import * as z from "zod/v4";
import { writeAccountFile } from "@/lib/storage/quota";
import { readAccountText } from "@/lib/storage/sealed";
import { accountScope, parentDir } from "@/lib/storage/scope";
import type { AuditRun, Issue, ScoreKey } from "./audit/types";
import { SiteError } from "./net";
import { currentProjectId, projectPaths } from "@/lib/cv/projects";

/**
 * Website state per CV project (`site/<id>.json` for the first project, `cv/<id>.p-<project>.site.json` for the others;
 * the GitHub App installations stay account-wide in `site/<id>.json`), sealed at rest like every account file (src/lib/storage/sealed.ts),
 * counted by the quota, removed with the account. The GitHub token and the PageSpeed key live only here and never leave
 * the server: `siteView` is what routes and tools answer. Synchronous read-modify-write on the single Node thread.
 */

export const KEEP_AUDITS = 12;

const tokenSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("pat"), value: z.string().min(1).max(500), login: z.string().max(100) }),
  // Admins only: the server's own `gh` login (the token is read from `gh auth token` per call, never stored).
  z.object({ source: z.literal("host-gh"), login: z.string().max(100) }),
  // The server's GitHub App: an installation this account proved it can reach (no secret stored; tokens are minted per call).
  z.object({ source: z.literal("app"), installationId: z.number().int().positive(), login: z.string().max(100) }),
]);

/** A repository of an installation as the linked GitHub user sees it (`GET /user/installations/{id}/repositories`). */
const repoAccessSchema = z.object({ fullName: z.string().max(200), private: z.boolean(), defaultBranch: z.string().max(200), htmlUrl: z.string().max(500), push: z.boolean() });
const installationSchema = z.object({
  id: z.number().int().positive(),
  account: z.string().max(100),
  accountType: z.string().max(40),
  /** Only these may be connected (with push). Absent in files written before per-user scoping: nothing is connectable. */
  repos: z.array(repoAccessSchema).max(300).default([]),
  reposVerified: z.boolean().default(false),
});
export type LinkedInstallation = z.infer<typeof installationSchema>;

export const connectionSchema = z.object({
  repo: z.string().max(200),
  baseBranch: z.string().max(200),
  productionUrl: z.string().max(500),
  /** Paths audited on every run (the home page always), e.g. "/", "/classic". */
  pages: z.array(z.string().max(300)).max(10),
  token: tokenSchema,
  psiKey: z.string().max(200).default(""),
  /** The production origin as verified at Connect (ownership.ts: repository homepage or Pages host); "" = not verified. */
  verifiedOrigin: z.string().max(500).default(""),
  connectedAt: z.string(),
});
export type SiteConnection = z.infer<typeof connectionSchema>;

const workSchema = z.object({
  branch: z.string().max(200),
  base: z.string().max(200),
  createdAt: z.string(),
  pull: z.number().int().nullable().default(null),
});
export type WorkBranch = z.infer<typeof workSchema>;

/**
 * A website without a repository (the CV check only): its address, the pages to read, and the ownership proof. In public
 * mode a non-admin's address is read only once verified (ownership.ts `verifySiteUrl`: the site serves `token`).
 */
export const siteUrlSchema = z.object({
  url: z.string().max(500),
  pages: z.array(z.string().max(300)).max(10).default([]),
  token: z.string().max(80),
  verifiedOrigin: z.string().max(500).default(""),
  setAt: z.string(),
});
export type SiteUrl = z.infer<typeof siteUrlSchema>;

const fileSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().min(0).default(0),
  connection: connectionSchema.nullable().default(null),
  siteUrl: siteUrlSchema.nullable().default(null),
  work: workSchema.nullable().default(null),
  // Audit runs are produced by our own code; stored as they are (validated loosely).
  audits: z.array(z.record(z.string(), z.unknown())).max(KEEP_AUDITS).default([]),
  /** GitHub App installations verified for this account with a GitHub sign-in (GET /user/installations), and who signed in. */
  github: z.object({ login: z.string().max(100), installations: z.array(installationSchema).max(100), checkedAt: z.string() }).nullable().default(null),
  /** Last publish / discard, for the Changes tab. */
  lastAction: z.object({ kind: z.string(), at: z.string(), detail: z.string() }).nullable().default(null),
});
export type SiteFile = Omit<z.infer<typeof fileSchema>, "audits"> & { audits: AuditRun[] };

/** The account file: the first CV project's website, and the GitHub App installations linked for the whole account. */
function accountPath(accountId: string): string {
  const file = accountScope(accountId).siteFile;
  parentDir(file);
  return file;
}

/** The website file of the CV project this call works on (src/lib/cv/projects.ts). */
function path(accountId: string): string {
  const file = projectPaths(accountId, currentProjectId(accountId)).site;
  parentDir(file);
  return file;
}

const EMPTY: SiteFile = { version: 1, revision: 0, connection: null, siteUrl: null, work: null, audits: [], lastAction: null, github: null };

export function loadSite(accountId: string): SiteFile {
  const file = path(accountId);
  const site = readFile(accountId, file);
  const shared = accountPath(accountId);
  // The GitHub sign-in (linked installations) is the account's, whichever project shows it.
  if (file !== shared) site.github = readFile(accountId, shared).github;
  return site;
}

function readFile(accountId: string, file: string): SiteFile {
  if (!existsSync(file)) return { ...EMPTY, audits: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readAccountText(accountId, file));
  } catch {
    throw new SiteError("the website studio data is damaged (site/<account>.json)", 500);
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) throw new SiteError(`the website studio data is invalid at ${parsed.error.issues[0].path.join("/")}`, 500);
  return parsed.data as unknown as SiteFile;
}

/** Read-modify-write; bumps the revision (open pages poll it to show what an agent changed). */
export function mutateSite<T>(accountId: string, fn: (site: SiteFile) => T): T {
  const site = loadSite(accountId);
  const result = fn(site);
  site.revision += 1;
  site.audits = site.audits.slice(0, KEEP_AUDITS);
  const file = path(accountId);
  const shared = accountPath(accountId);
  if (file === shared) {
    writeAccountFile(accountId, file, JSON.stringify(site));
  } else {
    writeAccountFile(accountId, file, JSON.stringify({ ...site, github: null }));
    const account = readFile(accountId, shared);
    if (JSON.stringify(account.github) !== JSON.stringify(site.github)) {
      account.github = site.github;
      account.revision += 1;
      writeAccountFile(accountId, shared, JSON.stringify(account));
    }
  }
  return result;
}

function hint(token: string): string {
  return token.length > 8 ? `${token.slice(0, 4)}…${token.slice(-4)}` : "set";
}

export interface AuditSummary {
  id: string;
  finishedAt: string;
  target: string;
  baseUrl: string;
  scores: Partial<Record<ScoreKey, number>>;
  issues: Record<Issue["severity"], number>;
}

export function summarize(run: AuditRun): AuditSummary {
  const issues = { high: 0, medium: 0, low: 0 };
  for (const i of run.issues) issues[i.severity] += 1;
  return { id: run.id, finishedAt: run.finishedAt, target: run.target, baseUrl: run.baseUrl, scores: run.scores, issues };
}

/** What may be shown to the account's own browser or agent: no token, no key. */
export function siteView(site: SiteFile) {
  const c = site.connection;
  return {
    revision: site.revision,
    connected: !!c,
    connection: c
      ? {
          repo: c.repo,
          baseBranch: c.baseBranch,
          productionUrl: c.productionUrl,
          pages: c.pages,
          token: { source: c.token.source, login: c.token.login, installationId: c.token.source === "app" ? c.token.installationId : null, hint: c.token.source === "pat" ? hint(c.token.value) : c.token.source === "app" ? `GitHub App installation ${c.token.installationId}` : "server gh login" },
          hasPsiKey: !!c.psiKey,
          productionVerified: !!c.productionUrl && c.verifiedOrigin === new URL(c.productionUrl).origin,
          connectedAt: c.connectedAt,
        }
      : null,
    siteUrl: site.siteUrl
      ? {
          url: site.siteUrl.url,
          pages: site.siteUrl.pages,
          token: site.siteUrl.token,
          verified: !!site.siteUrl.url && site.siteUrl.verifiedOrigin === new URL(site.siteUrl.url).origin,
          setAt: site.siteUrl.setAt,
        }
      : null,
    work: site.work,
    lastAction: site.lastAction,
    github: site.github ? { login: site.github.login, installations: site.github.installations, checkedAt: site.github.checkedAt } : null,
    latest: site.audits[0] ? summarize(site.audits[0]) : null,
    history: site.audits.map(summarize),
  };
}
export type SiteView = ReturnType<typeof siteView>;
