import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import * as z from "zod/v4";
import { readAccountText } from "@/lib/storage/sealed";
import { writeAccountFile } from "@/lib/storage/quota";
import { accountScope, parentDir } from "@/lib/storage/scope";

const MAX_GOALS = 100;
const MAX_EVENTS = 100;
const goalStatus = z.enum(["active", "paused", "completed", "archived"]);
const stepStatus = z.enum(["pending", "in_progress", "completed"]);

const stepSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().trim().min(1).max(160),
  status: stepStatus,
});
const eventSchema = z.object({ id: z.string().min(1).max(64), at: z.string(), text: z.string().max(1000) });
const goalSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().trim().min(1).max(160),
  objective: z.string().trim().min(1).max(4000),
  project: z.string().trim().max(160).default(""),
  status: goalStatus,
  nextAction: z.string().max(1000).default(""),
  steps: z.array(stepSchema).max(50).default([]),
  events: z.array(eventSchema).max(MAX_EVENTS).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const fileSchema = z.object({ version: z.literal(1), goals: z.array(goalSchema).max(MAX_GOALS) });

export type AgentGoal = z.infer<typeof goalSchema>;
export type GoalStatus = z.infer<typeof goalStatus>;
export type GoalStepStatus = z.infer<typeof stepStatus>;
type GoalFile = z.infer<typeof fileSchema>;

export class AgentGoalError extends Error {}

function goalPath(accountId: string): string {
  const path = accountScope(accountId).goalsFile;
  parentDir(path);
  return path;
}

function readFile(accountId: string): GoalFile {
  const path = goalPath(accountId);
  if (!existsSync(path)) return { version: 1, goals: [] };
  try {
    return fileSchema.parse(JSON.parse(readAccountText(accountId, path)));
  } catch (error) {
    throw new AgentGoalError(`The saved goals are damaged: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeFile(accountId: string, file: GoalFile): void {
  writeAccountFile(accountId, goalPath(accountId), `${JSON.stringify(fileSchema.parse(file), null, 2)}\n`);
}

function addEvent(goal: AgentGoal, text: string): void {
  goal.events.push({ id: randomUUID(), at: new Date().toISOString(), text: text.trim().slice(0, 1000) });
  goal.events = goal.events.slice(-MAX_EVENTS);
  goal.updatedAt = new Date().toISOString();
}

export function listAgentGoals(accountId: string, includeCompleted = true): AgentGoal[] {
  const goals = readFile(accountId).goals;
  return (includeCompleted ? goals : goals.filter((goal) => goal.status !== "completed" && goal.status !== "archived"))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function createAgentGoal(accountId: string, input: {
  title: string; objective: string; project?: string; steps?: string[]; nextAction?: string;
}): AgentGoal {
  const file = readFile(accountId);
  if (file.goals.length >= MAX_GOALS) throw new AgentGoalError(`At most ${MAX_GOALS} goals can be saved.`);
  const now = new Date().toISOString();
  const goal = goalSchema.parse({
    id: randomUUID(), title: input.title, objective: input.objective, project: input.project ?? "",
    status: "active", nextAction: input.nextAction ?? "",
    steps: (input.steps ?? []).map((title) => ({ id: randomUUID(), title, status: "pending" })),
    events: [], createdAt: now, updatedAt: now,
  });
  addEvent(goal, "Goal created");
  file.goals.push(goal);
  writeFile(accountId, file);
  return goal;
}

export function updateAgentGoal(accountId: string, id: string, patch: {
  title?: string; objective?: string; project?: string; nextAction?: string; status?: GoalStatus; steps?: Array<{ id?: string; title: string; status: GoalStepStatus }>;
}): AgentGoal {
  const file = readFile(accountId);
  const goal = file.goals.find((item) => item.id === id);
  if (!goal) throw new AgentGoalError("Goal not found.");
  const changed = Object.keys(patch).filter((key) => patch[key as keyof typeof patch] !== undefined);
  const previousStatus = goal.status;
  if (patch.title !== undefined) goal.title = patch.title.trim();
  if (patch.objective !== undefined) goal.objective = patch.objective.trim();
  if (patch.project !== undefined) goal.project = patch.project.trim();
  if (patch.nextAction !== undefined) goal.nextAction = patch.nextAction.trim();
  if (patch.steps !== undefined) {
    goal.steps = patch.steps.map((step) => ({ id: step.id || randomUUID(), title: step.title.trim(), status: step.status }));
  }
  if (patch.status !== undefined) goal.status = patch.status;
  const statusChanged = previousStatus !== goal.status;
  const fieldsChanged = changed.filter((key) => key !== "status");
  if (statusChanged && fieldsChanged.length) addEvent(goal, `Status changed: ${previousStatus} → ${goal.status}; updated ${fieldsChanged.join(", ")}`);
  else if (statusChanged) addEvent(goal, `Status changed: ${previousStatus} → ${goal.status}`);
  else addEvent(goal, fieldsChanged.length ? `Updated: ${fieldsChanged.join(", ")}` : "Goal checked");
  goalSchema.parse(goal);
  writeFile(accountId, file);
  return goal;
}

export function checkpointAgentGoal(accountId: string, id: string, input: {
  note: string; stepId?: string; stepStatus?: GoalStepStatus; nextAction?: string;
}): AgentGoal {
  const file = readFile(accountId);
  const goal = file.goals.find((item) => item.id === id);
  if (!goal) throw new AgentGoalError("Goal not found.");
  if (input.stepId && input.stepStatus) {
    const step = goal.steps.find((item) => item.id === input.stepId);
    if (!step) throw new AgentGoalError("Step not found in this goal.");
    step.status = input.stepStatus;
  }
  if (input.nextAction !== undefined) goal.nextAction = input.nextAction.trim();
  addEvent(goal, input.note);
  goalSchema.parse(goal);
  writeFile(accountId, file);
  return goal;
}
