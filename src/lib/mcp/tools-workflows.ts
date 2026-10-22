import * as z from "zod/v4";
import { defineTool, type KnifeToolContext, type KnifeToolDefinition } from "./define";
import { NODE_CATALOG, nodeMeta } from "@/lib/workflows/catalog/index";
import { credentialType } from "@/lib/workflows/credential-types";
import { newNodeId, renameNode, uniqueName } from "@/lib/workflows/editor-model";
import { hookUrls } from "@/lib/workflows/server/hooks";
import { RunRefusedError, startRun } from "@/lib/workflows/server/runner";
import { createWorkflow, deleteWorkflow, getRun, listCredentials, listRuns, listWorkflows, requireWorkflow, saveWorkflow, WorkflowStoreError } from "@/lib/workflows/server/store";
import { type Connection, type Item, type NodeMeta, type NodeParam, type Workflow, type WorkflowNode } from "@/lib/workflows/types";
import { activationProblems, structuralProblems } from "@/lib/workflows/validate";
import { QuotaExceededError } from "@/lib/storage/quota";
import { wrapUntrustedStrings } from "@/lib/security/untrusted";

/**
 * Workflow tools (group `workflows`, docs/WORKFLOWS.md): read the node catalog, list / read / build / edit / activate /
 * run workflows of the calling account, read run results. The user sees changes live in an open editor (it reloads
 * when the stored version moves on). Credentials are listed by id and name only: secrets are entered by the user in the
 * Credentials tab, never through these tools. Deleting a workflow or removing nodes is destructive (confirmed).
 */

const ID = z.string().regex(/^[a-z0-9]{8,24}$/, "expected a workflow id from knife_workflow_list");
const RUN_ID = z.string().regex(/^[0-9a-f]{16}$/, "expected a run id from knife_workflow_runs");

function account(ctx: KnifeToolContext | undefined): string {
  if (!ctx?.accountId) throw new Error("Workflow tools need an account context.");
  return ctx.accountId;
}

async function guarded<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof WorkflowStoreError) throw new Error(error.details ? `${error.message} (${JSON.stringify(error.details).slice(0, 600)})` : error.message);
    if (error instanceof RunRefusedError || error instanceof QuotaExceededError) throw new Error(error.message);
    throw error;
  }
}

const typeName = (type: string) => (type.startsWith("core.") ? type : `core.${type}`);

function paramSummary(param: NodeParam): Record<string, unknown> {
  return {
    name: param.name,
    type: param.type,
    label: param.label,
    ...(param.default !== undefined ? { default: param.default } : {}),
    ...(param.options ? { options: param.options.map((option) => option.value) } : {}),
    ...(param.showIf ? { showIf: param.showIf } : {}),
    ...(param.description ? { description: param.description } : {}),
    ...(param.fields ? { fields: param.fields.map(paramSummary) } : {}),
    ...(param.required ? { required: true } : {}),
  };
}

function nodeSummary(meta: NodeMeta) {
  return { type: meta.type, label: meta.label, ...(meta.alias ? { n8nName: meta.alias } : {}), group: meta.group, description: meta.description, inputs: meta.inputs, outputs: typeof meta.outputs === "function" ? "depends on parameters" : meta.outputs, ...(meta.trigger ? { trigger: meta.trigger } : {}) };
}

const agentNode = z.object({
  name: z.string().trim().min(1).max(80),
  type: z.string().min(2).max(64),
  parameters: z.record(z.string(), z.unknown()).optional(),
  credentials: z.record(z.string(), z.string().max(40)).optional(),
  position: z.tuple([z.number(), z.number()]).optional(),
  disabled: z.boolean().optional(),
  notes: z.string().max(4000).optional(),
  retryOnFail: z.boolean().optional(),
  maxTries: z.number().int().min(1).max(10).optional(),
  waitBetweenTries: z.number().int().min(0).max(60000).optional(),
  onError: z.enum(["stop", "continue", "errorOutput"]).optional(),
  alwaysOutputData: z.boolean().optional(),
  executeOnce: z.boolean().optional(),
});

const agentConnection = z.object({ from: z.string().min(1).max(80), to: z.string().min(1).max(80), output: z.number().int().min(0).max(63).optional(), input: z.number().int().min(0).max(7).optional() });

type AgentNode = z.infer<typeof agentNode>;

function toConnections(list: z.infer<typeof agentConnection>[]): Connection[] {
  return list.map((c) => ({ from: { node: c.from, output: c.output ?? 0 }, to: { node: c.to, input: c.input ?? 0 } }));
}

/** Gives agent-written nodes what the model needs (id, type prefix, version) and places unplaced ones by depth. */
function toNodes(list: AgentNode[], connections: Connection[], existing: WorkflowNode[] = []): { nodes: WorkflowNode[]; warnings: string[] } {
  const warnings: string[] = [];
  const nodes: WorkflowNode[] = list.map((entry) => {
    const type = typeName(entry.type);
    const meta = nodeMeta(type);
    if (!meta) throw new Error(`Unknown node type "${entry.type}". Call knife_workflow_nodes for the list.`);
    const known = new Set(meta.params.map((param) => param.name));
    for (const name of Object.keys(entry.parameters ?? {})) if (!known.has(name)) warnings.push(`${entry.name}: "${name}" is not a parameter of ${meta.label} (known: ${[...known].join(", ") || "none"}).`);
    for (const slot of Object.keys(entry.credentials ?? {})) if (!(meta.credentials ?? []).some((s) => s.name === slot)) warnings.push(`${entry.name}: "${slot}" is not a credential slot of ${meta.label}.`);
    const previous = existing.find((node) => node.name === entry.name);
    const { position, ...rest } = entry;
    return { ...rest, id: previous?.id ?? newNodeId(), type, typeVersion: meta.version ?? 1, parameters: entry.parameters ?? {}, position: position ?? previous?.position ?? [Number.NaN, Number.NaN] } as WorkflowNode;
  });
  // Unplaced nodes: column = distance from a trigger, row = order in the column.
  const depth = new Map<string, number>();
  const queue = nodes.filter((node) => (nodeMeta(node.type)?.inputs ?? 1) === 0).map((node) => node.name);
  for (const name of queue) depth.set(name, 0);
  while (queue.length) {
    const name = queue.shift() as string;
    for (const c of connections) {
      if (c.from.node === name && !depth.has(c.to.node)) {
        depth.set(c.to.node, (depth.get(name) ?? 0) + 1);
        queue.push(c.to.node);
      }
    }
  }
  const rows = new Map<number, number>();
  for (const node of nodes) {
    if (Number.isFinite(node.position[0])) continue;
    const column = depth.get(node.name) ?? Math.max(0, ...depth.values()) + 1;
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    node.position = [column * 260, row * 140];
  }
  return { nodes, warnings };
}

function workflowView(workflow: Workflow) {
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    active: workflow.active,
    version: workflow.version,
    settings: workflow.settings,
    // Ids and type versions are the editor's business; agents address nodes by name.
    nodes: workflow.nodes.map((node) => Object.fromEntries(Object.entries(node).filter(([key]) => key !== "id" && key !== "typeVersion"))),
    connections: workflow.connections.map((c) => ({ from: c.from.node, output: c.from.output, to: c.to.node, input: c.to.input })),
    webhooks: hookUrls(workflow),
  };
}

function checkResult(workflow: Workflow, warnings: string[]) {
  const activation = workflow.active ? [] : activationProblems(workflow).map((p) => p.message);
  return { id: workflow.id, version: workflow.version, active: workflow.active, ...(warnings.length ? { warnings } : {}), ...(activation.length ? { notActivatableYet: activation } : {}), webhooks: hookUrls(workflow) };
}

function itemsJson(items: Item[] | undefined, max: number) {
  return (items ?? []).slice(0, max).map((item) => (item.binary ? { ...item.json, _files: Object.fromEntries(Object.entries(item.binary).map(([key, ref]) => [key, `${ref.fileName ?? "file"} (${ref.mimeType}, ${ref.fileSize} bytes)`])) } : item.json));
}

export const WORKFLOW_KNIFE_TOOLS: KnifeToolDefinition[] = [
  defineTool({
    name: "knife_workflow_nodes",
    scope: "pure",
    effect: "read",
    description:
      "The workflow node catalog (n8n-style): without `type`, every node type (type, label, n8n name, group, description, inputs, outputs); with `type` (e.g. 'core.http-request' or 'http-request'), its parameters (name, type, default, options, showIf conditions, nested fields) and credential slots. Read a node's parameters before writing them. Parameters starting with '=' are expressions: '={{ $json.field }}', '=Hello {{ $json.name }}', '={{ $(\"Node name\").item.json.x }}', '={{ $now.toFormat(\"yyyy-MM-dd\") }}'.",
    schema: z.object({ type: z.string().max(64).optional(), query: z.string().max(80).optional() }).strict(),
    run({ type, query }) {
      if (type) {
        const meta = nodeMeta(typeName(type));
        if (!meta) throw new Error(`Unknown node type "${type}".`);
        return {
          ...nodeSummary(meta),
          ...(typeof meta.outputs === "function" ? { outputsNote: "Switch: one output per rule (+ Fallback when options.fallbackOutput = 'extra'), or numberOutputs in expression mode." } : {}),
          parameters: meta.params.map(paramSummary),
          credentials: (meta.credentials ?? []).map((slot) => ({ slot: slot.name, label: slot.label, types: slot.types, ...(slot.showIf ? { showIf: slot.showIf } : {}) })),
        };
      }
      const q = query?.trim().toLowerCase();
      return { nodes: NODE_CATALOG.filter((meta) => !q || `${meta.label} ${meta.alias ?? ""} ${meta.keywords?.join(" ") ?? ""} ${meta.description}`.toLowerCase().includes(q)).map(nodeSummary) };
    },
  }),
  defineTool({
    name: "knife_workflow_list",
    scope: "account",
    effect: "read",
    description: "List the user's workflows: id, name, active, node count, trigger kinds, last update (newest first).",
    schema: z.object({}).strict(),
    run(_input, ctx) {
      return guarded(() => ({ workflows: listWorkflows(account(ctx)) }));
    },
  }),
  defineTool({
    name: "knife_workflow_get",
    scope: "account",
    effect: "read",
    description: "Read one workflow: nodes (name, type, parameters, credentials, settings), connections (from/output -> to/input by node name), settings, version, active, and its webhook base URLs (production / test; add the Webhook node's path).",
    schema: z.object({ id: ID }).strict(),
    run({ id }, ctx) {
      return guarded(() => workflowView(requireWorkflow(account(ctx), id)));
    },
  }),
  defineTool({
    name: "knife_workflow_create",
    scope: "account",
    effect: "write",
    description:
      "Create a workflow from nodes and connections. Nodes: {name (unique), type (from knife_workflow_nodes), parameters?, credentials? {slot: credentialId}, position? [x,y] (placed automatically when left out), onError?, retryOnFail?, disabled?}. Connections: {from, to, output? (0), input? (0)} by node name (If: output 0 true / 1 false; Merge: input 0 / 1; Loop Over Items: output 0 done / 1 loop). Start with a trigger (core.manual-trigger to run it by hand, core.schedule-trigger, core.webhook). Returns the id, warnings about unknown parameters, and what still keeps it from being activated.",
    schema: z.object({ name: z.string().trim().min(1).max(120), description: z.string().max(4000).optional(), nodes: z.array(agentNode).max(300).default([]), connections: z.array(agentConnection).max(1000).default([]), settings: z.record(z.string(), z.unknown()).optional() }).strict(),
    run({ name, description, nodes, connections, settings }, ctx) {
      return guarded(() => {
        const links = toConnections(connections);
        const built = toNodes(nodes, links);
        const workflow = createWorkflow(account(ctx), { name, description, nodes: built.nodes, connections: links, settings });
        return checkResult(workflow, built.warnings);
      });
    },
  }),
  defineTool({
    name: "knife_workflow_edit",
    scope: "account",
    effect: "write",
    description:
      "Edit a workflow in small steps (applied in order, saved once): {op:'add', node:{…same as create}, after?: node name, output?: n} adds a node (connected from `after` when given); {op:'set', node: name, parameters?: {…merged into the node's parameters; null removes one}, rename?, credentials?, disabled?, onError?, retryOnFail?, notes?}; {op:'connect', from, to, output?, input?}; {op:'disconnect', from, to, output?, input?}. Also name/description/settings changes. Pass `version` from knife_workflow_get to refuse if the user saved meanwhile. Removing nodes: knife_workflow_remove_nodes.",
    schema: z.object({
      id: ID,
      version: z.number().int().min(1).optional(),
      name: z.string().trim().min(1).max(120).optional(),
      description: z.string().max(4000).optional(),
      settings: z.record(z.string(), z.unknown()).optional(),
      ops: z
        .array(
          z.discriminatedUnion("op", [
            z.object({ op: z.literal("add"), node: agentNode, after: z.string().max(80).optional(), output: z.number().int().min(0).max(63).optional() }),
            z.object({
              op: z.literal("set"),
              node: z.string().max(80),
              parameters: z.record(z.string(), z.unknown()).optional(),
              rename: z.string().trim().min(1).max(80).optional(),
              credentials: z.record(z.string(), z.string().max(40).nullable()).optional(),
              disabled: z.boolean().optional(),
              onError: z.enum(["stop", "continue", "errorOutput"]).optional(),
              retryOnFail: z.boolean().optional(),
              notes: z.string().max(4000).optional(),
            }),
            z.object({ op: z.literal("connect"), from: z.string().max(80), to: z.string().max(80), output: z.number().int().min(0).max(63).optional(), input: z.number().int().min(0).max(7).optional() }),
            z.object({ op: z.literal("disconnect"), from: z.string().max(80), to: z.string().max(80), output: z.number().int().min(0).max(63).optional(), input: z.number().int().min(0).max(7).optional() }),
          ]),
        )
        .max(100)
        .default([]),
    }).strict(),
    run({ id, version, name, description, settings, ops }, ctx) {
      return guarded(async () => {
        const accountId = account(ctx);
        const current = requireWorkflow(accountId, id);
        if (version !== undefined && version !== current.version) throw new Error(`The workflow is at version ${current.version} now (the user or another agent saved it). Read it again with knife_workflow_get.`);
        let nodes = current.nodes.map((node) => ({ ...node, parameters: { ...node.parameters } }));
        let connections = [...current.connections];
        const warnings: string[] = [];
        const find = (nodeName: string) => {
          const found = nodes.find((node) => node.name === nodeName);
          if (!found) throw new Error(`No node named "${nodeName}" (nodes: ${nodes.map((n) => n.name).join(", ")}).`);
          return found;
        };
        for (const op of ops) {
          if (op.op === "add") {
            const taken = nodes.map((n) => n.name);
            const entry = { ...op.node, name: uniqueName(op.node.name, taken) };
            if (entry.name !== op.node.name) warnings.push(`A node "${op.node.name}" exists already; the new one is "${entry.name}".`);
            const link: Connection[] = op.after ? [{ from: { node: find(op.after).name, output: op.output ?? 0 }, to: { node: entry.name, input: 0 } }] : [];
            const built = toNodes([entry], link, []);
            warnings.push(...built.warnings);
            const added = built.nodes[0];
            if (!op.node.position) {
              const anchor = op.after ? find(op.after) : nodes[nodes.length - 1];
              added.position = anchor ? [anchor.position[0] + 260, anchor.position[1] + (op.output ?? 0) * 140] : [0, 0];
            }
            nodes = [...nodes, added];
            connections = [...connections, ...link];
          } else if (op.op === "set") {
            const node = find(op.node);
            const meta = nodeMeta(node.type);
            if (op.parameters) {
              for (const [key, value] of Object.entries(op.parameters)) {
                if (meta && !meta.params.some((param) => param.name === key)) warnings.push(`${node.name}: "${key}" is not a parameter of ${meta.label}.`);
                if (value === null) delete node.parameters[key];
                else node.parameters[key] = value;
              }
            }
            if (op.credentials) {
              const next = { ...(node.credentials ?? {}) };
              for (const [slot, value] of Object.entries(op.credentials)) {
                if (value === null) delete next[slot];
                else next[slot] = value;
              }
              node.credentials = next;
            }
            for (const key of ["disabled", "onError", "retryOnFail", "notes"] as const) if (op[key] !== undefined) (node as Record<string, unknown>)[key] = op[key];
            if (op.rename && op.rename !== node.name) {
              if (nodes.some((n) => n.name === op.rename)) throw new Error(`A node is already named "${op.rename}".`);
              const renamed = renameNode(nodes, connections, node.name, op.rename);
              nodes = renamed.nodes;
              connections = renamed.connections;
            }
          } else if (op.op === "connect") {
            find(op.from);
            find(op.to);
            const link = { from: { node: op.from, output: op.output ?? 0 }, to: { node: op.to, input: op.input ?? 0 } };
            if (!connections.some((c) => c.from.node === link.from.node && c.from.output === link.from.output && c.to.node === link.to.node && c.to.input === link.to.input)) connections.push(link);
          } else {
            const before = connections.length;
            connections = connections.filter((c) => !(c.from.node === op.from && c.to.node === op.to && (op.output === undefined || c.from.output === op.output) && (op.input === undefined || c.to.input === op.input)));
            if (connections.length === before) warnings.push(`No connection ${op.from} -> ${op.to} to remove.`);
          }
        }
        const problems = structuralProblems({ nodes, connections });
        if (problems.length) throw new Error(`Not saved: ${problems.map((p) => p.message).join(" ")}`);
        const saved = saveWorkflow(accountId, id, current.version, { name, description, nodes, connections, ...(settings ? { settings: { ...current.settings, ...settings } } : {}) });
        return checkResult(saved, warnings);
      });
    },
  }),
  defineTool({
    name: "knife_workflow_remove_nodes",
    scope: "account",
    effect: "destructive",
    description: "Remove nodes (by name) from a workflow, with their connections. The user confirms.",
    schema: z.object({ id: ID, nodes: z.array(z.string().max(80)).min(1).max(100), version: z.number().int().min(1).optional() }).strict(),
    run({ id, nodes: names, version }, ctx) {
      return guarded(() => {
        const accountId = account(ctx);
        const current = requireWorkflow(accountId, id);
        if (version !== undefined && version !== current.version) throw new Error(`The workflow is at version ${current.version} now; read it again.`);
        const missing = names.filter((name) => !current.nodes.some((node) => node.name === name));
        if (missing.length) throw new Error(`No node named ${missing.map((m) => `"${m}"`).join(", ")}.`);
        const drop = new Set(names);
        const saved = saveWorkflow(accountId, id, current.version, { nodes: current.nodes.filter((node) => !drop.has(node.name)), connections: current.connections.filter((c) => !drop.has(c.from.node) && !drop.has(c.to.node)) });
        return checkResult(saved, []);
      });
    },
  }),
  defineTool({
    name: "knife_workflow_activate",
    scope: "account",
    effect: "write",
    description: "Activate (or deactivate) a workflow: once active, its Schedule Triggers run by themselves and its production webhook URLs answer. Needs a Schedule Trigger or a Webhook.",
    schema: z.object({ id: ID, active: z.boolean() }).strict(),
    run({ id, active }, ctx) {
      return guarded(() => {
        const accountId = account(ctx);
        const current = requireWorkflow(accountId, id);
        return checkResult(saveWorkflow(accountId, id, current.version, { active }), []);
      });
    },
  }),
  defineTool({
    name: "knife_workflow_run",
    scope: "account",
    effect: "write",
    publishes: true,
    untrustedOutput: true,
    description:
      "Run a saved workflow now and wait for it (up to its time limit). Its nodes do what they are set to do (HTTP requests to their URLs, emails…), so run only workflows the user asked for. Optional startNode (a trigger), destinationNode (run only up to it), items (the trigger's output, e.g. [{json:{name:'Ada'}}] as test data). Returns status, error, per-node item counts and the last node's first items.",
    schema: z.object({ id: ID, startNode: z.string().max(80).optional(), destinationNode: z.string().max(80).optional(), items: z.array(z.object({ json: z.record(z.string(), z.unknown()) })).max(200).optional(), maxItems: z.number().int().min(1).max(100).optional() }).strict(),
    run({ id, startNode, destinationNode, items, maxItems }, ctx) {
      return guarded(async () => {
        const accountId = account(ctx);
        const workflow = requireWorkflow(accountId, id);
        const { runId, result } = await startRun({ accountId, workflow, mode: "manual", startNode, destinationNode, triggerItems: items as Item[] | undefined });
        const nodes = Object.entries(result.runData).map(([name, runs]) => {
          const last = runs[runs.length - 1];
          return { name, runs: runs.length, items: last?.outputs.map((output) => output.length), ...(last?.error ? { error: last.error.message } : {}), ms: last?.ms };
        });
        // Node data and error texts can come from the services the workflow called: third-party content.
        return {
          runId,
          status: result.status,
          ...(result.error ? { error: wrapUntrustedStrings("workflow run error", result.error) } : {}),
          ...(result.lastNode ? { lastNode: result.lastNode } : {}),
          nodes: nodes.map((entry) => (entry.error ? { ...entry, error: wrapUntrustedStrings("workflow node error", entry.error) } : entry)),
          output: wrapUntrustedStrings("workflow run output", itemsJson(result.lastItems, maxItems ?? 20)),
        };
      });
    },
  }),
  defineTool({
    name: "knife_workflow_runs",
    scope: "account",
    effect: "read",
    description: "A workflow's run history (newest first): id, mode (manual, trigger, webhook, resume…), status, start/end, error, last node.",
    schema: z.object({ id: ID }).strict(),
    run({ id }, ctx) {
      return guarded(() => {
        const accountId = account(ctx);
        requireWorkflow(accountId, id);
        return { runs: listRuns(accountId, id).slice(0, 50) };
      });
    },
  }),
  defineTool({
    name: "knife_workflow_run_get",
    scope: "account",
    effect: "read",
    untrustedOutput: true,
    description: "One run in detail: per node its item counts per output, error and logs; with `node`, that node's output items (first `maxItems`, default 20; stored runs keep the first 50 per output).",
    schema: z.object({ id: ID, runId: RUN_ID, node: z.string().max(80).optional(), maxItems: z.number().int().min(1).max(50).optional() }).strict(),
    run({ id, runId, node, maxItems }, ctx) {
      return guarded(() => {
        const accountId = account(ctx);
        requireWorkflow(accountId, id);
        const run = getRun(accountId, id, runId);
        if (!run) throw new Error("Unknown run.");
        const nodes = Object.entries(run.runData).map(([name, runs]) => {
          const last = runs[runs.length - 1];
          return { name, runs: runs.length, items: last?.outputCounts ?? last?.outputs.map((o) => o.length), ...(last?.error ? { error: wrapUntrustedStrings("workflow node error", last.error) } : {}), ...(last?.logs?.length ? { logs: wrapUntrustedStrings("workflow node log", last.logs.slice(0, 50)) } : {}) };
        });
        const detail = node
          ? (() => {
              const runs = run.runData[node];
              if (!runs) throw new Error(`Node "${node}" did not run in this run.`);
              const last = runs[runs.length - 1];
              return { node, outputs: wrapUntrustedStrings("workflow node output", last.outputs.map((output) => itemsJson(output, maxItems ?? 20))) };
            })()
          : undefined;
        return { id: run.id, status: run.status, mode: run.mode, startedAt: run.startedAt, finishedAt: run.finishedAt, ...(run.error ? { error: wrapUntrustedStrings("workflow run error", run.error) } : {}), nodes, ...(detail ? { detail } : {}) };
      });
    },
  }),
  defineTool({
    name: "knife_workflow_credentials",
    scope: "account",
    effect: "read",
    description: "The user's workflow credentials by id, name and type (never their secrets): use an id in a node's `credentials` {slot: id}. New credentials are created by the user in the Workflows > Credentials tab (keys never pass through you).",
    schema: z.object({}).strict(),
    run(_input, ctx) {
      return guarded(() => ({ credentials: listCredentials(account(ctx)).map((c) => ({ id: c.id, name: c.name, type: c.type, typeLabel: credentialType(c.type)?.label ?? c.type, ...(c.connected !== undefined ? { connected: c.connected } : {}) })) }));
    },
  }),
  defineTool({
    name: "knife_workflow_delete",
    scope: "account",
    effect: "destructive",
    description: "Delete a workflow with its run history. The user confirms.",
    schema: z.object({ id: ID }).strict(),
    run({ id }, ctx) {
      return guarded(() => {
        const accountId = account(ctx);
        const workflow = requireWorkflow(accountId, id);
        deleteWorkflow(accountId, id);
        return { deleted: true, name: workflow.name };
      });
    },
  }),
];
