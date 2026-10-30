import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { AgentGoalError, createAgentGoal, deleteAgentGoal, listAgentGoals, updateAgentGoal, type GoalStatus, type GoalStepStatus } from "@/lib/agent-work/goals";
import { quotaErrorResponse } from "@/lib/storage/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const step = z.object({ id: z.string().max(64).optional(), title: z.string().trim().min(1).max(160), status: z.enum(["pending", "in_progress", "completed"]) }).strict();
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), title: z.string().trim().min(1).max(160), objective: z.string().trim().min(1).max(4000), project: z.string().max(160).optional(), nextAction: z.string().max(1000).optional(), steps: z.array(z.string().trim().min(1).max(160)).max(50).optional() }).strict(),
  z.object({ action: z.literal("delete"), id: z.string().min(1).max(64) }).strict(),
  z.object({ action: z.literal("update"), id: z.string().min(1).max(64), title: z.string().trim().min(1).max(160).optional(), objective: z.string().trim().min(1).max(4000).optional(), project: z.string().max(160).optional(), nextAction: z.string().max(1000).optional(), status: z.enum(["active", "paused", "completed", "archived"]).optional(), steps: z.array(step).max(50).optional() }).strict(),
]);

function failure(error: unknown): Response {
  if (error instanceof AgentGoalError) return jsonError(error.message, 422);
  const quota = quotaErrorResponse(error);
  if (quota) return quota;
  throw error;
}

export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  try {
    return json({ goals: listAgentGoals(auth.account.id) });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const read = await readJsonBody(request, 64 * 1024);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) return jsonError(parsed.error.issues.map((issue) => issue.message).join("; "), 422);
  try {
    const input = parsed.data;
    if (input.action === "create") return json({ goal: createAgentGoal(auth.account.id, input) }, 201);
    if (input.action === "delete") {
      deleteAgentGoal(auth.account.id, input.id);
      return json({ ok: true });
    }
    return json({ goal: updateAgentGoal(auth.account.id, input.id, {
      title: input.title,
      objective: input.objective,
      project: input.project,
      nextAction: input.nextAction,
      status: input.status as GoalStatus | undefined,
      steps: input.steps as Array<{ id?: string; title: string; status: GoalStepStatus }> | undefined,
    }) });
  } catch (error) {
    return failure(error);
  }
}
