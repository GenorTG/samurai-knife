/**
 * Instance-wide index of what starts runs by itself (docs/WORKFLOWS.md "Triggers"): one entry per workflow (its webhook
 * token's hash, and for active workflows the schedule rules and webhook routes) and one per waiting run. Lets the
 * scheduler and the webhook routes find work without opening every account's sealed files. Holds ids, rules and hashes
 * only: never a token, a credential or run data. `$KNIFE_DATA_DIR/workflow-triggers.json`, 0600, atomic writes; only the
 * server process writes it (each change is synchronous, so two requests cannot interleave).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDataDir, writePrivateFile } from "@/lib/accounts/store";
import { nodeMeta } from "../catalog/index";
import type { Workflow } from "../types";
import { normalizeHookPath } from "../validate";
import { createHash } from "node:crypto";

export interface ScheduleEntry {
  node: string;
  rules: unknown[];
}

export interface HookEntry {
  node: string;
  method: string;
  path: string;
}

export interface WorkflowEntry {
  account: string;
  workflowId: string;
  tokenHash: string;
  active: boolean;
  timezone: string | null;
  schedules: ScheduleEntry[];
  hooks: HookEntry[];
  /** Has an Error Trigger (may be named as another workflow's error workflow). */
  errorTrigger: boolean;
}

export interface WaitEntry {
  account: string;
  workflowId: string;
  runId: string;
  until?: number;
  resumeHash?: string;
}

interface IndexFile {
  version: 1;
  workflows: Record<string, WorkflowEntry>;
  waits: Record<string, WaitEntry>;
  /** `<account>/<workflow>/<node>/<rule>` -> last fire time (ms). */
  fired: Record<string, number>;
}

const key = (account: string, workflowId: string) => `${account}/${workflowId}`;

function file(): string {
  return join(ensureDataDir(), "workflow-triggers.json");
}

let cache: { mtime: string; data: IndexFile } | null = null;

function load(): IndexFile {
  const path = file();
  if (!existsSync(path)) return { version: 1, workflows: {}, waits: {}, fired: {} };
  const text = readFileSync(path, "utf8");
  if (cache && cache.mtime === text) return structuredClone(cache.data);
  const data = JSON.parse(text) as IndexFile;
  cache = { mtime: text, data };
  return structuredClone(data);
}

function mutate<T>(change: (data: IndexFile) => T): T {
  const data = load();
  const result = change(data);
  const text = `${JSON.stringify(data)}\n`;
  writePrivateFile(file(), text);
  cache = { mtime: text, data: structuredClone(data) };
  return result;
}

export function read(): IndexFile {
  return load();
}

export function syncWorkflowTriggers(account: string, workflow: Workflow): void {
  const enabled = workflow.nodes.filter((node) => !node.disabled);
  const entry: WorkflowEntry = {
    account,
    workflowId: workflow.id,
    tokenHash: createHash("sha256").update(workflow.hookToken).digest("hex"),
    active: workflow.active,
    timezone: workflow.settings.timezone,
    schedules: workflow.active
      ? enabled.filter((node) => nodeMeta(node.type)?.trigger === "schedule").map((node) => ({ node: node.name, rules: Array.isArray(node.parameters.rules) ? node.parameters.rules : [] }))
      : [],
    hooks: enabled
      .filter((node) => nodeMeta(node.type)?.trigger === "webhook")
      .map((node) => ({ node: node.name, method: String(node.parameters.httpMethod ?? "POST").toUpperCase(), path: normalizeHookPath(node.parameters.path) })),
    errorTrigger: enabled.some((node) => nodeMeta(node.type)?.trigger === "error"),
  };
  mutate((data) => {
    data.workflows[key(account, workflow.id)] = entry;
    // Fire times of schedule nodes that no longer exist are dropped.
    const prefix = `${key(account, workflow.id)}/`;
    const keep = new Set(entry.schedules.map((schedule) => schedule.node));
    for (const name of Object.keys(data.fired)) {
      if (name.startsWith(prefix) && !keep.has(name.slice(prefix.length).split("/")[0])) delete data.fired[name];
    }
  });
}

export function removeWorkflowTriggers(account: string, workflowId: string): void {
  mutate((data) => {
    delete data.workflows[key(account, workflowId)];
    for (const [runId, wait] of Object.entries(data.waits)) if (wait.account === account && wait.workflowId === workflowId) delete data.waits[runId];
    const prefix = `${key(account, workflowId)}/`;
    for (const name of Object.keys(data.fired)) if (name.startsWith(prefix)) delete data.fired[name];
  });
}

/** Every workflow of an account (account deletion). */
export function removeAccountTriggers(account: string): void {
  mutate((data) => {
    for (const [name, entry] of Object.entries(data.workflows)) if (entry.account === account) delete data.workflows[name];
    for (const [runId, wait] of Object.entries(data.waits)) if (wait.account === account) delete data.waits[runId];
    for (const name of Object.keys(data.fired)) if (name.startsWith(`${account}/`)) delete data.fired[name];
  });
}

export function findByTokenHash(hash: string): WorkflowEntry | null {
  return Object.values(load().workflows).find((entry) => entry.tokenHash === hash) ?? null;
}

export function activeSchedules(): WorkflowEntry[] {
  return Object.values(load().workflows).filter((entry) => entry.active && entry.schedules.length > 0);
}

export function lastFired(account: string, workflowId: string, node: string, rule: number): number | undefined {
  return load().fired[`${key(account, workflowId)}/${node}/${rule}`];
}

export function markFired(account: string, workflowId: string, node: string, rule: number, at: number): void {
  mutate((data) => {
    data.fired[`${key(account, workflowId)}/${node}/${rule}`] = at;
  });
}

export function addWait(entry: WaitEntry): void {
  mutate((data) => {
    data.waits[entry.runId] = entry;
  });
}

export function removeWait(runId: string): void {
  mutate((data) => {
    delete data.waits[runId];
  });
}

export function dueWaits(now: number): WaitEntry[] {
  return Object.values(load().waits).filter((wait) => wait.until !== undefined && wait.until <= now);
}

export function findWaitByResumeHash(hash: string): WaitEntry | null {
  return Object.values(load().waits).find((wait) => wait.resumeHash === hash) ?? null;
}

export function waitsOf(account: string): WaitEntry[] {
  return Object.values(load().waits).filter((wait) => wait.account === account);
}
