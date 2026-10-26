import { msg, msgf } from "@/lib/i18n/msg";
import { randomBytes } from "node:crypto";
import { getAccount } from "@/lib/accounts/store";
import { loadCv } from "@/lib/cv/store";
import { admitOutbound, hostGate, mayUseAnonymousPageSpeed, outboundLimitMessage, pageSpeedKey } from "@/lib/net/outbound";
import { fetchPage, sitePolicy, SiteError, type FetchedPage, type NetDeps } from "../net";
import { loadSite, mutateSite } from "../store";
import { siteTargetProblem } from "../ownership";
import { alignCvWithSite, alignmentIssues } from "./align";
import { analyzeCopy, copyIssues } from "./copy";
import { lighthouseIssues, PSI_API, runLighthouse } from "./lighthouse";
import { analyzePage } from "./page";
import { checkSite, siteIssues, SECURITY_HEADERS } from "./site";
import type { AuditRun, Issue, LighthouseResult, ScoreKey } from "./types";

/**
 * One audit run: the configured pages of a base URL (production, the PR preview, or any URL) -> page + copy checks,
 * site checks, Lighthouse via PageSpeed (mobile + desktop of the home page), CV alignment -> scores + issues, stored as
 * the newest run (KEEP_AUDITS kept). One run per account at a time; progress is readable while it runs.
 */

export const MAX_PAGES = 10;

/** Where a site fetch may go (verified production origin for public non-admins): src/lib/site/ownership.ts. */
export { siteTargetProblem };

export interface AuditOptions {
  /** Absolute base URL; default: the connection's production URL. */
  url?: string;
  target?: "production" | "preview" | "custom";
  /** Paths to audit; default: the connection's pages (always including "/"). */
  pages?: string[];
  lighthouse?: boolean;
  deps?: NetDeps;
}

export interface AuditProgress {
  id: string;
  accountId: string;
  phase: string;
  done: number;
  total: number;
  startedAt: number;
  finished: boolean;
  error: string;
}

const KEY = Symbol.for("samurai-knife.site-audits.v1");
function running(): Map<string, AuditProgress> {
  const g = globalThis as unknown as Record<symbol, Map<string, AuditProgress> | undefined>;
  return (g[KEY] ??= new Map());
}

export function auditProgress(accountId: string, id: string): AuditProgress | null {
  const p = running().get(id);
  return p && p.accountId === accountId ? p : null;
}

export function currentAudit(accountId: string): AuditProgress | null {
  for (const p of running().values()) if (p.accountId === accountId && !p.finished) return p;
  return null;
}

function gc(): void {
  const cutoff = Date.now() - 15 * 60_000;
  for (const [id, p] of running()) if (p.finished && p.startedAt < cutoff) running().delete(id);
}

export function normalizePaths(paths: string[]): string[] {
  const out = ["/"];
  for (const raw of paths) {
    const p = raw.trim();
    if (!p) continue;
    if (!p.startsWith("/") || p.startsWith("//") || /\s/.test(p) || p.length > 300) throw new SiteError(msgf("'{p}' is not a page path (start with /)", { p: p.slice(0, 80) }));
    if (!out.includes(p)) out.push(p);
  }
  if (out.length > MAX_PAGES) throw new SiteError(`at most ${MAX_PAGES} pages per audit`);
  return out;
}

const PENALTY: Record<Issue["severity"], number> = { high: 15, medium: 7, low: 3 };
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export function computeScores(issues: Issue[], copyScores: number[], alignment: number | null, lighthouse: LighthouseResult[], security: Record<string, boolean> | null, httpsRedirect: boolean | null): AuditRun["scores"] {
  const scores: AuditRun["scores"] = {};
  // Technical SEO: 100 minus a penalty per distinct problem kind (a problem on 3 pages counts once, at its worst).
  const worst = new Map<string, Issue["severity"]>();
  for (const i of issues.filter((x) => x.category === "seo" || x.category === "content" || x.category === "accessibility")) {
    const prev = worst.get(i.id);
    if (!prev || PENALTY[i.severity] > PENALTY[prev]) worst.set(i.id, i.severity);
  }
  scores.seo = clamp(100 - [...worst.values()].reduce((n, s) => n + PENALTY[s], 0));
  if (copyScores.length) scores.copy = clamp(copyScores.reduce((a, b) => a + b, 0) / copyScores.length);
  if (alignment !== null) scores.alignment = alignment;
  if (security) {
    const present = SECURITY_HEADERS.filter((h) => security[h]).length;
    scores.security = clamp((present / SECURITY_HEADERS.length) * 80 + (httpsRedirect === false ? 0 : 20));
  }
  const lh = lighthouse.find((r) => r.ok && r.strategy === "mobile") ?? lighthouse.find((r) => r.ok);
  if (lh) {
    if (lh.scores.performance !== undefined) scores.performance = lh.scores.performance;
    if (lh.scores.accessibility !== undefined) scores.accessibility = lh.scores.accessibility;
    if (lh.scores["best-practices"] !== undefined) scores.bestPractices = lh.scores["best-practices"];
    if (lh.scores.seo !== undefined) scores.lighthouseSeo = lh.scores.seo;
  }
  const weights: Partial<Record<ScoreKey, number>> = { seo: 1, copy: 1.5, alignment: 1, security: 0.5, performance: 1, accessibility: 1, bestPractices: 0.5 };
  let sum = 0;
  let total = 0;
  for (const [key, w] of Object.entries(weights) as [ScoreKey, number][]) {
    const v = scores[key];
    if (v === undefined) continue;
    sum += v * w;
    total += w;
  }
  if (total) scores.overall = clamp(sum / total);
  return scores;
}

/** Starts an audit; resolves with the stored run. Throws SiteError (409 already running, 429 budget, 400 no URL). */
export async function runAudit(accountId: string, options: AuditOptions = {}): Promise<AuditRun> {
  gc();
  const account = getAccount(accountId);
  if (!account) throw new SiteError("unknown account", 404);
  if (currentAudit(accountId)) throw new SiteError(msg("an audit is already running for this account; wait for it to finish"), 409);
  const site = loadSite(accountId);
  const base = (options.url ?? site.connection?.productionUrl ?? "").trim();
  if (!base) throw new SiteError(msg("no URL to audit: set the production URL in Connect, or pass one"));
  let origin: URL;
  try {
    origin = new URL(base);
  } catch {
    throw new SiteError(msgf("'{base}' is not a valid URL", { base: base.slice(0, 200) }));
  }
  if (!/^https?:$/.test(origin.protocol)) throw new SiteError(msg("only http(s) sites can be audited"));
  const paths = normalizePaths(options.pages ?? site.connection?.pages ?? []);
  const refused = siteTargetProblem(account, site.connection, origin.href);
  if (refused) throw new SiteError(refused, 403);
  const budget = admitOutbound(account, "audit", origin);
  if (!budget.ok) throw new SiteError(outboundLimitMessage(budget.retryAfterSeconds), 429);

  const policy = sitePolicy(account);
  // Every page, robots.txt, sitemap and redirect hop of the run is counted against its host's budget (once per host).
  const deps: NetDeps = { ...(options.deps ?? {}), admitHop: hostGate(account, "audit", origin) };
  const lighthouseOn = options.lighthouse !== false;
  const progress: AuditProgress = {
    id: `audit_${randomBytes(6).toString("hex")}`,
    accountId,
    phase: "Fetching pages",
    done: 0,
    total: paths.length + 1 + (lighthouseOn ? 1 : 0) + 1,
    startedAt: Date.now(),
    finished: false,
    error: "",
  };
  running().set(progress.id, progress);
  const startedAt = new Date().toISOString();
  try {
    const issues: Issue[] = [];
    const pages: AuditRun["pages"] = [];
    const notes: string[] = [];
    let home: FetchedPage | null = null;
    const allText: string[] = [];
    const allLinks: string[] = [];
    const allContacts: string[] = [];
    const copyScores: number[] = [];
    for (const p of paths) {
      progress.phase = `Fetching ${p}`;
      const url = new URL(p, origin).href;
      try {
        const fetched = await fetchPage(url, policy, deps);
        if (p === "/") home = fetched;
        const { facts, issues: found } = analyzePage(fetched);
        const copy = analyzeCopy(facts);
        issues.push(...found, ...copyIssues(copy, facts.finalUrl));
        if (copy.words >= 30) copyScores.push(copy.score);
        allText.push(facts.title, facts.metaDescription, facts.text);
        allLinks.push(...facts.links.profiles);
        allContacts.push(...facts.links.contacts);
        const { text, ...rest } = facts;
        pages.push({ ...rest, textPreview: text.slice(0, 4000), copy });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        issues.push({ id: "page.unreachable", severity: "high", category: "seo", title: msgf("Could not load {p}", { p }), detail: message, page: url, fix: msg("Check the URL and that the site is up.") });
      }
      progress.done += 1;
    }
    if (!home) throw new SiteError(msgf("the home page of {origin} could not be loaded: {value}", { origin: origin.origin, value: issues.find((i) => i.id === "page.unreachable")?.detail ?? "no answer" }), 502);

    progress.phase = "Checking robots.txt, sitemap, redirects and headers";
    const siteFacts = await checkSite(home, policy, deps);
    issues.push(...siteIssues(siteFacts, paths));
    progress.done += 1;

    let lighthouse: LighthouseResult[] = [];
    if (lighthouseOn) {
      progress.phase = "Running Lighthouse (PageSpeed Insights, mobile + desktop)";
      // The server's PageSpeed key and its anonymous quota are the admin's; everyone else brings their own key.
      const psi = pageSpeedKey(account, site.connection?.psiKey ?? "");
      if (psi.source === "none" && !mayUseAnonymousPageSpeed(account)) {
        notes.push(msg("Lighthouse skipped: add your own PageSpeed Insights API key in Connect to get performance scores."));
      } else {
        const homeUrl = home.finalUrl;
        const one = (strategy: LighthouseResult["strategy"]): Promise<LighthouseResult> => {
          const admitted = admitOutbound(account, "psi", PSI_API());
          if (!admitted.ok) return Promise.resolve({ strategy, ok: false, error: `PageSpeed Insights: ${outboundLimitMessage(admitted.retryAfterSeconds)}`, scores: {}, metrics: {}, failing: [] });
          return runLighthouse(homeUrl, strategy, psi.key, deps);
        };
        lighthouse = await Promise.all([one("mobile"), one("desktop")]);
      }
      for (const r of lighthouse) if (!r.ok) notes.push(`${r.strategy}: ${r.error}`);
      issues.push(...lighthouseIssues(lighthouse, home.finalUrl));
      progress.done += 1;
    }

    progress.phase = "Comparing with your CV";
    let alignment = null;
    try {
      const cv = loadCv(accountId);
      alignment = alignCvWithSite(cv, allText.join("\n"), allLinks, allContacts);
      if (alignment.items.length) issues.push(...alignmentIssues(alignment));
      else notes.push(alignment.note);
    } catch (error) {
      notes.push(`CV comparison skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
    progress.done += 1;

    const order = { high: 0, medium: 1, low: 2 };
    issues.sort((a, b) => order[a.severity] - order[b.severity]);
    const run: AuditRun = {
      id: progress.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      target: options.target ?? (options.url ? "custom" : "production"),
      baseUrl: origin.origin + (origin.pathname === "/" ? "" : origin.pathname.replace(/\/$/, "")),
      scores: computeScores(issues, copyScores, alignment && alignment.items.length ? alignment.score : null, lighthouse, siteFacts.securityHeaders, siteFacts.httpsRedirect),
      issues,
      pages,
      site: siteFacts,
      lighthouse,
      alignment,
      notes,
    };
    mutateSite(accountId, (s) => {
      s.audits.unshift(run);
    });
    progress.phase = "Done";
    return run;
  } catch (error) {
    progress.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    progress.finished = true;
  }
}

/** Start without waiting (the UI polls `auditProgress`); the run lands in the store when it finishes. */
export async function startAudit(accountId: string, options: AuditOptions = {}): Promise<{ id: string }> {
  if (currentAudit(accountId)) throw new SiteError(msg("an audit is already running for this account; wait for it to finish"), 409);
  // runAudit registers its progress synchronously, before its first await; a check that fails first (no URL, budget)
  // rejects without registering: awaiting the promise then rethrows that real reason.
  const promise = runAudit(accountId, options);
  promise.catch(() => undefined); // later failures are kept in the progress record
  const p = currentAudit(accountId);
  if (!p) {
    await promise;
    throw new SiteError(msg("the audit could not start"), 500);
  }
  return { id: p.id };
}
