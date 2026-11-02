import { auditDigest, compareAudits } from "./audit/digest";
import { runAudit } from "./audit/run";
import { SiteError } from "./net";
import * as service from "./service";
import { loadSite } from "./store";
import * as vercelService from "./vercel-service";
import { msg } from "@/lib/i18n/msg";

/**
 * knife_site_verify (docs/WEBSITE-STUDIO.md "Verify"): after a push, wait on the server (bounded, abortable) for the
 * preview of the work branch's HEAD commit, audit its HTML pages, read the commit's checks, and answer with one compact
 * report. Replaces the model's own previews -> wait -> previews -> audit -> changes chain (each step a model round).
 */

export const VERIFY_MAX_SECONDS = 240;
export const VERIFY_POLL_MS = 10_000;

export interface VerifyOptions {
  timeoutSec?: number;
  pages?: string[];
  lighthouse?: boolean;
  signal?: AbortSignal;
  /** Tests: poll faster. */
  pollMs?: number;
}

type PreviewState = "READY" | "BUILDING" | "FAILED" | "NONE";

interface PreviewProbe {
  head: string | null;
  state: PreviewState;
  url: string;
  deploymentId: string;
  error: string;
}

const ACTIVE = new Set(["QUEUED", "INITIALIZING", "BUILDING"]);

async function probe(accountId: string): Promise<PreviewProbe | null> {
  if (loadSite(accountId).vercel?.projectId) {
    const p = await vercelService.previews(accountId);
    if (!p.branch) return null;
    const d = p.headDeployment;
    const state: PreviewState = !d ? "NONE" : d.state === "READY" ? "READY" : ACTIVE.has(d.state) ? "BUILDING" : "FAILED";
    return { head: p.head, state, url: d?.url ? (d.url.startsWith("http") ? d.url : `https://${d.url}`) : "", deploymentId: d?.id ?? "", error: d?.error ?? "" };
  }
  const ch = await service.changes(accountId, false, true);
  if (!ch.work) return null;
  const pending = ch.checks?.items.some((i) => i.state === "pending") ?? false;
  const state: PreviewState = ch.checks?.previewUrl ? "READY" : pending ? "BUILDING" : "NONE";
  return { head: ch.work.head, state, url: ch.checks?.previewUrl ?? "", deploymentId: "", error: "" };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new SiteError(msg("verification stopped: the request was cancelled"), 499));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new SiteError(msg("verification stopped: the request was cancelled"), 499));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function checksSummary(accountId: string) {
  const ch = await service.changes(accountId, false, true);
  const checks = ch.checks;
  return {
    pull: ch.pull ? { number: ch.pull.number, url: ch.pull.url, state: ch.pull.state } : null,
    checks: checks ? { state: checks.state, items: checks.items.slice(0, 12).map((i) => ({ name: i.name.slice(0, 80), state: i.state })) } : null,
  };
}

export async function verifyPreview(accountId: string, options: VerifyOptions = {}) {
  if (!loadSite(accountId).connection) throw new SiteError("no repository connected", 409);
  const limitSec = Math.min(VERIFY_MAX_SECONDS, Math.max(0, options.timeoutSec ?? VERIFY_MAX_SECONDS));
  const pollMs = Math.max(10, options.pollMs ?? VERIFY_POLL_MS);
  const started = Date.now();
  const deadline = started + limitSec * 1000;
  let polls = 0;
  let seen: PreviewProbe | null = null;
  for (;;) {
    polls += 1;
    seen = await probe(accountId);
    if (!seen) return { verdict: "no-work-branch", next: "There is no work branch: write the changes first (knife_site_edit / knife_site_write), then verify." };
    if (seen.state === "READY" || seen.state === "FAILED") break;
    if (Date.now() + pollMs > deadline) break;
    await sleep(pollMs, options.signal);
  }
  const waitedSec = Math.round((Date.now() - started) / 1000);
  const preview = { state: seen.state, url: seen.url, ...(seen.deploymentId ? { deploymentId: seen.deploymentId } : {}), waitedSec, polls };
  if (seen.state === "FAILED") {
    return {
      verdict: "preview-failed", head: seen.head, preview: { ...preview, error: seen.error.slice(0, 400) }, ...(await checksSummary(accountId)),
      next: `The head preview failed: read knife_site_deploy_logs {id:"${seen.deploymentId}"}, fix the cause on the work branch, push, and verify again.`,
    };
  }
  if (seen.state !== "READY") {
    return {
      verdict: "preview-not-ready", head: seen.head, preview, ...(await checksSummary(accountId)),
      next: seen.state === "NONE"
        ? "No preview of the head commit was found in time: with Vercel, start one with knife_site_deploy; otherwise check that the host builds pull requests. Then verify again."
        : "The preview is still building after the wait: call knife_site_verify again (do not loop on wait_for or sleep).",
    };
  }
  const previous = loadSite(accountId).audits[0] ?? null;
  const vercelLinked = !!loadSite(accountId).vercel?.projectId;
  const base = { target: "preview" as const, pages: options.pages, lighthouse: options.lighthouse ?? false, ...(vercelLinked ? {} : { url: seen.url }) };
  const { options: auditOptions, note } = await vercelService.withVercelAudit(accountId, base);
  const run = await runAudit(accountId, auditOptions);
  const digest = auditDigest(run, 15);
  const summary = await checksSummary(accountId);
  const checksState = summary.checks?.state ?? "none";
  return {
    verdict: checksState === "failure" ? "checks-failed" : checksState === "pending" ? "checks-pending" : "verified",
    head: seen.head,
    preview,
    audit: { id: digest.id, scores: digest.scores, findings: digest.findings, moreFindings: digest.moreFindings, totalIssues: digest.totalIssues, skippedAsNotHtml: digest.skippedAsNotHtml, ...(note ? { vercel: note } : {}) },
    comparison: compareAudits(run, previous),
    ...summary,
    next: checksState === "failure"
      ? "Checks failed for this exact commit: report which, fix them on the work branch, push, and verify again."
      : checksState === "pending"
        ? "The preview is audited but checks still run: report them as pending, or verify again later."
        : checksState === "none"
          ? "No checks are configured: say automated build/lint was not verified; the preview audit is the evidence."
          : "Preview READY, audited and checks passed: summarise the comparison in the PR (knife_site_pr) and tell the user to review and Publish.",
  };
}
