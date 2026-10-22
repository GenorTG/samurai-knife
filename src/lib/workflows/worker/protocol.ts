/** Messages between the server and a workflow worker process (IPC, `serialization: "advanced"`: Buffers pass as is). */
import type { CredentialData, EngineLimits, SubWorkflowCall } from "../engine/node-api";
import type { WaitingState, RunResult } from "../engine/run";
import type { SandboxLimits } from "../sandbox/quickjs";
import type { BinaryRef, HookResponse, Item, NodeRun, RunMode, Workflow } from "../types";

export interface WorkerPolicy {
  allowPrivate: boolean;
  ports: string[] | null;
  httpsOnly: boolean;
}

export interface BlobPayload {
  ref: BinaryRef;
  bytes: Uint8Array;
}

export interface RunJob {
  workflow: Workflow;
  mode: RunMode;
  executionId: string;
  startNode?: string;
  destinationNode?: string;
  triggerItems?: Item[];
  resume?: { state: WaitingState; items?: Item[] };
  staticData: Record<string, Record<string, unknown>>;
  vars?: Record<string, string>;
  resumeUrl?: string;
  timezone: string;
  tzOffsetMinutes: number;
  /** `<node name>\u0000<slot>` -> the credential (opened by the server). */
  credentials: Record<string, CredentialData>;
  /** Files the trigger items or the waiting state refer to. */
  blobs: BlobPayload[];
  policy: WorkerPolicy;
  limits: Partial<EngineLimits>;
  sandboxLimits: Partial<SandboxLimits>;
  /** All files of the run together. */
  maxBlobBytes: number;
  /** Send per-node progress (editor runs). */
  progress: boolean;
}

export type ToWorker =
  | { t: "run"; job: RunJob }
  | { t: "call-result"; id: number; items?: Item[]; blobs?: BlobPayload[]; error?: string }
  | { t: "cancel" };

export interface NodeProgress {
  ms: number;
  outputCounts: number[];
  error?: NodeRun["error"];
}

export type FromWorker =
  | { t: "node-start"; node: string }
  | { t: "node-end"; node: string; run: NodeProgress }
  | { t: "respond"; response: HookResponse }
  | { t: "call"; id: number; call: SubWorkflowCall; blobs: BlobPayload[] }
  | { t: "credential-update"; id: string; data: Record<string, unknown> }
  | { t: "usage"; model: string; usage?: Record<string, unknown>; ms: number; failed: boolean }
  | { t: "done"; result: RunResult; blobs: BlobPayload[] }
  | { t: "fatal"; message: string };

export const credentialKey = (node: string, slot: string) => `${node}\u0000${slot}`;
