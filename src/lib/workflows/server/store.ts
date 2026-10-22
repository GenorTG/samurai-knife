/**
 * Per-account workflow storage (docs/WORKFLOWS.md "Storage"): `workflows/<account>/` with `wf/<id>.json`,
 * `runs/<workflowId>/<runId>.json` + `runs/<workflowId>/index.json`, `credentials.json` and `static.json`, every file
 * sealed and counted in the account's quota (area `workflows`). The instance-wide trigger index (which active
 * workflows have schedules and webhooks, which runs wait) lives in `./trigger-index.ts`.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { readAccountText } from "@/lib/storage/sealed";
import { removeAccountPath, writeAccountFile } from "@/lib/storage/quota";
import { accountScope, assertSegment, ensurePrivateDir, safeJoin } from "@/lib/storage/scope";
import { nodeMeta } from "../catalog/index";
import { credentialType, type CredentialField } from "../credential-types";
import { WORKFLOW_ID, workflowSchema, type Item, type NodeRun, type RunError, type RunMode, type RunStatus, type Workflow, type WorkflowNode } from "../types";
import { activationProblems, structuralProblems } from "../validate";
import { syncWorkflowTriggers, removeWorkflowTriggers } from "./trigger-index";

export const MAX_WORKFLOWS = 200;
export const MAX_CREDENTIALS = 100;
export const RUNS_KEPT = 100;
export const RUN_DAYS_KEPT = 14;
/** Items kept per node output in a stored run (the run's counts stay exact). */
const STORED_ITEMS = 50;
const STORED_RUN_BYTES = 2 * 1024 * 1024;
const RUN_ID = /^[0-9a-f]{16}$/;
const CREDENTIAL_ID = /^[0-9a-f]{12}$/;

export class WorkflowStoreError extends Error {
  readonly status: number;
  readonly details?: unknown;
  constructor(message: string, status = 400, details?: unknown) {
    super(message);
    this.name = "WorkflowStoreError";
    this.status = status;
    this.details = details;
  }
}

function root(accountId: string): string {
  return ensurePrivateDir(accountScope(accountId).workflows);
}

function readJson<T>(accountId: string, path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readAccountText(accountId, path)) as T;
}

function writeJson(accountId: string, path: string, value: unknown, enforce = true): void {
  writeAccountFile(accountId, path, JSON.stringify(value), { enforce });
}

const now = () => new Date().toISOString();
export const newWorkflowId = () => randomBytes(6).toString("hex");
export const newRunId = () => randomBytes(8).toString("hex");
export const newHookToken = () => randomBytes(18).toString("base64url");
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

function wfPath(accountId: string, id: string): string {
  if (!WORKFLOW_ID.test(id)) throw new WorkflowStoreError("Unknown workflow.", 404);
  return safeJoin(root(accountId), "wf", `${id}.json`);
}

/* ---------------------------------------------------------------------------------------------------- workflows */

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  active: boolean;
  tags: string[];
  nodeCount: number;
  triggers: string[];
  updatedAt: string;
  createdAt: string;
}

export function getWorkflow(accountId: string, id: string): Workflow | null {
  const path = wfPath(accountId, id);
  if (!existsSync(path)) return null;
  return workflowSchema.parse(readJson(accountId, path, null));
}

export function requireWorkflow(accountId: string, id: string): Workflow {
  const found = getWorkflow(accountId, id);
  if (!found) throw new WorkflowStoreError("Unknown workflow.", 404);
  return found;
}

export function listWorkflows(accountId: string): WorkflowSummary[] {
  const dir = safeJoin(root(accountId), "wf");
  if (!existsSync(dir)) return [];
  const out: WorkflowSummary[] = [];
  for (const name of readdirSync(dir)) {
    const id = name.replace(/\.json$/, "");
    if (!WORKFLOW_ID.test(id)) continue;
    try {
      const wf = requireWorkflow(accountId, id);
      out.push({
        id: wf.id,
        name: wf.name,
        description: wf.description,
        active: wf.active,
        tags: wf.tags,
        nodeCount: wf.nodes.length,
        triggers: [...new Set(wf.nodes.map((node) => nodeMeta(node.type)?.trigger).filter((t): t is NonNullable<typeof t> => Boolean(t)))],
        updatedAt: wf.updatedAt,
        createdAt: wf.createdAt,
      });
    } catch {
      // unreadable file: skipped (shown nowhere, kept for the admin to inspect)
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function checkCredentialRefs(accountId: string, nodes: WorkflowNode[]): void {
  const owned = new Set(listCredentials(accountId).map((credential) => credential.id));
  for (const node of nodes) {
    for (const [slot, id] of Object.entries(node.credentials ?? {})) {
      if (id && !owned.has(id)) throw new WorkflowStoreError(`Node "${node.name}" uses a credential (${slot}) that does not exist.`, 400);
    }
  }
}

function persist(accountId: string, workflow: Workflow): Workflow {
  const parsed = workflowSchema.parse(workflow);
  const problems = structuralProblems(parsed);
  if (problems.length) throw new WorkflowStoreError(problems[0].message, 400, problems);
  checkCredentialRefs(accountId, parsed.nodes);
  if (parsed.active) {
    const activation = activationProblems(parsed);
    if (activation.length) throw new WorkflowStoreError(activation[0].message, 400, activation);
  }
  writeJson(accountId, wfPath(accountId, parsed.id), parsed);
  syncWorkflowTriggers(accountId, parsed);
  return parsed;
}

export interface WorkflowDraft {
  name: string;
  description?: string;
  nodes?: unknown[];
  connections?: unknown[];
  settings?: unknown;
  tags?: string[];
}

export function createWorkflow(accountId: string, draft: WorkflowDraft): Workflow {
  if (listWorkflows(accountId).length >= MAX_WORKFLOWS) throw new WorkflowStoreError(`An account can keep ${MAX_WORKFLOWS} workflows.`, 409);
  const stamp = now();
  let id = newWorkflowId();
  while (existsSync(wfPath(accountId, id))) id = newWorkflowId();
  const parsed = workflowSchema.safeParse({
    id,
    name: draft.name,
    description: draft.description ?? "",
    nodes: draft.nodes ?? [],
    connections: draft.connections ?? [],
    settings: draft.settings,
    active: false,
    hookToken: newHookToken(),
    tags: draft.tags ?? [],
    createdAt: stamp,
    updatedAt: stamp,
    version: 1,
  });
  if (!parsed.success) throw new WorkflowStoreError(parsed.error.issues.map((issue) => `${issue.path.join(".") || "workflow"}: ${issue.message}`).join("; "));
  return persist(accountId, parsed.data);
}

/** Replaces the editable parts; `version` must be the stored one (409 when someone else saved meanwhile). */
export function saveWorkflow(accountId: string, id: string, version: number, changes: WorkflowDraft & { active?: boolean }): Workflow {
  const current = requireWorkflow(accountId, id);
  if (current.version !== version) throw new WorkflowStoreError("The workflow changed since you opened it (another tab, the assistant or MCP saved it). Reload to see the latest version.", 409, { version: current.version });
  const parsed = workflowSchema.safeParse({
    ...current,
    name: changes.name ?? current.name,
    description: changes.description ?? current.description,
    nodes: changes.nodes ?? current.nodes,
    connections: changes.connections ?? current.connections,
    settings: changes.settings ?? current.settings,
    tags: changes.tags ?? current.tags,
    active: changes.active ?? current.active,
    updatedAt: now(),
    version: current.version + 1,
  });
  if (!parsed.success) throw new WorkflowStoreError(parsed.error.issues.map((issue) => `${issue.path.join(".") || "workflow"}: ${issue.message}`).join("; "));
  if (parsed.data.settings.errorWorkflow === id) throw new WorkflowStoreError("A workflow cannot be its own error workflow.");
  return persist(accountId, parsed.data);
}

export function rotateHookToken(accountId: string, id: string): Workflow {
  const current = requireWorkflow(accountId, id);
  return persist(accountId, { ...current, hookToken: newHookToken(), updatedAt: now(), version: current.version + 1 });
}

export function deleteWorkflow(accountId: string, id: string): void {
  const path = wfPath(accountId, id);
  if (!existsSync(path)) throw new WorkflowStoreError("Unknown workflow.", 404);
  removeAccountPath(accountId, path);
  removeAccountPath(accountId, safeJoin(root(accountId), "runs", id));
  const statics = readJson<Record<string, unknown>>(accountId, staticPath(accountId), {});
  if (id in statics) {
    delete statics[id];
    writeJson(accountId, staticPath(accountId), statics, false);
  }
  removeWorkflowTriggers(accountId, id);
}

/* ---------------------------------------------------------------------------------------------------- static data */

function staticPath(accountId: string): string {
  return safeJoin(root(accountId), "static.json");
}

export function getStaticData(accountId: string, workflowId: string): Record<string, Record<string, unknown>> {
  return readJson<Record<string, Record<string, Record<string, unknown>>>>(accountId, staticPath(accountId), {})[workflowId] ?? {};
}

export function setStaticData(accountId: string, workflowId: string, data: Record<string, Record<string, unknown>>): void {
  const all = readJson<Record<string, unknown>>(accountId, staticPath(accountId), {});
  all[workflowId] = data;
  writeJson(accountId, staticPath(accountId), all);
}

/* ---------------------------------------------------------------------------------------------------------- runs */

export interface RunSummary {
  id: string;
  workflowId: string;
  mode: RunMode;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  error?: RunError;
  lastNode?: string;
  customData?: Record<string, string>;
  /** Waiting runs: when they resume by themselves. */
  waitUntil?: number;
}

export interface RunRecord extends RunSummary {
  runData: Record<string, NodeRun[]>;
  startNode?: string;
  /** Waiting runs only: the engine state to continue (src/lib/workflows/engine/run.ts WaitingState). */
  waiting?: unknown;
  /** Waiting runs: file bytes the waiting state refers to (base64). */
  waitingBlobs?: Record<string, string>;
  /** Hash of the resume token (Wait node "on webhook call"). */
  resumeHash?: string;
  /** A sub-workflow or error run: who started it. */
  parent?: { workflowId: string; runId: string };
}

function runsDir(accountId: string, workflowId: string): string {
  if (!WORKFLOW_ID.test(workflowId)) throw new WorkflowStoreError("Unknown workflow.", 404);
  return safeJoin(root(accountId), "runs", workflowId);
}

function runPath(accountId: string, workflowId: string, runId: string): string {
  if (!RUN_ID.test(runId)) throw new WorkflowStoreError("Unknown run.", 404);
  return safeJoin(runsDir(accountId, workflowId), `${assertSegment(runId)}.json`);
}

/** Shrinks node outputs for storage: the first items of each output, the counts unchanged. */
export function trimRunData(runData: Record<string, NodeRun[]>, maxItems = STORED_ITEMS, maxBytes = STORED_RUN_BYTES): Record<string, NodeRun[]> {
  let budget = maxBytes;
  const out: Record<string, NodeRun[]> = {};
  for (const [name, runs] of Object.entries(runData)) {
    out[name] = runs.map((run) => {
      let trimmed = false;
      const outputs = run.outputs.map((output) => {
        const kept: Item[] = [];
        for (const item of output.slice(0, maxItems)) {
          const size = JSON.stringify(item).length;
          if (size > budget) {
            trimmed = true;
            break;
          }
          budget -= size;
          kept.push(item);
        }
        if (kept.length < output.length) trimmed = true;
        return kept;
      });
      return { ...run, outputs, outputCounts: run.outputs.map((output) => output.length), ...(trimmed ? { trimmed: true } : {}) };
    });
  }
  return out;
}

function summaryOf(record: RunRecord): RunSummary {
  const { id, workflowId, mode, status, startedAt, finishedAt, error, lastNode, customData, waitUntil } = record;
  return { id, workflowId, mode, status, startedAt, finishedAt, ...(error ? { error } : {}), ...(lastNode ? { lastNode } : {}), ...(customData && Object.keys(customData).length ? { customData } : {}), ...(waitUntil ? { waitUntil } : {}) };
}

export function saveRun(accountId: string, record: RunRecord): void {
  const dir = runsDir(accountId, record.workflowId);
  writeJson(accountId, runPath(accountId, record.workflowId, record.id), { ...record, runData: trimRunData(record.runData) }, false);
  const indexPath = safeJoin(dir, "index.json");
  const index = readJson<RunSummary[]>(accountId, indexPath, []).filter((entry) => entry.id !== record.id);
  index.unshift(summaryOf(record));
  const cutoff = Date.now() - RUN_DAYS_KEPT * 86_400_000;
  const keep: RunSummary[] = [];
  for (const entry of index) {
    const old = keep.length >= RUNS_KEPT || Date.parse(entry.startedAt) < cutoff;
    if (old && entry.status !== "waiting" && entry.status !== "running") {
      removeAccountPath(accountId, runPath(accountId, record.workflowId, entry.id));
    } else keep.push(entry);
  }
  writeJson(accountId, indexPath, keep, false);
}

export function listRuns(accountId: string, workflowId: string): RunSummary[] {
  return readJson<RunSummary[]>(accountId, safeJoin(runsDir(accountId, workflowId), "index.json"), []);
}

export function getRun(accountId: string, workflowId: string, runId: string): RunRecord | null {
  const path = runPath(accountId, workflowId, runId);
  return existsSync(path) ? readJson<RunRecord | null>(accountId, path, null) : null;
}

export function deleteRun(accountId: string, workflowId: string, runId: string): void {
  removeAccountPath(accountId, runPath(accountId, workflowId, runId));
  const indexPath = safeJoin(runsDir(accountId, workflowId), "index.json");
  writeJson(accountId, indexPath, listRuns(accountId, workflowId).filter((entry) => entry.id !== runId), false);
}

/* --------------------------------------------------------------------------------------------------- credentials */

export interface StoredCredential {
  id: string;
  name: string;
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface PublicCredential {
  id: string;
  name: string;
  type: string;
  /** Non-secret fields as stored; secret fields as `true` when set. */
  fields: Record<string, unknown>;
  /** OAuth2: a token is stored. */
  connected?: boolean;
  createdAt: string;
  updatedAt: string;
}

function credentialsPath(accountId: string): string {
  return safeJoin(root(accountId), "credentials.json");
}

function allCredentials(accountId: string): StoredCredential[] {
  return readJson<{ credentials: StoredCredential[] }>(accountId, credentialsPath(accountId), { credentials: [] }).credentials;
}

function writeCredentials(accountId: string, list: StoredCredential[]): void {
  writeJson(accountId, credentialsPath(accountId), { credentials: list });
}

export function toPublicCredential(credential: StoredCredential): PublicCredential {
  const type = credentialType(credential.type);
  const fields: Record<string, unknown> = {};
  for (const field of type?.fields ?? []) {
    const value = credential.data[field.name];
    if (field.secret) fields[field.name] = value !== undefined && value !== null && value !== "";
    else if (value !== undefined) fields[field.name] = value;
  }
  return {
    id: credential.id,
    name: credential.name,
    type: credential.type,
    fields,
    ...(type?.oauth2 ? { connected: Boolean(credential.data.accessToken) } : {}),
    createdAt: credential.createdAt,
    updatedAt: credential.updatedAt,
  };
}

export function listCredentials(accountId: string): PublicCredential[] {
  return allCredentials(accountId).map(toPublicCredential);
}

/** Full credential with secrets: server and worker only. */
export function getCredential(accountId: string, id: string): StoredCredential | null {
  if (!CREDENTIAL_ID.test(id)) return null;
  return allCredentials(accountId).find((credential) => credential.id === id) ?? null;
}

function cleanFields(fields: CredentialField[], input: Record<string, unknown>, current: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.managed) {
      if (current[field.name] !== undefined) data[field.name] = current[field.name];
      continue;
    }
    const raw = input[field.name];
    // A blank secret keeps the stored one (the form never shows it); `null` clears it.
    if (field.secret && (raw === undefined || raw === "")) {
      if (current[field.name] !== undefined) data[field.name] = current[field.name];
      continue;
    }
    if (raw === null || raw === undefined) continue;
    if (field.type === "boolean") data[field.name] = raw === true || raw === "true";
    else {
      const text = String(raw);
      if (text.length > 16_384) throw new WorkflowStoreError(`${field.label} is too long.`);
      data[field.name] = text;
    }
  }
  for (const field of fields) {
    if (field.required && !field.managed && (data[field.name] === undefined || data[field.name] === "")) throw new WorkflowStoreError(`${field.label} is required.`);
  }
  return data;
}

export function saveCredential(accountId: string, input: { id?: string; name: string; type: string; data: Record<string, unknown> }): PublicCredential {
  const type = credentialType(input.type);
  if (!type) throw new WorkflowStoreError(`Unknown credential type "${input.type}".`);
  const name = String(input.name ?? "").trim().slice(0, 80);
  if (!name) throw new WorkflowStoreError("Give the credential a name.");
  const list = allCredentials(accountId);
  const stamp = now();
  if (input.id) {
    const index = list.findIndex((credential) => credential.id === input.id);
    if (index < 0) throw new WorkflowStoreError("Unknown credential.", 404);
    const current = list[index];
    if (current.type !== input.type) throw new WorkflowStoreError("A credential's type cannot change; create a new one.");
    // Changing where an OAuth app points drops the old token (it belongs to the old app).
    const data = cleanFields(type.fields, input.data, current.data);
    if (type.oauth2 && (data.clientId !== current.data.clientId || data.tokenUrl !== current.data.tokenUrl || data.authUrl !== current.data.authUrl)) {
      for (const key of ["accessToken", "refreshToken", "expiresAt", "connectedAt", "tokenType"]) delete data[key];
    }
    list[index] = { ...current, name, data, updatedAt: stamp };
    writeCredentials(accountId, list);
    return toPublicCredential(list[index]);
  }
  if (list.length >= MAX_CREDENTIALS) throw new WorkflowStoreError(`An account can keep ${MAX_CREDENTIALS} credentials.`, 409);
  const credential: StoredCredential = { id: randomBytes(6).toString("hex"), name, type: input.type, data: cleanFields(type.fields, input.data, {}), createdAt: stamp, updatedAt: stamp };
  writeCredentials(accountId, [...list, credential]);
  return toPublicCredential(credential);
}

/** Server-side updates (OAuth tokens from the connect flow or a refresh during a run). */
export function updateCredentialData(accountId: string, id: string, update: Record<string, unknown>): void {
  const list = allCredentials(accountId);
  const index = list.findIndex((credential) => credential.id === id);
  if (index < 0) return;
  const type = credentialType(list[index].type);
  const allowed = new Set((type?.fields ?? []).map((field) => field.name));
  const clean = Object.fromEntries(Object.entries(update).filter(([key]) => allowed.has(key)));
  list[index] = { ...list[index], data: { ...list[index].data, ...clean }, updatedAt: now() };
  writeCredentials(accountId, list);
}

export function deleteCredential(accountId: string, id: string): string[] {
  const list = allCredentials(accountId);
  if (!list.some((credential) => credential.id === id)) throw new WorkflowStoreError("Unknown credential.", 404);
  writeCredentials(accountId, list.filter((credential) => credential.id !== id));
  return listWorkflows(accountId)
    .filter((summary) => getWorkflow(accountId, summary.id)?.nodes.some((node) => Object.values(node.credentials ?? {}).includes(id)))
    .map((summary) => summary.name);
}
