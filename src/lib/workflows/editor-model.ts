/** Pure helpers of the workflow editor (src/tools/workflows/): node creation, names, connections, visibility. */
import { nodeMeta } from "./catalog/index";
import type { Connection, NodeMeta, NodeParam, WorkflowNode } from "./types";

export function uniqueName(base: string, taken: Iterable<string>): string {
  const names = new Set(taken);
  if (!names.has(base)) return base;
  const stem = base.replace(/\d+$/, "");
  for (let index = 1; ; index += 1) {
    const candidate = `${stem}${index}`;
    if (!names.has(candidate)) return candidate;
  }
}

export function newNodeId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createNode(meta: NodeMeta, taken: Iterable<string>, position: [number, number]): WorkflowNode {
  return {
    id: newNodeId(),
    type: meta.type,
    typeVersion: meta.version ?? 1,
    name: uniqueName(meta.defaultName ?? meta.label, taken),
    position: [Math.round(position[0] / 20) * 20, Math.round(position[1] / 20) * 20],
    parameters: {},
  };
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Rewrites `$('Old')`, `$("Old")`, `$node["Old"]`, `$items("Old")` references inside parameter values. */
export function renameReferences(value: unknown, from: string, to: string): unknown {
  if (typeof value === "string") {
    if (!value.includes(from)) return value;
    const q = escapeRegex(from);
    return value
      .replace(new RegExp(`\\$\\(\\s*(['"])${q}\\1\\s*\\)`, "g"), (_m, quote: string) => `$(${quote}${to}${quote})`)
      .replace(new RegExp(`\\$node\\[\\s*(['"])${q}\\1\\s*\\]`, "g"), (_m, quote: string) => `$node[${quote}${to}${quote}]`)
      .replace(new RegExp(`\\$items\\(\\s*(['"])${q}\\1`, "g"), (_m, quote: string) => `$items(${quote}${to}${quote}`);
  }
  if (Array.isArray(value)) return value.map((entry) => renameReferences(entry, from, to));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, renameReferences(entry, from, to)]));
  return value;
}

export function renameNode(nodes: WorkflowNode[], connections: Connection[], from: string, to: string): { nodes: WorkflowNode[]; connections: Connection[] } {
  return {
    nodes: nodes.map((node) => ({ ...(node.name === from ? { ...node, name: to } : node), parameters: renameReferences(node.parameters, from, to) as WorkflowNode["parameters"] })),
    connections: connections.map((c) => ({ from: { ...c.from, node: c.from.node === from ? to : c.from.node }, to: { ...c.to, node: c.to.node === from ? to : c.to.node } })),
  };
}

export function removeNodes(nodes: WorkflowNode[], connections: Connection[], names: Set<string>): { nodes: WorkflowNode[]; connections: Connection[] } {
  return { nodes: nodes.filter((node) => !names.has(node.name)), connections: connections.filter((c) => !names.has(c.from.node) && !names.has(c.to.node)) };
}

/** Adds a connection unless it exists, points into a trigger, or loops a node onto itself. */
export function addConnection(nodes: WorkflowNode[], connections: Connection[], connection: Connection): Connection[] {
  if (connection.from.node === connection.to.node) return connections;
  const target = nodes.find((node) => node.name === connection.to.node);
  if (!target || (nodeMeta(target.type)?.inputs ?? 1) === 0) return connections;
  const exists = connections.some((c) => c.from.node === connection.from.node && c.from.output === connection.from.output && c.to.node === connection.to.node && c.to.input === connection.to.input);
  return exists ? connections : [...connections, connection];
}

/** Whether a parameter is shown for these values (`showIf`: every named parameter has one of the listed values). */
export function paramVisible(param: NodeParam, values: Record<string, unknown>, defaults: NodeParam[]): boolean {
  if (!param.showIf) return true;
  return Object.entries(param.showIf).every(([name, allowed]) => {
    const value = name in values ? values[name] : defaults.find((p) => p.name === name)?.default;
    return allowed.some((entry) => entry === value);
  });
}

export function paramValue(node: WorkflowNode, meta: NodeMeta, name: string): unknown {
  return name in node.parameters ? node.parameters[name] : meta.params.find((param) => param.name === name)?.default;
}

export interface Template {
  id: string;
  name: string;
  description: string;
  build(): { nodes: WorkflowNode[]; connections: Connection[] };
}

function chain(specs: { type: string; name?: string; parameters?: Record<string, unknown> }[]): { nodes: WorkflowNode[]; connections: Connection[] } {
  const nodes: WorkflowNode[] = [];
  specs.forEach((spec, index) => {
    const meta = nodeMeta(spec.type);
    if (!meta) return;
    const node = createNode(meta, nodes.map((n) => n.name), [index * 240, 0]);
    nodes.push({ ...node, name: spec.name ?? node.name, parameters: spec.parameters ?? {} });
  });
  return { nodes, connections: nodes.slice(1).map((node, index) => ({ from: { node: nodes[index].name, output: 0 }, to: { node: node.name, input: 0 } })) };
}

export const TEMPLATES: Template[] = [
  { id: "blank", name: "Blank", description: "Just a manual trigger.", build: () => chain([{ type: "core.manual-trigger" }]) },
  {
    id: "webhook-reply",
    name: "Webhook that answers",
    description: "Receive JSON, reshape it, answer the caller.",
    build: () =>
      chain([
        { type: "core.webhook", parameters: { httpMethod: "POST", path: "hello", responseMode: "responseNode" } },
        { type: "core.set", parameters: { include: "none", assignments: [{ name: "greeting", type: "string", value: "=Hello {{ $json.body.name ?? 'there' }}!" }] } },
        { type: "core.respond-to-webhook", parameters: { respondWith: "firstIncomingItem" } },
      ]),
  },
  {
    id: "schedule-fetch",
    name: "Fetch an API every hour",
    description: "Schedule, HTTP request, keep only what matters.",
    build: () =>
      chain([
        { type: "core.schedule-trigger", parameters: { rules: [{ every: "hours", amount: 1, atMinute: 0 }] } },
        { type: "core.http-request", parameters: { method: "GET", url: "https://api.github.com/repos/nodejs/node/releases?per_page=5" } },
        { type: "core.set", parameters: { include: "none", assignments: [{ name: "name", type: "string", value: "={{ $json.name }}" }, { name: "published", type: "string", value: "={{ $json.published_at }}" }] } },
      ]),
  },
  {
    id: "ask-ai",
    name: "Ask AI about each item",
    description: "Sample items, one model call per item with your saved provider profile.",
    build: () =>
      chain([
        { type: "core.manual-trigger" },
        { type: "core.code", name: "Sample texts", parameters: { jsCode: "return [{ text: 'The delivery was late but the support team fixed it fast.' }, { text: 'Great product, would buy again.' }];\n" } },
        { type: "core.ai-chat", parameters: { instructions: "You are concise.", prompt: "=Summarize in five words: {{ $json.text }}", outputField: "summary" } },
      ]),
  },
  {
    id: "code-transform",
    name: "Transform data with code",
    description: "Manual trigger, sample data, a JavaScript Code node.",
    build: () =>
      chain([
        { type: "core.manual-trigger" },
        { type: "core.debug-helper", name: "Sample data", parameters: { category: "randomData", count: 5 } },
        { type: "core.code", parameters: { jsCode: "// Group people by whether they are active\nconst active = $input.all().filter((i) => i.json.active);\nreturn [{ json: { active: active.length, names: active.map((i) => i.json.firstName) } }];\n" } },
      ]),
  },
];
