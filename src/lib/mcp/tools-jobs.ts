import * as z from "zod/v4";
import { msg } from "@/lib/i18n/msg";
import { defineTool, KnifeCallContent, type KnifeToolContext, type KnifeToolDefinition } from "./define";
import { jobStatus, MAX_POLL_WAIT_SEC, type McpJobView } from "./jobs";

/**
 * knife_job_status (MCP only, docs/MCP.md "Long calls"): a call that did not finish within the answer window
 * (src/lib/mcp/jobs.ts) answered `{status:"running", jobId}`; this waits up to `waitSeconds` and returns its progress,
 * or once it is done the very content the call returns (a screenshot's image block, an audit digest...).
 */

export const POLL_HINT = "Call knife_job_status {jobId} again: it waits up to 25 s each time and returns the result once the work is done (the work keeps running on the server meanwhile; do not start the same call again).";

/** The `running` answer of a call or a poll. */
export function runningAnswer(job: McpJobView): Record<string, unknown> {
  return { status: "running", jobId: job.jobId, tool: job.tool, elapsedSec: job.elapsedSec, ...(job.progress ? { progress: job.progress } : {}), pollWith: "knife_job_status", hint: POLL_HINT };
}

function account(ctx: KnifeToolContext | undefined): string {
  if (!ctx?.accountId) throw new Error(msg("Job tools need an account context."));
  return ctx.accountId;
}

const JOB_STATUS = defineTool({
  name: "knife_job_status",
  scope: "account",
  effect: "read",
  description:
    "Result or progress of a tool call that is still running in the background. A long call (a screenshot, an audit, a preview verification...) answers within about 25 s: with its result, or with {status:\"running\", jobId, pollWith:\"knife_job_status\"} while the work continues on the server. Pass that jobId: this waits up to waitSeconds (default 20, max 25) and returns {status:\"running\", progress, elapsedSec} or, once finished, {status:\"done\"|\"failed\"} followed by exactly what the original call returns (image blocks included). Finished results are kept 15 minutes. Never start the same long call again while its job runs.",
  schema: z.object({
    jobId: z.string().min(1).max(40),
    waitSeconds: z.number().int().min(0).max(MAX_POLL_WAIT_SEC).optional(),
  }).strict(),
  async run({ jobId, waitSeconds }, ctx) {
    const found = await jobStatus(account(ctx), jobId, { waitSeconds, readOnly: ctx?.readOnly, onTick: ctx?.progress ? (job) => ctx.progress?.(job.progress || job.tool) : undefined });
    if (!found) throw new Error(msg("Unknown or expired job: results are kept for 15 minutes (and not across a server restart). Start the call again."));
    if (!found.result) return runningAnswer(found.view);
    const head = { type: "text" as const, text: JSON.stringify({ status: found.view.state, jobId: found.view.jobId, tool: found.view.tool, elapsedSec: found.view.elapsedSec }) };
    return new KnifeCallContent([head, ...found.result.content], found.result.isError === true);
  },
});

export const JOB_KNIFE_TOOLS: KnifeToolDefinition[] = [JOB_STATUS];
