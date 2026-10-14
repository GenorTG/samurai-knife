import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Node strips TypeScript types natively: the zod contract in types.ts is loaded as-is.
const types = await import("../src/lib/sql/types.ts");
const pyDir = new URL("../server/py/scripts/sqlkit/", import.meta.url);
const py = (file) => readFileSync(new URL(file, pyDir), "utf8");

test("dialect ids in types.ts match the Python engine", () => {
  const ids = types.SQL_DIALECTS.map((d) => d.id);
  const block = /DIALECT_IDS = \(([^)]*)\)/s.exec(py("common.py"))[1];
  const pyIds = [...block.matchAll(/"([a-z0-9]+)"/g)].map((m) => m[1]);
  assert.deepEqual(pyIds, ids);
  const styles = /PLACEHOLDER_STYLE = \{(.*?)\n\}/s.exec(py("compile.py"))[1];
  const styled = new Set([...styles.matchAll(/"([a-z0-9]+)":/g)].map((m) => m[1]));
  assert.deepEqual([...styled].sort(), [...ids].sort(), "every dialect has a placeholder style");
});

test("QuerySpec zod schema accepts the specs the engine accepts", () => {
  const specs = [
    { op: "select", from: "users" },
    { op: "select", from: { name: "users", as: "u" }, columns: ["u.id", { expr: { col: "*" }, agg: "count", as: "n" }],
      joins: [{ type: "left", table: "orgs", on: { col: "u.org_id", op: "=", value: { col: "orgs.id" } } }],
      where: { and: [{ col: "u.age", op: "between", value: [1, { param: "hi" }] }, { not: { or: [{ col: "u.n", op: "is null" }] } }] },
      groupBy: [{ col: "u.id" }], having: { col: "n", op: ">", value: 1 }, orderBy: [{ expr: { col: "n" }, dir: "desc", nulls: "last" }], limit: 5, offset: 1,
      ctes: [{ name: "c", query: { op: "select", from: "t" } }] },
    { op: "insert", table: "t", columns: ["a"], rows: [[1], [{ param: "p" }]], onConflict: { target: ["a"], action: "update", set: { a: { col: "excluded.a" } } }, returning: ["a"] },
    { op: "update", table: "t", set: { a: { fn: "+", args: [{ col: "a" }, 1] } }, where: { col: "id", op: "=", value: 1 } },
    { op: "delete", table: "t" },
    { op: "create_table", name: "t", columns: [{ name: "id", type: "serial", primaryKey: true, autoIncrement: true }, { name: "o", type: "integer", references: { table: "orgs", column: "id", onDelete: "cascade" } }], primaryKey: ["id"] },
  ];
  for (const spec of specs) assert.ok(types.querySpecSchema.safeParse(spec).success, JSON.stringify(spec));
});

test("QuerySpec zod schema rejects structural mistakes the engine also rejects", () => {
  const bad = [
    { op: "merge", table: "t" },
    { op: "select" },
    { op: "select", from: "t", where: { and: [] } },
    { op: "select", from: "t", where: { col: "a", op: "~~", value: 1 } },
    { op: "select", from: "t", wher: {} },
    { op: "select", from: "t", limit: -1 },
    { op: "insert", table: "t", columns: [], rows: [[1]] },
    { op: "create_table", name: "t", columns: [] },
  ];
  for (const spec of bad) assert.ok(!types.querySpecSchema.safeParse(spec).success, JSON.stringify(spec));
});

test("schema contract accepts the engine's schema output shape (unique, indexes)", () => {
  const schema = { tables: [{ name: "t", columns: [{ name: "id", type: "INT", nullable: false, primaryKey: true, unique: true, default: "1" }], primaryKey: ["id"],
    foreignKeys: [{ columns: ["id"], refTable: "u", refColumns: ["id"] }], indexes: [{ name: "ix", columns: ["id"], unique: true }] }] };
  assert.ok(types.sqlSchemaSchema.safeParse(schema).success);
});

test("conditions on expressions: zod accepts {expr, op, value} (where, having aggregate, distinct) and rejects mixed or unknown shapes", () => {
  const lower = { fn: "lower", args: [{ col: "name" }] };
  const ok = [
    { op: "select", from: "t", where: { expr: lower, op: "=", value: { param: "p" } } },
    { op: "select", from: "t", columns: ["g"], groupBy: [{ col: "g" }], having: { expr: { fn: "sum", args: [{ col: "total" }] }, op: ">", value: 100 } },
    { op: "select", from: "t", columns: ["g"], groupBy: [{ col: "g" }], having: { and: [{ expr: { fn: "count", args: [{ col: "x" }], distinct: true }, op: ">=", value: 2 }, { col: "n", op: ">", value: 1 }] } },
    { op: "update", table: "t", set: { a: 1 }, where: { expr: { fn: "%", args: [{ col: "a" }, 2] }, op: "between", value: [0, 1] } },
  ];
  for (const spec of ok) assert.ok(types.querySpecSchema.safeParse(spec).success, JSON.stringify(spec));
  const bad = [
    { op: "select", from: "t", where: { col: "a", expr: lower, op: "=", value: 1 } },
    { op: "select", from: "t", where: { expr: lower } },
    { op: "select", from: "t", where: { expr: { fn: "lower", distinct: "yes" }, op: "=", value: 1 } },
    { op: "select", from: "t", where: { expr: lower, op: "~~", value: 1 } },
  ];
  for (const spec of bad) assert.ok(!types.querySpecSchema.safeParse(spec).success, JSON.stringify(spec));
  assert.ok(types.isExprCondition({ expr: lower, op: "=" }) && !types.isExprCondition({ col: "a", op: "=" }));
});
