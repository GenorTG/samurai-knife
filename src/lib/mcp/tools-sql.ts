import * as z from "zod/v4";
import { defineTool, type KnifeToolDefinition } from "./define";
import { runSql } from "@/lib/sql/engine";
import { sqlDialectSchema, sqlSchemaSchema } from "@/lib/sql/types";

/**
 * Deterministic SQL tools for the assistant and MCP (`knife_sql_*`): format, transpile, validate, extract a schema,
 * compile a JSON query spec, check SQL against a schema. They call the sqlglot engine through `src/lib/sql/engine.ts`
 * (one-shot Python, no database connection).
 *
 * Schema decision: the recursive QuerySpec is exposed to function calling as a loose object (`{ op, ...rest }`)
 * and validated in full by the engine (`server/py/scripts/sqlkit/spec.py`), because recursive `$ref`/`anyOf` JSON
 * schemas are rejected or mangled by several OpenAI-compatible backends. The grammar lives in the tool description,
 * and engine errors name the offending field path (`spec.where.and[1].op: ...`) so the model can self-correct.
 */

const SQL_TEXT_MAX = 200_000;
const sqlText = z.string().min(1).max(SQL_TEXT_MAX);
const dialect = sqlDialectSchema.describe("Target SQL dialect id.");

const compileSchema = z.object({
  spec: z.looseObject({
    op: z.enum(["select", "insert", "update", "delete", "create_table"]).describe("Statement kind."),
  }).describe("Query spec object; full grammar in the tool description."),
  dialect,
  pretty: z.boolean().optional().describe("Multi-line formatted output."),
}).strict();

const checkSchema = z.object({
  sql: sqlText.describe("The SQL to verify (may hold several statements)."),
  dialect,
  schema: sqlSchemaSchema.optional().describe("Tables and columns, e.g. from knife_sql_schema or the user's description."),
  ddl: z.string().max(SQL_TEXT_MAX).optional().describe("CREATE TABLE statements to derive the schema from (use instead of `schema`)."),
}).strict();

function unwrap<T>(response: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!response.ok) throw new Error(response.error);
  return response.data;
}

export const SQL_KNIFE_TOOLS: KnifeToolDefinition[] = [
  defineTool({
    name: "knife_sql_format",
    scope: "pure",
    effect: "read",
    description: "Pretty-print SQL for one dialect (sqlglot). Deterministic; use it to tidy a query before showing it. Fails with the line/column of a syntax error.",
    schema: z.object({ sql: sqlText, dialect }).strict(),
    run: async ({ sql, dialect: d }, ctx) => unwrap(await runSql("format", { sql, dialect: d }, undefined, ctx?.accountId)),
  }),
  defineTool({
    name: "knife_sql_transpile",
    scope: "pure",
    effect: "read",
    description: "Convert SQL from one dialect to another (sqlglot). Use this for every dialect move instead of rewriting by hand. ALWAYS read `issues`: level 'error' means the converted SQL will not run on the target (no RETURNING, upsert without MERGE, arrays...), 'warning' means it runs but is an approximation (emulated ILIKE, FULL JOIN, DATEDIFF semantics). Several statements are separated by `;`.",
    schema: z.object({
      sql: sqlText,
      from: sqlDialectSchema.describe("Dialect the SQL is written in."),
      to: sqlDialectSchema.describe("Dialect to produce."),
      pretty: z.boolean().optional(),
    }).strict(),
    run: async ({ sql, from, to, pretty }, ctx) => unwrap(await runSql("transpile", { sql, from, to, pretty }, undefined, ctx?.accountId)),
  }),
  defineTool({
    name: "knife_sql_validate",
    scope: "pure",
    effect: "read",
    description: "Parse SQL in a dialect. Returns syntax errors with line/column plus, per statement, its kind (select, insert, create_table...), the tables and the columns it references. Checks syntax only; to verify names against the user's schema use knife_sql_check.",
    schema: z.object({ sql: sqlText, dialect }).strict(),
    run: async ({ sql, dialect: d }, ctx) => unwrap(await runSql("validate", { sql, dialect: d }, undefined, ctx?.accountId)),
  }),
  defineTool({
    name: "knife_sql_schema",
    scope: "pure",
    effect: "read",
    description: "Turn CREATE TABLE / CREATE INDEX / ALTER TABLE statements into a structured schema (tables, columns, types, nullability, defaults, primary and foreign keys, indexes) plus a Mermaid erDiagram. Pass the result's `schema` to knife_sql_check. `dialect` defaults to postgres.",
    schema: z.object({ ddl: sqlText, dialect: sqlDialectSchema.optional() }).strict(),
    run: async ({ ddl, dialect: d }, ctx) => unwrap(await runSql("schema", { ddl, dialect: d ?? "postgres" }, undefined, ctx?.accountId)),
  }),
  defineTool({
    name: "knife_sql_compile",
    scope: "pure",
    effect: "read",
    description: [
      "Compile a JSON query spec into dialect-correct SQL (no database is contacted). PREFER THIS over hand-writing SQL: it gets LIMIT vs TOP/FETCH, identifier quoting, ILIKE, upsert (ON CONFLICT vs ON DUPLICATE KEY), booleans, identity columns and placeholders right per dialect. Then run knife_sql_check on the result against the user's schema.",
      "spec.op = select | insert | update | delete | create_table.",
      "select: {op, from: 'tbl'|{name,as}, columns?: ['a','t.b','*', {expr: VALUE, as?, agg?: count|sum|avg|min|max, distinct?}], distinct?, joins?: [{type?: inner|left|right|full|cross, table, on?: COND}], where?: COND, groupBy?: [VALUE], having?: COND, orderBy?: [{expr: VALUE, dir?: asc|desc, nulls?: first|last}], limit?, offset?, ctes?: [{name, query: select}]}.",
      "insert: {op, table, columns: [..], rows: [[VALUE..]], onConflict?: {target: [cols], action: nothing|update, set?: {col: VALUE}}, returning?: [cols]}. In onConflict.set use {col:'excluded.x'} for the incoming value (default for action update: every non-target column).",
      "update: {op, table, set: {col: VALUE}, where?, returning?}. delete: {op, table, where?, returning?}.",
      "create_table: {op, name, ifNotExists?, columns: [{name, type: portable e.g. integer|bigint|text|varchar(80)|numeric(10,2)|boolean|timestamp|date|uuid|json|serial, nullable?, default?: VALUE, primaryKey?, unique?, autoIncrement?, references?: {table, column, onDelete?: cascade|restrict|'set null'|'no action'}}], primaryKey?: [cols]}.",
      "VALUE = string|number|boolean|null literal | {param: name} (bound placeholder: ALWAYS use it for user-supplied values) | {col: 't.c'} | {fn: name, args?: [VALUE], distinct?: true} where fn is any SQL function (now, upper, coalesce, sum, count...), an operator (+ - * / % ||) or cast with args [value, 'type']; distinct (count/sum/avg/min/max with one arg) gives COUNT(DISTINCT x).",
      "COND = {col OR expr: VALUE, op: = != < <= > >= like ilike in 'not in' between 'is null' 'is not null', value?} (in: array; between: [lo, hi]; value may be a VALUE incl. {col}) | {and: [COND..]} | {or: [COND..]} | {not: COND}. Use `expr` to filter on a function or aggregate: WHERE lower(name) = ? is {expr: {fn: 'lower', args: [{col: 'name'}]}, op: '=', value: {param: 'p'}}; HAVING sum(total) > 100 is {expr: {fn: 'sum', args: [{col: 'total'}]}, op: '>', value: 100} (aggregates only in having, never in where/on). In having, a col (or a {col} inside expr) naming an aggregate alias from columns also stands for that aggregate.",
      "Returns {sql, params, issues}: bind `params` in order. Placeholders: ? (sqlite, mysql, mariadb, duckdb, snowflake, clickhouse, trino, spark, hive; one per occurrence), $1.. (postgres, redshift), @name (tsql, bigquery), :name (oracle). Some dialects refuse features they lack (upsert/returning/identity): the error says so; read `issues` warnings too.",
    ].join("\n"),
    schema: compileSchema,
    run: async ({ spec, dialect: d, pretty }, ctx) => unwrap(await runSql("compile", { spec: spec as never, dialect: d, pretty }, undefined, ctx?.accountId)),
  }),
  defineTool({
    name: "knife_sql_check",
    scope: "pure",
    effect: "read",
    description: "Verify SQL against a schema: every table and column must exist; reports unknown tables/columns with a did-you-mean, ambiguous columns, unknown aliases and wrong value counts in INSERT. ALWAYS call this after writing or editing SQL from natural language, with the user's real schema (`schema` from knife_sql_schema, or `ddl`), and fix every issue with level 'error' before presenting the query. Never invent column names to make a query look plausible: ask or inspect the schema instead.",
    schema: checkSchema,
    run: async ({ sql, dialect: d, schema, ddl }, ctx) => {
      if (schema && ddl) throw new Error("Pass either `schema` or `ddl`, not both.");
      if (!schema && !ddl) throw new Error("Pass the schema to check against: `schema` ({ tables: [...] }) or `ddl` (CREATE TABLE statements).");
      let resolved = schema;
      const schemaIssues: unknown[] = [];
      if (ddl) {
        const built = unwrap(await runSql("schema", { ddl, dialect: d }, undefined, ctx?.accountId));
        const errors = built.issues.filter((issue) => issue.level === "error");
        if (errors.length) {
          throw new Error(`The DDL does not parse: ${errors.map((issue) => `${issue.message}${issue.line ? ` (line ${issue.line})` : ""}`).join("; ")}`);
        }
        resolved = built.schema;
        schemaIssues.push(...built.issues);
      }
      const result = unwrap(await runSql("check", { sql, dialect: d, schema: resolved as NonNullable<typeof resolved> }, undefined, ctx?.accountId));
      return schemaIssues.length ? { ...result, schemaIssues } : result;
    },
  }),
];
