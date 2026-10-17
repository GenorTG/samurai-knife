import { existsSync } from "node:fs";
import * as z from "zod/v4";
import { writeAccountFile } from "@/lib/storage/quota";
import { readAccountText } from "@/lib/storage/sealed";
import { accountScope, parentDir } from "@/lib/storage/scope";
import type { AuditRun, Issue, ScoreKey } from "./audit/types";
import { SiteError } from "./net";

/**
 * Per-account website studio state: `site/<id>.json`, sealed at rest like every account file (src/lib/storage/sealed.ts),
 * counted by the quota, removed with the account. The GitHub token and the PageSpeed key live only here and never leave
 * the server: `siteView` is what routes and tools answer. Synchronous read-modify-write on the single Node thread.
 */

export const KEEP_AUDITS = 12;

const tokenSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("pat"), value: z.string().min(1).max(500), login: z.string().max(100) }),
  // Admins only: the server's own `gh` login (the token is read from `gh auth token` per call, never stored).
  z.object({ source: z.literal("host-gh"), login: z.string().max(100) }),
]);

export const connectionSchema = z.object({
  repo: z.string().max(200),
  baseBranch: z.string().max(200),
  productionUrl: z.string().max(500),
  /** Paths audited on every run (the home page always), e.g. "/", "/classic". */
  pages: z.array(z.string().max(300)).max(10),
  token: tokenSchema,
  psiKey: z.string().max(200).default(""),
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

const fileSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().min(0).default(0),
  connection: connectionSchema.nullable().default(null),
  work: workSchema.nullable().default(null),
  // Audit runs are produced by our own code; stored as they are (validated loosely).
  audits: z.array(z.record(z.string(), z.unknown())).max(KEEP_AUDITS).default([]),
  /** Last publish / discard, for the Changes tab. */
  lastAction: z.object({ kind: z.string(), at: z.string(), detail: z.string() }).nullable().default(null),
});
export type SiteFile = Omit<z.infer<typeof fileSchema>, "audits"> & { audits: AuditRun[] };

function path(accountId: string): string {
  const file = accountScope(accountId).siteFile;
  parentDir(file);
  return file;
}

export function loadSite(accountId: string): SiteFile {
  const file = path(accountId);
  if (!existsSync(file)) return { version: 1, revision: 0, connection: null, work: null, audits: [], lastAction: null };
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
  writeAccountFile(accountId, path(accountId), JSON.stringify(site));
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
          token: { source: c.token.source, login: c.token.login, hint: c.token.source === "pat" ? hint(c.token.value) : "server gh login" },
          hasPsiKey: !!c.psiKey,
          connectedAt: c.connectedAt,
        }
      : null,
    work: site.work,
    lastAction: site.lastAction,
    latest: site.audits[0] ? summarize(site.audits[0]) : null,
    history: site.audits.map(summarize),
  };
}
export type SiteView = ReturnType<typeof siteView>;
