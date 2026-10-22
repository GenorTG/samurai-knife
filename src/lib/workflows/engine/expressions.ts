/**
 * Parameter expressions (docs/WORKFLOWS.md "Model"): a string parameter starting with `=` is a template whose `{{ … }}`
 * parts are JavaScript, evaluated in the sandbox per item. A template that is one whole `{{ … }}` keeps the value's type;
 * otherwise the parts are joined as text (objects as JSON). Each node execution with expressions gets one sandbox
 * session holding its input items, the outputs of the nodes its expressions name, and the run's metadata.
 */
import { openSandbox, SandboxError, type Sandbox, type SandboxLimits } from "../sandbox/quickjs";
import type { Item } from "../types";
import { SANDBOX_PRELUDE } from "./prelude";

export function isExpression(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("=");
}

export type TemplatePart = { text: string } | { code: string };

/** Splits the template (without its leading `=`) into text and `{{ code }}` parts; braces inside code may nest. */
export function parseTemplate(source: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf("{{", index);
    if (open < 0) {
      parts.push({ text: source.slice(index) });
      break;
    }
    if (open > index) parts.push({ text: source.slice(index, open) });
    let depth = 0;
    let quote: string | null = null;
    let end = -1;
    for (let at = open + 2; at < source.length; at += 1) {
      const ch = source[at];
      if (quote) {
        if (ch === "\\") at += 1;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") quote = ch;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        if (depth === 0 && source[at + 1] === "}") {
          end = at;
          break;
        }
        depth = Math.max(0, depth - 1);
      }
    }
    if (end < 0) {
      parts.push({ text: source.slice(open) });
      break;
    }
    parts.push({ code: source.slice(open + 2, end).trim() });
    index = end + 2;
  }
  return parts;
}

const NODE_REF = /\$\(\s*(['"])((?:\\.|(?!\1).)*)\1\s*\)|\$node\[\s*(['"])((?:\\.|(?!\3).)*)\3\s*\]|\$node\.([A-Za-z_$][\w$]*)|\$items\(\s*(['"])((?:\\.|(?!\6).)*)\6/g;

/** Node names an expression reads, and whether it reads one by a computed name (then every output is passed in). */
export function nodeReferences(code: string): { names: Set<string>; dynamic: boolean } {
  const names = new Set<string>();
  for (const match of code.matchAll(NODE_REF)) {
    const name = match[2] ?? match[4] ?? match[5] ?? match[7];
    if (name !== undefined) names.add(name.replace(/\\(.)/g, "$1"));
  }
  const dynamic = /\$\(\s*[^'"\s)]/.test(code) || /\$node\[\s*[^'"\s\]]/.test(code) || /\$items\(\s*[^'"\s)]/.test(code);
  return { names, dynamic };
}

/** Every `{{ code }}` in a parameter value (deep). */
export function expressionCodes(value: unknown, out: string[] = []): string[] {
  if (isExpression(value)) {
    for (const part of parseTemplate(value.slice(1))) if ("code" in part) out.push(part.code);
  } else if (Array.isArray(value)) {
    for (const entry of value) expressionCodes(entry, out);
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value)) expressionCodes(entry, out);
  }
  return out;
}

export interface ScopeMeta {
  now: number;
  tzOffset: number;
  runIndex: number;
  workflow: { id: string; name: string; active: boolean };
  execution: { id: string; mode: string; resumeUrl?: string; customData?: Record<string, string> };
  vars?: Record<string, string>;
  prevNode?: { name: string; outputIndex: number; runIndex: number };
  params?: Record<string, unknown>;
}

export interface ScopeData {
  items: Item[];
  nodes: Record<string, { items: Item[]; params?: Record<string, unknown> }>;
  meta: ScopeMeta;
}

/** Time limit of one expression evaluation (one item, one parameter). */
const EXPRESSION_MS = 2_000;

const SCOPE_NAMES = "$json, $binary, $itemIndex, $runIndex, $input, $, $node, $items, $now, $today, $workflow, $execution, $vars, $prevNode, $if, $ifEmpty, $min, $max";

function formatPart(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export class ExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpressionError";
  }
}

/** One sandbox session resolving one node's parameters for each of its items. */
export class ExpressionScope {
  private readonly box: Sandbox;
  private readonly compiled = new Map<string, number>();

  private constructor(box: Sandbox) {
    this.box = box;
  }

  static async open(data: ScopeData, limits: Partial<SandboxLimits> = {}): Promise<ExpressionScope> {
    const box = await openSandbox({ timeoutMs: 10_000, ...limits });
    try {
      box.setJson("__data", data);
      box.exec(SANDBOX_PRELUDE);
      box.exec("globalThis.__fx = [];");
    } catch (error) {
      box.dispose();
      throw error;
    }
    return new ExpressionScope(box);
  }

  /** Resolves every expression inside `value` for item `itemIndex`; other values are returned as they are. */
  resolve(value: unknown, itemIndex: number, label = "parameter"): unknown {
    if (isExpression(value)) return this.template(value.slice(1), itemIndex, label);
    if (Array.isArray(value)) return value.map((entry) => this.resolve(entry, itemIndex, label));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, this.resolve(entry, itemIndex, `${label}.${key}`)]));
    }
    return value;
  }

  evaluate(code: string, itemIndex: number, label = "expression"): unknown {
    let slot = this.compiled.get(code);
    try {
      if (slot === undefined) {
        slot = this.compiled.size;
        this.box.exec(`__fx[${slot}] = function (__i) { const { ${SCOPE_NAMES} } = __scope(__i); return (\n${code}\n); };`);
        this.compiled.set(code, slot);
      }
      this.box.setDeadline(EXPRESSION_MS);
      return this.box.run(`__fx[${slot}](${itemIndex})`);
    } catch (error) {
      if (error instanceof SandboxError) {
        if (error.kind === "code") throw new ExpressionError(`Expression in ${label}: ${error.message}`);
        throw new ExpressionError(`Expression in ${label} stopped: ${error.message}`);
      }
      throw error;
    }
  }

  get logs(): string[] {
    return this.box.logs;
  }

  dispose(): void {
    this.box.dispose();
  }

  private template(source: string, itemIndex: number, label: string): unknown {
    const parts = parseTemplate(source);
    const codes = parts.filter((part): part is { code: string } => "code" in part);
    if (codes.length === 1 && parts.every((part) => "code" in part || !part.text.trim())) {
      return this.evaluate(codes[0].code, itemIndex, label);
    }
    return parts.map((part) => ("code" in part ? formatPart(this.evaluate(part.code, itemIndex, label)) : part.text)).join("");
  }
}
