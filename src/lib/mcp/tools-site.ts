import * as z from "zod/v4";
import { getAccount } from "@/lib/accounts/store";
import { consumeOutbound, outboundLimitMessage } from "@/lib/net/outbound";
import { QuotaExceededError } from "@/lib/storage/quota";
import { analyzeCopy, copyIssues } from "@/lib/site/audit/copy";
import { analyzePage } from "@/lib/site/audit/page";
import { runAudit } from "@/lib/site/audit/run";
import type { AuditRun } from "@/lib/site/audit/types";
import { fetchPage, sitePolicy, SiteError } from "@/lib/site/net";
import * as service from "@/lib/site/service";
import { loadSite, siteView } from "@/lib/site/store";
import { defineTool, type KnifeToolContext, type KnifeToolDefinition } from "./define";

/**
 * Website studio tools (group `site`, docs/WEBSITE-STUDIO.md): read and score the user's website, read its repository,
 * and prepare changes on a work branch + pull request. Publishing (merging into the production branch) and discarding
 * stay with the user in the studio's Changes tab: no tool merges, deletes a branch or touches the base branch.
 */

function account(ctx: KnifeToolContext | undefined): string {
  if (!ctx?.accountId) throw new Error("Website tools need an account context.");
  return ctx.accountId;
}

async function guarded<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof SiteError || error instanceof QuotaExceededError) throw new Error(error.message);
    throw error;
  }
}

/** The part of a run an agent needs first: scores, the issues (capped), page copy scores, alignment gaps. */
export function auditDigest(run: AuditRun, maxIssues = 30) {
  return {
    id: run.id,
    finishedAt: run.finishedAt,
    target: run.target,
    baseUrl: run.baseUrl,
    scores: run.scores,
    issues: run.issues.slice(0, maxIssues).map(({ id, severity, category, title, detail, page, fix }) => ({ id, severity, category, title, detail: detail.slice(0, 300), page, fix })),
    moreIssues: Math.max(0, run.issues.length - maxIssues),
    pages: run.pages.map((p) => ({ url: p.finalUrl, status: p.status, title: p.title, words: p.wordCount, copyScore: p.copy.score, readability: p.copy.readability, ctas: p.ctas.slice(0, 8) })),
    lighthouse: run.lighthouse.map((l) => ({ strategy: l.strategy, ok: l.ok, error: l.error, scores: l.scores, metrics: l.metrics, failing: l.failing.slice(0, 8).map((f) => `${f.title}${f.display ? ` (${f.display})` : ""}`) })),
    alignment: run.alignment ? { score: run.alignment.score, missingOnSite: run.alignment.items.filter((i) => !i.onSite).map((i) => `${i.kind}: ${i.label}`), siteOnly: run.alignment.siteOnly } : null,
    notes: run.notes,
  };
}

const PATH = z.string().min(1).max(400);

export const SITE_KNIFE_TOOLS: KnifeToolDefinition[] = [
  defineTool({
    name: "knife_site_status",
    scope: "account",
    description:
      "Start here for any work on the user's website (Website studio). Returns the connected GitHub repository (repo, base branch, production URL, audited pages), the repository's OWN instructions for agents (AGENTS.md, CLAUDE.md, CONTENT_BRIEF.md, README.md: follow them when editing), the current work branch and pull request, and the latest audit scores. If nothing is connected, tell the user to connect the repo in the Website studio (open_tool site-studio, tab connect).",
    schema: z.object({}).strict(),
    run(_input, ctx) {
      return guarded(async () => {
        const acc = account(ctx);
        if (!loadSite(acc).connection) return { ...siteView(loadSite(acc)), hint: "No repository connected: the user connects it in the Website studio (Connect tab) with a GitHub token." };
        return service.status(acc);
      });
    },
  }),
  defineTool({
    name: "knife_site_audit",
    scope: "account",
    description:
      "Score the website now (takes 20-90 s): every configured page (or `pages`) of the production URL, a preview (`target: \"preview\"` = the pull request's preview deployment) or any `url`. Checks: technical SEO and accessibility (title, description, H1/heading order, alt texts, Open Graph, JSON-LD, canonical, robots/sitemap, 404, https), security headers, copywriting benchmarks in Polish or English (readability FOG-PL/Flesch, sentence length, hero clarity, calls to action, proof with numbers/projects, reader focus, buzzwords, substance, stale years), alignment with the user's CV studio profile (current role, headline, projects, skills, links missing on the site; tech on the site the CV lacks) and Lighthouse via PageSpeed Insights (performance, accessibility, best practices, SEO; mobile + desktop). Returns scores 0-100, issues with a fix each, page summaries. Stored in the studio's history (the Score tab shows the trend).",
    schema: z.object({
      url: z.string().max(500).optional(),
      target: z.enum(["production", "preview"]).optional(),
      pages: z.array(z.string().max(300)).max(10).optional(),
      lighthouse: z.boolean().optional().describe("false skips PageSpeed (faster, no performance scores)"),
    }).strict(),
    run({ url, target, pages, lighthouse }, ctx) {
      return guarded(async () => {
        const acc = account(ctx);
        let base = url;
        if (!base && target === "preview") {
          const ch = await service.changes(acc);
          base = ch.checks?.previewUrl || undefined;
          if (!base) throw new SiteError("there is no preview deployment yet (no pull request, or the host has not built it): try again in a minute or audit production");
        }
        const run = await runAudit(acc, { url: base, target: target ?? (url ? "custom" : "production"), pages, lighthouse });
        return auditDigest(run);
      });
    },
  }),
  defineTool({
    name: "knife_site_audit_get",
    scope: "account",
    description: "Read a stored audit (default the newest): `section` all (digest) | issues (every issue) | pages (per-page facts + copy metrics + the first 4000 characters of text) | lighthouse (full failing-audit lists) | alignment (every CV item with onSite) | history (scores of every kept run, newest first).",
    schema: z.object({ id: z.string().max(40).optional(), section: z.enum(["all", "issues", "pages", "lighthouse", "alignment", "history"]).default("all") }).strict(),
    run({ id, section }, ctx) {
      return guarded(() => {
        const site = loadSite(account(ctx));
        if (section === "history") return siteView(site).history;
        const run = id ? site.audits.find((a) => a.id === id) : site.audits[0];
        if (!run) throw new SiteError(id ? `no stored audit ${id}` : "no audit yet: run knife_site_audit");
        if (section === "issues") return run.issues;
        if (section === "pages") return run.pages;
        if (section === "lighthouse") return run.lighthouse;
        if (section === "alignment") return run.alignment;
        return auditDigest(run, 60);
      });
    },
  }),
  defineTool({
    name: "knife_site_page",
    scope: "account",
    description:
      "Read ONE live page for copywriting: title, meta description, heading outline, calls to action, contact/profile links, the full visible text (up to 30k chars) and its copy metrics and issues. Use it to see the current wording before proposing new copy.",
    schema: z.object({ url: z.string().min(1).max(500) }).strict(),
    run({ url }, ctx) {
      return guarded(async () => {
        const acc = account(ctx);
        const a = getAccount(acc);
        if (!a) throw new SiteError("unknown account", 404);
        const budget = consumeOutbound(a, "page");
        if (!budget.ok) throw new SiteError(outboundLimitMessage(budget.retryAfterSeconds), 429);
        const page = await fetchPage(url, sitePolicy(a));
        const { facts, issues } = analyzePage(page);
        const copy = analyzeCopy(facts);
        return { ...facts, copy, issues: [...issues, ...copyIssues(copy, facts.finalUrl)] };
      });
    },
  }),
  defineTool({
    name: "knife_site_files",
    scope: "account",
    description: "List the website repository one directory level at a time (`path` = directory, empty = root; sub-directories come with their file count). Reads the work branch when it exists (it has the latest changes), else the base branch; `ref` overrides.",
    schema: z.object({ path: z.string().max(400).default(""), ref: z.string().max(200).optional() }).strict(),
    run({ path, ref }, ctx) {
      return guarded(() => service.listFiles(account(ctx), path, ref));
    },
  }),
  defineTool({
    name: "knife_site_read",
    scope: "account",
    description: "Read one text file of the website repository (up to 1 MB) from the work branch if it exists, else the base branch (`ref` overrides). Always read a file before changing it.",
    schema: z.object({ path: PATH, ref: z.string().max(200).optional() }).strict(),
    run({ path, ref }, ctx) {
      return guarded(() => service.readFile(account(ctx), path, ref));
    },
  }),
  defineTool({
    name: "knife_site_search",
    scope: "account",
    description: "Find where text (a phrase from the page, a component name) lives in the website repository: GitHub code search, default branch only, returns paths with matching fragments.",
    schema: z.object({ query: z.string().min(1).max(200) }).strict(),
    run({ query }, ctx) {
      return guarded(() => service.search(account(ctx), query));
    },
  }),
  defineTool({
    name: "knife_site_replace",
    scope: "account",
    description:
      "Preferred edit for copy and small code changes: replace an exact text snippet in one repository file and commit it to the work branch (`knife/...`, created from the base branch on the first change; the base/production branch is never written). `find` must occur exactly once (or set all=true). Then knife_site_pr. Keep the site's own conventions (its AGENTS.md from knife_site_status).",
    schema: z.object({ path: PATH, find: z.string().min(1).max(50_000), replace: z.string().max(200_000), message: z.string().min(1).max(500), all: z.boolean().optional() }).strict(),
    run({ path, find, replace, message, all }, ctx) {
      return guarded(() => service.replaceText(account(ctx), path, find, replace, message, all ?? false));
    },
  }),
  defineTool({
    name: "knife_site_write",
    scope: "account",
    description:
      "Write whole files (new files, rewrites) to the work branch in ONE commit: `files` [{path, content}] plus optional `delete` [paths]; at most 25 files, 1 MB each. Workflow files and real .env files are refused. For changing a few lines use knife_site_replace instead. Then knife_site_pr.",
    schema: z.object({
      message: z.string().min(1).max(500),
      files: z.array(z.object({ path: PATH, content: z.string().max(1_000_000) }).strict()).max(25).default([]),
      delete: z.array(PATH).max(25).default([]),
    }).strict(),
    run({ message, files, delete: removed }, ctx) {
      return guarded(() => service.writeFiles(account(ctx), message, [...files, ...removed.map((path) => ({ path, delete: true as const }))]));
    },
  }),
  defineTool({
    name: "knife_site_pr",
    scope: "account",
    description:
      "Open (or update) the pull request from the work branch into the base branch with a title and a body that explains what changed and why (copy, SEO, projects added...). The host (e.g. Vercel) builds a preview of it: check knife_site_changes for the preview URL, then knife_site_audit target=preview. The USER publishes (merges) it from the Website studio's Changes tab; never ask them to merge elsewhere unless they want to.",
    schema: z.object({ title: z.string().min(1).max(250), body: z.string().max(20_000).default("") }).strict(),
    run({ title, body }, ctx) {
      return guarded(() => service.openPull(account(ctx), title, body));
    },
  }),
  defineTool({
    name: "knife_site_changes",
    scope: "account",
    description: "State of the prepared changes: work branch vs base (commits, changed files with patches), the pull request (number, URL, mergeable), commit checks and the preview deployment URL.",
    schema: z.object({}).strict(),
    run(_input, ctx) {
      return guarded(() => service.changes(account(ctx)));
    },
  }),
];
