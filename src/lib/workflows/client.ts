/** Browser client of the workflow API (src/app/api/workflows/, docs/WORKFLOWS.md). */
import type { PublicCredential, RunRecord, RunSummary, WorkflowSummary } from "./server/store";
import type { Connection, Workflow, WorkflowNode, WorkflowSettings } from "./types";

export type { PublicCredential, RunRecord, RunSummary, WorkflowSummary };

export class WorkflowApiError extends Error {
  readonly status: number;
  readonly details?: unknown;
  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = "WorkflowApiError";
    this.status = status;
    this.details = details;
  }
}

async function call<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch(path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: init.body === undefined ? undefined : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
    cache: "no-store",
    credentials: "same-origin",
  });
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const record = (body ?? {}) as { error?: unknown; message?: unknown; details?: unknown };
    const message = typeof record.message === "string" ? record.message : typeof record.error === "string" ? record.error : `HTTP ${response.status}`;
    throw new WorkflowApiError(message, response.status, record.details);
  }
  return body as T;
}

export interface HookUrls {
  production: string;
  test: string;
}

export interface Draft {
  nodes: WorkflowNode[];
  connections: Connection[];
  settings: WorkflowSettings;
}

export type RunEvent =
  | { type: "start"; runId: string; workflowId: string }
  | { type: "node-start"; node: string }
  | { type: "node-end"; node: string; run: { ms: number; outputCounts: number[]; error?: { message: string; description?: string } } }
  | { type: "done"; status: string; error?: { message: string; node?: string; description?: string } };

const wf = (id: string) => `/api/workflows/${encodeURIComponent(id)}`;

export const workflowsApi = {
  list: () => call<{ workflows: WorkflowSummary[]; credentials: PublicCredential[] }>("/api/workflows"),
  create: (draft: { name: string; description?: string; nodes?: WorkflowNode[]; connections?: Connection[]; settings?: Partial<WorkflowSettings>; tags?: string[] }) =>
    call<{ workflow: Workflow }>("/api/workflows", { body: { action: "create", ...draft } }),
  get: (id: string) => call<{ workflow: Workflow; hooks: HookUrls; runs: RunSummary[] }>(wf(id)),
  save: (id: string, version: number, changes: Partial<Pick<Workflow, "name" | "description" | "nodes" | "connections" | "settings" | "tags" | "active">>) =>
    call<{ workflow: Workflow; hooks: HookUrls }>(wf(id), { method: "PUT", body: { version, ...changes } }),
  remove: (id: string) => call<void>(wf(id), { method: "DELETE" }),
  run: (id: string, body: { startNode?: string; destinationNode?: string; draft?: Draft; items?: { json: Record<string, unknown> }[] }) => call<{ runId: string }>(`${wf(id)}/run`, { body }),
  events: (id: string, runId: string, after: number, signal?: AbortSignal) =>
    call<{ events: RunEvent[]; next: number; done: boolean; unknown?: boolean }>(`${wf(id)}/runs/${runId}/events?after=${after}`, { signal }),
  runs: (id: string) => call<{ runs: RunSummary[] }>(`${wf(id)}/runs`),
  getRun: (id: string, runId: string) => call<{ run: RunRecord }>(`${wf(id)}/runs/${runId}`),
  cancelRun: (id: string, runId: string) => call<{ canceled: boolean }>(`${wf(id)}/runs/${runId}`, { body: { action: "cancel" } }),
  deleteRun: (id: string, runId: string) => call<void>(`${wf(id)}/runs/${runId}`, { method: "DELETE" }),
  listen: (id: string, draft: Draft, signal?: AbortSignal) => call<{ runId: string | null }>(`${wf(id)}/listen`, { body: { draft }, signal }),
  stopListening: (id: string) => call<void>(`${wf(id)}/listen`, { method: "DELETE" }),
  rotateToken: (id: string) => call<{ workflow: Workflow; hooks: HookUrls }>(`${wf(id)}/token`, { body: {} }),
  credentials: () => call<{ credentials: PublicCredential[] }>("/api/workflows/credentials"),
  saveCredential: (body: { id?: string; name: string; type: string; data: Record<string, string | boolean | null> }) =>
    call<{ credential: PublicCredential }>("/api/workflows/credentials", { body: { action: body.id ? "update" : "create", ...body } }),
  deleteCredential: (id: string) => call<{ deleted: boolean; usedBy: string[] }>("/api/workflows/credentials", { body: { action: "delete", id } }),
};
