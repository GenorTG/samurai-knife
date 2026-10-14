import type { QuerySpec } from "./types";

export interface SpecExample {
  id: string;
  label: string;
  spec: QuerySpec;
}

/** Examples are written against the sample shop schema (Schema tab -> "Sample: shop"). */
export const SPEC_EXAMPLES: SpecExample[] = [
  {
    id: "top-customers",
    label: "Top customers by revenue",
    spec: {
      op: "select",
      from: { name: "customers", as: "c" },
      columns: ["c.name", { expr: { col: "o.id" }, agg: "count", as: "orders" }, { expr: { col: "o.total" }, agg: "sum", as: "revenue" }],
      joins: [{ type: "left", table: { name: "orders", as: "o" }, on: { col: "o.customer_id", op: "=", value: { col: "c.id" } } }],
      groupBy: [{ col: "c.name" }],
      orderBy: [{ expr: { col: "revenue" }, dir: "desc" }],
      limit: 10,
    },
  },
  {
    id: "paged-filter",
    label: "Filtered, paginated list with parameters",
    spec: {
      op: "select",
      from: "orders",
      columns: ["id", "status", "placed_at", "total"],
      where: { and: [{ col: "status", op: "in", value: ["new", "paid"] }, { col: "total", op: ">=", value: { param: "min_total" } }, { not: { col: "placed_at", op: "is null" } }] },
      orderBy: [{ expr: { col: "placed_at" }, dir: "desc" }],
      limit: 25,
      offset: 50,
    },
  },
  {
    id: "insert-upsert",
    label: "Insert with upsert",
    spec: {
      op: "insert",
      table: "products",
      columns: ["sku", "title", "price", "stock"],
      rows: [["KB-01", "Mechanical keyboard", { param: "price" }, 10]],
      onConflict: { target: ["sku"], action: "update", set: { price: { param: "price" }, stock: 10 } },
    },
  },
  {
    id: "update-where",
    label: "Update with and/or filter",
    spec: {
      op: "update",
      table: "orders",
      set: { status: "shipped" },
      where: { and: [{ col: "status", op: "=", value: "paid" }, { or: [{ col: "total", op: ">", value: 100 }, { col: "customer_id", op: "=", value: { param: "customer_id" } }] }] },
    },
  },
  {
    id: "delete-not-in",
    label: "Delete with NOT and IN",
    spec: {
      op: "delete",
      table: "orders",
      where: { and: [{ not: { col: "status", op: "in", value: ["paid", "shipped"] } }, { col: "placed_at", op: "<", value: "2025-01-01" }] },
    },
  },
  {
    id: "create-table",
    label: "Create table with foreign key",
    spec: {
      op: "create_table",
      name: "reviews",
      ifNotExists: true,
      columns: [
        { name: "id", type: "integer", primaryKey: true },
        { name: "product_id", type: "integer", nullable: false, references: { table: "products", column: "id", onDelete: "cascade" } },
        { name: "rating", type: "integer", nullable: false },
        { name: "body", type: "text" },
      ],
    },
  },
];

export const BLANK_SPECS: Record<QuerySpec["op"], QuerySpec> = {
  select: { op: "select", from: "", columns: ["*"] },
  insert: { op: "insert", table: "", columns: [""], rows: [[""]] },
  update: { op: "update", table: "", set: { "": "" } },
  delete: { op: "delete", table: "" },
  create_table: { op: "create_table", name: "", columns: [{ name: "id", type: "integer", primaryKey: true }] },
};
