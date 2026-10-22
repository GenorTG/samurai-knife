/**
 * Workflow worker process (docs/WORKFLOWS.md "Rules"): one per run, started by src/lib/workflows/server/runner.ts with
 * Node's permission model (reads inside the app only, no writes, no child processes, no workers, no addons), a scrubbed
 * environment and a heap cap. Gets one `run` job over IPC, runs the engine with the workflow nodes and nothing else,
 * sends the result back and exits. It cannot open the account's files: the server passes what the run needs.
 */
import { randomBytes } from "node:crypto";
import { nodeMeta } from "../catalog/index";
import { NodeError, type BlobStore, type CredentialData, type EngineServices } from "../engine/node-api";
import { runWorkflow, type RunResult } from "../engine/run";
import { nodeImpl } from "../nodes/index";
import type { BinaryRef, Item } from "../types";
import { policyHttp, toOutboundPolicy } from "./http";
import { credentialKey, type BlobPayload, type FromWorker, type RunJob, type ToWorker } from "./protocol";

const send = (message: FromWorker): Promise<void> =>
  new Promise((resolve) => {
    if (!process.send) return resolve();
    process.send(message, undefined, {}, () => resolve());
  });

function blobStore(limit: number): BlobStore & { payloads(refs: Iterable<string>): BlobPayload[]; load(list: BlobPayload[]): void } {
  const blobs = new Map<string, { ref: BinaryRef; bytes: Uint8Array }>();
  let total = 0;
  return {
    put(bytes, meta) {
      total += bytes.byteLength;
      if (total > limit) throw new NodeError(`The run's files together exceed ${Math.round(limit / 1048576)} MB.`);
      const id = randomBytes(9).toString("hex");
      const fileName = meta.fileName?.slice(0, 200);
      const ref: BinaryRef = {
        id,
        mimeType: (meta.mimeType || "application/octet-stream").slice(0, 120),
        ...(fileName ? { fileName, fileExtension: fileName.includes(".") ? fileName.split(".").pop()?.toLowerCase().slice(0, 12) : undefined } : {}),
        fileSize: bytes.byteLength,
      };
      blobs.set(id, { ref, bytes });
      return ref;
    },
    get(ref) {
      const found = blobs.get(typeof ref === "string" ? ref : ref.id);
      if (!found) throw new NodeError("A file of this item is no longer available (files are kept for one run).");
      return found.bytes;
    },
    payloads(refs) {
      const out: BlobPayload[] = [];
      for (const id of refs) {
        const found = blobs.get(id);
        if (found) out.push({ ref: found.ref, bytes: found.bytes });
      }
      return out;
    },
    load(list) {
      for (const { ref, bytes } of list) {
        blobs.set(ref.id, { ref, bytes });
        total += bytes.byteLength;
      }
    },
  };
}

/** Ids of every file referenced by these items (deep: waiting state, sub-workflow calls). */
function blobIds(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const entry of value) blobIds(entry, out);
  else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.binary && typeof record.binary === "object") {
      for (const ref of Object.values(record.binary as Record<string, BinaryRef>)) if (ref && typeof ref.id === "string") out.add(ref.id);
    }
    for (const [key, entry] of Object.entries(record)) if (key !== "binary" && entry && typeof entry === "object") blobIds(entry, out);
  }
  return out;
}

const pendingCalls = new Map<number, { resolve: (items: Item[]) => void; reject: (error: Error) => void }>();
const controller = new AbortController();
let nextCall = 1;
let started = false;
let activeStore: ReturnType<typeof blobStore> | null = null;

async function run(job: RunJob): Promise<void> {
  const store = blobStore(job.maxBlobBytes);
  store.load(job.blobs);
  activeStore = store;
  const credentials = new Map<string, CredentialData>(Object.entries(job.credentials));
  const services: EngineServices = {
    http: policyHttp(toOutboundPolicy(job.policy), controller.signal),
    blobs: store,
    now: () => Date.now(),
    sandboxLimits: job.sandboxLimits,
    async credential(node, slot) {
      return credentials.get(credentialKey(node.name, slot)) ?? null;
    },
    async updateCredential(id, data) {
      for (const credential of credentials.values()) if (credential.id === id) Object.assign(credential.data, data);
      await send({ t: "credential-update", id, data });
    },
    callWorkflow(call) {
      const id = nextCall++;
      const blobs = store.payloads(blobIds(call.items));
      return new Promise<Item[]>((resolve, reject) => {
        pendingCalls.set(id, { resolve, reject });
        void send({ t: "call", id, call, blobs });
      });
    },
    respond(response) {
      void send({ t: "respond", response });
    },
    reportUsage(round) {
      void send({ t: "usage", ...round });
    },
  };
  let result: RunResult;
  try {
    result = await runWorkflow({
      workflow: job.workflow,
      mode: job.mode,
      executionId: job.executionId,
      startNode: job.startNode,
      destinationNode: job.destinationNode,
      triggerItems: job.triggerItems,
      resume: job.resume,
      meta: nodeMeta,
      impl: nodeImpl,
      services,
      limits: job.limits,
      staticData: job.staticData,
      vars: job.vars,
      resumeUrl: job.resumeUrl,
      timezone: job.timezone,
      tzOffsetMinutes: job.tzOffsetMinutes,
      signal: controller.signal,
      onNodeStart: job.progress ? (node) => void send({ t: "node-start", node }) : undefined,
      onNodeEnd: job.progress ? (node, nodeRun) => void send({ t: "node-end", node, run: { ms: nodeRun.ms, outputCounts: nodeRun.outputs.map((o) => o.length), ...(nodeRun.error ? { error: nodeRun.error } : {}) } }) : undefined,
    });
  } catch (error) {
    await send({ t: "fatal", message: error instanceof Error ? error.message : String(error) });
    return;
  }
  // Files the server may need afterwards: the waiting state (to resume) and the last node's items (webhook answer).
  const wanted = blobIds([result.waiting ?? null, result.lastItems ?? []]);
  await send({ t: "done", result, blobs: store.payloads(wanted) });
}

process.on("message", (message: ToWorker) => {
  if (message.t === "run" && !started) {
    started = true;
    void run(message.job).finally(() => {
      process.disconnect?.();
    });
  } else if (message.t === "call-result") {
    const pending = pendingCalls.get(message.id);
    if (!pending) return;
    pendingCalls.delete(message.id);
    if (message.blobs?.length) activeStore?.load(message.blobs);
    if (message.error) pending.reject(new NodeError(message.error));
    else pending.resolve(message.items ?? []);
  } else if (message.t === "cancel") {
    controller.abort(new Error("The run was stopped."));
  }
});

process.on("disconnect", () => {
  // The server went away: nothing can receive the result.
  controller.abort(new Error("The server stopped."));
  setTimeout(() => process.exit(0), 50).unref();
});
