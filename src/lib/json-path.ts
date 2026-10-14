/** JSONPath subset ($, .name, [index], ['key'], *) over a JSON document. Pure: inline for small documents, json-path.worker.ts for large ones. */

type Segment = string | number | "*";
type Hit = { value: unknown; path: Segment[] };

export interface JsonPathInput {
  json: string;
  query: string;
}

export interface JsonPathResult {
  /** The first `JSON_PATH_SHOWN` matches, ready to render. */
  shown: { path: string; pretty: string }[];
  count: number;
  /** Every match as `pointer<TAB>json`, for Copy matches. */
  copyText: string;
  error: string;
}

export type JsonPathTasks = { query: { payload: JsonPathInput; result: JsonPathResult } };

export const JSON_PATH_SHOWN = 500;
/** A document above this many characters is queried in the worker. */
export const JSON_PATH_INLINE_LIMIT = 100_000;

function parsePath(query: string): Segment[] {
  const input = query.trim();
  if (!input.startsWith("$")) throw new Error("A query must start with $.");
  const segments: Segment[] = [];
  let index = 1;
  while (index < input.length) {
    if (input[index] === ".") {
      index += 1;
      if (input[index] === ".") throw new Error("Recursive descent (..) is not supported yet.");
      const match = input.slice(index).match(/^([\w$-]+|\*)/);
      if (!match) throw new Error(`Expected a property at character ${index + 1}.`);
      segments.push(match[1] === "*" ? "*" : match[1]);
      index += match[0].length;
    } else if (input[index] === "[") {
      const end = input.indexOf("]", index + 1);
      if (end < 0) throw new Error("Unclosed bracket selector.");
      const content = input.slice(index + 1, end).trim();
      if (content === "*") segments.push("*");
      else if (/^(0|[1-9]\d*)$/.test(content)) segments.push(Number(content));
      else if (/^(['"]).*\1$/.test(content)) segments.push(content.slice(1, -1).replace(/\\(['"\\])/g, "$1"));
      else throw new Error(`Unsupported bracket selector: [${content}]. Use an index, quoted key, or *.`);
      index = end + 1;
    } else throw new Error(`Unexpected character at ${index + 1}.`);
  }
  return segments;
}

function pointer(path: Segment[]): string { return path.map((part) => `/${String(part).replace(/~/g, "~0").replace(/\//g, "~1")}`).join(""); }

function queryValue(root: unknown, segments: Segment[]): { value: unknown; path: string }[] {
  let current: Hit[] = [{ value: root, path: [] }];
  for (const segment of segments) {
    const next: Hit[] = [];
    for (const item of current) {
      if (segment === "*") {
        if (Array.isArray(item.value)) item.value.forEach((value, index) => next.push({ value, path: [...item.path, index] }));
        else if (item.value !== null && typeof item.value === "object") Object.entries(item.value).forEach(([key, value]) => next.push({ value, path: [...item.path, key] }));
      } else if (Array.isArray(item.value) && typeof segment === "number" && segment < item.value.length) next.push({ value: item.value[segment], path: [...item.path, segment] });
      else if (item.value !== null && typeof item.value === "object" && typeof segment === "string" && Object.hasOwn(item.value, segment)) next.push({ value: (item.value as Record<string, unknown>)[segment], path: [...item.path, segment] });
    }
    current = next;
  }
  return current.map((item) => ({ path: pointer(item.path), value: item.value }));
}

/** Typing the query re-runs over the same document: parse a given text once. */
let parsed: { text: string; root: unknown } | null = null;

export function evaluateJsonPath({ json, query }: JsonPathInput): JsonPathResult {
  try {
    if (parsed?.text !== json) parsed = { text: json, root: JSON.parse(json) as unknown };
    const matches = queryValue(parsed.root, parsePath(query));
    return {
      shown: matches.slice(0, JSON_PATH_SHOWN).map((match) => ({ path: match.path, pretty: JSON.stringify(match.value, null, 2) })),
      count: matches.length,
      copyText: matches.map((match) => `${match.path || "/"}\t${JSON.stringify(match.value)}`).join("\n"),
      error: "",
    };
  } catch (error) {
    return { shown: [], count: 0, copyText: "", error: error instanceof Error ? error.message : "Could not evaluate query." };
  }
}
