/**
 * Chroma operation spec -> validated Python (chromadb) and JavaScript (chromadb npm) code, plus explain.
 *
 * Rules and syntax come from the official Chroma docs (read 2026-10-07):
 *  - add / metadata types / array metadata    https://docs.trychroma.com/docs/collections/add-data
 *  - update / upsert                          https://docs.trychroma.com/docs/collections/update-data
 *  - delete                                   https://docs.trychroma.com/docs/collections/delete-data
 *  - create / get / get_or_create, naming     https://docs.trychroma.com/docs/collections/manage-collections
 *  - configuration (hnsw space ...)           https://docs.trychroma.com/docs/collections/configure
 *  - query / get, n_results, include, ids     https://docs.trychroma.com/docs/querying-collections/query-and-get
 *  - where operators, $and/$or, array metadata   https://docs.trychroma.com/docs/querying-collections/metadata-filtering
 *  - where_document $contains/$not_contains/$regex/$not_regex   https://docs.trychroma.com/docs/querying-collections/full-text-search
 *  - Persistent / Http / Cloud clients        https://docs.trychroma.com/docs/run-chroma/clients
 *  - embedding functions (default, none, OpenAI)   https://docs.trychroma.com/docs/embeddings/embedding-functions
 */
import * as z from "zod/v4";
import {
  didYouMean,
  findProtoKey,
  PROTO_KEY_MESSAGE,
  describe,
  group,
  hasErrors,
  isInt,
  isObj,
  jsKey,
  jsString,
  jsNumber,
  makeIssue,
  widthFor,
  printAt,
  printDoc,
  pyNumber,
  pyString,
  zodToIssues,
  type CompileOptions,
  type CompileResult,
  type Doc,
  type Item,
  type NosqlIssue,
  type Obj,
  type Snippet,
} from "./common";

export const CHROMA_OPS = ["create_collection", "get_or_create_collection", "add", "upsert", "update", "get", "query", "delete", "count"] as const;
export type ChromaOp = (typeof CHROMA_OPS)[number];

/** where operators (metadata-filtering page). `$contains`/`$not_contains` act on array metadata. */
export const WHERE_COMPARISON = ["$eq", "$ne", "$gt", "$gte", "$lt", "$lte"] as const;
export const WHERE_LIST = ["$in", "$nin"] as const;
export const WHERE_ARRAY = ["$contains", "$not_contains"] as const;
export const WHERE_OPERATORS = [...WHERE_COMPARISON, ...WHERE_LIST, ...WHERE_ARRAY] as const;
export const WHERE_LOGICAL = ["$and", "$or"] as const;
/** where_document operators (full-text-search page). */
export const DOC_OPERATORS = ["$contains", "$not_contains", "$regex", "$not_regex"] as const;
export const INCLUDE_GET = ["documents", "embeddings", "metadatas", "uris", "data"] as const;
export const INCLUDE_QUERY = [...INCLUDE_GET, "distances"] as const;
export const HNSW_SPACES = ["l2", "cosine", "ip"] as const;
export const CLIENT_TYPES = ["persistent", "http", "cloud", "ephemeral"] as const;
export const EMBEDDING_FUNCTIONS = ["default", "none", "openai"] as const;

/* ------------------------------------------------------------------- schema */

const object = (what: string) => z.record(z.string(), z.unknown(), { error: `${what} must be a JSON object` });
const list = (what: string) => z.array(z.unknown(), { error: `${what} must be a list` });
const count = (what: string, min = 0) => z.number({ error: `${what} must be a whole number` }).int({ error: `${what} must be a whole number` }).min(min, { error: `${what} must be ${min} or greater` });

const clientSchema = z.strictObject({
  type: z.enum(CLIENT_TYPES, { error: `client.type must be one of ${CLIENT_TYPES.join(", ")}` }).optional(),
  path: z.string({ error: "client.path must be a string" }).optional(),
  host: z.string({ error: "client.host must be a string" }).optional(),
  port: count("client.port", 1).max(65535, { error: "client.port must be 65535 or less" }).optional(),
  ssl: z.boolean({ error: "client.ssl must be true or false" }).optional(),
  tenant: z.string({ error: "client.tenant must be a string" }).optional(),
  database: z.string({ error: "client.database must be a string" }).optional(),
}, { error: "client must be an object like {\"type\": \"persistent\", \"path\": \"./chroma\"}" });

const base = {
  client: clientSchema.optional(),
  collection: z.string({ error: "collection is required: the collection name as a string" }).min(1, { error: "collection must not be empty" }),
};
const records = {
  ids: list("ids"),
  documents: list("documents").optional(),
  embeddings: list("embeddings").optional(),
  metadatas: list("metadatas").optional(),
};
const filters = { where: object("where").optional(), where_document: object("where_document").optional() };
const embeddingFunction = z.enum(EMBEDDING_FUNCTIONS, { error: `embedding_function must be one of ${EMBEDDING_FUNCTIONS.join(", ")}` }).optional();
const createShape = { metadata: object("metadata").optional(), configuration: object("configuration").optional(), embedding_function: embeddingFunction };

const shapes = {
  create_collection: createShape,
  get_or_create_collection: createShape,
  add: records,
  upsert: records,
  update: records,
  get: { ids: list("ids").optional(), ...filters, limit: count("limit", 1).optional(), offset: count("offset").optional(), include: list("include").optional() },
  query: { query_texts: list("query_texts").optional(), query_embeddings: list("query_embeddings").optional(), n_results: count("n_results", 1).optional(), ids: list("ids").optional(), ...filters, include: list("include").optional() },
  delete: { ids: list("ids").optional(), ...filters },
  count: {},
} satisfies Record<ChromaOp, z.ZodRawShape>;

function opSchema<Op extends ChromaOp>(op: Op) {
  return z.strictObject({ op: z.literal(op), ...base, ...shapes[op] });
}

export const chromaSpecSchema = z.discriminatedUnion("op", [
  opSchema("create_collection"), opSchema("get_or_create_collection"), opSchema("add"), opSchema("upsert"), opSchema("update"),
  opSchema("get"), opSchema("query"), opSchema("delete"), opSchema("count"),
]);
export type ChromaSpec = z.infer<typeof chromaSpecSchema>;

/** Fields each operation accepts (drives the form and the did-you-mean for unknown keys). */
export const CHROMA_FIELDS: Record<ChromaOp, string[]> = Object.fromEntries(CHROMA_OPS.map((op) => [op, ["op", "client", "collection", ...Object.keys(shapes[op])]])) as Record<ChromaOp, string[]>;

/* ---------------------------------------------------------------- validation */

type Scalar = string | number | boolean | bigint;
const isScalar = (v: unknown): v is Scalar => typeof v === "string" || typeof v === "boolean" || typeof v === "bigint" || (typeof v === "number" && Number.isFinite(v));
const isNumber = (v: unknown): boolean => typeof v === "bigint" || (typeof v === "number" && Number.isFinite(v));
const scalarType = (v: Scalar): string => (typeof v === "boolean" ? "bool" : typeof v === "string" ? "str" : Number.isInteger(v) || typeof v === "bigint" ? "int" : "float");

function path(base: string, key: string | number): string {
  return typeof key === "number" ? `${base}[${key}]` : base ? `${base}.${key}` : key;
}

export function checkCollectionName(name: string, at: string, out: NosqlIssue[]): void {
  if (name.length < 3 || name.length > 512) out.push(makeIssue("error", at, `Collection names must be 3 to 512 characters; "${name}" has ${name.length}.`));
  if (!/^[A-Za-z0-9._-]*$/.test(name)) out.push(makeIssue("error", at, `Collection name "${name}" may only contain letters, digits, dots, dashes and underscores.`, "Replace spaces and other symbols with - or _."));
  else if (!/^[A-Za-z0-9].*[A-Za-z0-9]$/.test(name) && name.length >= 3) out.push(makeIssue("error", at, "A collection name must start and end with a letter or a digit."));
  if (/[A-Z]/.test(name)) out.push(makeIssue("warning", at, "The Chroma docs say names start and end with a lowercase letter or digit; uppercase may be rejected by some versions.", "Use lowercase to be safe."));
  if (name.includes("..")) out.push(makeIssue("error", at, "A collection name must not contain two consecutive dots."));
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) out.push(makeIssue("error", at, "A collection name must not be a valid IP address."));
}

/** One metadata value: str / int / float / bool, or a non-empty array of one such type. */
function checkMetadataValue(value: unknown, at: string, out: NosqlIssue[]): void {
  if (isScalar(value)) return;
  if (Array.isArray(value)) {
    if (!value.length) return void out.push(makeIssue("error", at, "Empty arrays are not allowed in metadata."));
    if (!value.every(isScalar)) return void out.push(makeIssue("error", at, "Array metadata may only contain strings, numbers or booleans (no nested arrays, objects or null)."));
    const kinds = new Set(value.map((v) => scalarType(v as Scalar)));
    if (kinds.size > 1) out.push(makeIssue("error", at, `All elements of a metadata array must be the same type, found ${[...kinds].join(" and ")}.`));
    return;
  }
  if (value === null) return void out.push(makeIssue("error", at, "Metadata values cannot be null.", "Leave the key out instead."));
  if (isObj(value)) return void out.push(makeIssue("error", at, "Metadata values cannot be nested objects.", "Flatten it: {\"address_city\": \"Oslo\"} instead of {\"address\": {\"city\": \"Oslo\"}}."));
  out.push(makeIssue("error", at, `Metadata values must be a string, number, boolean or an array of those, got ${describe(value)}.`));
}

export function checkMetadataObject(meta: unknown, at: string, out: NosqlIssue[], allowEmpty = false): void {
  if (!isObj(meta)) return void out.push(makeIssue("error", at, `Metadata must be an object of key/value pairs, got ${describe(meta)}.`));
  const keys = Object.keys(meta);
  if (!keys.length && !allowEmpty) out.push(makeIssue("warning", at, "An empty metadata object is rejected by some Chroma versions.", "Use null for records without metadata, or add a key."));
  for (const key of keys) {
    if (key.startsWith("chroma:")) out.push(makeIssue("error", path(at, key), `Keys starting with "chroma:" are reserved by Chroma ("${key}").`));
    checkMetadataValue(meta[key], path(at, key), out);
  }
}

function checkRecords(spec: { op: ChromaOp; ids?: unknown[]; documents?: unknown[]; embeddings?: unknown[]; metadatas?: unknown[] }, out: NosqlIssue[]): void {
  const { ids, documents, embeddings, metadatas } = spec;
  if (ids) {
    if (!ids.length) out.push(makeIssue("error", "ids", "ids must contain at least one id."));
    const seen = new Map<string, number>();
    ids.forEach((id, index) => {
      if (typeof id !== "string" || !id) return void out.push(makeIssue("error", path("ids", index), `Every id must be a non-empty string, got ${typeof id === "string" ? "an empty string" : describe(id)}.`, 'Chroma ids are strings, e.g. "doc-1".'));
      if (seen.has(id)) out.push(makeIssue("error", path("ids", index), `Duplicate id "${id}" (also at ids[${seen.get(id)}]). Chroma rejects batches with repeated ids.`, "Make each id unique within the call."));
      else seen.set(id, index);
    });
  }
  const lengths: [string, number][] = [];
  if (ids) lengths.push(["ids", ids.length]);
  if (documents) {
    lengths.push(["documents", documents.length]);
    documents.forEach((doc, index) => typeof doc !== "string" && out.push(makeIssue("error", path("documents", index), `Every document must be a string, got ${describe(doc)}.`)));
  }
  if (embeddings) {
    lengths.push(["embeddings", embeddings.length]);
    let dim: number | undefined;
    embeddings.forEach((vec, index) => {
      const at = path("embeddings", index);
      if (!Array.isArray(vec) || !vec.length) return void out.push(makeIssue("error", at, "Every embedding must be a non-empty list of numbers."));
      vec.forEach((n, j) => !isNumber(n) && out.push(makeIssue("error", path(at, j), `Embedding values must be finite numbers, got ${describe(n)}.`)));
      if (dim === undefined) dim = vec.length;
      else if (vec.length !== dim) out.push(makeIssue("error", at, `This embedding has ${vec.length} numbers but embeddings[0] has ${dim}: all embeddings in a call must have the same dimension.`));
    });
    if (embeddings.length) out.push(makeIssue("info", "embeddings", "The dimension must match the collection's existing embeddings (it is fixed by the first insert)."));
  }
  if (metadatas) {
    lengths.push(["metadatas", metadatas.length]);
    metadatas.forEach((meta, index) => (meta === null ? undefined : checkMetadataObject(meta, path("metadatas", index), out)));
  }
  const first = lengths[0];
  for (const [name, len] of lengths.slice(1)) if (first && len !== first[1]) out.push(makeIssue("error", name, `${name} has ${len} item${len === 1 ? "" : "s"} but ${first[0]} has ${first[1]}: the lists must be the same length (item i of each list describes record i).`));
  if (spec.op === "add" || spec.op === "upsert") {
    if (!documents && !embeddings) out.push(makeIssue("error", "documents", `${spec.op} needs documents, embeddings, or both.`, "Give documents and Chroma will embed them, or give your own embeddings."));
    else if (documents && !embeddings) out.push(makeIssue("info", "documents", "No embeddings given: Chroma embeds the documents with the collection's embedding function (default: a local sentence-transformer, all-MiniLM-L6-v2)."));
    else if (documents && embeddings) out.push(makeIssue("info", "embeddings", "Documents and embeddings both given: Chroma stores them as-is and does not re-embed the documents."));
  }
  if (spec.op === "update") {
    if (!documents && !embeddings && !metadatas) out.push(makeIssue("error", "documents", "update needs at least one of documents, embeddings or metadatas.", "Pass the property you want to change."));
    if (documents && !embeddings) out.push(makeIssue("info", "documents", "Documents without embeddings: the embeddings are recomputed with the collection's embedding function."));
    out.push(makeIssue("info", "ids", "Ids that do not exist are ignored (an error is logged). Use upsert to insert-or-update."));
  }
  if (spec.op === "add") out.push(makeIssue("info", "ids", "add ignores ids that already exist without an error. Use update or upsert to overwrite."));
}

export function checkWhere(where: unknown, at: string, out: NosqlIssue[], depth = 0): void {
  if (!isObj(where)) return void out.push(makeIssue("error", at, `A where filter must be an object, got ${describe(where)}.`, 'Example: {"page": {"$gt": 10}}.'));
  if (depth > 50) return void out.push(makeIssue("error", at, "where is nested too deeply."));
  const keys = Object.keys(where);
  if (!keys.length) return void out.push(makeIssue("error", at, "where is empty.", "Leave `where` out to match everything."));
  if (keys.length > 1) {
    out.push(makeIssue("error", at, `A where object must hold exactly one condition, found ${keys.length} (${keys.join(", ")}). Chroma does not treat several keys as AND.`, `Combine them: {"$and": [${keys.map((k) => `{"${k}": ...}`).join(", ")}]}.`));
    return;
  }
  const key = keys[0];
  const value = where[key];
  const here = path(at, key);
  if (key.startsWith("$")) {
    if (!(WHERE_LOGICAL as readonly string[]).includes(key)) {
      const hint = (DOC_OPERATORS as readonly string[]).includes(key) ? `${key} filters document text, so it belongs in where_document, not where.` : `Unknown where operator ${key}.${didYouMean(key, [...WHERE_LOGICAL, ...WHERE_OPERATORS])}`;
      return void out.push(makeIssue("error", here, hint, (WHERE_OPERATORS as readonly string[]).includes(key) ? `Operators go under a metadata field: {"field": {"${key}": value}}.` : undefined));
    }
    if (!Array.isArray(value) || value.length < 2) return void out.push(makeIssue("error", here, `${key} needs a list of at least 2 conditions (got ${Array.isArray(value) ? value.length : describe(value)}).`, value && Array.isArray(value) && value.length === 1 ? "With one condition just write it directly." : `Write ${key}: [ {...}, {...} ].`));
    value.forEach((clause, i) => checkWhere(clause, path(here, i), out, depth + 1));
    return;
  }
  if (isScalar(value)) return;
  if (!isObj(value)) return void out.push(makeIssue("error", here, `The condition for "${key}" must be a value or an operator object, got ${describe(value)}.`, "Use a string, number or boolean for equality, or {\"$in\": [...]}."));
  const ops = Object.keys(value);
  if (ops.length !== 1) return void out.push(makeIssue("error", here, `The condition for "${key}" needs exactly one operator, found ${ops.length}.`, ops.length ? `Split into {"$and": [${ops.map((o) => `{"${key}": {"${o}": ...}}`).join(", ")}]}.` : undefined));
  const op = ops[0];
  const operand = value[op];
  const opAt = path(here, op);
  if (!(WHERE_OPERATORS as readonly string[]).includes(op)) {
    const hint = (DOC_OPERATORS as readonly string[]).includes(op) ? `${op} filters document text, so it belongs in where_document.` : `Unknown where operator ${op}.${didYouMean(op, WHERE_OPERATORS)}`;
    return void out.push(makeIssue("error", opAt, hint, `Operators: ${WHERE_OPERATORS.join(", ")}.`));
  }
  if ((["$gt", "$gte", "$lt", "$lte"] as string[]).includes(op)) {
    if (!isNumber(operand)) out.push(makeIssue("error", opAt, `${op} needs a number (int or float), got ${describe(operand)}.`, "Comparison operators only work on numeric metadata."));
  } else if ((["$eq", "$ne", "$contains", "$not_contains"] as string[]).includes(op)) {
    if (!isScalar(operand)) out.push(makeIssue("error", opAt, `${op} needs a string, number or boolean, got ${describe(operand)}.`));
  } else {
    if (!Array.isArray(operand) || !operand.length) return void out.push(makeIssue("error", opAt, `${op} needs a non-empty list of values.`));
    if (!operand.every(isScalar)) return void out.push(makeIssue("error", opAt, `${op} may only contain strings, numbers or booleans.`));
    const kinds = new Set(operand.map((v) => scalarType(v as Scalar)));
    if (kinds.size > 1) out.push(makeIssue("error", opAt, `All values in ${op} must be the same type, found ${[...kinds].join(" and ")}.`));
  }
}

export function checkWhereDocument(where: unknown, at: string, out: NosqlIssue[], depth = 0): void {
  if (!isObj(where)) return void out.push(makeIssue("error", at, `where_document must be an object, got ${describe(where)}.`, 'Example: {"$contains": "search text"}.'));
  if (depth > 50) return void out.push(makeIssue("error", at, "where_document is nested too deeply."));
  const keys = Object.keys(where);
  if (keys.length !== 1) return void out.push(makeIssue("error", at, `where_document needs exactly one operator, found ${keys.length}.`, keys.length ? `Combine with {"$and": [${keys.map((k) => `{"${k}": ...}`).join(", ")}]}.` : undefined));
  const op = keys[0];
  const value = where[op];
  const here = path(at, op);
  if ((WHERE_LOGICAL as readonly string[]).includes(op)) {
    if (!Array.isArray(value) || value.length < 2) return void out.push(makeIssue("error", here, `${op} needs a list of at least 2 conditions.`));
    value.forEach((clause, i) => checkWhereDocument(clause, path(here, i), out, depth + 1));
    return;
  }
  if (!(DOC_OPERATORS as readonly string[]).includes(op)) {
    const hint = (WHERE_OPERATORS as readonly string[]).includes(op) && !(DOC_OPERATORS as readonly string[]).includes(op) ? `${op} filters metadata, so it belongs in where, not where_document.` : `Unknown where_document operator ${op}.${didYouMean(op, [...WHERE_LOGICAL, ...DOC_OPERATORS])}`;
    return void out.push(makeIssue("error", here, hint, `Operators: ${DOC_OPERATORS.join(", ")}, $and, $or.`));
  }
  if (typeof value !== "string" || !value) return void out.push(makeIssue("error", here, `${op} needs a non-empty string.`));
  if (op === "$contains" || op === "$not_contains") out.push(makeIssue("info", here, "Full-text matching is case-sensitive."));
}

function checkInclude(include: unknown[] | undefined, allowed: readonly string[], at: string, out: NosqlIssue[]): void {
  include?.forEach((item, index) => {
    if (typeof item !== "string" || !allowed.includes(item)) {
      const hint = item === "ids" ? "ids are always returned; do not list them." : item === "distances" ? "distances are only returned by query." : didYouMean(String(item), allowed).trim();
      out.push(makeIssue("error", path(at, index), `"${String(item)}" is not a valid include value.${hint ? ` ${hint}` : ""}`, `Valid: ${allowed.join(", ")}.`));
    }
  });
}

function checkClient(client: ChromaSpec["client"], out: NosqlIssue[]): void {
  if (!client) return;
  const type = client.type ?? "persistent";
  if (type !== "persistent" && client.path) out.push(makeIssue("warning", "client.path", `client.path only applies to the persistent client; it is ignored for "${type}".`));
  if (type !== "http" && (client.host || client.port || client.ssl !== undefined)) out.push(makeIssue("warning", "client", `host/port/ssl only apply to the http client; they are ignored for "${type}".`));
  if (type !== "cloud" && (client.tenant || client.database)) out.push(makeIssue("warning", "client", `tenant/database only apply to the cloud client; they are ignored for "${type}".`));
  if (type === "cloud") out.push(makeIssue("info", "client", "The cloud client reads the API key from the CHROMA_API_KEY environment variable in the generated code; never paste the key into a spec."));
}

export function check(input: unknown): { spec?: ChromaSpec; issues: NosqlIssue[] } {
  if (!isObj(input)) return { issues: [makeIssue("error", "(spec)", 'The spec must be a JSON object like {"op": "query", "collection": "docs", ...}.')] };
  const op = input.op;
  if (typeof op !== "string") return { issues: [makeIssue("error", "op", 'Missing "op": which operation to run.', `Choose one of: ${CHROMA_OPS.join(", ")}.`)] };
  if (!(CHROMA_OPS as readonly string[]).includes(op)) return { issues: [makeIssue("error", "op", `Unknown operation "${op}".${didYouMean(op, CHROMA_OPS)}`, `Choose one of: ${CHROMA_OPS.join(", ")}.`)] };
  const proto = findProtoKey(input);
  if (proto) return { issues: [makeIssue("error", proto, PROTO_KEY_MESSAGE, "Rename the field.")] };
  const parsed = chromaSpecSchema.safeParse(input);
  if (!parsed.success) return { issues: zodToIssues(parsed.error, CHROMA_FIELDS[op as ChromaOp]) };
  const spec = parsed.data;
  const out: NosqlIssue[] = [];
  checkClient(spec.client, out);
  if (spec.op === "create_collection" || spec.op === "get_or_create_collection") checkCollectionName(spec.collection, "collection", out);
  switch (spec.op) {
    case "create_collection":
    case "get_or_create_collection": {
      if (spec.metadata) {
        checkMetadataObject(spec.metadata, "metadata", out, true);
        if ("hnsw:space" in spec.metadata) out.push(makeIssue("info", "metadata.hnsw:space", 'The "hnsw:space" metadata key is the legacy way to set the distance; prefer configuration.hnsw.space.'));
      }
      const hnsw = isObj(spec.configuration) ? spec.configuration.hnsw : undefined;
      if (spec.configuration) {
        for (const key of Object.keys(spec.configuration)) if (!["hnsw", "spann", "embedding_function"].includes(key)) out.push(makeIssue("warning", `configuration.${key}`, `Unknown configuration section "${key}".${didYouMean(key, ["hnsw", "spann", "embedding_function"])}`));
      }
      if (hnsw !== undefined) {
        if (!isObj(hnsw)) out.push(makeIssue("error", "configuration.hnsw", "configuration.hnsw must be an object."));
        else {
          if ("space" in hnsw && !(HNSW_SPACES as readonly unknown[]).includes(hnsw.space)) out.push(makeIssue("error", "configuration.hnsw.space", `space must be one of ${HNSW_SPACES.join(", ")} (l2 = squared L2, cosine, ip = inner product).`));
          for (const key of ["ef_construction", "ef_search", "max_neighbors"]) if (key in hnsw && !(isInt(hnsw[key]) && (hnsw[key] as number) > 0)) out.push(makeIssue("error", `configuration.hnsw.${key}`, `${key} must be a positive whole number.`));
          for (const key of Object.keys(hnsw)) if (!["space", "ef_construction", "ef_search", "max_neighbors", "num_threads", "batch_size", "sync_threshold", "resize_factor"].includes(key)) out.push(makeIssue("warning", `configuration.hnsw.${key}`, `Unknown hnsw setting "${key}".`));
        }
      }
      if (spec.op === "create_collection") out.push(makeIssue("info", "op", "create_collection raises an error if the name already exists; use get_or_create_collection to be idempotent."));
      if (spec.embedding_function === "openai") out.push(makeIssue("info", "embedding_function", "The OpenAI embedding function reads OPENAI_API_KEY from the environment; the model is text-embedding-3-small."));
      if (!spec.embedding_function || spec.embedding_function === "default") out.push(makeIssue("info", "embedding_function", "The default embedding function is a local sentence-transformer (all-MiniLM-L6-v2, 384 dimensions); the first use downloads the model."));
      if (spec.embedding_function === "none") out.push(makeIssue("info", "embedding_function", "With no embedding function you must pass embeddings (add) and query_embeddings (query) yourself."));
      break;
    }
    case "add":
    case "upsert":
    case "update":
      checkRecords(spec, out);
      break;
    case "get":
      if (spec.where) checkWhere(spec.where, "where", out);
      if (spec.where_document) checkWhereDocument(spec.where_document, "where_document", out);
      checkInclude(spec.include, INCLUDE_GET, "include", out);
      if (spec.ids) checkRecords({ op: "get", ids: spec.ids }, out);
      if (spec.offset && !spec.limit) out.push(makeIssue("info", "offset", "offset without limit skips records but still returns all the rest."));
      if (!spec.ids && !spec.where && !spec.where_document && !spec.limit) out.push(makeIssue("info", "limit", "No ids, filters or limit: this returns every record in the collection.", "Add a limit while exploring."));
      break;
    case "query": {
      const hasTexts = spec.query_texts !== undefined;
      const hasVecs = spec.query_embeddings !== undefined;
      if (!hasTexts && !hasVecs) out.push(makeIssue("error", "query_texts", "query needs query_texts or query_embeddings.", "query_texts is easiest when the collection has an embedding function."));
      if (hasTexts && hasVecs) out.push(makeIssue("error", "query_embeddings", "Give either query_texts or query_embeddings, not both.", "Chroma accepts exactly one kind of query input."));
      spec.query_texts?.forEach((t, i) => typeof t !== "string" && out.push(makeIssue("error", path("query_texts", i), `Every query text must be a string, got ${describe(t)}.`)));
      if (spec.query_texts && !spec.query_texts.length) out.push(makeIssue("error", "query_texts", "query_texts must not be empty."));
      if (spec.query_embeddings) {
        if (!spec.query_embeddings.length) out.push(makeIssue("error", "query_embeddings", "query_embeddings must not be empty."));
        let dim: number | undefined;
        spec.query_embeddings.forEach((vec, i) => {
          if (!Array.isArray(vec) || !vec.length || !vec.every(isNumber)) return void out.push(makeIssue("error", path("query_embeddings", i), "Every query embedding must be a non-empty list of numbers."));
          if (dim === undefined) dim = vec.length;
          else if (vec.length !== dim) out.push(makeIssue("error", path("query_embeddings", i), `This embedding has ${vec.length} numbers but query_embeddings[0] has ${dim}.`));
        });
        out.push(makeIssue("info", "query_embeddings", "The dimension must match the collection's embeddings."));
      }
      if (spec.query_texts) out.push(makeIssue("info", "query_texts", "The texts are embedded with the collection's embedding function; if the collection was created with embedding_function none, use query_embeddings."));
      if (spec.where) checkWhere(spec.where, "where", out);
      if (spec.where_document) checkWhereDocument(spec.where_document, "where_document", out);
      checkInclude(spec.include, INCLUDE_QUERY, "include", out);
      if (spec.ids) checkRecords({ op: "get", ids: spec.ids }, out);
      if (spec.n_results === undefined) out.push(makeIssue("info", "n_results", "n_results defaults to 10 results per query."));
      break;
    }
    case "delete":
      if (!spec.ids && !spec.where && !spec.where_document) out.push(makeIssue("error", "ids", "delete needs ids, where or where_document: Chroma refuses to delete without a selector.", "Pass the ids to delete, or a filter."));
      if (spec.ids) checkRecords({ op: "get", ids: spec.ids }, out);
      if (spec.where) checkWhere(spec.where, "where", out);
      if (spec.where_document) checkWhereDocument(spec.where_document, "where_document", out);
      out.push(makeIssue("warning", "op", "delete is permanent: embeddings, documents and metadata of the matching records are removed."));
      break;
    case "count":
      break;
  }
  return { spec, issues: out };
}

export function validate(input: unknown): { ok: boolean; issues: NosqlIssue[] } {
  const { issues } = check(input);
  return { ok: !hasErrors(issues), issues };
}

/* ------------------------------------------------------------------- render */

type Lang = "python" | "javascript";

interface Ctx {
  issues: NosqlIssue[];
}

function plain(value: unknown, lang: Lang, ctx: Ctx, at: string): Doc {
  if (value === null) return lang === "python" ? "None" : "null";
  if (typeof value === "boolean") return lang === "python" ? (value ? "True" : "False") : String(value);
  if (typeof value === "string") return lang === "python" ? pyString(value) : jsString(value);
  if (typeof value === "bigint") {
    if (lang === "javascript") ctx.issues.push(makeIssue("warning", at, "This integer is larger than 2^53: JavaScript numbers lose precision, so the JS client would store a different value.", "Use the Python snippet, or store it as a string."));
    return value.toString();
  }
  if (typeof value === "number") {
    if (lang === "javascript" && Number.isInteger(value) && !Number.isSafeInteger(value)) ctx.issues.push(makeIssue("warning", at, "Number is outside JavaScript's exact integer range."));
    return lang === "python" ? pyNumber(value) : jsNumber(value);
  }
  if (Array.isArray(value)) return group("[", "]", value.map((item, i) => ({ value: plain(item, lang, ctx, `${at}[${i}]`) })));
  if (isObj(value)) {
    const items: Item[] = Object.entries(value).map(([k, v]) => ({
      key: lang === "python" ? `${pyString(k)}: ` : `${jsKey(k)}: `,
      value: plain(v, lang, ctx, `${at}.${k}`),
    }));
    return group("{", "}", items, lang === "javascript");
  }
  return lang === "python" ? "None" : "null";
}

function pyCall(prefix: string, kwargs: [string, Doc][], width: number): string {
  if (!kwargs.length) return `${prefix}()`;
  return `${prefix}${printAt(group("(", ")", kwargs.map(([k, v]) => ({ key: `${k}=`, value: v }))), prefix.length, 0, "    ", width, 1)}`;
}

function jsCall(prefix: string, props: [string, Doc][], width: number): string {
  if (!props.length) return `${prefix}()`;
  const body = group("{", "}", props.map(([k, v]) => ({ key: `${k}: `, value: v })), true);
  return `${prefix}(${printAt(body, prefix.length + 1, 0, "  ", width, 2)});`;
}

function pyClient(spec: ChromaSpec): { imports: string[]; line: string } {
  const c = spec.client ?? {};
  const type = c.type ?? "persistent";
  if (type === "http") {
    const args = [`host=${pyString(c.host ?? "localhost")}`, `port=${c.port ?? 8000}`, ...(c.ssl ? ["ssl=True"] : [])];
    return { imports: ["import chromadb"], line: `client = chromadb.HttpClient(${args.join(", ")})` };
  }
  if (type === "cloud") {
    const args = [...(c.tenant ? [`tenant=${pyString(c.tenant)}`] : []), ...(c.database ? [`database=${pyString(c.database)}`] : []), 'api_key=os.environ["CHROMA_API_KEY"]'];
    return { imports: ["import os", "import chromadb"], line: `client = chromadb.CloudClient(${args.join(", ")})` };
  }
  if (type === "ephemeral") return { imports: ["import chromadb"], line: "client = chromadb.Client()  # in-memory: data is lost when the program exits" };
  return { imports: ["import chromadb"], line: `client = chromadb.PersistentClient(path=${pyString(c.path ?? "./chroma")})` };
}

function jsClient(spec: ChromaSpec): { imports: string[]; line: string; note?: string } {
  const c = spec.client ?? {};
  const type = c.type ?? "persistent";
  if (type === "cloud") {
    const args = [...(c.tenant ? [`tenant: ${jsString(c.tenant)}`] : []), ...(c.database ? [`database: ${jsString(c.database)}`] : []), "apiKey: process.env.CHROMA_API_KEY"];
    return { imports: ["CloudClient"], line: `const client = new CloudClient({ ${args.join(", ")} });` };
  }
  const args = [`host: ${jsString(c.host ?? "localhost")}`, `port: ${c.port ?? 8000}`, `ssl: ${c.ssl ? "true" : "false"}`];
  const note = type === "persistent" || type === "ephemeral" ? `// The JS client talks to a Chroma server; start one with: npx chroma run --path ${c.path ?? "./chroma"}\n` : "";
  return { imports: ["ChromaClient"], line: `const client = new ChromaClient({ ${args.join(", ")} });`, note };
}

function embeddingFn(kind: string | undefined, lang: Lang): { import?: string; expr?: string } {
  if (kind === "none") return { expr: lang === "python" ? "None" : "null" };
  if (kind === "openai") {
    return lang === "python"
      ? { import: "from chromadb.utils.embedding_functions import OpenAIEmbeddingFunction", expr: 'OpenAIEmbeddingFunction(api_key=os.getenv("OPENAI_API_KEY"), model_name="text-embedding-3-small")' }
      : { import: 'import { OpenAIEmbeddingFunction } from "@chroma-core/openai";', expr: 'new OpenAIEmbeddingFunction({ apiKey: process.env.OPENAI_API_KEY, modelName: "text-embedding-3-small" })' };
  }
  return {};
}

const PY_KEYS = ["ids", "documents", "embeddings", "metadatas"] as const;

function renderPython(spec: ChromaSpec, ctx: Ctx, width: number): string {
  const client = pyClient(spec);
  const imports = [...client.imports];
  const body: string[] = [];
  const name = pyString(spec.collection);
  const kwargs: [string, Doc][] = [];
  const p = (value: unknown, at: string) => plain(value, "python", ctx, at);
  const take = (key: string, value: unknown) => value !== undefined && kwargs.push([key, p(value, key)]);
  if (spec.op === "create_collection" || spec.op === "get_or_create_collection") {
    const fn = embeddingFn(spec.embedding_function, "python");
    if (fn.import) imports.push("import os", fn.import);
    const args: [string, Doc][] = [["name", name]];
    if (spec.metadata) args.push(["metadata", p(spec.metadata, "metadata")]);
    if (spec.configuration) args.push(["configuration", p(spec.configuration, "configuration")]);
    if (fn.expr) args.push(["embedding_function", fn.expr]);
    body.push(pyCall(`collection = client.${spec.op}`, args, width), "print(collection.name)");
  } else {
    body.push(`collection = client.get_collection(name=${name})`);
    switch (spec.op) {
      case "add":
      case "upsert":
      case "update":
        for (const key of PY_KEYS) take(key, spec[key]);
        body.push(pyCall(`collection.${spec.op}`, kwargs, width));
        break;
      case "get":
        take("ids", spec.ids); take("where", spec.where); take("where_document", spec.where_document); take("limit", spec.limit); take("offset", spec.offset); take("include", spec.include);
        body.push(pyCall("results = collection.get", kwargs, width), "print(results)");
        break;
      case "query":
        take("query_texts", spec.query_texts); take("query_embeddings", spec.query_embeddings); take("n_results", spec.n_results); take("ids", spec.ids); take("where", spec.where); take("where_document", spec.where_document); take("include", spec.include);
        body.push(pyCall("results = collection.query", kwargs, width), "print(results)");
        break;
      case "delete":
        take("ids", spec.ids); take("where", spec.where); take("where_document", spec.where_document);
        body.push(pyCall("collection.delete", kwargs, width));
        break;
      case "count":
        body.push("print(collection.count())");
        break;
    }
  }
  const uniq = [...new Set(imports)];
  const std = uniq.filter((i) => i === "import os");
  const rest = uniq.filter((i) => i !== "import os");
  return `${[...std, ...rest].join("\n")}\n\n${client.line}\n${body.join("\n")}\n`;
}

function renderJs(spec: ChromaSpec, ctx: Ctx, width: number): string {
  const client = jsClient(spec);
  const extraImports: string[] = [];
  const name = jsString(spec.collection);
  const props: [string, Doc][] = [];
  const p = (value: unknown, at: string) => plain(value, "javascript", ctx, at);
  const take = (key: string, field: string, value: unknown) => value !== undefined && props.push([key, p(value, field)]);
  const body: string[] = [];
  if (spec.op === "create_collection" || spec.op === "get_or_create_collection") {
    const fn = embeddingFn(spec.embedding_function, "javascript");
    if (fn.import) extraImports.push(fn.import);
    const args: [string, Doc][] = [["name", name]];
    if (spec.metadata) args.push(["metadata", p(spec.metadata, "metadata")]);
    if (spec.configuration) args.push(["configuration", p(spec.configuration, "configuration")]);
    if (fn.expr) args.push(["embeddingFunction", fn.expr]);
    const method = spec.op === "create_collection" ? "createCollection" : "getOrCreateCollection";
    body.push(jsCall(`const collection = await client.${method}`, args, width), "console.log(collection.name);");
  } else {
    body.push(`const collection = await client.getCollection({ name: ${name} });`);
    switch (spec.op) {
      case "add":
      case "upsert":
      case "update":
        for (const key of PY_KEYS) take(key, key, spec[key]);
        body.push(jsCall(`await collection.${spec.op}`, props, width));
        break;
      case "get":
        take("ids", "ids", spec.ids); take("where", "where", spec.where); take("whereDocument", "where_document", spec.where_document); take("limit", "limit", spec.limit); take("offset", "offset", spec.offset); take("include", "include", spec.include);
        body.push(jsCall("const results = await collection.get", props, width), "console.log(results);");
        break;
      case "query":
        take("queryTexts", "query_texts", spec.query_texts); take("queryEmbeddings", "query_embeddings", spec.query_embeddings); take("nResults", "n_results", spec.n_results); take("ids", "ids", spec.ids); take("where", "where", spec.where); take("whereDocument", "where_document", spec.where_document); take("include", "include", spec.include);
        body.push(jsCall("const results = await collection.query", props, width), "console.log(results);");
        break;
      case "delete":
        take("ids", "ids", spec.ids); take("where", "where", spec.where); take("whereDocument", "where_document", spec.where_document);
        body.push(jsCall("await collection.delete", props, width));
        break;
      case "count":
        body.push("console.log(await collection.count());");
        break;
    }
  }
  const imports = `import { ${client.imports.join(", ")} } from "chromadb";${extraImports.length ? `\n${extraImports.join("\n")}` : ""}`;
  return `${imports}\n\n${client.note ?? ""}${client.line}\n${body.join("\n")}\n`;
}

export function compile(input: unknown, options?: CompileOptions): CompileResult {
  const { spec, issues } = check(input);
  if (!spec || hasErrors(issues)) return { ok: false, snippets: [], issues };
  const ctx: Ctx = { issues: [] };
  const width = widthFor(options);
  const snippets: Snippet[] = [
    { language: "python", label: `Python (chromadb, ${clientLabel(spec)})`, code: renderPython(spec, ctx, width) },
    { language: "javascript", label: "JavaScript (chromadb npm)", code: renderJs(spec, ctx, width) },
  ];
  const all = [...issues];
  const seen = new Set(all.map((i) => `${i.path}|${i.message}`));
  for (const item of ctx.issues) {
    const key = `${item.path}|${item.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(item);
  }
  return { ok: !hasErrors(all), snippets, issues: all };
}

function clientLabel(spec: ChromaSpec): string {
  const type = spec.client?.type ?? "persistent";
  return type === "persistent" ? "PersistentClient" : type === "http" ? "HttpClient" : type === "cloud" ? "CloudClient" : "Client";
}

/* -------------------------------------------------------------------- explain */

function flat(value: unknown): string {
  return printDoc(plain(value, "javascript", { issues: [] }, ""), 0, 0, 1e9);
}

const WORDS: Record<string, string> = { $eq: "equals", $ne: "is not", $gt: "is greater than", $gte: "is at least", $lt: "is less than", $lte: "is at most", $in: "is one of", $nin: "is none of", $contains: "contains", $not_contains: "does not contain" };

export function describeWhere(where: unknown): string {
  if (!isObj(where)) return "?";
  const [key] = Object.keys(where);
  if (key === "$and" || key === "$or") return (where[key] as unknown[]).map((c) => `(${describeWhere(c)})`).join(key === "$and" ? " AND " : " OR ");
  const value = where[key];
  if (isObj(value)) {
    const [op] = Object.keys(value);
    return `metadata "${key}" ${WORDS[op] ?? op} ${flat(value[op])}`;
  }
  return `metadata "${key}" equals ${flat(value)}`;
}

export function describeWhereDocument(where: unknown): string {
  if (!isObj(where)) return "?";
  const [key] = Object.keys(where);
  if (key === "$and" || key === "$or") return (where[key] as unknown[]).map((c) => `(${describeWhereDocument(c)})`).join(key === "$and" ? " AND " : " OR ");
  const words: Record<string, string> = { $contains: "contains the text", $not_contains: "does not contain the text", $regex: "matches the regex", $not_regex: "does not match the regex" };
  return `the document ${words[key] ?? key} ${flat(where[key])}`;
}

export function explain(input: unknown): string[] {
  const { spec } = check(input);
  if (!spec) return [];
  const steps = [`Connect with a ${clientLabel(spec)}${spec.client?.type === "http" ? ` to ${spec.client.host ?? "localhost"}:${spec.client.port ?? 8000}` : ""}.`];
  const selector = (s: { ids?: unknown[]; where?: unknown; where_document?: unknown }) => [s.ids ? `ids in ${flat(s.ids)}` : "", s.where ? describeWhere(s.where) : "", s.where_document ? describeWhereDocument(s.where_document) : ""].filter(Boolean).join(" AND ");
  switch (spec.op) {
    case "create_collection":
    case "get_or_create_collection": {
      steps.push(`${spec.op === "create_collection" ? "Create" : "Get, or create if missing,"} the collection "${spec.collection}".`);
      const space = isObj(spec.configuration?.hnsw) ? (spec.configuration?.hnsw as Obj).space : undefined;
      if (space) steps.push(`Measure similarity with the "${space}" distance.`);
      steps.push(spec.embedding_function === "none" ? "No embedding function: you supply embeddings yourself." : spec.embedding_function === "openai" ? "Embed text with OpenAI text-embedding-3-small." : "Embed text with Chroma's default local embedding function.");
      break;
    }
    case "add":
    case "upsert":
    case "update":
      steps.push(`Open the collection "${spec.collection}".`, `${spec.op === "add" ? "Add" : spec.op === "upsert" ? "Insert or overwrite" : "Update"} ${spec.ids.length} record${spec.ids.length === 1 ? "" : "s"} (ids: ${flat(spec.ids)}).`);
      if (spec.documents) steps.push(spec.embeddings ? "Store the documents and your embeddings as given." : "Embed the documents with the collection's embedding function.");
      if (spec.metadatas) steps.push("Attach the metadata to each record.");
      break;
    case "get":
      steps.push(`Open the collection "${spec.collection}".`, `Fetch records${selector(spec) ? ` where ${selector(spec)}` : ""}${spec.limit ? `, at most ${spec.limit}` : ""}${spec.offset ? ` starting at ${spec.offset}` : ""} (no similarity ranking).`);
      break;
    case "query":
      steps.push(`Open the collection "${spec.collection}".`, `Embed ${spec.query_texts ? `${spec.query_texts.length} query text${spec.query_texts.length === 1 ? "" : "s"}` : "(your query embeddings are used as given)"}.`, `For each query, return the ${spec.n_results ?? 10} nearest records${selector(spec) ? `, only among records where ${selector(spec)}` : ""}.`);
      steps.push(`Results come back grouped per query: ${(spec.include ?? ["documents", "metadatas", "distances"]).join(", ")} (ids always).`);
      break;
    case "delete":
      steps.push(`Open the collection "${spec.collection}".`, `Delete the records where ${selector(spec)}. This cannot be undone.`);
      break;
    case "count":
      steps.push(`Open the collection "${spec.collection}".`, "Count its records.");
      break;
  }
  return steps;
}

/* ------------------------------------------------------------------- examples */

export interface ChromaExample {
  id: string;
  title: string;
  description: string;
  spec: Obj;
}

export const CHROMA_EXAMPLES: ChromaExample[] = [
  { id: "create-cosine", title: "Create a cosine-distance collection", description: "get_or_create with a distance configuration.", spec: { op: "get_or_create_collection", collection: "articles", configuration: { hnsw: { space: "cosine" } }, metadata: { description: "News articles" } } },
  { id: "create-own-embeddings", title: "Collection where you bring the embeddings", description: "embedding_function none.", spec: { op: "create_collection", collection: "my-vectors", embedding_function: "none" } },
  { id: "add-documents", title: "Add documents (Chroma embeds them)", description: "documents + metadatas, no embeddings.", spec: { op: "add", collection: "articles", ids: ["a1", "a2", "a3"], documents: ["Cats sleep a lot.", "Dogs love walks.", "Parrots can talk."], metadatas: [{ topic: "cats", year: 2022 }, { topic: "dogs", year: 2023 }, { topic: "birds", year: 2023 }] } },
  { id: "add-embeddings", title: "Add your own embeddings", description: "embeddings + documents are stored as-is.", spec: { op: "add", collection: "my-vectors", ids: ["v1", "v2"], embeddings: [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]], documents: ["first", "second"] } },
  { id: "add-array-metadata", title: "Array metadata", description: "Arrays must be non-empty and of one type.", spec: { op: "add", collection: "movies", ids: ["m1"], documents: ["A heist film."], metadatas: [{ genres: ["action", "thriller"], scores: [1, 2, 3], year: 2020 }], client: { type: "http", host: "localhost", port: 8000 } } },
  { id: "upsert", title: "Upsert", description: "Insert or overwrite by id.", spec: { op: "upsert", collection: "articles", ids: ["a1"], documents: ["Cats sleep up to 16 hours a day."], metadatas: [{ topic: "cats", year: 2024 }] } },
  { id: "update-metadata", title: "Update metadata only", description: "update with just metadatas.", spec: { op: "update", collection: "articles", ids: ["a2"], metadatas: [{ topic: "dogs", year: 2025 }] } },
  { id: "get-ids", title: "Get records by id", description: "No similarity ranking.", spec: { op: "get", collection: "articles", ids: ["a1", "a2"], include: ["documents", "metadatas"] } },
  { id: "get-where", title: "Get with a metadata filter", description: "One condition per object; $and combines several.", spec: { op: "get", collection: "articles", where: { $and: [{ year: { $gte: 2023 } }, { topic: { $in: ["dogs", "birds"] } }] }, limit: 10 } },
  { id: "get-where-document", title: "Get by document text", description: "where_document $contains (case-sensitive).", spec: { op: "get", collection: "articles", where_document: { $contains: "sleep" } } },
  { id: "query-texts", title: "Semantic search with text", description: "query_texts embedded by the collection's function.", spec: { op: "query", collection: "articles", query_texts: ["pets that sleep"], n_results: 3, include: ["documents", "distances"] } },
  { id: "query-filtered", title: "Semantic search + filters", description: "Vectors, metadata filter and text filter together.", spec: { op: "query", collection: "articles", query_texts: ["friendly animals"], n_results: 5, where: { year: 2023 }, where_document: { $not_contains: "talk" } } },
  { id: "query-embeddings", title: "Search with your own vector", description: "query_embeddings, cloud client.", spec: { op: "query", collection: "my-vectors", query_embeddings: [[0.1, 0.2, 0.3]], n_results: 2, client: { type: "cloud", tenant: "my-tenant", database: "my-db" } } },
  { id: "delete-where", title: "Delete by filter", description: "Permanent: removes every matching record.", spec: { op: "delete", collection: "articles", where: { year: { $lt: 2023 } } } },
  { id: "count", title: "Count records", description: "How many records are stored.", spec: { op: "count", collection: "articles" } },
];
