import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { workflowError, zodMessage } from "@/lib/workflows/server/http";
import { startRun } from "@/lib/workflows/server/runner";
import { draftWorkflow, requireWorkflow } from "@/lib/workflows/server/store";
import type { Item } from "@/lib/workflows/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const itemSchema = z.object({ json: z.record(z.string(), z.unknown()) }).passthrough();
const runSchema = z.object({
  startNode: z.string().max(80).optional(),
  destinationNode: z.string().max(80).optional(),
  /** The editor's unsaved nodes/connections/settings (run without saving). */
  draft: z.object({ nodes: z.array(z.unknown()).max(300), connections: z.array(z.unknown()).max(1000), settings: z.unknown().optional() }).optional(),
  /** Items the start node outputs (test data for a manual start). */
  items: z.array(itemSchema).max(1000).optional(),
  /** Wait for the end and answer with the result (assistant, MCP); default: answer at once with the run id. */
  wait: z.boolean().optional(),
}).strict();

/**
 * POST /api/workflows/<id>/run -> 202 `{ runId }` (follow it at …/runs/<runId>/events), or with `wait: true` 200
 * `{ runId, status, error?, lastNode?, output }` (the last node's first 50 items).
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const { id } = await ctx.params;
  const read = await readJsonBody(request, 4 * 1024 * 1024);
  if ("response" in read) return read.response;
  const parsed = runSchema.safeParse(read.body ?? {});
  if (!parsed.success) return jsonError(zodMessage(parsed.error), 422);
  const body = parsed.data;
  try {
    const workflow = body.draft ? draftWorkflow(auth.account.id, id, body.draft as Parameters<typeof draftWorkflow>[2]) : requireWorkflow(auth.account.id, id);
    let runId = "";
    const run = startRun({
      accountId: auth.account.id,
      workflow,
      mode: "manual",
      startNode: body.startNode,
      destinationNode: body.destinationNode,
      triggerItems: body.items as Item[] | undefined,
      progress: true,
      onRunId: (value) => {
        runId = value;
      },
    });
    if (!body.wait) {
      void run.catch((error: unknown) => console.error(`[workflows] manual run failed to start: ${error instanceof Error ? error.message : String(error)}`));
      return json({ runId }, 202);
    }
    const { result } = await run;
    return json({ runId, status: result.status, ...(result.error ? { error: result.error } : {}), ...(result.lastNode ? { lastNode: result.lastNode } : {}), output: (result.lastItems ?? []).slice(0, 50).map((item) => item.json) });
  } catch (error) {
    return workflowError(error);
  }
}
