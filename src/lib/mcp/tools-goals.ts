import * as z from "zod/v4";
import { defineTool, type KnifeToolContext, type KnifeToolDefinition } from "./define";
import { checkpointAgentGoal, createAgentGoal, listAgentGoals, updateAgentGoal } from "@/lib/agent-work/goals";

function account(ctx: KnifeToolContext | undefined): string {
  if (!ctx?.accountId) throw new Error("Goal tools need an account context.");
  return ctx.accountId;
}

const statuses = ["pending", "in_progress", "completed"] as const;

export const GOAL_KNIFE_TOOLS: KnifeToolDefinition[] = [
  defineTool({
    name: "knife_goal_list",
    scope: "account",
    effect: "read",
    description: "List the user's durable goals/projects, including status, next action, checklist progress and recent checkpoints. Read this when resuming work or the user asks what is in progress.",
    schema: z.object({ includeCompleted: z.boolean().optional() }).strict(),
    run: ({ includeCompleted }, ctx) => listAgentGoals(account(ctx), includeCompleted ?? true),
  }),
  defineTool({
    name: "knife_goal_create",
    scope: "account",
    effect: "write",
    description: "Save a durable project or task goal to the user's account so it survives chat/provider changes. Include a clear objective, optional project/site name, concrete ordered steps, and nextAction. Use when the user asks to track or resume multi-step work; don't create for a trivial one-turn request.",
    schema: z.object({ title: z.string().trim().min(1).max(160), objective: z.string().trim().min(1).max(4000), project: z.string().max(160).optional(), nextAction: z.string().max(1000).optional(), steps: z.array(z.string().trim().min(1).max(160)).max(50).optional() }).strict(),
    run: (input, ctx) => createAgentGoal(account(ctx), input),
  }),
  defineTool({
    name: "knife_goal_update",
    scope: "account",
    effect: "write",
    description: "Edit an existing goal's title/objective/project/steps/nextAction or set status active, paused, completed, or archived. Get the id from knife_goal_list. Every change is recorded in its checkpoint history.",
    schema: z.object({ id: z.string().min(1).max(64), title: z.string().trim().min(1).max(160).optional(), objective: z.string().trim().min(1).max(4000).optional(), project: z.string().max(160).optional(), nextAction: z.string().max(1000).optional(), status: z.enum(["active", "paused", "completed", "archived"]).optional(), steps: z.array(z.object({ id: z.string().max(64).optional(), title: z.string().trim().min(1).max(160), status: z.enum(statuses) }).strict()).max(50).optional() }).strict(),
    run: ({ id, ...patch }, ctx) => updateAgentGoal(account(ctx), id, patch),
  }),
  defineTool({
    name: "knife_goal_checkpoint",
    scope: "account",
    effect: "write",
    description: "Append a durable progress note to a goal, optionally update a checklist step and nextAction. Use after meaningful work or before ending/pausing a long task. Be specific about completed work, evidence, blockers and the next step; never claim a step is done without doing it.",
    schema: z.object({ id: z.string().min(1).max(64), note: z.string().trim().min(1).max(1000), stepId: z.string().max(64).optional(), stepStatus: z.enum(statuses).optional(), nextAction: z.string().max(1000).optional() }).strict(),
    run: ({ id, ...input }, ctx) => checkpointAgentGoal(account(ctx), id, input),
  }),
];
