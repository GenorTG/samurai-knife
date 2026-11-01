import { wrapUntrusted } from "@/lib/security/untrusted";
import type { AuditRun, Issue } from "./types";

/**
 * Findings for a model, grouped by id (docs/WEBSITE-STUDIO.md "Agent output"): the enum fields and the user's own page
 * URLs stay structured, everything written in words (title, detail, fix: page text can flow into them) goes in ONE
 * untrusted envelope per finding instead of one per field. Distinct details are kept (at most 3) with their pages.
 */
export function compactAuditIssues(issues: Issue[], detailChars = 300) {
  const groups = new Map<string, { id: string; severity: string; category: string; pages: string[]; title: string; fix: string; details: { text: string; pages: string[] }[] }>();
  for (const issue of issues) {
    const group = groups.get(issue.id) ?? { id: issue.id, severity: issue.severity, category: issue.category, pages: [], title: issue.title, fix: issue.fix, details: [] };
    if (issue.page && !group.pages.includes(issue.page)) group.pages.push(issue.page);
    const detail = issue.detail.slice(0, detailChars);
    const known = group.details.find((d) => d.text === detail);
    if (known) {
      if (issue.page && !known.pages.includes(issue.page)) known.pages.push(issue.page);
    } else if (detail) {
      group.details.push({ text: detail, pages: issue.page ? [issue.page] : [] });
    }
    groups.set(issue.id, group);
  }
  return [...groups.values()].map((g) => {
    const shown = g.details.slice(0, 3);
    const lines = [`Title: ${g.title}`];
    if (shown.length === 1) lines.push(`Detail: ${shown[0].text}`);
    else shown.forEach((d, i) => lines.push(`Detail ${i + 1}${d.pages.length ? ` (${d.pages.join(", ")})` : ""}: ${d.text}`));
    if (g.details.length > shown.length) lines.push(`(${g.details.length - shown.length} more details)`);
    lines.push(`Fix: ${g.fix}`);
    return { id: g.id, severity: g.severity, category: g.category, pages: g.pages, finding: wrapUntrusted(`website audit finding ${g.id}`, lines.join("\n")) };
  });
}

/** The part of a run an agent needs first: scores, the findings (capped), page copy scores, alignment gaps. */
export function auditDigest(run: AuditRun, maxIssues = 30) {
  const findings = compactAuditIssues(run.issues);
  const pageWords = run.pages.map((p) => ({ url: p.finalUrl, title: p.title, ctas: p.ctas.slice(0, 8) }));
  const lighthouseFailing = run.lighthouse.filter((l) => l.failing.length || l.error).map((l) => ({ strategy: l.strategy, error: l.error, failing: l.failing.slice(0, 8).map((f) => `${f.title}${f.display ? ` (${f.display})` : ""}`) }));
  return {
    id: run.id,
    finishedAt: run.finishedAt,
    target: run.target,
    baseUrl: run.baseUrl,
    scores: run.scores,
    findings: findings.slice(0, maxIssues),
    moreFindings: Math.max(0, findings.length - maxIssues),
    totalIssues: run.issues.length,
    pages: run.pages.map((p) => ({ url: p.finalUrl, status: p.status, words: p.wordCount, copyScore: p.copy.score, readability: p.copy.readability })),
    /** Titles and calls to action are page text: one envelope for all pages. */
    pageText: pageWords.length ? wrapUntrusted("website audit page titles and calls to action", JSON.stringify(pageWords)) : null,
    lighthouse: run.lighthouse.map((l) => ({ strategy: l.strategy, ok: l.ok, scores: l.scores, runs: l.runs ?? 1, spread: l.spread ?? null, metrics: l.metrics })),
    lighthouseFailing: lighthouseFailing.length ? wrapUntrusted("PageSpeed failing audits", JSON.stringify(lighthouseFailing)) : null,
    alignment: run.alignment ? {
      score: run.alignment.score,
      missingOnSite: run.alignment.items.filter((i) => !i.onSite).map((i) => `${i.kind}: ${i.label}`),
      siteOnly: run.alignment.siteOnly.length ? wrapUntrusted("technologies named on the website only", JSON.stringify(run.alignment.siteOnly)) : [],
    } : null,
    notes: run.notes,
    /** Audited paths that are not web pages (robots.txt, sitemap, llms.txt...): checked as files, not as pages. */
    skippedAsNotHtml: (run.resources ?? []).map((r) => ({ path: r.path, kind: r.kind, status: r.status, contentType: r.contentType })),
  };
}

/** Score deltas (now minus then) and the findings that appeared or went away, by id + page. */
export function compareAudits(run: AuditRun, previous: AuditRun | null) {
  if (!previous) return { previousId: null, note: "There was no earlier audit to compare with.", scoreDeltas: null, newFindings: [], resolvedFindings: [] };
  const key = (issue: Issue) => JSON.stringify([issue.id, issue.page]);
  const prior = new Set(previous.issues.map(key));
  const current = new Set(run.issues.map(key));
  const scoreDeltas = Object.fromEntries(Object.entries(run.scores).map(([name, value]) => {
    const before = previous.scores[name as keyof AuditRun["scores"]];
    return [name, typeof value === "number" && typeof before === "number" ? value - before : null];
  }));
  return {
    previousId: previous.id,
    previousFinishedAt: previous.finishedAt,
    ...(previous.target !== run.target ? { note: `The previous audit checked ${previous.target}, this one ${run.target}.` } : {}),
    scoreDeltas,
    newFindings: compactAuditIssues(run.issues.filter((issue) => !prior.has(key(issue)))),
    resolvedFindings: compactAuditIssues(previous.issues.filter((issue) => !current.has(key(issue)))),
  };
}
