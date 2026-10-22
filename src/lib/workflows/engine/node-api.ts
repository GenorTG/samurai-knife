/**
 * What a node implementation sees (src/lib/workflows/nodes/) and returns. The executor (`run.ts`) builds one context per
 * node execution. Services that reach outside the run (HTTP, credentials, sub-workflows) are passed in by whoever runs
 * the engine: the workflow worker in production, fakes in unit tests.
 */
import type { SandboxLimits, Sandbox } from "../sandbox/quickjs";
import type { ScopeData } from "./expressions";
import type { BinaryRef, HookResponse, Item, NodeMeta, RunMode, Workflow, WorkflowNode } from "../types";

export interface HttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  /** Follow redirects (each hop re-checked by the outbound policy). */
  followRedirects?: boolean;
  maxRedirects?: number;
  timeoutMs?: number;
  /** Largest body read (bytes); bigger answers fail. */
  maxBytes?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  url: string;
}

export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;

export interface BlobStore {
  put(bytes: Uint8Array, meta: { mimeType?: string; fileName?: string }): BinaryRef;
  get(ref: BinaryRef | string): Uint8Array;
}

/** A credential as the node gets it: its type and opened fields (OAuth2 also carries the current token). */
export interface CredentialData {
  id: string;
  type: string;
  name: string;
  data: Record<string, unknown>;
}

export interface WaitRequest {
  /** Resume at this time (ms since epoch). */
  until?: number;
  /** Resume when `$execution.resumeUrl` is called (and at `until`, if set, whichever comes first). */
  webhook?: boolean;
}

export interface SubWorkflowCall {
  workflowId: string;
  items: Item[];
  /** Wait for the result; false = start it and continue with the input items. */
  wait: boolean;
}

export interface EngineServices {
  http: HttpClient;
  blobs: BlobStore;
  credential(node: WorkflowNode, slot: string): Promise<CredentialData | null>;
  /** Persist a credential's refreshed fields (OAuth2 tokens). */
  updateCredential?(id: string, data: Record<string, unknown>): Promise<void>;
  callWorkflow?(call: SubWorkflowCall): Promise<Item[]>;
  /** First Respond to Webhook (or the end of the run, per the webhook's mode) answers the caller. */
  respond?(response: HookResponse): void;
  sendEmail?(message: Record<string, unknown>, credential: CredentialData): Promise<Record<string, unknown>>;
  now(): number;
  sandboxLimits?: Partial<SandboxLimits>;
}

export interface ExecuteContext {
  node: WorkflowNode;
  meta: NodeMeta;
  workflow: Workflow;
  mode: RunMode;
  executionId: string;
  runIndex: number;
  /** Items per input index (a missing branch is an empty list). */
  inputs: Item[][];
  /** First input's items. */
  items: Item[];
  /** Trigger nodes: the items that started the run (webhook request, schedule tick, sub-workflow input). */
  triggerItems: Item[];
  /** Parameter `name` resolved for item `itemIndex` (expressions evaluated; the node meta's default when unset). */
  param<T = unknown>(name: string, itemIndex?: number): T;
  /** Parameter as stored, expressions not evaluated. */
  rawParam(name: string): unknown;
  /** Evaluates arbitrary expression code against item `itemIndex` (Filter/If conditions written as code). */
  evaluate(code: string, itemIndex: number): unknown;
  credential(slot: string): Promise<CredentialData>;
  optionalCredential(slot: string): Promise<CredentialData | null>;
  services: EngineServices;
  /** Fresh sandbox (Code node); the caller disposes it. */
  openSandbox(limits?: Partial<SandboxLimits>): Promise<Sandbox>;
  /** Data the injected sandbox prelude needs (the Code node passes the same `$` helpers to user code). */
  scopeData(): Promise<ScopeData>;
  /** Per-run state of this node (Loop Over Items keeps its queue here). */
  state: Record<string, unknown>;
  /** Persists across runs of the workflow (Remove Duplicates across runs, polling cursors). */
  staticData: Record<string, unknown>;
  /** Run-level custom data (Execution Data node), saved with the run. */
  customData: Record<string, string>;
  log(line: string): void;
  now(): number;
  tzOffsetMinutes: number;
  timezone: string;
  resumeUrl?: string;
  signal: AbortSignal;
  limits: EngineLimits;
}

export interface NodeOutcome {
  outputs: Item[][];
  wait?: WaitRequest;
  respond?: HookResponse;
  /** Stop the whole run as a success after this node (Respond to Webhook in some modes does not). */
  stop?: boolean;
}

export type NodeResult = Item[][] | NodeOutcome;

export interface NodeImpl {
  type: string;
  execute(ctx: ExecuteContext): Promise<NodeResult>;
}

export interface EngineLimits {
  /** Node executions per run (loops count each pass). */
  maxNodeRuns: number;
  /** Items in one node output. */
  maxItemsPerOutput: number;
  /** Approximate JSON bytes held in one node's output. */
  maxOutputBytes: number;
  /** Sub-workflow nesting. */
  maxDepth: number;
  /** HTTP body read cap. */
  maxHttpBytes: number;
}

export const DEFAULT_ENGINE_LIMITS: EngineLimits = {
  maxNodeRuns: 5000,
  maxItemsPerOutput: 50_000,
  maxOutputBytes: 64 * 1024 * 1024,
  maxDepth: 5,
  maxHttpBytes: 32 * 1024 * 1024,
};

/** An error a node raises on purpose; `message` is shown to the workflow's owner. */
export class NodeError extends Error {
  readonly description?: string;
  readonly httpCode?: number;
  readonly itemIndex?: number;
  constructor(message: string, options: { description?: string; httpCode?: number; itemIndex?: number } = {}) {
    super(message);
    this.name = "NodeError";
    this.description = options.description;
    this.httpCode = options.httpCode;
    this.itemIndex = options.itemIndex;
  }
}
