/**
 * MongoDB operation spec -> validated mongosh / PyMongo / Node.js driver code, plus plain-English explain.
 *
 * Syntax references (read before writing the generators):
 *  - mongosh collection methods  https://www.mongodb.com/docs/manual/reference/method/ (db.collection.find / updateOne / createIndex ...)
 *  - PyMongo Collection API      https://pymongo.readthedocs.io/en/stable/api/pymongo/collection.html
 *  - Node.js driver CRUD         https://www.mongodb.com/docs/drivers/node/current/crud/
 *  - Extended JSON v2            https://www.mongodb.com/docs/manual/reference/mongodb-extended-json/
 * Operator tables and semantic checks: `mongo-operators.ts`, `mongo-validate.ts`, typed values: `mongo-ejson.ts`.
 */
import * as z from "zod/v4";
import {
  didYouMean,
  findProtoKey,
  PROTO_KEY_MESSAGE,
  hasErrors,
  indentLines,
  isIdentifier,
  isObj,
  jsString,
  lineColumn,
  makeIssue,
  parseJsonLossless,
  widthFor,
  printAt,
  printDoc,
  pyString,
  zodToIssues,
  group,
  type CompileOptions,
  type CompileResult,
  type Doc,
  type NosqlIssue,
  type Obj,
  type Snippet,
} from "./common";
import { convertEjson, ejsonText, newContext, parseShellValue, typedIssues, valueDoc, type EjsonMode, type RenderContext, type Target } from "./mongo-ejson";
import {
  AGGREGATE_OPTION_KEYS,
  COUNT_OPTION_KEYS,
  DELETE_OPTION_KEYS,
  DISTINCT_OPTION_KEYS,
  FIND_OPTION_KEYS,
  INSERT_MANY_OPTION_KEYS,
  UPDATE_OPTION_KEYS,
} from "./mongo-operators";
import { checkArrayFilters, checkDocument, checkFilter, checkIndex, checkPipeline, checkProjection, checkSort, checkUpdate } from "./mongo-validate";

export const MONGO_OPS = ["find", "findOne", "aggregate", "insertOne", "insertMany", "updateOne", "updateMany", "replaceOne", "deleteOne", "deleteMany", "countDocuments", "distinct", "createIndex"] as const;
export type MongoOp = (typeof MONGO_OPS)[number];

/* ------------------------------------------------------------------- schema */

const object = (what: string) => z.record(z.string(), z.unknown(), { error: `${what} must be a JSON object like {"field": value}` });
const count = (what: string) => z.number({ error: `${what} must be a whole number` }).int({ error: `${what} must be a whole number` }).min(0, { error: `${what} must be 0 or greater` });
const sortValue = z.union([object("sort"), z.array(z.tuple([z.string(), z.unknown()]), { error: "sort must be an object or a list of [field, direction] pairs" })], { error: 'sort must be an object like {"age": -1}' });
const target = { database: z.string({ error: "database must be a string" }).min(1, { error: "database must not be empty" }).optional(), collection: z.string({ error: "collection is required: the collection name as a string" }).min(1, { error: "collection must not be empty" }) };
const options = object("options").optional();

const shapes = {
  find: { filter: object("filter").optional(), projection: object("projection").optional(), sort: sortValue.optional(), limit: count("limit").optional(), skip: count("skip").optional(), options },
  findOne: { filter: object("filter").optional(), projection: object("projection").optional(), sort: sortValue.optional(), skip: count("skip").optional(), options },
  aggregate: { pipeline: z.array(z.unknown(), { error: "pipeline must be an array of stages" }), options },
  insertOne: { document: object("document"), options },
  insertMany: { documents: z.array(object("each document"), { error: "documents must be an array of objects" }).min(1, { error: "documents needs at least one document" }), options },
  updateOne: { filter: object("filter"), update: z.union([object("update"), z.array(z.unknown())], { error: 'update must be an object of operators like {"$set": {...}} or a pipeline array' }), options },
  updateMany: { filter: object("filter"), update: z.union([object("update"), z.array(z.unknown())], { error: 'update must be an object of operators like {"$set": {...}} or a pipeline array' }), options },
  replaceOne: { filter: object("filter"), replacement: object("replacement"), options },
  deleteOne: { filter: object("filter"), options },
  deleteMany: { filter: object("filter"), options },
  countDocuments: { filter: object("filter").optional(), options },
  distinct: { field: z.string({ error: "field is required: the field name to list distinct values of" }).min(1, { error: "field must not be empty" }), filter: object("filter").optional(), options },
  createIndex: { keys: object("keys"), options },
} satisfies Record<MongoOp, z.ZodRawShape>;

function opSchema<Op extends MongoOp>(op: Op) {
  return z.strictObject({ op: z.literal(op), ...target, ...shapes[op] });
}

export const mongoSpecSchema = z.discriminatedUnion("op", [
  opSchema("find"), opSchema("findOne"), opSchema("aggregate"), opSchema("insertOne"), opSchema("insertMany"), opSchema("updateOne"),
  opSchema("updateMany"), opSchema("replaceOne"), opSchema("deleteOne"), opSchema("deleteMany"), opSchema("countDocuments"),
  opSchema("distinct"), opSchema("createIndex"),
]);
export type MongoSpec = z.infer<typeof mongoSpecSchema>;

/** Fields each operation accepts (drives the form and the did-you-mean for unknown keys). */
export const MONGO_FIELDS: Record<MongoOp, string[]> = Object.fromEntries(MONGO_OPS.map((op) => [op, ["op", "database", "collection", ...Object.keys(shapes[op])]])) as Record<MongoOp, string[]>;
const OPTION_KEYS: Record<MongoOp, readonly string[]> = {
  find: FIND_OPTION_KEYS, findOne: FIND_OPTION_KEYS, aggregate: AGGREGATE_OPTION_KEYS, insertOne: ["bypassDocumentValidation", "comment", "writeConcern"], insertMany: INSERT_MANY_OPTION_KEYS,
  updateOne: UPDATE_OPTION_KEYS, updateMany: UPDATE_OPTION_KEYS, replaceOne: UPDATE_OPTION_KEYS.filter((k) => k !== "arrayFilters"), deleteOne: DELETE_OPTION_KEYS, deleteMany: DELETE_OPTION_KEYS,
  countDocuments: COUNT_OPTION_KEYS, distinct: DISTINCT_OPTION_KEYS, createIndex: [],
};

/* ---------------------------------------------------------------- validation */

const RESERVED_COLLECTION = /^system\./;

function checkNames(spec: { database?: string; collection: string }, out: NosqlIssue[]): void {
  const c = spec.collection;
  if (c.includes("$")) out.push(makeIssue("error", "collection", `Collection names cannot contain "$" ("${c}").`));
  if (c.includes("\0")) out.push(makeIssue("error", "collection", "Collection names cannot contain a null character."));
  if (RESERVED_COLLECTION.test(c)) out.push(makeIssue("warning", "collection", `"${c}" starts with "system.", which MongoDB reserves for internal collections.`));
  if (byteLength(c) > 255) out.push(makeIssue("error", "collection", "Collection names can be at most 255 bytes."));
  const d = spec.database;
  if (d !== undefined) {
    if (/[/\\. "$*<>:|?\0]/.test(d)) out.push(makeIssue("error", "database", `Database names cannot contain / \\ . " $ * < > : | ? or spaces ("${d}").`));
    if (byteLength(d) > 63) out.push(makeIssue("error", "database", "Database names can be at most 63 bytes."));
  }
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function checkOptions(op: MongoOp, opts: Obj | undefined, out: NosqlIssue[]): void {
  if (!opts) return;
  const allowed = OPTION_KEYS[op];
  for (const key of Object.keys(opts)) {
    if (!allowed.includes(key)) out.push(makeIssue("error", `options.${key}`, `"${key}" is not an option of ${op}.${didYouMean(key, allowed)}`, allowed.length ? `Options for ${op}: ${allowed.join(", ")}.` : `${op} takes its options at the top level of the spec.`));
  }
}

/** Parses + validates a spec object. `spec` is the normalised value when no structural error was found. */
export function check(input: unknown): { spec?: MongoSpec; issues: NosqlIssue[] } {
  const out: NosqlIssue[] = [];
  if (!isObj(input)) return { issues: [makeIssue("error", "(spec)", "The spec must be a JSON object like {\"op\": \"find\", \"collection\": \"users\", ...}.")] };
  const op = input.op;
  if (typeof op !== "string") return { issues: [makeIssue("error", "op", "Missing \"op\": which operation to run.", `Choose one of: ${MONGO_OPS.join(", ")}.`)] };
  if (!(MONGO_OPS as readonly string[]).includes(op)) {
    return { issues: [makeIssue("error", "op", `Unknown operation "${op}".${didYouMean(op, MONGO_OPS)}`, `Choose one of: ${MONGO_OPS.join(", ")}.`)] };
  }
  const proto = findProtoKey(input);
  if (proto) return { issues: [makeIssue("error", proto, PROTO_KEY_MESSAGE, "Rename the field.")] };
  const parsed = mongoSpecSchema.safeParse(input);
  if (!parsed.success) return { issues: zodToIssues(parsed.error, MONGO_FIELDS[op as MongoOp]) };
  const spec = parsed.data;
  checkNames(spec, out);
  out.push(...typedIssues({ ...spec, op: undefined }, ""));
  if (spec.op !== "createIndex") checkOptions(spec.op, spec.options as Obj | undefined, out);
  const opts = (spec.options as Obj | undefined) ?? {};
  switch (spec.op) {
    case "find":
    case "findOne": {
      if (spec.filter) checkFilter(spec.filter, "filter", out);
      if (spec.projection) checkProjection(spec.projection, "projection", out);
      if (spec.sort) checkSort(spec.sort, "sort", out);
      if (spec.skip && !spec.sort) out.push(makeIssue("warning", "skip", "skip without sort: the order is undefined, so pages may overlap or miss documents.", 'Add a sort such as {"_id": 1}.'));
      if (spec.op === "find" && spec.limit === 0) out.push(makeIssue("info", "limit", "limit 0 means no limit."));
      if (spec.op === "find" && spec.limit && !spec.sort) out.push(makeIssue("info", "limit", "limit without sort returns an arbitrary set of documents."));
      if (spec.op === "find" && !spec.limit && !spec.filter) out.push(makeIssue("info", "limit", "No filter and no limit: this reads the whole collection.", "Add a limit while exploring."));
      break;
    }
    case "aggregate":
      checkPipeline(spec.pipeline, "pipeline", out);
      break;
    case "insertOne":
      checkDocument(spec.document, "document", out);
      break;
    case "insertMany": {
      const seen = new Set<string>();
      spec.documents.forEach((doc, index) => {
        checkDocument(doc, `documents[${index}]`, out);
        if ("_id" in doc) {
          const key = JSON.stringify(convertEjson(doc._id, "canonical"), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
          if (seen.has(key)) out.push(makeIssue("error", `documents[${index}]._id`, `Duplicate _id ${key}: the insert would fail with E11000 duplicate key.`, "Make every _id unique or leave _id out so MongoDB generates it."));
          seen.add(key);
        }
      });
      if (spec.documents.length > 100000) out.push(makeIssue("info", "documents", "More than 100,000 documents: drivers split this into several batches automatically."));
      break;
    }
    case "updateOne":
    case "updateMany": {
      checkFilter(spec.filter, "filter", out);
      const used = checkUpdate(spec.update, "update", out, opts.upsert === true);
      checkArrayFilters(opts.arrayFilters, "options.arrayFilters", out, used);
      if (!Object.keys(spec.filter).length) out.push(makeIssue("warning", "filter", spec.op === "updateMany" ? "An empty filter updates EVERY document in the collection." : "An empty filter updates an arbitrary first document.", "Add a filter unless that is what you want."));
      if (opts.upsert === true) out.push(makeIssue("info", "options.upsert", "upsert: if nothing matches, a new document is inserted from the filter's equality fields plus the update."));
      if ("upsert" in opts && typeof opts.upsert !== "boolean") out.push(makeIssue("error", "options.upsert", "upsert must be true or false."));
      break;
    }
    case "replaceOne": {
      checkFilter(spec.filter, "filter", out);
      const bad = Object.keys(spec.replacement).find((k) => k.startsWith("$"));
      if (bad) out.push(makeIssue("error", `replacement.${bad}`, `A replacement document cannot contain operators like ${bad}.`, "Use updateOne for operators, or pass a plain document to replaceOne."));
      else checkDocument(spec.replacement, "replacement", out);
      if (!Object.keys(spec.filter).length) out.push(makeIssue("warning", "filter", "An empty filter replaces an arbitrary first document."));
      break;
    }
    case "deleteOne":
    case "deleteMany":
      checkFilter(spec.filter, "filter", out);
      if (!Object.keys(spec.filter).length) out.push(makeIssue("warning", "filter", spec.op === "deleteMany" ? "An empty filter deletes EVERY document in the collection." : "An empty filter deletes an arbitrary first document.", "Add a filter unless that is what you want (to empty a collection, drop() is faster)."));
      break;
    case "countDocuments":
      if (spec.filter) checkFilter(spec.filter, "filter", out, { count: true });
      break;
    case "distinct":
      if (spec.filter) checkFilter(spec.filter, "filter", out);
      out.push(makeIssue("info", "field", "distinct returns one array that must fit in 16 MB; use an aggregation with $group for large result sets."));
      break;
    case "createIndex":
      checkIndex(spec.keys, spec.options, "", out);
      break;
  }
  return { spec, issues: out };
}

export function validate(input: unknown): { ok: boolean; issues: NosqlIssue[] } {
  const { issues } = check(input);
  return { ok: !hasErrors(issues), issues };
}

/* --------------------------------------------------------------- spec parsing */

export interface ParsedSpecText {
  spec?: unknown;
  issues: NosqlIssue[];
  /** True when the text used mongosh syntax (ObjectId(...), unquoted keys...) and was converted to Extended JSON. */
  convertedFromShell?: boolean;
}

/** Accepts the JSON spec, or (when it is not valid JSON) the same object written in mongosh syntax. Big integers stay exact. */
export function parseSpecText(text: string): ParsedSpecText {
  const json = parseJsonLossless(text);
  if (json.ok) return { spec: json.value, issues: [] };
  const shell = parseShellValue(text);
  if (shell.ok) return { spec: shell.value, convertedFromShell: true, issues: [makeIssue("info", "(spec)", "Read as mongosh syntax and converted to Extended JSON.")] };
  const where = lineColumn(text, json.offset);
  const shellWhere = lineColumn(text, shell.offset);
  const preferShell = /ObjectId|ISODate|NumberLong|NumberInt|NumberDecimal|Timestamp|BinData|UUID|\/[^/\n]+\/[a-z]*/.test(text);
  return { issues: [makeIssue("error", "(spec)", preferShell ? `Not valid mongosh syntax: ${shell.message} (line ${shellWhere.line}, column ${shellWhere.column}).` : `Not valid JSON: ${json.message} (line ${where.line}, column ${where.column}).`)] };
}

/** Converts a pasted value between mongosh syntax and Extended JSON (relaxed/canonical). */
export function convertValueText(text: string, to: EjsonMode | "shell"): { ok: true; text: string } | { ok: false; message: string } {
  let value: unknown;
  const json = parseJsonLossless(text);
  if (json.ok) value = json.value;
  else {
    const shell = parseShellValue(text);
    if (!shell.ok) return { ok: false, message: `${shell.message} (offset ${shell.offset})` };
    value = shell.value;
  }
  const issues = typedIssues(value, "");
  if (issues.length) return { ok: false, message: issues.map((i) => `${i.path}: ${i.message}`).join(" ") };
  if (to === "shell") return { ok: true, text: printDoc(valueDoc(value, "mongosh", newContext()), 0, 0) };
  return { ok: true, text: ejsonText(value, to) };
}

/* -------------------------------------------------------------------- compile */

const PY_KWARGS: Record<string, string> = {
  maxTimeMS: "max_time_ms", allowDiskUse: "allow_disk_use", batchSize: "batch_size", noCursorTimeout: "no_cursor_timeout", allowPartialResults: "allow_partial_results",
  returnKey: "return_key", showRecordId: "show_record_id", arrayFilters: "array_filters", bypassDocumentValidation: "bypass_document_validation",
};
/** Aggregate / count / index kwargs keep the server's spelling in PyMongo. */
const PY_VERBATIM = new Set(["aggregate", "countDocuments", "distinct", "createIndex"]);
const PY_UNSUPPORTED = new Set(["readConcern", "writeConcern"]);

function sortPairs(sort: unknown): [string, unknown][] {
  return Array.isArray(sort) ? (sort as [string, unknown][]) : Object.entries(sort as Obj);
}

function sortObject(sort: unknown): Obj {
  return Array.isArray(sort) ? Object.fromEntries(sort as [string, unknown][]) : (sort as Obj);
}

function pyTuples(doc: unknown, ctx: RenderContext, path: string): Doc {
  const entries = Array.isArray(doc) ? (doc as [string, unknown][]) : Object.entries(doc as Obj);
  return group("[", "]", entries.map(([k, v]) => ({ value: group("(", ")", [{ value: pyString(k) }, { value: valueDoc(v, "python", ctx, `${path}.${k}`) }]) })));
}

class Writer {
  readonly target: Target;
  readonly ctx: RenderContext;
  readonly width: number;
  constructor(target: Target, ctx: RenderContext, width: number) {
    this.target = target;
    this.ctx = ctx;
    this.width = width;
  }
  v(value: unknown, path = ""): Doc {
    return valueDoc(value, this.target, this.ctx, path);
  }
  /** A call `name(arg, arg)` laid out by the pretty-printer, starting at column `prefix.length`. */
  call(prefix: string, args: Doc[], suffix = ""): string {
    const unit = this.target === "python" ? "    " : "  ";
    // a lone object/array argument hugs the parentheses: f({\n  ...\n})
    const tail = suffix.split("\n")[0].length;
    if (args.length === 1 && typeof args[0] !== "string") return `${prefix}(${printAt(args[0], prefix.length + 1, 0, unit, this.width, tail + 1)})${suffix}`;
    return `${prefix}${printAt(group("(", ")", args.map((value) => ({ value }))), prefix.length, 0, unit, this.width, tail)}${suffix}`;
  }
}

function pyKwargs(op: MongoOp, opts: Obj | undefined, w: Writer): { key: string; value: Doc }[] {
  const out: { key: string; value: Doc }[] = [];
  for (const [key, value] of Object.entries(opts ?? {})) {
    if (PY_UNSUPPORTED.has(key)) {
      w.ctx.issues.push(makeIssue("info", `options.${key}`, `${key} is not translated for PyMongo: set it on the collection, e.g. coll.with_options(${key === "readConcern" ? "read_concern=ReadConcern(...)" : "write_concern=WriteConcern(...)"}).`));
      continue;
    }
    const name = PY_VERBATIM.has(op) ? key : (PY_KWARGS[key] ?? key);
    const doc = key === "hint" && isObj(value) ? pyTuples(value, w.ctx, `options.${key}`) : key === "min" || key === "max" ? (isObj(value) ? pyTuples(value, w.ctx, `options.${key}`) : w.v(value, `options.${key}`)) : w.v(value, `options.${key}`);
    out.push({ key: name, value: doc });
  }
  return out;
}

/** Python keyword arguments, `key=value`, flat (nested values still break via their own layout when long). */
function kwStrings(entries: { key: string; value: Doc }[]): Doc[] {
  return entries.map(({ key, value }) => `${key}=${printDoc(value, 0, 0, 1e9)}`);
}

/* ---- mongosh */

function shellCollection(spec: { collection: string }): string {
  const reserved = new Set(["stats", "help", "version", "drop", "count", "find", "getName", "runCommand", "auth", "logout", "dropDatabase", "createCollection", "hostInfo", "isMaster", "hello", "serverStatus", "aggregate", "watch", "getMongo", "getSiblingDB"]);
  return isIdentifier(spec.collection) && !spec.collection.startsWith("$") && !reserved.has(spec.collection) && !spec.collection.startsWith("get") && !spec.collection.startsWith("_") ? `db.${spec.collection}` : `db.getCollection(${jsString(spec.collection)})`;
}

function renderMongosh(spec: MongoSpec, ctx: RenderContext, width: number): string {
  const w = new Writer("mongosh", ctx, width);
  const coll = shellCollection(spec);
  const opts = spec.options as Obj | undefined;
  const optDoc = opts && Object.keys(opts).length ? w.v(opts, "options") : null;
  const head = spec.database ? `db = db.getSiblingDB(${jsString(spec.database)});\n\n` : "";
  const empty = group("{", "}", [], true);
  let body: string;
  switch (spec.op) {
    case "find": {
      const args: Doc[] = [];
      if (spec.filter || spec.projection || optDoc) args.push(spec.filter ? w.v(spec.filter, "filter") : empty);
      if (spec.projection || optDoc) args.push(spec.projection ? w.v(spec.projection, "projection") : empty);
      if (optDoc) args.push(optDoc);
      let chain = "";
      if (spec.sort) chain += `.sort(${printDoc(w.v(sortObject(spec.sort), "sort"), 0, 0, 1e9)})`;
      if (spec.skip) chain += `.skip(${spec.skip})`;
      if (spec.limit) chain += `.limit(${spec.limit})`;
      body = w.call(`${coll}.find`, args, chain);
      break;
    }
    case "findOne": {
      if (spec.sort || spec.skip) {
        const args: Doc[] = [spec.filter ? w.v(spec.filter, "filter") : empty];
        if (spec.projection) args.push(w.v(spec.projection, "projection"));
        let chain = "";
        if (spec.sort) chain += `.sort(${printDoc(w.v(sortObject(spec.sort), "sort"), 0, 0, 1e9)})`;
        if (spec.skip) chain += `.skip(${spec.skip})`;
        body = w.call(`${coll}.find`, args, `${chain}.limit(1).next()`);
      } else {
        const args: Doc[] = [spec.filter ? w.v(spec.filter, "filter") : empty];
        if (spec.projection || optDoc) args.push(spec.projection ? w.v(spec.projection, "projection") : empty);
        if (optDoc) args.push(optDoc);
        body = w.call(`${coll}.findOne`, args);
      }
      break;
    }
    case "aggregate":
      body = w.call(`${coll}.aggregate`, [w.v(spec.pipeline, "pipeline"), ...(optDoc ? [optDoc] : [])]);
      break;
    case "insertOne":
      body = w.call(`${coll}.insertOne`, [w.v(spec.document, "document"), ...(optDoc ? [optDoc] : [])]);
      break;
    case "insertMany":
      body = w.call(`${coll}.insertMany`, [w.v(spec.documents, "documents"), ...(optDoc ? [optDoc] : [])]);
      break;
    case "updateOne":
    case "updateMany":
      body = w.call(`${coll}.${spec.op}`, [w.v(spec.filter, "filter"), w.v(spec.update, "update"), ...(optDoc ? [optDoc] : [])]);
      break;
    case "replaceOne":
      body = w.call(`${coll}.replaceOne`, [w.v(spec.filter, "filter"), w.v(spec.replacement, "replacement"), ...(optDoc ? [optDoc] : [])]);
      break;
    case "deleteOne":
    case "deleteMany":
      body = w.call(`${coll}.${spec.op}`, [w.v(spec.filter, "filter"), ...(optDoc ? [optDoc] : [])]);
      break;
    case "countDocuments":
      body = w.call(`${coll}.countDocuments`, [spec.filter ? w.v(spec.filter, "filter") : empty, ...(optDoc ? [optDoc] : [])]);
      break;
    case "distinct":
      body = w.call(`${coll}.distinct`, [jsString(spec.field), ...(spec.filter || optDoc ? [spec.filter ? w.v(spec.filter, "filter") : empty] : []), ...(optDoc ? [optDoc] : [])]);
      break;
    case "createIndex":
      body = w.call(`${coll}.createIndex`, [w.v(spec.keys, "keys"), ...(spec.options ? [w.v(spec.options, "options")] : [])]);
      break;
  }
  return `${head}${body};\n`;
}

/* ---- PyMongo */

function renderPython(spec: MongoSpec, ctx: RenderContext, width: number): string {
  const w = new Writer("python", ctx, width);
  const opts = spec.options as Obj | undefined;
  const kwargs = pyKwargs(spec.op, opts, w);
  const v = (value: unknown, path: string) => w.v(value, path);
  const call = (method: string, positional: Doc[], extra: { key: string; value: Doc }[] = []) => w.call(`coll.${method}`, [...positional, ...kwStrings([...extra, ...kwargs])]);
  const dbExpr = `client[${pyString(spec.database ?? "mydb")}][${pyString(spec.collection)}]`;
  const lines: string[] = [];
  const sortKw = (sort: unknown) => ({ key: "sort", value: pyTuples(sort, ctx, "sort") });
  switch (spec.op) {
    case "find": {
      const extra: { key: string; value: Doc }[] = [];
      if (spec.skip) extra.push({ key: "skip", value: String(spec.skip) });
      if (spec.limit) extra.push({ key: "limit", value: String(spec.limit) });
      if (spec.sort) extra.push(sortKw(sortPairs(spec.sort)));
      const positional = [spec.filter ? v(spec.filter, "filter") : group("{", "}", []), ...(spec.projection ? [v(spec.projection, "projection")] : [])];
      lines.push(`${w.call("docs = list(coll.find", [...positional, ...kwStrings([...extra, ...kwargs])], ")")}`, "for doc in docs:", "    print(doc)");
      break;
    }
    case "findOne": {
      const extra: { key: string; value: Doc }[] = [];
      if (spec.sort) extra.push(sortKw(sortPairs(spec.sort)));
      if (spec.skip) extra.push({ key: "skip", value: String(spec.skip) });
      const positional = [spec.filter ? v(spec.filter, "filter") : group("{", "}", []), ...(spec.projection ? [v(spec.projection, "projection")] : [])];
      lines.push(w.call("doc = coll.find_one", [...positional, ...kwStrings([...extra, ...kwargs])]), "print(doc)");
      break;
    }
    case "aggregate":
      lines.push(w.call("docs = list(coll.aggregate", [v(spec.pipeline, "pipeline"), ...kwStrings(kwargs)], ")"), "for doc in docs:", "    print(doc)");
      break;
    case "insertOne":
      lines.push(`result = ${call("insert_one", [v(spec.document, "document")])}`, "print(result.inserted_id)");
      break;
    case "insertMany":
      lines.push(`result = ${call("insert_many", [v(spec.documents, "documents")])}`, "print(result.inserted_ids)");
      break;
    case "updateOne":
    case "updateMany":
      lines.push(`result = ${call(spec.op === "updateOne" ? "update_one" : "update_many", [v(spec.filter, "filter"), v(spec.update, "update")])}`, "print(result.matched_count, result.modified_count, result.upserted_id)");
      break;
    case "replaceOne":
      lines.push(`result = ${call("replace_one", [v(spec.filter, "filter"), v(spec.replacement, "replacement")])}`, "print(result.matched_count, result.modified_count)");
      break;
    case "deleteOne":
    case "deleteMany":
      lines.push(`result = ${call(spec.op === "deleteOne" ? "delete_one" : "delete_many", [v(spec.filter, "filter")])}`, "print(result.deleted_count)");
      break;
    case "countDocuments":
      lines.push(`total = ${call("count_documents", [spec.filter ? v(spec.filter, "filter") : group("{", "}", [])])}`, "print(total)");
      break;
    case "distinct":
      lines.push(`values = ${call("distinct", [pyString(spec.field), ...(spec.filter ? [v(spec.filter, "filter")] : [])])}`, "print(values)");
      break;
    case "createIndex": {
      const idxKw = Object.entries((spec.options as Obj | undefined) ?? {}).map(([key, value]) => ({ key, value: v(value, `options.${key}`) }));
      lines.push(`name = ${w.call("coll.create_index", [pyTuples(spec.keys, ctx, "keys"), ...kwStrings(idxKw)])}`, "print(name)");
      break;
    }
  }
  const imports = ["from pymongo import MongoClient", ...[...ctx.imports].sort((a, b) => (a.startsWith("import") === b.startsWith("import") ? a.localeCompare(b) : a.startsWith("import") ? -1 : 1))];
  const stdlib = imports.filter((i) => i.startsWith("import "));
  const third = imports.filter((i) => i.startsWith("from "));
  const bson = third.filter((i) => i.startsWith("from bson"));
  const merged = bson.length ? mergeBsonImports(bson) : [];
  const header = [...stdlib, ...(stdlib.length ? [""] : []), "from pymongo import MongoClient", ...merged].join("\n");
  return `${header}\n\nclient = MongoClient("mongodb://localhost:27017")\ncoll = ${dbExpr}\n\n${lines.join("\n")}\n`;
}

function mergeBsonImports(lines: string[]): string[] {
  const names = lines.map((l) => l.replace("from bson import ", "")).sort();
  return [`from bson import ${names.join(", ")}`];
}

/* ---- Node.js */

function renderNode(spec: MongoSpec, ctx: RenderContext, width: number): string {
  const w = new Writer("node", ctx, width);
  const opts = { ...((spec.options as Obj | undefined) ?? {}) };
  const call = (prefix: string, args: Doc[], suffix = "") => w.call(prefix, args, suffix);
  const optionsDoc = (extra: Obj = {}): Doc[] => {
    const merged = { ...extra, ...opts };
    return Object.keys(merged).length ? [w.v(merged, "options")] : [];
  };
  const emptyFilter = group("{", "}", [], true);
  let statement: string;
  switch (spec.op) {
    case "find": {
      const extra: Obj = {};
      if (spec.projection) extra.projection = spec.projection;
      if (spec.sort) extra.sort = sortObject(spec.sort);
      if (spec.skip) extra.skip = spec.skip;
      if (spec.limit) extra.limit = spec.limit;
      statement = call("const docs = await coll.find", [spec.filter ? w.v(spec.filter, "filter") : emptyFilter, ...optionsDoc(extra)], ".toArray();\nconsole.log(docs);");
      break;
    }
    case "findOne": {
      const extra: Obj = {};
      if (spec.projection) extra.projection = spec.projection;
      if (spec.sort) extra.sort = sortObject(spec.sort);
      if (spec.skip) extra.skip = spec.skip;
      statement = call("const doc = await coll.findOne", [spec.filter ? w.v(spec.filter, "filter") : emptyFilter, ...optionsDoc(extra)], ";\nconsole.log(doc);");
      break;
    }
    case "aggregate":
      statement = call("const docs = await coll.aggregate", [w.v(spec.pipeline, "pipeline"), ...optionsDoc()], ".toArray();\nconsole.log(docs);");
      break;
    case "insertOne":
      statement = call("const result = await coll.insertOne", [w.v(spec.document, "document"), ...optionsDoc()], ";\nconsole.log(result.insertedId);");
      break;
    case "insertMany":
      statement = call("const result = await coll.insertMany", [w.v(spec.documents, "documents"), ...optionsDoc()], ";\nconsole.log(result.insertedIds);");
      break;
    case "updateOne":
    case "updateMany":
      statement = call(`const result = await coll.${spec.op}`, [w.v(spec.filter, "filter"), w.v(spec.update, "update"), ...optionsDoc()], ";\nconsole.log(result.matchedCount, result.modifiedCount, result.upsertedId);");
      break;
    case "replaceOne":
      statement = call("const result = await coll.replaceOne", [w.v(spec.filter, "filter"), w.v(spec.replacement, "replacement"), ...optionsDoc()], ";\nconsole.log(result.matchedCount, result.modifiedCount);");
      break;
    case "deleteOne":
    case "deleteMany":
      statement = call(`const result = await coll.${spec.op}`, [w.v(spec.filter, "filter"), ...optionsDoc()], ";\nconsole.log(result.deletedCount);");
      break;
    case "countDocuments":
      statement = call("const total = await coll.countDocuments", [spec.filter ? w.v(spec.filter, "filter") : emptyFilter, ...optionsDoc()], ";\nconsole.log(total);");
      break;
    case "distinct":
      statement = call("const values = await coll.distinct", [jsString(spec.field), ...(spec.filter || Object.keys(opts).length ? [spec.filter ? w.v(spec.filter, "filter") : emptyFilter] : []), ...optionsDoc()], ";\nconsole.log(values);");
      break;
    case "createIndex":
      statement = call("const name = await coll.createIndex", [w.v(spec.keys, "keys"), ...(spec.options ? [w.v(spec.options, "options")] : [])], ";\nconsole.log(name);");
      break;
  }
  const driverImports = ["MongoClient", ...[...ctx.imports].sort()];
  return `import { ${driverImports.join(", ")} } from "mongodb";\n\nconst client = new MongoClient("mongodb://localhost:27017");\ntry {\n  await client.connect();\n  const coll = client.db(${jsString(spec.database ?? "mydb")}).collection(${jsString(spec.collection)});\n\n${indentLines(statement, 2)}\n} finally {\n  await client.close();\n}\n`;
}

/* ---- JSON payload */

function payload(spec: MongoSpec): unknown {
  switch (spec.op) {
    case "find":
    case "findOne":
    case "deleteOne":
    case "deleteMany":
    case "countDocuments":
      return spec.filter ?? {};
    case "aggregate": return spec.pipeline;
    case "insertOne": return spec.document;
    case "insertMany": return spec.documents;
    case "updateOne":
    case "updateMany": return { filter: spec.filter, update: spec.update };
    case "replaceOne": return { filter: spec.filter, replacement: spec.replacement };
    case "distinct": return { field: spec.field, filter: spec.filter ?? {} };
    case "createIndex": return { keys: spec.keys, ...(spec.options ? { options: spec.options } : {}) };
  }
}

const PAYLOAD_LABEL: Record<MongoOp, string> = {
  find: "filter", findOne: "filter", deleteOne: "filter", deleteMany: "filter", countDocuments: "filter", aggregate: "pipeline", insertOne: "document", insertMany: "documents",
  updateOne: "filter + update", updateMany: "filter + update", replaceOne: "filter + replacement", distinct: "field + filter", createIndex: "keys + options",
};

export function compile(input: unknown, options?: CompileOptions): CompileResult {
  const { spec, issues } = check(input);
  const width = widthFor(options);
  if (!spec || hasErrors(issues)) return { ok: false, snippets: [], issues };
  const all = [...issues];
  const seen = new Set(all.map((i) => `${i.severity}|${i.path}|${i.message}`));
  const render = (fn: (s: MongoSpec, c: RenderContext, w: number) => string): string => {
    const ctx = newContext();
    const code = fn(spec, ctx, width);
    for (const item of ctx.issues) {
      const key = `${item.severity}|${item.path}|${item.message}`;
      if (!seen.has(key)) {
        seen.add(key);
        all.push(item);
      }
    }
    return code;
  };
  const snippets: Snippet[] = [
    { language: "javascript", label: "mongosh", code: render(renderMongosh) },
    { language: "python", label: "PyMongo", code: render(renderPython) },
    { language: "javascript", label: "Node.js driver", code: render(renderNode) },
    { language: "json", label: `Extended JSON (${PAYLOAD_LABEL[spec.op]})`, code: `${ejsonText(payload(spec), "relaxed")}\n` },
  ];
  return hasErrors(all) ? { ok: false, snippets: [], issues: all } : { ok: true, snippets, issues: all };
}

/* -------------------------------------------------------------------- explain */

function flat(value: unknown): string {
  return printDoc(valueDoc(value, "mongosh", newContext()), 0, 0, 1e9);
}

const COMPARE_WORDS: Record<string, string> = { $eq: "equals", $ne: "is not equal to", $gt: "is greater than", $gte: "is greater than or equal to", $lt: "is less than", $lte: "is less than or equal to" };

function describeCondition(field: string, value: unknown): string {
  if (!isObj(value) || !Object.keys(value).length || !Object.keys(value).every((k) => k.startsWith("$")) || (asTypedKind(value))) return `${field} equals ${flat(value)}`;
  return Object.entries(value)
    .map(([op, operand]) => {
      if (op in COMPARE_WORDS) return `${field} ${COMPARE_WORDS[op]} ${flat(operand)}`;
      switch (op) {
        case "$in": return `${field} is one of ${flat(operand)}`;
        case "$nin": return `${field} is none of ${flat(operand)} (or missing)`;
        case "$all": return `${field} (an array) contains all of ${flat(operand)}`;
        case "$exists": return operand === false ? `${field} is absent` : `${field} exists`;
        case "$regex": return `${field} matches the pattern ${flat(operand)}${typeof value.$options === "string" ? ` (flags: ${value.$options})` : ""}`;
        case "$options": return "";
        case "$size": return `${field} (an array) has exactly ${flat(operand)} items`;
        case "$type": return `${field} has BSON type ${flat(operand)}`;
        case "$mod": return `${field} divided by ${flat((operand as unknown[])[0])} leaves remainder ${flat((operand as unknown[])[1])}`;
        case "$not": return `NOT (${isObj(operand) ? describeCondition(field, operand) : flat(operand)})`;
        case "$elemMatch": return `${field} has an array element where ${isObj(operand) && Object.keys(operand).every((k) => k.startsWith("$")) ? describeCondition("the element", operand) : describeFilter(operand)}`;
        default: return `${field} uses ${op} ${flat(operand)}`;
      }
    })
    .filter(Boolean)
    .join(" AND ");
}

function asTypedKind(value: Obj): boolean {
  return Object.keys(value).length === 1 && ["$oid", "$date", "$numberLong", "$numberInt", "$numberDouble", "$numberDecimal", "$regularExpression", "$timestamp", "$binary", "$uuid", "$minKey", "$maxKey"].includes(Object.keys(value)[0]);
}

export function describeFilter(filter: unknown): string {
  if (!isObj(filter) || !Object.keys(filter).length) return "every document";
  return Object.entries(filter)
    .map(([key, value]) => {
      if (key === "$and" || key === "$or" || key === "$nor") {
        const parts = (Array.isArray(value) ? value : []).map((clause) => `(${describeFilter(clause)})`);
        return key === "$and" ? parts.join(" AND ") : key === "$or" ? `any of: ${parts.join(" OR ")}` : `none of: ${parts.join(", ")}`;
      }
      if (key === "$expr") return `the expression ${flat(value)} is true`;
      if (key === "$text") return `the text index matches ${flat(isObj(value) ? value.$search : value)}`;
      if (key === "$where") return "the JavaScript in $where is true";
      return describeCondition(key, value);
    })
    .join(" AND ");
}

function describeStage(name: string, body: unknown): string {
  switch (name) {
    case "$match": return `Keep only documents where ${describeFilter(body)}.`;
    case "$group": return isObj(body) ? `Group documents by ${flat(body._id)}${Object.entries(body).filter(([k]) => k !== "_id").map(([k, v]) => (isObj(v) ? `; compute ${k} = ${Object.keys(v)[0]?.replace("$", "") ?? "?"} of ${flat(Object.values(v)[0])}` : "")).join("")}.` : "Group documents.";
    case "$sort": return `Sort by ${Object.entries(sortObjectSafe(body)).map(([k, d]) => `${k} ${d === -1 ? "descending" : "ascending"}`).join(", ")}.`;
    case "$limit": return `Keep only the first ${flat(body)} documents.`;
    case "$skip": return `Skip the first ${flat(body)} documents.`;
    case "$project": return `Reshape each document, keeping: ${isObj(body) ? Object.entries(body).map(([k, v]) => (v === 0 || v === false ? `without ${k}` : k)).join(", ") : "?"}.`;
    case "$addFields":
    case "$set": return `Add or overwrite fields: ${isObj(body) ? Object.keys(body).join(", ") : "?"}.`;
    case "$unwind": return `Emit one document per element of the array ${flat(isObj(body) ? body.path : body)}.`;
    case "$lookup": return isObj(body) ? `Join with collection ${flat(body.from)} as ${flat(body.as)}${body.localField ? ` where ${flat(body.localField)} = ${flat(body.foreignField)}` : " using a sub-pipeline"}.` : "Join another collection.";
    case "$count": return `Count the documents into a field named ${flat(body)}.`;
    case "$out": return `Write the results to collection ${flat(body)}, replacing it.`;
    case "$merge": return `Merge the results into ${flat(isObj(body) ? body.into : body)}.`;
    case "$unset": return `Remove fields ${flat(body)}.`;
    case "$replaceRoot":
    case "$replaceWith": return "Replace each document with a sub-document.";
    case "$sample": return `Pick ${flat(isObj(body) ? body.size : body)} random documents.`;
    case "$facet": return `Run several sub-pipelines in parallel: ${isObj(body) ? Object.keys(body).join(", ") : "?"}.`;
    default: return `Apply ${name}.`;
  }
}

function sortObjectSafe(body: unknown): Obj {
  return isObj(body) ? body : {};
}

function describeUpdate(update: unknown): string[] {
  if (Array.isArray(update)) return [`Update with an aggregation pipeline of ${update.length} stage(s).`];
  if (!isObj(update)) return [];
  return Object.entries(update).flatMap(([op, operand]) => {
    if (!isObj(operand)) return [];
    return Object.entries(operand).map(([field, value]) => {
      switch (op) {
        case "$set": return `Set ${field} to ${flat(value)}.`;
        case "$unset": return `Remove the field ${field}.`;
        case "$inc": return `Add ${flat(value)} to ${field}.`;
        case "$mul": return `Multiply ${field} by ${flat(value)}.`;
        case "$push": return `Append ${flat(value)} to the array ${field}.`;
        case "$addToSet": return `Add ${flat(value)} to the array ${field} if it is not there yet.`;
        case "$pull": return `Remove matching elements from the array ${field}.`;
        case "$rename": return `Rename ${field} to ${flat(value)}.`;
        case "$min": return `Set ${field} to ${flat(value)} if that is smaller than the current value.`;
        case "$max": return `Set ${field} to ${flat(value)} if that is larger than the current value.`;
        case "$currentDate": return `Set ${field} to the current date/time.`;
        case "$setOnInsert": return `If a new document is inserted, set ${field} to ${flat(value)}.`;
        default: return `${op} on ${field}: ${flat(value)}.`;
      }
    });
  });
}

/** Plain-English steps for a spec. Returns an empty list when the spec is structurally invalid. */
export function explain(input: unknown): string[] {
  const { spec } = check(input);
  if (!spec) return [];
  const where = `${spec.database ? `database ${spec.database}, ` : ""}collection ${spec.collection}`;
  const steps: string[] = [`Work in ${where}.`];
  const opts = spec.options as Obj | undefined;
  switch (spec.op) {
    case "find":
    case "findOne":
      steps.push(`Find ${spec.op === "find" ? "documents" : "the first document"} where ${describeFilter(spec.filter)}.`);
      if (spec.projection) steps.push(`Return only these fields: ${Object.entries(spec.projection).map(([k, v]) => (v === 0 || v === false ? `all except ${k}` : k)).join(", ")}.`);
      if (spec.sort) steps.push(`Sort by ${sortPairs(spec.sort).map(([k, d]) => `${k} ${d === -1 ? "descending" : "ascending"}`).join(", ")}.`);
      if (spec.skip) steps.push(`Skip the first ${spec.skip} results.`);
      if (spec.op === "find" && spec.limit) steps.push(`Return at most ${spec.limit} results.`);
      break;
    case "aggregate":
      spec.pipeline.forEach((stage, index) => {
        if (isObj(stage) && Object.keys(stage).length === 1) steps.push(`Stage ${index + 1}: ${describeStage(Object.keys(stage)[0], Object.values(stage)[0])}`);
      });
      break;
    case "insertOne": steps.push(`Insert one document with fields: ${Object.keys(spec.document).join(", ") || "(none; MongoDB adds _id)"}.`); break;
    case "insertMany": steps.push(`Insert ${spec.documents.length} documents${opts?.ordered === false ? " (unordered: a failure does not stop the rest)" : " (ordered: the first failure stops the rest)"}.`); break;
    case "updateOne":
    case "updateMany":
      steps.push(`Select ${spec.op === "updateOne" ? "the first document" : "all documents"} where ${describeFilter(spec.filter)}.`, ...describeUpdate(spec.update));
      if (opts?.upsert === true) steps.push("If nothing matches, insert a new document (upsert).");
      break;
    case "replaceOne": steps.push(`Select the first document where ${describeFilter(spec.filter)}.`, `Replace it entirely with a document that has the fields: ${Object.keys(spec.replacement).join(", ") || "(none)"} (the _id is kept).`); break;
    case "deleteOne": steps.push(`Delete the first document where ${describeFilter(spec.filter)}.`); break;
    case "deleteMany": steps.push(`Delete every document where ${describeFilter(spec.filter)}.`); break;
    case "countDocuments": steps.push(`Count documents where ${describeFilter(spec.filter)}.`); break;
    case "distinct": steps.push(`List the distinct values of ${spec.field} among documents where ${describeFilter(spec.filter)}.`); break;
    case "createIndex":
      steps.push(`Create an index on ${Object.entries(spec.keys).map(([k, d]) => `${k} (${d === 1 ? "ascending" : d === -1 ? "descending" : String(d)})`).join(", ")}.`);
      if (isObj(spec.options)) {
        if (spec.options.unique === true) steps.push("Values must be unique.");
        if (typeof spec.options.expireAfterSeconds === "number") steps.push(`Documents expire ${spec.options.expireAfterSeconds} seconds after the indexed date (TTL).`);
        if (spec.options.partialFilterExpression) steps.push(`Only index documents where ${describeFilter(spec.options.partialFilterExpression)}.`);
      }
      break;
  }
  return steps;
}

/* ------------------------------------------------------------------ examples */

export interface MongoExample {
  id: string;
  title: string;
  description: string;
  spec: Obj;
}

export const MONGO_EXAMPLES: MongoExample[] = [
  { id: "find-active", title: "Find active adults, newest first", description: "A filter with two conditions, a projection, a sort and a limit.", spec: { op: "find", database: "shop", collection: "users", filter: { status: "active", age: { $gte: 18 } }, projection: { name: 1, email: 1, _id: 0 }, sort: { createdAt: -1 }, limit: 20 } },
  { id: "find-by-id", title: "Find one document by ObjectId", description: "Extended JSON {$oid} becomes ObjectId(...) in every language.", spec: { op: "findOne", collection: "orders", filter: { _id: { $oid: "507f1f77bcf86cd799439011" } } } },
  { id: "find-or-in", title: "Match any of several conditions", description: "$or, $in and a case-insensitive regex.", spec: { op: "find", collection: "products", filter: { $or: [{ category: { $in: ["books", "music"] } }, { title: { $regex: "^guide", $options: "i" } }] }, limit: 50 } },
  { id: "find-date-range", title: "Documents from last January", description: "Dates are Extended JSON {$date}: ISODate / datetime / new Date.", spec: { op: "find", collection: "events", filter: { at: { $gte: { $date: "2025-01-01T00:00:00Z" }, $lt: { $date: "2025-02-01T00:00:00Z" } } }, sort: { at: 1 } } },
  { id: "agg-revenue", title: "Revenue per customer", description: "$match early, $group, then $sort and $limit in the right order.", spec: { op: "aggregate", collection: "orders", pipeline: [{ $match: { status: "paid" } }, { $group: { _id: "$customerId", total: { $sum: "$amount" }, orders: { $sum: 1 } } }, { $sort: { total: -1 } }, { $limit: 10 }] } },
  { id: "agg-lookup", title: "Join orders with customers", description: "$lookup + $unwind + $project.", spec: { op: "aggregate", collection: "orders", pipeline: [{ $lookup: { from: "customers", localField: "customerId", foreignField: "_id", as: "customer" } }, { $unwind: "$customer" }, { $project: { total: 1, "customer.name": 1 } }] } },
  { id: "insert-one", title: "Insert one document", description: "Nested objects, arrays and a date.", spec: { op: "insertOne", collection: "users", document: { name: "Ada", tags: ["admin", "dev"], address: { city: "London" }, joined: { $date: "2024-05-17T09:30:00Z" } } } },
  { id: "insert-many", title: "Insert several documents", description: "Unordered so one failure does not stop the rest.", spec: { op: "insertMany", collection: "logs", documents: [{ level: "info", msg: "started" }, { level: "warn", msg: "disk almost full" }], options: { ordered: false } } },
  { id: "update-set-inc", title: "Update with $set and $inc", description: "Operators in the update, upsert in the options.", spec: { op: "updateOne", collection: "users", filter: { email: "ada@example.com" }, update: { $set: { status: "active" }, $inc: { logins: 1 } }, options: { upsert: true } } },
  { id: "update-array-filter", title: "Update array elements with arrayFilters", description: "$[elem] needs a matching arrayFilters entry.", spec: { op: "updateMany", collection: "orders", filter: { "items.sku": "A1" }, update: { $set: { "items.$[elem].qty": 0 } }, options: { arrayFilters: [{ "elem.sku": "A1" }] } } },
  { id: "replace-one", title: "Replace a whole document", description: "replaceOne takes a plain document, no operators.", spec: { op: "replaceOne", collection: "settings", filter: { key: "theme" }, replacement: { key: "theme", value: "dark" } } },
  { id: "delete-many", title: "Delete old log entries", description: "deleteMany with a date filter.", spec: { op: "deleteMany", collection: "logs", filter: { at: { $lt: { $date: "2024-01-01T00:00:00Z" } } } } },
  { id: "count", title: "Count documents", description: "countDocuments with a filter.", spec: { op: "countDocuments", collection: "users", filter: { status: "active" } } },
  { id: "distinct", title: "Distinct values", description: "List the distinct countries.", spec: { op: "distinct", collection: "users", field: "country", filter: { status: "active" } } },
  { id: "index-ttl", title: "TTL index on a date field", description: "Documents expire an hour after createdAt.", spec: { op: "createIndex", collection: "sessions", keys: { createdAt: 1 }, options: { expireAfterSeconds: 3600 } } },
  { id: "index-unique-partial", title: "Unique email, only for active users", description: "Unique + partialFilterExpression.", spec: { op: "createIndex", collection: "users", keys: { email: 1 }, options: { unique: true, partialFilterExpression: { status: "active" } } } },
];
