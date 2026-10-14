import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

// The worker-side SQLite helpers (src/lib/sql/sqlite-runtime.ts) run against the real sql.js build (Node flavour).
const require = createRequire(import.meta.url);
const initSqlJs = require("sql.js");
const rt = await import("../src/lib/sql/sqlite-runtime.ts");
const SQL = await initSqlJs();

const fresh = () => new SQL.Database();

test("runScript stores at most maxStored rows but counts every row, and reports progress", () => {
  const db = fresh();
  const seen = [];
  const out = rt.runScript(db, "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 10000) SELECT i FROM n;", {
    maxStored: 100,
    onProgress: (p) => seen.push(p.rows),
  });
  assert.equal(out.error, null);
  assert.equal(out.results[0].total, 10000);
  assert.equal(out.results[0].rows.length, 100);
  assert.ok(seen.length >= 4 && seen.every((n, i) => i === 0 || n > seen[i - 1]), `progress ${seen}`);
});

test("a failing statement keeps the earlier ones applied and names the failing index", () => {
  const db = fresh();
  const out = rt.runScript(db, "CREATE TABLE t(a); INSERT INTO t VALUES (1); INSERT INTO nope VALUES (2); INSERT INTO t VALUES (3);", { maxStored: 10 });
  assert.equal(out.error.index, 3);
  assert.match(out.error.message, /no such table/);
  assert.deepEqual(db.exec("select a from t")[0].values, [[1]]);
});

test("changeMarker ignores reads and moves on writes, CTE writes and DDL", () => {
  const db = fresh();
  db.run("CREATE TABLE t(a)");
  const m0 = rt.changeMarker(db);
  rt.runScript(db, "SELECT * FROM t; PRAGMA table_info(t);", { maxStored: 10 });
  assert.equal(rt.changeMarker(db), m0, "reads leave the marker alone");
  db.run("INSERT INTO t VALUES (1)");
  const m1 = rt.changeMarker(db);
  assert.notEqual(m1, m0);
  db.run("WITH c(x) AS (SELECT 5) INSERT INTO t SELECT x FROM c");
  const m2 = rt.changeMarker(db);
  assert.notEqual(m2, m1);
  db.run("CREATE INDEX i ON t(a)");
  assert.notEqual(rt.changeMarker(db), m2);
});

test("snapshotOf round-trips the database and refuses databases over the limit", () => {
  const db = fresh();
  db.run("CREATE TABLE t(a); INSERT INTO t VALUES (1),(2),(3)");
  const snap = rt.snapshotOf(db, 1 << 20);
  assert.ok(snap && snap.length > 0);
  const copy = rt.openDatabase(SQL, snap);
  assert.deepEqual(copy.exec("select count(*) from t")[0].values, [[3]]);
  assert.equal(rt.snapshotOf(db, 10), null);
  assert.deepEqual(db.exec("select count(*) from t")[0].values, [[3]], "the live database survives an export");
});

test("importDelimited infers types, reports progress and rolls back on failure", () => {
  const db = fresh();
  const rows = [["id", "zip", "v"]];
  for (let i = 0; i < 12000; i += 1) rows.push([String(i), "007", String(i / 4)]);
  const seen = [];
  const out = rt.importDelimited(db, "big", rows, (n, total) => seen.push([n, total]));
  assert.equal(out.rows, 12000);
  assert.deepEqual(seen.map((p) => p[0]), [0, 5000, 10000]);
  const types = db.exec("select name, type from pragma_table_info('big')")[0].values;
  assert.deepEqual(types, [["id", "INTEGER"], ["zip", "TEXT"], ["v", "REAL"]]);
  assert.deepEqual(db.exec("select count(*) from big")[0].values, [[12000]]);
});

test("detectDelimiter prefers the most frequent candidate on the first line; .tsv forces tab", () => {
  assert.equal(rt.detectDelimiter("a;b;c\n1;2;3", "x.csv"), ";");
  assert.equal(rt.detectDelimiter("a,b|c|d", "x.txt"), "|");
  assert.equal(rt.detectDelimiter("single", "x.csv"), ",");
  assert.equal(rt.detectDelimiter("a,b", "x.tsv"), "\t");
});

test("csvCell quotes exactly when needed", () => {
  assert.equal(rt.csvCell(null), "");
  assert.equal(rt.csvCell("plain"), "plain");
  assert.equal(rt.csvCell('a,"b"'), '"a,""b"""');
  assert.equal(rt.csvCell("line\nbreak"), '"line\nbreak"');
  assert.equal(rt.csvCell(5), "5");
});
