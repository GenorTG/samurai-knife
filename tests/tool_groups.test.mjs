import assert from "node:assert/strict";
import { test } from "node:test";
import { TOOL_GROUPS, groupOf, initialGroups, loadToolsDef, runLoadTools, visibleTools } from "../src/lib/agent-client/tool-groups.ts";

const def = (name) => ({ type: "function", function: { name, description: "d", parameters: { type: "object", properties: {} } } });
const ALL = ["list_tools", "load_tools", "knife_hash", "knife_sql_compile", "knife_sql_check", "knife_mongo_compile", "knife_chroma_validate", "knife_redis_explain"].map(def);
const names = (defs) => defs.map((d) => d.function.name);
const call = (name, args = {}) => ({ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }] });

test("groups cover exactly the database tool prefixes", () => {
  assert.equal(groupOf("knife_sql_compile")?.id, "sql");
  for (const n of ["knife_mongo_compile", "knife_chroma_validate", "knife_redis_explain"]) assert.equal(groupOf(n)?.id, "nosql", n);
  for (const n of ["knife_hash", "list_tools", "load_tools", "knife_json_format"]) assert.equal(groupOf(n), null, n);
  assert.equal(groupOf("doc_live_read")?.id, "office_live");
  assert.deepEqual(TOOL_GROUPS.map((g) => g.id), ["sql", "cv", "docs", "nosql", "office_live"]);
});

test("on an ordinary page only the core tools are sent", () => {
  assert.deepEqual(names(visibleTools(ALL, initialGroups("/tools/json", []))), ["list_tools", "load_tools", "knife_hash"]);
});

test("lab pages preload their own group (also with a tab query-less path and trailing slash)", () => {
  assert.deepEqual([...initialGroups("/tools/sql-lab", [])], ["sql"]);
  assert.deepEqual([...initialGroups("/tools/nosql-lab/", [])], ["nosql"]);
  assert.deepEqual([...initialGroups("/tools/cv-studio", [])], ["cv"]);
  assert.equal(groupOf("knife_cv_patch")?.id, "cv");
  assert.deepEqual([...initialGroups("/tools/sql-labx", [])], []);
  assert.ok(names(visibleTools(ALL, initialGroups("/tools/sql-lab", []))).includes("knife_sql_check"));
  assert.ok(!names(visibleTools(ALL, initialGroups("/tools/sql-lab", []))).includes("knife_mongo_compile"));
});

test("a group the conversation already used (directly or via load_tools) stays loaded", () => {
  assert.deepEqual([...initialGroups("/tools/json", [call("knife_mongo_compile")])], ["nosql"]);
  assert.deepEqual([...initialGroups("/tools/json", [call("load_tools", { group: "sql" })])], ["sql"]);
  assert.deepEqual([...initialGroups("/tools/json", [call("load_tools", { group: "bogus" })])], []);
  assert.deepEqual([...initialGroups("/tools/json", [{ role: "assistant", content: null, tool_calls: [{ id: "x", type: "function", function: { name: "load_tools", arguments: "{oops" } }] }])], []);
});

test("load_tools adds the group, lists its tools, rejects unknown groups, and is idempotent", () => {
  const active = new Set();
  const first = JSON.parse(runLoadTools({ group: "sql" }, active, ALL).content);
  assert.deepEqual(first.tools, ["knife_sql_compile", "knife_sql_check"]);
  assert.ok(active.has("sql"));
  assert.match(JSON.parse(runLoadTools({ group: "sql" }, active, ALL).content).note, /Already/);
  const bad = runLoadTools({ group: "nope" }, active, ALL);
  assert.equal(bad.ok, false);
  assert.match(bad.content, /Unknown group/);
});

test("loaded groups are appended after the core tools (request prefix stays stable)", () => {
  const before = names(visibleTools(ALL, new Set()));
  const after = names(visibleTools(ALL, new Set(["sql"])));
  assert.deepEqual(after.slice(0, before.length), before);
});

test("the load_tools definition is valid function-calling JSON with an enum of the groups", () => {
  const d = loadToolsDef();
  assert.equal(d.function.name, "load_tools");
  assert.deepEqual(d.function.parameters.properties.group.enum, ["sql", "cv", "docs", "nosql"], "office_live is page-only (its tools need the open editor)");
  assert.deepEqual(d.function.parameters.required, ["group"]);
  assert.ok(d.function.description.length < 900, d.function.description.length);
});
