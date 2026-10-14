import * as z from "zod/v4";

/**
 * The database contract shared by the SQL lab UI, the Python engine (`server/py/scripts/sql_tool.py`),
 * the `knife_sql_*` tools and the assistant. Pure types + schemas: no server or browser imports.
 *
 * Idea: the assistant (or a person) states WHAT they want as a small JSON query spec; a deterministic
 * compiler (sqlglot) renders it for the chosen dialect, so dialect syntax is never a model guess.
 * Changes here must be additive: three consumers are built against it.
 */

/** Dialect ids are sqlglot names. MariaDB has no sqlglot dialect of its own and compiles as `mysql`. */
export const SQL_DIALECTS = [
  { id: "sqlite", label: "SQLite" },
  { id: "postgres", label: "PostgreSQL" },
  { id: "mysql", label: "MySQL" },
  { id: "mariadb", label: "MariaDB (as MySQL)" },
  { id: "tsql", label: "SQL Server (T-SQL)" },
  { id: "oracle", label: "Oracle" },
  { id: "bigquery", label: "BigQuery" },
  { id: "snowflake", label: "Snowflake" },
  { id: "duckdb", label: "DuckDB" },
  { id: "redshift", label: "Redshift" },
  { id: "clickhouse", label: "ClickHouse" },
  { id: "trino", label: "Trino / Presto" },
  { id: "spark", label: "Spark SQL" },
  { id: "hive", label: "Hive" },
] as const;

export type SqlDialect = (typeof SQL_DIALECTS)[number]["id"];
export const SQL_DIALECT_IDS = SQL_DIALECTS.map((d) => d.id) as [SqlDialect, ...SqlDialect[]];
export const sqlDialectSchema = z.enum(SQL_DIALECT_IDS);

/* ------------------------------------------------------------------ query spec */

/** A literal, a named parameter (rendered as the dialect's placeholder), a column, or a function call. */
export type SpecValue =
  | string
  | number
  | boolean
  | null
  | { param: string }
  | { col: string }
  | { fn: string; args?: SpecValue[]; distinct?: boolean };

export const specValueSchema: z.ZodType<SpecValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.object({ param: z.string().min(1) }).strict(),
    z.object({ col: z.string().min(1) }).strict(),
    // `distinct` turns an aggregate into e.g. COUNT(DISTINCT x) (aggregate fn with exactly one arg only).
    z.object({ fn: z.string().min(1), args: z.array(specValueSchema).optional(), distinct: z.boolean().optional() }).strict(),
  ]),
);

export const COMPARISON_OPS = ["=", "!=", "<", "<=", ">", ">=", "like", "ilike", "in", "not in", "between", "is null", "is not null"] as const;

export type SpecCondition =
  | { and: SpecCondition[] }
  | { or: SpecCondition[] }
  | { not: SpecCondition }
  | { col: string; op: (typeof COMPARISON_OPS)[number]; value?: SpecValue | SpecValue[] };

/**
 * Condition on an expression instead of a bare column: `lower(name) = ?` is
 * `{ expr: { fn: "lower", args: [{ col: "name" }] }, op: "=", value: { param: "p" } }`. In `having` the expression may be an
 * aggregate (`{ fn: "sum", args: [{ col: "total" }] }`); aggregates are rejected in where / join conditions.
 * Exactly one of `col` / `expr` per leaf. `{ fn, args, distinct: true }` gives COUNT(DISTINCT x).
 *
 * `specConditionSchema` (and therefore `querySpecSchema`) ACCEPTS these leaves at runtime, but the static type
 * `SpecCondition` deliberately still lists only the column leaf: the Build tab forms narrow on `.col` and are built on
 * that type. Code that handles conditions generically should use `SpecExprCondition` / `isExprCondition` below.
 */
export type SpecExprCondition = { expr: SpecValue; op: (typeof COMPARISON_OPS)[number]; value?: SpecValue | SpecValue[] };

export function isExprCondition(condition: unknown): condition is SpecExprCondition {
  return typeof condition === "object" && condition !== null && "expr" in condition;
}

const comparisonValue = z.union([specValueSchema, z.array(specValueSchema)]).optional();

export const specConditionSchema: z.ZodType<SpecCondition> = z.lazy(() =>
  z.union([
    z.object({ and: z.array(specConditionSchema).min(1) }).strict(),
    z.object({ or: z.array(specConditionSchema).min(1) }).strict(),
    z.object({ not: specConditionSchema }).strict(),
    z.object({ col: z.string().min(1), op: z.enum(COMPARISON_OPS), value: comparisonValue }).strict(),
    z.object({ expr: specValueSchema, op: z.enum(COMPARISON_OPS), value: comparisonValue }).strict(),
  ]),
) as z.ZodType<SpecCondition>;

export const AGGREGATES = ["count", "sum", "avg", "min", "max"] as const;

/** `"name"`, `"t.name"`, `"*"`, or an expression with an alias / aggregate. */
export type SpecColumn = string | { expr: SpecValue; as?: string; agg?: (typeof AGGREGATES)[number]; distinct?: boolean };

export const specColumnSchema: z.ZodType<SpecColumn> = z.union([
  z.string().min(1),
  z.object({
    expr: specValueSchema,
    as: z.string().min(1).optional(),
    agg: z.enum(AGGREGATES).optional(),
    distinct: z.boolean().optional(),
  }).strict(),
]);

const tableRefSchema = z.union([
  z.string().min(1),
  z.object({ name: z.string().min(1), as: z.string().min(1).optional() }).strict(),
]);

const joinSchema = z.object({
  type: z.enum(["inner", "left", "right", "full", "cross"]).default("inner"),
  table: tableRefSchema,
  on: specConditionSchema.optional(),
}).strict();

const orderSchema = z.object({
  expr: specValueSchema,
  dir: z.enum(["asc", "desc"]).optional(),
  nulls: z.enum(["first", "last"]).optional(),
}).strict();

const selectBase = {
  op: z.literal("select"),
  from: tableRefSchema,
  columns: z.array(specColumnSchema).optional(),
  distinct: z.boolean().optional(),
  joins: z.array(joinSchema).optional(),
  where: specConditionSchema.optional(),
  groupBy: z.array(specValueSchema).optional(),
  having: specConditionSchema.optional(),
  orderBy: z.array(orderSchema).optional(),
  limit: z.number().int().min(0).optional(),
  offset: z.number().int().min(0).optional(),
};

export type SelectSpec = {
  op: "select";
  from: string | { name: string; as?: string };
  columns?: SpecColumn[];
  distinct?: boolean;
  joins?: { type?: "inner" | "left" | "right" | "full" | "cross"; table: string | { name: string; as?: string }; on?: SpecCondition }[];
  where?: SpecCondition;
  groupBy?: SpecValue[];
  having?: SpecCondition;
  orderBy?: { expr: SpecValue; dir?: "asc" | "desc"; nulls?: "first" | "last" }[];
  limit?: number;
  offset?: number;
  ctes?: { name: string; query: SelectSpec }[];
};

export const selectSpecSchema: z.ZodType<SelectSpec> = z.lazy(() =>
  z.object({ ...selectBase, ctes: z.array(z.object({ name: z.string().min(1), query: selectSpecSchema }).strict()).optional() }).strict(),
) as z.ZodType<SelectSpec>;

const columnDefSchema = z.object({
  name: z.string().min(1),
  /** A portable type name (`integer`, `text`, `varchar(80)`, `timestamp`…); the compiler maps it per dialect. */
  type: z.string().min(1),
  nullable: z.boolean().optional(),
  default: specValueSchema.optional(),
  primaryKey: z.boolean().optional(),
  unique: z.boolean().optional(),
  /** Identity column: AUTO_INCREMENT / IDENTITY / GENERATED BY DEFAULT AS IDENTITY per dialect (`serial` types imply it). */
  autoIncrement: z.boolean().optional(),
  references: z.object({ table: z.string().min(1), column: z.string().min(1), onDelete: z.enum(["cascade", "restrict", "set null", "no action"]).optional() }).strict().optional(),
}).strict();

export const querySpecSchema = z.union([
  selectSpecSchema,
  z.object({
    op: z.literal("insert"),
    table: z.string().min(1),
    columns: z.array(z.string().min(1)).min(1),
    rows: z.array(z.array(specValueSchema)).min(1),
    onConflict: z.object({
      target: z.array(z.string().min(1)).min(1),
      action: z.enum(["nothing", "update"]),
      set: z.record(z.string(), specValueSchema).optional(),
    }).strict().optional(),
    returning: z.array(z.string().min(1)).optional(),
  }).strict(),
  z.object({
    op: z.literal("update"),
    table: z.string().min(1),
    set: z.record(z.string(), specValueSchema),
    where: specConditionSchema.optional(),
    returning: z.array(z.string().min(1)).optional(),
  }).strict(),
  z.object({
    op: z.literal("delete"),
    table: z.string().min(1),
    where: specConditionSchema.optional(),
    returning: z.array(z.string().min(1)).optional(),
  }).strict(),
  z.object({
    op: z.literal("create_table"),
    name: z.string().min(1),
    ifNotExists: z.boolean().optional(),
    columns: z.array(columnDefSchema).min(1),
    primaryKey: z.array(z.string().min(1)).optional(),
  }).strict(),
]);

export type QuerySpec = z.infer<typeof querySpecSchema>;

/* ------------------------------------------------------------------ engine API */

export const SQL_ACTIONS = ["format", "transpile", "validate", "schema", "compile", "check"] as const;
export type SqlAction = (typeof SQL_ACTIONS)[number];

export interface SqlIssue {
  message: string;
  line?: number;
  column?: number;
  /** "error" blocks; "warning" is a dialect feature that does not convert exactly. */
  level: "error" | "warning";
}

/** Table/column shape the checker validates references against. */
export interface SqlSchemaColumn {
  name: string;
  type?: string;
  nullable?: boolean;
  default?: string;
  primaryKey?: boolean;
  /** Single-column UNIQUE constraint (added by the schema action). */
  unique?: boolean;
}
export interface SqlSchemaTable {
  name: string;
  columns: SqlSchemaColumn[];
  primaryKey?: string[];
  foreignKeys?: { columns: string[]; refTable: string; refColumns: string[] }[];
  /** CREATE INDEX statements (added by the schema action). */
  indexes?: { name: string; columns: string[]; unique?: boolean }[];
}
export interface SqlSchema {
  tables: SqlSchemaTable[];
}

export const sqlSchemaSchema: z.ZodType<SqlSchema> = z.object({
  tables: z.array(z.object({
    name: z.string().min(1),
    columns: z.array(z.object({
      name: z.string().min(1),
      type: z.string().optional(),
      nullable: z.boolean().optional(),
      default: z.string().optional(),
      primaryKey: z.boolean().optional(),
      unique: z.boolean().optional(),
    }).strict()),
    primaryKey: z.array(z.string()).optional(),
    foreignKeys: z.array(z.object({ columns: z.array(z.string()), refTable: z.string(), refColumns: z.array(z.string()) }).strict()).optional(),
    indexes: z.array(z.object({ name: z.string(), columns: z.array(z.string()), unique: z.boolean().optional() }).strict()).optional(),
  }).strict()),
}).strict();

/** Per-action parameters and results (one JSON object in, one out; the route wraps them in `{ ok, data | error }`). */
export interface SqlActionMap {
  /** Pretty-print in one dialect. */
  format: { in: { sql: string; dialect: SqlDialect }; out: { sql: string } };
  /** Convert between dialects; `issues` lists constructs that do not translate exactly. */
  transpile: { in: { sql: string; from: SqlDialect; to: SqlDialect; pretty?: boolean }; out: { sql: string; issues: SqlIssue[] } };
  /** Parse in a dialect: syntax errors with positions, plus what the statements touch. */
  validate: {
    in: { sql: string; dialect: SqlDialect };
    out: { ok: boolean; issues: SqlIssue[]; statements: { kind: string; tables: string[]; columns: string[] }[] };
  };
  /** DDL -> structured schema (+ Mermaid ER diagram text). */
  schema: { in: { ddl: string; dialect: SqlDialect }; out: { schema: SqlSchema; mermaid: string; issues: SqlIssue[] } };
  /**
   * Query spec -> SQL with the dialect's placeholder style; `params` lists the named parameters in binding order.
   * Styles: `?` (sqlite, mysql, mariadb, duckdb, snowflake, clickhouse, trino, spark, hive; one entry per placeholder),
   * `$1` (postgres, redshift), `@name` (tsql, bigquery), `:name` (oracle) (named/numbered styles list each name once).
   * `issues` (optional) carries warnings such as emulated ILIKE or MariaDB-as-MySQL notes.
   */
  compile: { in: { spec: QuerySpec; dialect: SqlDialect; pretty?: boolean }; out: { sql: string; params: string[]; issues?: SqlIssue[] } };
  /** Does every table/column the SQL references exist in the schema? Catches invented columns. */
  check: { in: { sql: string; dialect: SqlDialect; schema: SqlSchema }; out: { ok: boolean; issues: SqlIssue[] } };
}

export type SqlResponse<A extends SqlAction> = { ok: true; data: SqlActionMap[A]["out"] } | { ok: false; error: string };
