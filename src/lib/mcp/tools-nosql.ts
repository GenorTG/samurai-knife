import * as z from "zod/v4";
import { defineTool, type KnifeToolDefinition } from "./define";
import * as chroma from "@/lib/nosql/chroma";
import { parseJsonLossless, type CompileResult, type NosqlIssue } from "@/lib/nosql/common";
import * as mongo from "@/lib/nosql/mongo";
import * as redis from "@/lib/nosql/redis";
import { msg } from "@/lib/i18n/msg";

/**
 * Deterministic NoSQL/vector helpers for the assistant and MCP (`knife_mongo_*`, `knife_chroma_*`, `knife_redis_*`).
 * The idea: state WHAT you want as a small JSON spec; the compiler writes the client code (mongosh/PyMongo/Node,
 * chromadb Python/JS, redis-cli/redis-py/node-redis) and the validator names every wrong field, so syntax is never
 * a model guess. Pure TypeScript in src/lib/nosql, no database connection.
 */

const specInput = {
  spec: z.record(z.string(), z.unknown()).optional().describe("The spec as a JSON object."),
  specText: z.string().max(200_000).optional().describe("The spec as text instead: JSON (big integers stay exact) or, for MongoDB, mongosh syntax; for Redis, redis-cli lines."),
};
const compileSchema = z.object({ ...specInput, compact: z.boolean().optional().describe("true = no line wrapping") }).strict();
const validateSchema = z.object(specInput).strict();

type Input = { spec?: Record<string, unknown>; specText?: string };

function resolve(input: Input, parse: (text: string) => { spec?: unknown; issues: NosqlIssue[] }): { spec?: unknown; issues: NosqlIssue[] } {
  if (input.specText !== undefined) return parse(input.specText);
  if (input.spec !== undefined) return { spec: input.spec, issues: [] };
  throw new Error(msg("Give either spec (a JSON object) or specText (the spec as text)."));
}

const parseJson = (text: string): { spec?: unknown; issues: NosqlIssue[] } => {
  const parsed = parseJsonLossless(text);
  return parsed.ok ? { spec: parsed.value, issues: [] } : { issues: [{ severity: "error", path: "(specText)", message: `Not valid JSON: ${parsed.message} (offset ${parsed.offset}).` }] };
};

const parseRedis = (text: string): { spec?: unknown; issues: NosqlIssue[] } => {
  const json = parseJson(text);
  if (json.spec !== undefined) return json;
  const lines = redis.parseCommandLines(text);
  return lines.spec ? { spec: lines.spec, issues: [] } : json;
};

const parseMongo = (text: string): { spec?: unknown; issues: NosqlIssue[] } => {
  const parsed = mongo.parseSpecText(text);
  return { spec: parsed.spec, issues: parsed.issues.filter((i) => i.severity === "error") };
};

function summarize(issues: NosqlIssue[]) {
  return {
    errors: issues.filter((i) => i.severity === "error"),
    warnings: issues.filter((i) => i.severity === "warning"),
    tips: issues.filter((i) => i.severity === "info"),
  };
}

function compileReport(result: CompileResult, parseIssues: NosqlIssue[], explain: string[]) {
  const issues = [...parseIssues, ...result.issues];
  return {
    ok: result.ok,
    snippets: result.snippets,
    ...summarize(issues),
    explain: result.ok ? explain : [],
    next: result.ok ? "Show the user the snippet(s) they asked for; mention any warnings." : "Fix every error (each names the field path and how to fix it), then call this tool again.",
  };
}

function validateReport(ok: boolean, issues: NosqlIssue[]) {
  return { ok, ...summarize(issues), next: ok ? "The spec is valid." : "Fix every error (each names the field path), then validate again." };
}

const MONGO_MANUAL =
  "Spec: {op, database?, collection, ...}. op is one of find, findOne, aggregate, insertOne, insertMany, updateOne, updateMany, replaceOne, deleteOne, deleteMany, countDocuments, distinct, createIndex. " +
  "Fields: filter, projection, sort ({field: 1|-1}), limit, skip, update ({$set: ...} or a pipeline array), replacement, pipeline, document, documents, field (distinct), keys (createIndex), options. " +
  'BSON values use Extended JSON v2: {"$oid": "<24 hex>"}, {"$date": "2025-01-02T03:04:05Z"}, {"$numberLong": "9007199254740993"}, {"$numberDecimal": "10.99"}, {"$regularExpression": {"pattern": "^a", "options": "i"}}. ' +
  "Example: {\"op\":\"find\",\"collection\":\"users\",\"filter\":{\"age\":{\"$gte\":18}},\"sort\":{\"name\":1},\"limit\":10}.";

const CHROMA_MANUAL =
  "Spec: {op, collection, client?, ...}. op is one of create_collection, get_or_create_collection, add, upsert, update, get, query, delete, count. " +
  "Fields: ids, documents, embeddings, metadatas (scalar values or same-type arrays; no nested objects), query_texts or query_embeddings, n_results, where, where_document, limit, offset, include, metadata, configuration ({\"hnsw\": {\"space\": \"cosine\"}}), embedding_function (default|none|openai). " +
  'client: {"type": "persistent"|"http"|"cloud"|"ephemeral", path|host|port|ssl|tenant|database}. where holds ONE condition per object: combine with {"$and": [..., ...]} (at least 2); operators $eq $ne $gt $gte $lt $lte $in $nin $contains $not_contains. where_document: $contains $not_contains $regex $not_regex. ' +
  'Example: {"op":"query","collection":"docs","query_texts":["pets"],"n_results":3,"where":{"year":{"$gte":2023}}}.';

const REDIS_MANUAL =
  'Spec: {ops: [{command, args}], mode?: "sequential"|"pipeline"|"transaction", connection?: {host, port, db, tls}}. args are strings or numbers (never booleans/objects). ' +
  'Do not write MULTI/EXEC: use mode "transaction". Commands, option spelling and arity are checked against the official command table. ' +
  'specText also accepts redis-cli lines, one command per line. Example: {"ops":[{"command":"SET","args":["k","v","EX",60]},{"command":"GET","args":["k"]}]}.';

export const NOSQL_KNIFE_TOOLS: KnifeToolDefinition[] = [
  defineTool({
    name: "knife_mongo_compile",
    scope: "pure",
    effect: "read",
    description:
      "Turn a small JSON spec of a MongoDB operation into correct, validated code for mongosh, PyMongo and the Node.js driver (plus Extended JSON), with a plain-English explanation. " +
      "Use this instead of hand-writing MongoDB syntax, and validate filters/pipelines through it. Returns errors with exact field paths and fixes when the spec is wrong. No database connection is made. " +
      MONGO_MANUAL,
    schema: compileSchema,
    run: (input) => {
      const { spec, issues } = resolve(input, parseMongo);
      if (spec === undefined) return { ok: false, snippets: [], ...summarize(issues), explain: [], next: "Fix the text so it parses, then call again." };
      return compileReport(mongo.compile(spec, { compact: input.compact }), issues, mongo.explain(spec));
    },
  }),
  defineTool({
    name: "knife_mongo_validate",
    scope: "pure",
    effect: "read",
    description:
      "Check a MongoDB operation spec without generating code: every $operator is validated against the official lists (with did-you-mean), update documents, projections, sorts, index options and aggregation pipelines (stage order, $group needs _id, $out last, $match early). " +
      "Always run it on filters and pipelines you wrote before showing them. Same spec format as knife_mongo_compile.",
    schema: validateSchema,
    run: (input) => {
      const { spec, issues } = resolve(input, parseMongo);
      if (spec === undefined) return validateReport(false, issues);
      const result = mongo.validate(spec);
      return validateReport(result.ok, [...issues, ...result.issues]);
    },
  }),
  defineTool({
    name: "knife_chroma_compile",
    scope: "pure",
    effect: "read",
    description:
      "Turn a small JSON spec of a Chroma (vector database) operation into validated Python (chromadb) and JavaScript (chromadb npm) code, with explanation. " +
      "Use it instead of hand-writing Chroma calls; it enforces equal-length ids/documents/embeddings/metadatas, unique string ids, scalar metadata, valid where/where_document operators, and notes the embedding-function default. No database connection is made. " +
      CHROMA_MANUAL,
    schema: compileSchema,
    run: (input) => {
      const { spec, issues } = resolve(input, parseJson);
      if (spec === undefined) return { ok: false, snippets: [], ...summarize(issues), explain: [], next: "Fix the JSON, then call again." };
      return compileReport(chroma.compile(spec, { compact: input.compact }), issues, chroma.explain(spec));
    },
  }),
  defineTool({
    name: "knife_chroma_validate",
    scope: "pure",
    effect: "read",
    description:
      "Check a Chroma operation spec without generating code: where / where_document filters (operator names, exactly one condition per object, $and/$or need 2+ items, operand types), metadata types, list lengths, ids, collection name rules, include values. Always run it on filters you wrote. Same spec format as knife_chroma_compile.",
    schema: validateSchema,
    run: (input) => {
      const { spec, issues } = resolve(input, parseJson);
      if (spec === undefined) return validateReport(false, issues);
      const result = chroma.validate(spec);
      return validateReport(result.ok, [...issues, ...result.issues]);
    },
  }),
  defineTool({
    name: "knife_redis_compile",
    scope: "pure",
    effect: "read",
    description:
      "Turn a list of Redis commands (JSON spec, or redis-cli lines) into validated redis-cli lines, redis-py and node-redis code. Arity, option spelling and argument types are checked against the official command table; dangerous or slow commands (KEYS, FLUSHALL, SMEMBERS, blocking calls) come back as warnings. " +
      "Use it instead of hand-writing client code. No server connection is made. " + REDIS_MANUAL,
    schema: compileSchema,
    run: (input) => {
      const { spec, issues } = resolve(input, parseRedis);
      if (spec === undefined) return { ok: false, snippets: [], ...summarize(issues), explain: [], next: "Fix the input, then call again." };
      return compileReport(redis.compile(spec), issues, redis.explain(spec));
    },
  }),
  defineTool({
    name: "knife_redis_explain",
    scope: "pure",
    effect: "read",
    description:
      "Explain Redis commands in plain English: what each command does, its documented time complexity, and pitfalls (KEYS, FLUSHALL, big collections, blocking commands, deprecated commands). Also validates arity and option spelling. Same spec format as knife_redis_compile (a {ops: [{command, args}]} object, or redis-cli lines in specText).",
    schema: validateSchema,
    run: (input) => {
      const { spec, issues } = resolve(input, parseRedis);
      if (spec === undefined) return validateReport(false, issues);
      const result = redis.validate(spec);
      return { ...validateReport(result.ok, [...issues, ...result.issues]), steps: redis.explain(spec) };
    },
  }),
];
