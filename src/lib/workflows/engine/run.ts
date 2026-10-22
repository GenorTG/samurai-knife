/**
 * The workflow executor (docs/WORKFLOWS.md "Model"). Pure: no storage, no network of its own; everything outside the run
 * comes through `EngineServices`. Order: from the start node, depth-first, a node's successors ordered by their canvas
 * position (top, then left); a node with several inputs (Merge) waits until each input has data, or runs with what it
 * has once nothing else is left to run. A node whose output is empty does not start its successors (unless the node is
 * set to always output data). A Wait node suspends the run: the state needed to continue is returned as `waiting`.
 */
import { ExpressionScope, expressionCodes, nodeReferences, type ScopeData } from "./expressions";
import {
  DEFAULT_ENGINE_LIMITS,
  NodeError,
  type EngineLimits,
  type EngineServices,
  type ExecuteContext,
  type NodeImpl,
  type NodeOutcome,
  type NodeResult,
} from "./node-api";
import { openSandbox } from "../sandbox/quickjs";
import type { Connection, Item, NodeMeta, NodeParam, NodeRun, RunError, RunMode, RunStatus, Workflow, WorkflowNode } from "../types";

interface PendingExec {
  node: string;
  inputs: (Item[] | null)[];
  source?: { node: string; output: number };
}

/** Everything needed to continue a suspended run (JSON-safe). */
export interface WaitingState {
  waitNode: string;
  waitOutputs: Item[][];
  stack: PendingExec[];
  partial: [string, (Item[] | null)[]][];
  runData: Record<string, NodeRun[]>;
  nodeState: Record<string, Record<string, unknown>>;
  customData: Record<string, string>;
  nodeRuns: number;
  until?: number;
  webhook?: boolean;
  destinationNode?: string;
  startNode: string;
}

export interface RunRequest {
  workflow: Workflow;
  mode: RunMode;
  executionId: string;
  /** Trigger to start from (default: the Manual Trigger, else the first trigger). */
  startNode?: string;
  triggerItems?: Item[];
  /** Run only what leads to this node (editor "run up to here"). */
  destinationNode?: string;
  resume?: { state: WaitingState; items?: Item[] };
  meta(type: string): NodeMeta | undefined;
  impl(type: string): NodeImpl | undefined;
  services: EngineServices;
  limits?: Partial<EngineLimits>;
  staticData?: Record<string, Record<string, unknown>>;
  vars?: Record<string, string>;
  resumeUrl?: string;
  timezone?: string;
  tzOffsetMinutes?: number;
  signal?: AbortSignal;
  onNodeStart?(name: string): void;
  onNodeEnd?(name: string, run: NodeRun): void;
}

export interface RunResult {
  status: RunStatus;
  error?: RunError;
  runData: Record<string, NodeRun[]>;
  lastNode?: string;
  lastItems?: Item[];
  waiting?: WaitingState;
  customData: Record<string, string>;
  staticData: Record<string, Record<string, unknown>>;
  startNode?: string;
}

class RunStop extends Error {
  readonly status: RunStatus;
  readonly runError?: RunError;
  constructor(status: RunStatus, runError?: RunError) {
    super(runError?.message ?? status);
    this.status = status;
    this.runError = runError;
  }
}

function paramDefault(params: NodeParam[], name: string): unknown {
  const found = params.find((param) => param.name === name);
  return found?.default;
}

function normalizeItems(value: unknown, nodeName: string): Item[] {
  if (!Array.isArray(value)) throw new NodeError(`Node "${nodeName}" returned something that is not a list of items.`);
  return value.map((entry, index) => {
    if (entry && typeof entry === "object" && "json" in entry && entry.json && typeof entry.json === "object" && !Array.isArray(entry.json)) {
      return entry as Item;
    }
    if (entry && typeof entry === "object" && !Array.isArray(entry)) return { json: entry as Item["json"], pairedItem: index };
    return { json: { value: entry as unknown }, pairedItem: index };
  });
}

function toOutcome(result: NodeResult): NodeOutcome {
  return Array.isArray(result) ? { outputs: result } : result;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Approximate JSON size of items (binary bytes are not inline). */
function sizeOf(items: Item[]): number {
  let total = 0;
  for (const item of items) total += JSON.stringify(item.json)?.length ?? 0;
  return total;
}

export function findStartNode(workflow: Workflow, meta: (type: string) => NodeMeta | undefined, wanted?: string): WorkflowNode | null {
  if (wanted) return workflow.nodes.find((node) => node.name === wanted) ?? null;
  const triggers = workflow.nodes.filter((node) => !node.disabled && meta(node.type)?.inputs === 0);
  return triggers.find((node) => meta(node.type)?.trigger === "manual") ?? triggers[0] ?? null;
}

export async function runWorkflow(request: RunRequest): Promise<RunResult> {
  const { workflow, services } = request;
  const limits: EngineLimits = { ...DEFAULT_ENGINE_LIMITS, ...request.limits };
  const signal = request.signal ?? new AbortController().signal;
  const byName = new Map(workflow.nodes.map((node) => [node.name, node]));
  const outgoing = new Map<string, Connection[]>();
  const incoming = new Map<string, Connection[]>();
  for (const connection of workflow.connections) {
    if (!byName.has(connection.from.node) || !byName.has(connection.to.node)) continue;
    outgoing.set(connection.from.node, [...(outgoing.get(connection.from.node) ?? []), connection]);
    incoming.set(connection.to.node, [...(incoming.get(connection.to.node) ?? []), connection]);
  }
  const inputCount = (node: WorkflowNode): number => {
    const declared = request.meta(node.type)?.inputs ?? 1;
    const wired = Math.max(-1, ...(incoming.get(node.name) ?? []).map((c) => c.to.input)) + 1;
    return Math.max(declared, wired, 1);
  };

  const staticData = structuredClone(request.staticData ?? {});
  let runData: Record<string, NodeRun[]> = {};
  let nodeState: Record<string, Record<string, unknown>> = {};
  let customData: Record<string, string> = {};
  let stack: PendingExec[] = [];
  let partial = new Map<string, (Item[] | null)[]>();
  let nodeRuns = 0;
  let lastNode: string | undefined;
  let lastItems: Item[] | undefined;
  let startName: string;
  let destination = request.destinationNode;

  // Nodes that lead to the destination (partial runs only).
  let toward: Set<string> | null = null;
  const computeToward = () => {
    if (!destination) return null;
    const set = new Set<string>([destination]);
    const queue = [destination];
    while (queue.length) {
      const name = queue.pop() as string;
      for (const connection of incoming.get(name) ?? []) {
        if (!set.has(connection.from.node)) {
          set.add(connection.from.node);
          queue.push(connection.from.node);
        }
      }
    }
    return set;
  };

  const enqueueSuccessors = (from: WorkflowNode, outputs: Item[][]) => {
    if (destination && from.name === destination) return;
    const next: { exec: PendingExec | null; target: WorkflowNode; connection: Connection; items: Item[] }[] = [];
    for (const connection of outgoing.get(from.name) ?? []) {
      const items = outputs[connection.from.output];
      if (!items || (!items.length && !from.alwaysOutputData)) continue;
      const target = byName.get(connection.to.node);
      if (!target) continue;
      if (toward && !toward.has(target.name)) continue;
      next.push({ exec: null, target, connection, items });
    }
    next.sort((a, b) => a.target.position[1] - b.target.position[1] || a.target.position[0] - b.target.position[0]);
    const ready: PendingExec[] = [];
    for (const entry of next) {
      const count = inputCount(entry.target);
      const source = { node: from.name, output: entry.connection.from.output };
      if (count <= 1) {
        ready.push({ node: entry.target.name, inputs: [entry.items], source });
        continue;
      }
      let slots = partial.get(entry.target.name);
      if (slots && slots[entry.connection.to.input] !== null) {
        // The same input fired again before the others: run what was collected, start collecting anew.
        partial.delete(entry.target.name);
        ready.push({ node: entry.target.name, inputs: slots.map((slot) => slot ?? []), source });
        slots = undefined;
      }
      slots ??= Array.from({ length: count }, () => null);
      slots[entry.connection.to.input] = entry.items;
      if (slots.every((slot) => slot !== null)) {
        partial.delete(entry.target.name);
        ready.push({ node: entry.target.name, inputs: slots, source });
      } else {
        partial.set(entry.target.name, slots);
      }
    }
    for (let index = ready.length - 1; index >= 0; index -= 1) stack.push(ready[index]);
  };

  if (request.resume) {
    const state = request.resume.state;
    runData = state.runData;
    nodeState = state.nodeState;
    customData = state.customData;
    stack = state.stack;
    partial = new Map(state.partial);
    nodeRuns = state.nodeRuns;
    startName = state.startNode;
    destination = state.destinationNode;
    toward = computeToward();
    const waitNode = byName.get(state.waitNode);
    if (!waitNode) return { status: "error", error: { message: `The waiting node "${state.waitNode}" is no longer in the workflow.` }, runData, customData, staticData };
    const outputs = request.resume.items ? [request.resume.items] : state.waitOutputs;
    const runs = runData[waitNode.name];
    if (runs?.length) runs[runs.length - 1] = { ...runs[runs.length - 1], outputs };
    lastNode = waitNode.name;
    lastItems = outputs[0];
    enqueueSuccessors(waitNode, outputs);
  } else {
    const start = findStartNode(workflow, request.meta, request.startNode);
    if (!start) return { status: "error", error: { message: "The workflow has no trigger to start from." }, runData, customData, staticData };
    startName = start.name;
    toward = computeToward();
    stack.push({ node: start.name, inputs: [request.triggerItems ?? [{ json: {} }]] });
  }

  const outputsOf = (name: string): Item[] | undefined => {
    const runs = runData[name];
    const latest = runs?.[runs.length - 1];
    return latest?.outputs.find((output) => output.length) ?? latest?.outputs[0];
  };

  const runNode = async (node: WorkflowNode, inputs: Item[][], source?: PendingExec["source"]): Promise<{ outcome: NodeOutcome; logs: string[] }> => {
    const meta = request.meta(node.type);
    const impl = request.impl(node.type);
    if (!meta || !impl) throw new NodeError(`Unknown node type "${node.type}".`);
    const runIndex = runData[node.name]?.length ?? 0;
    const logs: string[] = [];
    const items = inputs[0] ?? [];

    const scopeData = (): ScopeData => {
      const refs = nodeReferences(JSON.stringify(node.parameters));
      const names = refs.dynamic ? Object.keys(runData) : [...refs.names];
      const nodes: ScopeData["nodes"] = {};
      for (const name of names) {
        const out = outputsOf(name);
        const other = byName.get(name);
        if (out) nodes[name] = { items: out, params: other?.parameters };
      }
      return {
        items,
        nodes,
        meta: {
          now: services.now(),
          tzOffset: request.tzOffsetMinutes ?? 0,
          runIndex,
          workflow: { id: workflow.id, name: workflow.name, active: workflow.active },
          execution: { id: request.executionId, mode: request.mode, resumeUrl: request.resumeUrl, customData },
          vars: request.vars,
          prevNode: source ? { name: source.node, outputIndex: source.output, runIndex: Math.max(0, (runData[source.node]?.length ?? 1) - 1) } : undefined,
          params: node.parameters,
        },
      };
    };

    let scope: ExpressionScope | null = null;
    const needsScope = expressionCodes(node.parameters).length > 0;
    if (needsScope) scope = await ExpressionScope.open(scopeData(), services.sandboxLimits);
    const resolveRaw = (name: string): unknown => (name in node.parameters ? node.parameters[name] : paramDefault(meta.params, name));
    const ctx: ExecuteContext = {
      node,
      meta,
      workflow,
      mode: request.mode,
      executionId: request.executionId,
      runIndex,
      inputs,
      items: node.executeOnce ? items.slice(0, 1) : items,
      triggerItems: request.triggerItems ?? [{ json: {} }],
      param: <T,>(name: string, itemIndex = 0) => {
        const raw = resolveRaw(name);
        return (scope ? scope.resolve(raw, itemIndex, `"${name}"`) : raw) as T;
      },
      rawParam: resolveRaw,
      evaluate: (code: string, itemIndex: number) => {
        if (!scope) throw new NodeError("Expressions are not available here.");
        return scope.evaluate(code, itemIndex);
      },
      credential: async (slot) => {
        const found = await services.credential(node, slot);
        if (!found) throw new NodeError(`Node "${node.name}" needs a credential for "${slot}".`, { description: "Choose one in the node's settings (Credentials)." });
        return found;
      },
      optionalCredential: (slot) => services.credential(node, slot),
      services,
      openSandbox: (overrides) => openSandbox({ ...services.sandboxLimits, ...overrides }),
      scopeData: async () => scopeData(),
      state: (nodeState[node.name] ??= {}),
      staticData: (staticData[node.name] ??= {}),
      customData,
      log: (line) => {
        if (logs.length < 200) logs.push(String(line).slice(0, 2000));
      },
      now: () => services.now(),
      tzOffsetMinutes: request.tzOffsetMinutes ?? 0,
      timezone: request.timezone ?? "UTC",
      resumeUrl: request.resumeUrl,
      signal,
      limits,
    };
    try {
      const outcome = toOutcome(await impl.execute(ctx));
      outcome.outputs = outcome.outputs.map((output) => normalizeItems(output, node.name));
      return { outcome, logs: scope ? [...logs, ...scope.logs] : logs };
    } finally {
      scope?.dispose();
    }
  };

  const fail = (node: WorkflowNode, error: unknown): RunError => {
    const message = error instanceof Error ? error.message : String(error);
    const runError: RunError = { message, node: node.name };
    if (error instanceof NodeError) {
      if (error.description) runError.description = error.description;
      if (error.httpCode) runError.httpCode = error.httpCode;
    }
    return runError;
  };

  try {
    for (;;) {
      if (signal.aborted) throw new RunStop("canceled", { message: "The run was stopped." });
      let exec = stack.pop();
      if (!exec) {
        const first = partial.entries().next();
        if (first.done) break;
        partial.delete(first.value[0]);
        exec = { node: first.value[0], inputs: first.value[1] };
      }
      const node = byName.get(exec.node);
      if (!node) continue;
      nodeRuns += 1;
      if (nodeRuns > limits.maxNodeRuns) {
        throw new RunStop("error", { message: `The run executed more than ${limits.maxNodeRuns} nodes (a loop that never ends?).`, node: node.name });
      }
      const inputs = exec.inputs.map((slot) => slot ?? []);
      const startedAt = services.now();
      request.onNodeStart?.(node.name);
      let outcome: NodeOutcome;
      let logs: string[] = [];
      let error: RunError | undefined;
      const outputsCount = (() => {
        const meta = request.meta(node.type);
        return meta ? (typeof meta.outputs === "function" ? meta.outputs(node.parameters) : meta.outputs).length : 1;
      })();
      if (node.disabled) {
        outcome = { outputs: [inputs[0] ?? []] };
      } else {
        const tries = node.retryOnFail ? Math.max(1, node.maxTries ?? 3) : 1;
        let attempt = 0;
        for (;;) {
          attempt += 1;
          try {
            const result = await runNode(node, inputs, exec.source);
            outcome = result.outcome;
            logs = result.logs;
            break;
          } catch (caught) {
            if (signal.aborted) throw new RunStop("canceled", { message: "The run was stopped." });
            if (attempt < tries) {
              await sleep(node.waitBetweenTries ?? 1000, signal);
              continue;
            }
            error = fail(node, caught);
            const onError = node.onError ?? "stop";
            if (onError === "stop") {
              const run: NodeRun = { startedAt, ms: services.now() - startedAt, inputCounts: inputs.map((i) => i.length), outputs: [], error, logs };
              (runData[node.name] ??= []).push(run);
              request.onNodeEnd?.(node.name, run);
              lastNode = node.name;
              throw new RunStop("error", error);
            }
            const errored = (inputs[0]?.length ? inputs[0] : [{ json: {} }]).map((item, index) => ({ json: { ...item.json, error: error?.message }, pairedItem: index, error: { message: error?.message ?? "" } }));
            outcome = onError === "continue" ? { outputs: [errored] } : { outputs: [...Array.from({ length: outputsCount }, () => []), errored] };
            break;
          }
        }
      }
      // TypeScript cannot see that every branch above assigns `outcome`.
      const done = outcome!;
      for (const output of done.outputs) {
        if (output.length > limits.maxItemsPerOutput) {
          throw new RunStop("error", { message: `Node "${node.name}" produced ${output.length} items (limit ${limits.maxItemsPerOutput}).`, node: node.name });
        }
      }
      const bytes = done.outputs.reduce((sum, output) => sum + sizeOf(output), 0);
      if (bytes > limits.maxOutputBytes) {
        throw new RunStop("error", { message: `Node "${node.name}" produced about ${Math.round(bytes / 1048576)} MB of data (limit ${Math.round(limits.maxOutputBytes / 1048576)} MB).`, node: node.name });
      }
      const run: NodeRun = { startedAt, ms: services.now() - startedAt, inputCounts: inputs.map((i) => i.length), outputs: done.outputs, ...(error ? { error } : {}), ...(logs.length ? { logs } : {}) };
      (runData[node.name] ??= []).push(run);
      request.onNodeEnd?.(node.name, run);
      lastNode = node.name;
      lastItems = done.outputs[0];
      if (done.respond) services.respond?.(done.respond);
      if (done.wait) {
        return {
          status: "waiting",
          runData,
          lastNode,
          lastItems,
          customData,
          staticData,
          startNode: startName,
          waiting: {
            waitNode: node.name,
            waitOutputs: done.outputs,
            stack,
            partial: [...partial.entries()],
            runData,
            nodeState,
            customData,
            nodeRuns,
            until: done.wait.until,
            webhook: done.wait.webhook,
            destinationNode: destination,
            startNode: startName,
          },
        };
      }
      if (done.stop) break;
      enqueueSuccessors(node, done.outputs);
    }
  } catch (caught) {
    if (caught instanceof RunStop) {
      return { status: caught.status, error: caught.runError, runData, lastNode, lastItems, customData, staticData, startNode: startName };
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    return { status: "error", error: { message }, runData, lastNode, lastItems, customData, staticData, startNode: startName };
  }
  return { status: "success", runData, lastNode, lastItems, customData, staticData, startNode: startName };
}
