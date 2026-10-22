/** Data node implementations (metadata: src/lib/workflows/catalog/data.ts). */
import { randomUUID } from "node:crypto";
import { SANDBOX_PRELUDE } from "../engine/prelude";
import { NodeError, type ExecuteContext, type NodeImpl } from "../engine/node-api";
import { SandboxError } from "../sandbox/quickjs";
import type { Item, JsonObject } from "../types";
import { cloneJson, deepEqual, deletePath, fieldList, getPath, isPlainObject, jsonParam, setPath, stableKey } from "./util";

function coerce(value: unknown, type: string, name: string): unknown {
  switch (type) {
    case "number": {
      if (typeof value === "number") return value;
      const n = Number(value);
      if (value === "" || value === null || !Number.isFinite(n)) throw new NodeError(`"${name}" should be a number, got ${JSON.stringify(value)}.`);
      return n;
    }
    case "boolean":
      if (typeof value === "boolean") return value;
      if (value === "true" || value === "1" || value === 1) return true;
      if (value === "false" || value === "0" || value === 0 || value === "") return false;
      throw new NodeError(`"${name}" should be true or false, got ${JSON.stringify(value)}.`);
    case "array":
    case "object": {
      const parsed = typeof value === "string" ? jsonParam(value, `"${name}"`) : value;
      if (type === "array" ? !Array.isArray(parsed) : !isPlainObject(parsed)) throw new NodeError(`"${name}" should be ${type === "array" ? "a list" : "an object"}.`);
      return parsed;
    }
    default:
      return value === undefined || value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  }
}

const setNode: NodeImpl = {
  type: "core.set",
  async execute(ctx) {
    const dot = ctx.param<boolean>("dotNotation") !== false;
    return [
      ctx.items.map((item, index) => {
        const include = ctx.param<string>("include", index);
        const fields = fieldList(ctx.param("includeFields", index));
        let json: JsonObject;
        if (include === "none") json = {};
        else if (include === "selected") {
          json = {};
          for (const field of fields) {
            const value = getPath(item.json, field, dot);
            if (value !== undefined) setPath(json, field, cloneJson(value), dot);
          }
        } else {
          json = cloneJson(item.json);
          if (include === "except") for (const field of fields) deletePath(json, field);
        }
        if (ctx.param("mode", index) === "raw") {
          const value = jsonParam(ctx.param("jsonOutput", index), "JSON");
          if (!isPlainObject(value)) throw new NodeError("The JSON must be an object.", { itemIndex: index });
          json = { ...json, ...value };
        } else {
          for (const row of ctx.param<{ name?: string; type?: string; value?: unknown }[]>("assignments", index) ?? []) {
            const name = String(row.name ?? "").trim();
            if (!name) continue;
            setPath(json, name, coerce(row.value, row.type ?? "string", name), dot);
          }
        }
        return { json, ...(item.binary ? { binary: item.binary } : {}), pairedItem: index };
      }),
    ];
  },
};

const SCOPE_NAMES = "$json, $binary, $itemIndex, $runIndex, $input, $, $node, $items, $now, $today, $workflow, $execution, $vars, $prevNode, $if, $ifEmpty, $min, $max";

function wrapAll(code: string): { source: string; offset: number } {
  const head = `(async () => {\nconst { ${SCOPE_NAMES} } = __scope(0);\nconst items = $input.all();\nreturn await (async () => {\n`;
  return { source: `${head}${code}\n})();\n})()`, offset: head.split("\n").length - 1 };
}

function wrapEach(code: string): { source: string; offset: number } {
  const head = `(async () => {\nconst __out = [];\nfor (let __i = 0; __i < __data.items.length; __i++) {\nconst { ${SCOPE_NAMES} } = __scope(__i);\nconst item = $input.item;\nconst __r = await (async () => {\n`;
  const tail = `\n})();\nif (__r === undefined || __r === null) continue;\nfor (const __e of Array.isArray(__r) ? __r : [__r]) {\n  const __w = __e && typeof __e === "object" && __e.json && typeof __e.json === "object" ? __e : { json: __e };\n  __out.push({ ...__w, pairedItem: __i });\n}\n}\nreturn __out;\n})()`;
  return { source: `${head}${code}${tail}`, offset: head.split("\n").length - 1 };
}

/** Runs user code in a fresh sandbox with the node's `$…` helpers; rethrows with the user's line number. */
async function runUserCode(ctx: ExecuteContext, wrapped: { source: string; offset: number }, timeoutMs: number): Promise<unknown> {
  const box = await ctx.openSandbox({ timeoutMs });
  try {
    box.setJson("__data", await ctx.scopeData());
    box.exec(SANDBOX_PRELUDE);
    return box.run(wrapped.source);
  } catch (error) {
    if (error instanceof SandboxError) {
      const line = error.line !== undefined ? error.line - wrapped.offset : undefined;
      throw new NodeError(line !== undefined && line > 0 ? `${error.message} [line ${line}]` : error.message, {
        description: error.kind === "code" ? undefined : "The Code node runs in a sandbox with a time and memory limit and no network.",
      });
    }
    throw error;
  } finally {
    for (const line of box.logs) ctx.log(line);
    box.dispose();
  }
}

const codeNode: NodeImpl = {
  type: "core.code",
  async execute(ctx) {
    const seconds = Math.max(1, Math.min(60, Number(ctx.param("timeoutSeconds")) || 10));
    const each = ctx.param("mode") === "runOnceForEachItem";
    const code = String(ctx.rawParam(each ? "jsCodeEach" : "jsCode") ?? "");
    if (!code.trim()) throw new NodeError("The code is empty.");
    const result = await runUserCode(ctx, each ? wrapEach(code) : wrapAll(code), seconds * 1000);
    if (result === undefined || result === null) return [[]];
    const list = Array.isArray(result) ? result : [result];
    return [
      list.map((entry, index) => {
        if (isPlainObject(entry) && isPlainObject(entry.json)) {
          const item: Item = { json: entry.json };
          // Files can be passed on (refs of this run), never forged: only refs the input already had.
          if (isPlainObject(entry.binary)) {
            const known = new Map(ctx.items.flatMap((it) => Object.values(it.binary ?? {})).map((ref) => [ref.id, ref]));
            const binary: Item["binary"] = {};
            for (const [key, ref] of Object.entries(entry.binary)) {
              const id = isPlainObject(ref) && typeof ref.id === "string" ? ref.id : "";
              const original = known.get(id);
              if (original) binary[key] = original;
            }
            if (Object.keys(binary).length) item.binary = binary;
          }
          item.pairedItem = typeof entry.pairedItem === "number" ? entry.pairedItem : index;
          return item;
        }
        if (isPlainObject(entry)) return { json: entry, pairedItem: index };
        throw new NodeError(`The code returned ${JSON.stringify(entry)?.slice(0, 80)} at position ${index}: return objects or { json: {...} } items.`);
      }),
    ];
  },
};

const splitOutNode: NodeImpl = {
  type: "core.split-out",
  async execute(ctx) {
    const out: Item[] = [];
    ctx.items.forEach((item, index) => {
      const fields = fieldList(ctx.param("fieldToSplitOut", index));
      if (!fields.length) throw new NodeError("Name the field to split out.");
      const include = ctx.param<string>("include", index);
      const keep = fieldList(ctx.param("fieldsToInclude", index));
      const destination = String(ctx.param("destinationFieldName", index) ?? "").trim();
      const lists = fields.map((field) => {
        const value = getPath(item.json, field);
        if (value === undefined || value === null) return [];
        return Array.isArray(value) ? value : isPlainObject(value) ? Object.values(value) : [value];
      });
      const length = Math.max(0, ...lists.map((list) => list.length));
      for (let at = 0; at < length; at += 1) {
        let json: JsonObject = {};
        if (include === "allOtherFields") {
          json = cloneJson(item.json);
          for (const field of fields) deletePath(json, field);
        } else if (include === "selectedOtherFields") {
          for (const field of keep) {
            const value = getPath(item.json, field);
            if (value !== undefined) setPath(json, field, cloneJson(value));
          }
        }
        fields.forEach((field, fieldIndex) => {
          const value = lists[fieldIndex][at];
          if (fields.length === 1 && !destination && isPlainObject(value) && include === "noOtherFields") json = { ...json, ...cloneJson(value) };
          else setPath(json, destination && fields.length === 1 ? destination : field, cloneJson(value ?? null));
        });
        out.push({ json, ...(item.binary ? { binary: item.binary } : {}), pairedItem: index });
      }
    });
    return [out];
  },
};

const aggregateNode: NodeImpl = {
  type: "core.aggregate",
  async execute(ctx) {
    if (!ctx.items.length) return [[]];
    const keepMissing = ctx.param<boolean>("keepMissing");
    if (ctx.param("aggregate") === "allItemData") {
      const destination = String(ctx.param("destinationFieldName") ?? "data") || "data";
      return [[{ json: { [destination]: ctx.items.map((item) => item.json) } }]];
    }
    const json: JsonObject = {};
    for (const row of ctx.param<{ field?: string; outputField?: string }[]>("fieldsToAggregate") ?? []) {
      const field = String(row.field ?? "").trim();
      if (!field) continue;
      const values = ctx.items.map((item) => getPath(item.json, field)).filter((value) => keepMissing || (value !== undefined && value !== null && value !== ""));
      setPath(json, String(row.outputField ?? "").trim() || field, values);
    }
    return [[{ json }]];
  },
};

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined || a === null) return 1;
  if (b === undefined || b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "en", { numeric: true });
}

const sortNode: NodeImpl = {
  type: "core.sort",
  async execute(ctx) {
    const type = ctx.param<string>("type");
    const items = [...ctx.items];
    if (type === "random") {
      for (let index = items.length - 1; index > 0; index -= 1) {
        const other = Math.floor(Math.random() * (index + 1));
        [items[index], items[other]] = [items[other], items[index]];
      }
      return [items];
    }
    if (type === "code") {
      const code = String(ctx.rawParam("code") ?? "");
      const wrapped = { source: `(() => {\nconst __cmp = (a, b) => {\n${code}\n};\nconst __idx = __data.items.map((_, i) => i);\n__idx.sort((x, y) => __cmp(__data.items[x], __data.items[y]));\nreturn __idx;\n})()`, offset: 2 };
      const order = await runUserCode(ctx, wrapped, 10_000);
      if (!Array.isArray(order)) throw new NodeError("The compare function did not run.");
      return [order.map((index) => ctx.items[Number(index)])];
    }
    const fields = (ctx.param<{ field?: string; order?: string }[]>("fields") ?? []).filter((row) => String(row.field ?? "").trim());
    items.sort((a, b) => {
      for (const row of fields) {
        const result = compareValues(getPath(a.json, String(row.field)), getPath(b.json, String(row.field)));
        if (result) return row.order === "descending" ? -result : result;
      }
      return 0;
    });
    return [items];
  },
};

const limitNode: NodeImpl = {
  type: "core.limit",
  async execute(ctx) {
    const max = Math.max(0, Math.floor(Number(ctx.param("maxItems")) || 0));
    return [ctx.param("keep") === "lastItems" ? ctx.items.slice(Math.max(0, ctx.items.length - max)) : ctx.items.slice(0, max)];
  },
};

const removeDuplicatesNode: NodeImpl = {
  type: "core.remove-duplicates",
  async execute(ctx) {
    if (ctx.param("operation") === "acrossRuns") {
      const size = Math.max(1, Math.min(100_000, Math.floor(Number(ctx.param("historySize")) || 10_000)));
      const seen = Array.isArray(ctx.staticData.seen) ? (ctx.staticData.seen as string[]) : [];
      const known = new Set(seen);
      const out: Item[] = [];
      ctx.items.forEach((item, index) => {
        const key = stableKey(ctx.param("dedupeValue", index));
        if (known.has(key)) return;
        known.add(key);
        seen.push(key);
        out.push({ ...item, pairedItem: index });
      });
      ctx.staticData.seen = seen.slice(Math.max(0, seen.length - size));
      return [out];
    }
    const compare = ctx.param<string>("compare");
    const fields = fieldList(ctx.param("fields"));
    const seen = new Set<string>();
    const out: Item[] = [];
    ctx.items.forEach((item, index) => {
      let basis: unknown;
      if (compare === "selectedFields") basis = fields.map((field) => getPath(item.json, field));
      else if (compare === "allFieldsExcept") {
        const copy = cloneJson(item.json);
        for (const field of fields) deletePath(copy, field);
        basis = copy;
      } else basis = item.json;
      const key = stableKey(basis);
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ ...item, pairedItem: index });
    });
    return [out];
  },
};

const renameKeysNode: NodeImpl = {
  type: "core.rename-keys",
  async execute(ctx) {
    return [
      ctx.items.map((item, index) => {
        const json = cloneJson(item.json);
        for (const row of ctx.param<{ currentKey?: string; newKey?: string }[]>("keys", index) ?? []) {
          const from = String(row.currentKey ?? "").trim();
          const to = String(row.newKey ?? "").trim();
          if (!from || !to || from === to) continue;
          const value = getPath(json, from);
          if (value === undefined) continue;
          deletePath(json, from);
          setPath(json, to, value);
        }
        return { ...item, json, pairedItem: index };
      }),
    ];
  },
};

const summarizeNode: NodeImpl = {
  type: "core.summarize",
  async execute(ctx) {
    const rows = (ctx.param<{ aggregation?: string; field?: string; separator?: string }[]>("fieldsToSummarize") ?? []).filter((row) => row.aggregation);
    const splitBy = fieldList(ctx.param("splitBy"));
    const groups = new Map<string, { key: unknown[]; items: Item[] }>();
    for (const item of ctx.items) {
      const key = splitBy.map((field) => getPath(item.json, field) ?? null);
      const text = stableKey(key);
      const group = groups.get(text) ?? { key, items: [] };
      group.items.push(item);
      groups.set(text, group);
    }
    if (!ctx.items.length && !splitBy.length) groups.set("[]", { key: [], items: [] });
    const out: Item[] = [];
    for (const group of groups.values()) {
      const json: JsonObject = {};
      splitBy.forEach((field, index) => setPath(json, field, group.key[index]));
      for (const row of rows) {
        const field = String(row.field ?? "").trim();
        const values = group.items.map((item) => (field ? getPath(item.json, field) : undefined));
        const present = values.filter((value) => value !== undefined && value !== null && value !== "");
        const numbers = present.map(Number).filter(Number.isFinite);
        const name = `${row.aggregation}_${field || "items"}`.replace(/\./g, "_");
        switch (row.aggregation) {
          case "count": json[name] = field ? present.length : group.items.length; break;
          case "countUnique": json[name] = new Set(present.map(stableKey)).size; break;
          case "sum": json[name] = numbers.reduce((a, b) => a + b, 0); break;
          case "average": json[name] = numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : null; break;
          case "min": json[name] = numbers.length ? Math.min(...numbers) : null; break;
          case "max": json[name] = numbers.length ? Math.max(...numbers) : null; break;
          case "concatenate": json[name] = present.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))).join(row.separator ?? ", "); break;
          case "append": json[name] = present; break;
          case "appendUnique": {
            const seen = new Set<string>();
            json[name] = present.filter((value) => {
              const key = stableKey(value);
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
            break;
          }
          default: throw new NodeError(`Unknown aggregation "${row.aggregation}".`);
        }
      }
      out.push({ json });
    }
    return [out];
  },
};

const compareDatasetsNode: NodeImpl = {
  type: "core.compare-datasets",
  async execute(ctx) {
    const [a = [], b = []] = ctx.inputs;
    const fields = (ctx.param<{ fieldA?: string; fieldB?: string }[]>("fields") ?? []).filter((f) => f.fieldA && f.fieldB);
    if (!fields.length) throw new NodeError("Add at least one pair of fields to match.");
    const skip = fieldList(ctx.param("skipFields"));
    const strip = (json: JsonObject) => {
      const copy = cloneJson(json);
      for (const field of skip) deletePath(copy, field);
      return copy;
    };
    const keyA = (item: Item) => stableKey(fields.map((f) => getPath(item.json, String(f.fieldA))));
    const keyB = (item: Item) => stableKey(fields.map((f) => getPath(item.json, String(f.fieldB))));
    const byKeyB = new Map<string, Item>();
    for (const item of b) if (!byKeyB.has(keyB(item))) byKeyB.set(keyB(item), item);
    const used = new Set<string>();
    const onlyA: Item[] = [];
    const same: Item[] = [];
    const different: Item[] = [];
    for (const item of a) {
      const key = keyA(item);
      const other = byKeyB.get(key);
      if (!other) {
        onlyA.push(item);
        continue;
      }
      used.add(key);
      if (deepEqual(strip(item.json), strip(other.json))) same.push(item);
      else {
        const keys = new Set([...Object.keys(item.json), ...Object.keys(other.json)].filter((k) => !skip.includes(k)));
        const differences: JsonObject = {};
        for (const k of keys) if (!deepEqual(item.json[k], other.json[k])) differences[k] = { inputA: item.json[k] ?? null, inputB: other.json[k] ?? null };
        different.push({ json: { keys: Object.fromEntries(fields.map((f) => [String(f.fieldA), getPath(item.json, String(f.fieldA))])), same: Object.fromEntries([...Object.keys(item.json)].filter((k) => !(k in differences)).map((k) => [k, item.json[k]])), different: differences } });
      }
    }
    const onlyB = b.filter((item) => !used.has(keyB(item)));
    return [onlyA, same, different, onlyB];
  },
};

const executionDataNode: NodeImpl = {
  type: "core.execution-data",
  async execute(ctx) {
    ctx.items.forEach((_, index) => {
      for (const row of ctx.param<{ key?: string; value?: unknown }[]>("dataToSave", index) ?? []) {
        const key = String(row.key ?? "").trim().slice(0, 50);
        if (!key) continue;
        if (!(key in ctx.customData) && Object.keys(ctx.customData).length >= 20) throw new NodeError("At most 20 keys can be saved with a run.");
        ctx.customData[key] = String(row.value ?? "").slice(0, 255);
      }
    });
    return [ctx.items];
  },
};

const FIRST = ["Ada", "Alan", "Grace", "Linus", "Margaret", "Ken", "Barbara", "Dennis", "Radia", "Tim"];
const LAST = ["Lovelace", "Turing", "Hopper", "Torvalds", "Hamilton", "Thompson", "Liskov", "Ritchie", "Perlman", "Berners-Lee"];

const debugHelperNode: NodeImpl = {
  type: "core.debug-helper",
  async execute(ctx) {
    const category = ctx.param<string>("category");
    if (category === "throwError") throw new NodeError(String(ctx.param("message") ?? "Debug error"));
    if (category === "doNothing") return [ctx.items];
    const count = Math.max(1, Math.min(1000, Math.floor(Number(ctx.param("count")) || 10)));
    return [
      Array.from({ length: count }, (_, index) => {
        const first = FIRST[index % FIRST.length];
        const last = LAST[(index * 7) % LAST.length];
        return { json: { id: randomUUID(), index, firstName: first, lastName: last, email: `${first}.${last}@example.com`.toLowerCase(), score: (index * 37) % 100, active: index % 3 !== 0, createdAt: new Date(ctx.now() - index * 86_400_000).toISOString() } };
      }),
    ];
  },
};

export const DATA_IMPLS: NodeImpl[] = [
  setNode,
  codeNode,
  splitOutNode,
  aggregateNode,
  sortNode,
  limitNode,
  removeDuplicatesNode,
  renameKeysNode,
  summarizeNode,
  compareDatasetsNode,
  executionDataNode,
  debugHelperNode,
];
