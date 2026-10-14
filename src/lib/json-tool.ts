/** Parse, sort, flatten and measure a JSON document. Pure: runs inline for small input and in json-tool.worker.ts for large input. */

export type SortMode = "none" | "keys" | "natural";

export interface JsonToolInput {
  text: string;
  indent: number;
  sort: SortMode;
  flattened: boolean;
}

export interface JsonIssue {
  message: string;
  line: number;
  column: number;
  offset: number;
  /** Up to 40 characters before the offending position, and 12 from it, for the error excerpt. */
  before: string;
  at: string;
}

export interface JsonStats {
  objects: number;
  arrays: number;
  leaves: number;
  depth: number;
}

export type JsonToolOutput =
  | { state: "empty" }
  | { state: "invalid"; issue: JsonIssue }
  | { state: "failed"; message: string }
  | { state: "valid"; output: string; minified: string; stats: JsonStats };

export type JsonToolTasks = { json: { payload: JsonToolInput; result: JsonToolOutput } };

/** Input above this many characters is processed in the worker. */
export const JSON_INLINE_LIMIT = 100_000;
/** Large inputs (worker path): the output panel shows at most this many characters of the result (laying out 200 KB of <pre> cost ~250 ms); Copy and Save always use the full text. */
export const JSON_DISPLAY_LIMIT = 50_000;

/** V8 parse errors carry "at position N" (V8 ≥12) or "at line C column R". */
function locateIssue(raw: string, message: string): JsonIssue {
  const positionMatch = /at position (\d+)/.exec(message);
  const legacyMatch = /at line (\d+) column (\d+)/.exec(message);

  let offset = positionMatch ? Number(positionMatch[1]) : -1;
  if (offset === -1 && legacyMatch) {
    const line = Number(legacyMatch[1]);
    const column = Number(legacyMatch[2]);
    const lines = raw.split("\n");
    offset = lines.slice(0, line - 1).reduce((sum, l) => sum + l.length + 1, 0) + (column - 1);
  }
  if (offset === -1) offset = 0;

  const before = raw.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - before.lastIndexOf("\n");

  const short = message.replace(/^JSON\.parse: /, "").replace(/ at (position|line).*/, "");
  return {
    message: short || "Invalid JSON",
    line,
    column,
    offset,
    before: raw.slice(Math.max(0, offset - 40), offset),
    at: raw.slice(offset, offset + 12),
  };
}

function sortDeep(value: unknown, mode: SortMode, depth = 0): unknown {
  if (mode === "none" || depth > 64) return value;
  if (Array.isArray(value)) {
    const items = value.map((item) => sortDeep(item, mode, depth + 1));
    if (mode === "natural") {
      items.sort((a, b) =>
        (a === null || typeof a === "object") === (b === null || typeof b === "object")
          ? String(a).localeCompare(String(b), undefined, { numeric: true })
          : a === null || typeof a === "object"
            ? 1
            : -1,
      );
    }
    return items;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const out: Record<string, unknown> = {};
    for (const key of keys) out[key] = sortDeep(record[key], mode, depth + 1);
    return out;
  }
  return value;
}

function flatten(value: unknown, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out[prefix || "(root)"] = value;
      return out;
    }
    value.forEach((item, index) => flatten(item, `${prefix}[${index}]`, out));
    return out;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      out[prefix || "(root)"] = value;
      return out;
    }
    for (const [key, item] of entries) {
      flatten(item, prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }
  out[prefix || "(root)"] = value;
  return out;
}

function countDeep(value: unknown): { objects: number; arrays: number; leaves: number } {
  const counts = { objects: 0, arrays: 0, leaves: 0 };
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      counts.arrays += 1;
      node.forEach(walk);
      return;
    }
    if (node && typeof node === "object") {
      counts.objects += 1;
      Object.values(node as Record<string, unknown>).forEach(walk);
      return;
    }
    counts.leaves += 1;
  };
  walk(value);
  return counts;
}

/** `Math.max(0, ...children)` throws a RangeError past ~100k elements, which a real array of records easily exceeds, so fold instead. */
function depthOf(value: unknown, seen = new Set<unknown>()): number {
  const children = Array.isArray(value) ? value : value && typeof value === "object" ? Object.values(value as Record<string, unknown>) : null;
  if (!children) return 0;
  if (seen.has(value)) return 0;
  seen.add(value);
  let deepest = 0;
  for (const child of children) deepest = Math.max(deepest, depthOf(child, seen));
  return 1 + deepest;
}

export function runJsonTool({ text, indent, sort, flattened }: JsonToolInput): JsonToolOutput {
  const trimmed = text.trim();
  if (!trimmed) return { state: "empty" };
  let value: unknown;
  try {
    value = JSON.parse(trimmed) as unknown;
  } catch (exc) {
    return { state: "invalid", issue: locateIssue(trimmed, exc instanceof Error ? exc.message : String(exc)) };
  }
  try {
    const prepared = sort === "none" ? value : sortDeep(value, sort);
    const output = JSON.stringify(flattened ? flatten(prepared) : prepared, null, indent);
    return { state: "valid", output, minified: JSON.stringify(value), stats: { ...countDeep(value), depth: depthOf(value) } };
  } catch (exc) {
    return { state: "failed", message: exc instanceof Error ? exc.message : "Could not format this document." };
  }
}
