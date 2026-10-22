/**
 * Workflow model (docs/WORKFLOWS.md "Model"). Isomorphic: the editor, the server and the workflow worker all import it.
 * Plain data only (it crosses the worker's IPC as JSON). The worker runs this file with Node's type stripping, so no
 * enums, namespaces or parameter properties here or in anything the worker imports.
 */
import { z } from "zod";

export const NODE_NAME_MAX = 80;
export const MAX_NODES = 300;
export const MAX_CONNECTIONS = 1000;
export const WORKFLOW_ID = /^[a-z0-9]{8,24}$/;

const nodeName = z.string().trim().min(1).max(NODE_NAME_MAX).refine((name) => !/[\0\n\r]/.test(name), "invalid node name");

export const workflowNodeSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  type: z.string().regex(/^[a-z][a-z0-9.-]{1,60}$/),
  /** Bumped when a node type changes its parameters incompatibly; old workflows keep their version's behaviour. */
  typeVersion: z.number().int().min(1).max(100).default(1),
  name: nodeName,
  position: z.tuple([z.number().finite(), z.number().finite()]),
  parameters: z.record(z.string(), z.unknown()).default({}),
  /** Credential slot (the node type names its slots) -> credential id of the account. */
  credentials: z.record(z.string(), z.string().max(40)).optional(),
  disabled: z.boolean().optional(),
  notes: z.string().max(4000).optional(),
  retryOnFail: z.boolean().optional(),
  maxTries: z.number().int().min(1).max(10).optional(),
  waitBetweenTries: z.number().int().min(0).max(60_000).optional(),
  onError: z.enum(["stop", "continue", "errorOutput"]).optional(),
  alwaysOutputData: z.boolean().optional(),
  executeOnce: z.boolean().optional(),
});

export const connectionSchema = z.object({
  from: z.object({ node: nodeName, output: z.number().int().min(0).max(63) }),
  to: z.object({ node: nodeName, input: z.number().int().min(0).max(7) }),
});

export const workflowSettingsSchema = z.object({
  /** IANA zone for schedules and date nodes; null = the server's. */
  timezone: z.string().max(64).nullable().default(null),
  /** Workflow (same account) run when a run of this one fails. */
  errorWorkflow: z.string().regex(WORKFLOW_ID).nullable().default(null),
  /** Run wall clock in seconds (capped by the instance limit). */
  timeoutSeconds: z.number().int().min(1).max(3600).nullable().default(null),
  saveSuccessfulRuns: z.boolean().default(true),
  saveManualRuns: z.boolean().default(true),
  /** Which workflows may call this one as a sub-workflow: "any" of the account, or "none". */
  callableBy: z.enum(["any", "none"]).default("any"),
});

export const workflowSchema = z.object({
  id: z.string().regex(WORKFLOW_ID),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(4000).default(""),
  nodes: z.array(workflowNodeSchema).max(MAX_NODES),
  connections: z.array(connectionSchema).max(MAX_CONNECTIONS),
  settings: workflowSettingsSchema.default(() => workflowSettingsSchema.parse({})),
  active: z.boolean().default(false),
  /** Secret part of this workflow's webhook URLs (rotatable). */
  hookToken: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Optimistic concurrency: a save must name the version it edited. */
  version: z.number().int().min(1),
});

export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export type Connection = z.infer<typeof connectionSchema>;
export type WorkflowSettings = z.infer<typeof workflowSettingsSchema>;
export type Workflow = z.infer<typeof workflowSchema>;

/** A file attached to an item. Bytes live in the run's blob store; `id` is only meaningful inside one run. */
export interface BinaryRef {
  id: string;
  mimeType: string;
  fileName?: string;
  fileExtension?: string;
  fileSize: number;
}

export type JsonObject = { [key: string]: unknown };

export interface Item {
  json: JsonObject;
  binary?: Record<string, BinaryRef>;
  /** Index of the input item this one came from (first input), when the node knows it. */
  pairedItem?: number;
  /** Set by "continue on error" on the item that failed. */
  error?: { message: string };
}

export type RunMode = "manual" | "trigger" | "webhook" | "webhook-test" | "subworkflow" | "error" | "resume" | "chat";
export type RunStatus = "running" | "success" | "error" | "waiting" | "canceled";

/** One execution of one node inside a run (a node in a loop has several). */
export interface NodeRun {
  startedAt: number;
  ms: number;
  /** Items per input index as received (counts are always kept; data may be trimmed in stored runs). */
  inputCounts: number[];
  /** Items per output index. */
  outputs: Item[][];
  error?: RunError;
  /** Data was cut to keep the stored run small. */
  trimmed?: boolean;
  logs?: string[];
}

export interface RunError {
  message: string;
  node?: string;
  description?: string;
  /** HTTP status of a failed request, when there was one. */
  httpCode?: number;
}

export interface HookResponse {
  status: number;
  headers: Record<string, string>;
  /** Text or JSON body, or a binary (base64) one. */
  body?: string;
  bodyBase64?: string;
}

/** Display metadata shared by the editor palette and the engine (no behaviour). */
export type NodeGroup = "trigger" | "flow" | "data" | "transform" | "files" | "network" | "utility" | "ai" | "apps";

export type ParamType =
  | "string"
  | "number"
  | "boolean"
  | "options"
  | "multiOptions"
  | "json"
  | "code"
  | "conditions"
  | "keyValue"
  | "list"
  | "collection"
  | "notice"
  | "dateTime"
  | "color";

export interface ParamOption {
  value: string;
  label: string;
  description?: string;
}

export interface NodeParam {
  name: string;
  label: string;
  type: ParamType;
  default?: unknown;
  description?: string;
  placeholder?: string;
  required?: boolean;
  options?: ParamOption[];
  /** Shown only when every named parameter has one of the listed values. */
  showIf?: Record<string, unknown[]>;
  /** For `list` (repeatable rows) and `collection` (optional extras): the row's fields. */
  fields?: NodeParam[];
  /** Editor hints. */
  rows?: number;
  language?: "javascript" | "json" | "html" | "sql" | "text";
  /** Value is never an expression (for example the code itself). */
  noExpression?: boolean;
  min?: number;
  max?: number;
}

export interface CredentialSlot {
  name: string;
  label: string;
  /** Credential types that fit this slot. */
  types: string[];
  required?: boolean;
  /** Shown only when these parameters match. */
  showIf?: Record<string, unknown[]>;
}

export interface NodeMeta {
  type: string;
  label: string;
  group: NodeGroup;
  description: string;
  /** n8n's name for the same node, for search ("Edit Fields (Set)"). */
  alias?: string;
  keywords?: string[];
  /** Number of inputs (0 = a trigger). */
  inputs: number;
  /** Output labels; a function of the parameters for nodes like Switch. */
  outputs: string[] | ((parameters: Record<string, unknown>) => string[]);
  trigger?: "manual" | "schedule" | "webhook" | "subworkflow" | "error" | "chat";
  params: NodeParam[];
  credentials?: CredentialSlot[];
  /** Default node name on the canvas. */
  defaultName?: string;
  /** Accent hue for the canvas card. */
  hue?: number;
  /** Version written into new nodes. */
  version?: number;
}

export function outputLabels(meta: NodeMeta, parameters: Record<string, unknown>): string[] {
  return typeof meta.outputs === "function" ? meta.outputs(parameters) : meta.outputs;
}
