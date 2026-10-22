/** Checks a workflow beyond its schema (isomorphic: the editor shows the same problems the server refuses). */
import { nodeMeta } from "./catalog/index";
import { outputLabels, type Workflow } from "./types";

export interface WorkflowProblem {
  message: string;
  node?: string;
}

/** Problems that make a workflow unsavable. */
export function structuralProblems(workflow: Pick<Workflow, "nodes" | "connections">): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  const names = new Map<string, number>();
  const ids = new Set<string>();
  for (const node of workflow.nodes) {
    names.set(node.name, (names.get(node.name) ?? 0) + 1);
    if (ids.has(node.id)) problems.push({ message: `Two nodes share the id ${node.id}.`, node: node.name });
    ids.add(node.id);
    if (!nodeMeta(node.type)) problems.push({ message: `Unknown node type "${node.type}".`, node: node.name });
  }
  for (const [name, count] of names) if (count > 1) problems.push({ message: `${count} nodes are named "${name}"; names must be unique.`, node: name });
  const byName = new Map(workflow.nodes.map((node) => [node.name, node]));
  const seen = new Set<string>();
  for (const connection of workflow.connections) {
    const from = byName.get(connection.from.node);
    const to = byName.get(connection.to.node);
    if (!from || !to) {
      problems.push({ message: `A connection points to a missing node (${!from ? connection.from.node : connection.to.node}).` });
      continue;
    }
    const key = `${connection.from.node}\u0000${connection.from.output}\u0000${connection.to.node}\u0000${connection.to.input}`;
    if (seen.has(key)) problems.push({ message: `"${from.name}" is connected to "${to.name}" twice.`, node: from.name });
    seen.add(key);
    const fromMeta = nodeMeta(from.type);
    const toMeta = nodeMeta(to.type);
    if (fromMeta) {
      const outputs = outputLabels(fromMeta, from.parameters).length + (from.onError === "errorOutput" ? 1 : 0);
      if (connection.from.output >= outputs) problems.push({ message: `"${from.name}" has no output ${connection.from.output + 1}.`, node: from.name });
    }
    if (toMeta) {
      if (toMeta.inputs === 0) problems.push({ message: `"${to.name}" is a trigger and takes no input.`, node: to.name });
      else if (connection.to.input >= toMeta.inputs) problems.push({ message: `"${to.name}" has no input ${connection.to.input + 1}.`, node: to.name });
    }
  }
  return problems;
}

/** Problems that keep a workflow from being activated (triggers that run by themselves). */
export function activationProblems(workflow: Pick<Workflow, "nodes" | "connections">): WorkflowProblem[] {
  const problems = structuralProblems(workflow);
  const automatic = workflow.nodes.filter((node) => !node.disabled && ["schedule", "webhook", "error", "subworkflow"].includes(nodeMeta(node.type)?.trigger ?? ""));
  if (!automatic.some((node) => ["schedule", "webhook"].includes(nodeMeta(node.type)?.trigger ?? ""))) {
    problems.push({ message: "Add a Schedule Trigger or a Webhook to activate the workflow (manual, error and sub-workflow triggers work without activating)." });
  }
  const hooks = new Map<string, string>();
  for (const node of automatic) {
    if (nodeMeta(node.type)?.trigger !== "webhook") continue;
    const key = `${String(node.parameters.httpMethod ?? "POST")} ${normalizeHookPath(node.parameters.path)}`;
    const other = hooks.get(key);
    if (other) problems.push({ message: `"${node.name}" and "${other}" listen on the same method and path.`, node: node.name });
    hooks.set(key, node.name);
  }
  return problems;
}

/** "orders/:id/" -> "orders/:id"; the empty path is "". */
export function normalizeHookPath(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/");
}

/** Matches a request path against a webhook path with `:params`; returns the params or null. */
export function matchHookPath(pattern: string, path: string): Record<string, string> | null {
  const want = normalizeHookPath(pattern).split("/").filter(Boolean);
  const got = normalizeHookPath(path).split("/").filter(Boolean);
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < want.length; index += 1) {
    if (want[index].startsWith(":")) {
      let value: string;
      try {
        value = decodeURIComponent(got[index]);
      } catch {
        return null;
      }
      params[want[index].slice(1)] = value;
    } else if (want[index] !== got[index]) return null;
  }
  return params;
}
