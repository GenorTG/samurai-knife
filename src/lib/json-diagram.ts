/** JSON structure tree (depth 10, 50 children per node, 1000 rows). Pure: inline for small documents, json-diagram.worker.ts for large ones. */

export type DiagramRow = { depth: number; label: string; type: string; path: string };

export interface DiagramResult {
  rows: DiagramRow[];
  error: string;
}

export type DiagramTasks = { diagram: { payload: string; result: DiagramResult } };

/** A document above this many characters is described in the worker. */
export const DIAGRAM_INLINE_LIMIT = 100_000;

function describe(value: unknown, path: string, depth: number, out: DiagramRow[]) {
  if (out.length >= 1000) return;
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const size = Array.isArray(value) ? `${value.length} items` : value && typeof value === "object" ? `${Object.keys(value).length} keys` : "";
  out.push({ depth, label: path.split("/").at(-1) || "$", type: size ? `${type} · ${size}` : type, path: path || "$" });
  if (depth >= 10) return;
  if (Array.isArray(value)) {
    value.slice(0, 50).forEach((child, index) => describe(child, `${path}/${index}`, depth + 1, out));
  } else if (value && typeof value === "object") {
    Object.entries(value).slice(0, 50).forEach(([key, child]) => describe(child, `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`, depth + 1, out));
  }
}

export function diagramJson(input: string): DiagramResult {
  try {
    const value: unknown = JSON.parse(input);
    const rows: DiagramRow[] = [];
    describe(value, "", 0, rows);
    return { rows, error: "" };
  } catch (e) {
    return { rows: [], error: e instanceof Error ? e.message : "Invalid JSON." };
  }
}
