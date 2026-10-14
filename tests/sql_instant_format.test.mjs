// Instant SQL formatter (src/lib/sql/instant-format.ts). The oracle is semantic: formatted SQL must return the same rows as the
// original when both run in SQLite (node:sqlite), so a formatter bug that moves code into a comment cannot hide behind "looks fine".
// Found 2026-10-10 in the browser: `... WHERE a=1 -- keep⏎AND b IN (1,2)` came back as `... a=1 -- keep AND b IN (1, 2)`.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --disable-warning=ExperimentalWarning --import ./tests/ts-resolve.mjs --test tests/sql_instant_format.test.mjs
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { formatSql } from "../src/lib/sql/instant-format.ts";

const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE t (a INTEGER, b INTEGER, name TEXT);
INSERT INTO t VALUES (1, 1, 'x'), (1, 5, 'y'), (1, 2, 'z'), (2, 1, 'w');`);
const rows = (sql) => db.prepare(sql).all();

const SAMPLES = [
  "SELECT a, b FROM t WHERE a=1 -- keep\nAND b IN (1,2)",
  "select a from t -- first\nwhere b = 5 -- second\norder by a",
  "SELECT a FROM t -- trailing comment on the last line",
  "SELECT name /* block */ FROM t WHERE a = 1 -- c\n  AND name <> 'q' ORDER BY name",
  "SELECT 'from where' AS s, \"name\" FROM t WHERE a=1 --c\nLIMIT 1",
  "SELECT a FROM t WHERE a=1 --\nAND b=1",
  "SELECT a,b FROM t\r\nWHERE a=1 -- crlf\r\nAND b=1",
];

for (const upper of [true, false]) {
  test(`formatted SQL returns the same rows as the original (upper=${upper})`, () => {
    for (const sql of SAMPLES) {
      const formatted = formatSql(sql, upper);
      assert.deepEqual(rows(formatted), rows(sql), `\n--- input\n${sql}\n--- formatted\n${formatted}`);
    }
  });
}

test("a line comment is always followed by a line break, so the next clause is never inside it", () => {
  const out = formatSql("SELECT a FROM t WHERE a=1 -- keep\nAND b IN (1,2)", true);
  assert.equal(out, "SELECT a\nFROM t\nWHERE a=1 -- keep\nAND b IN (1, 2)");
  assert.ok(!/--[^\n]*\bAND\b/.test(out.replace("-- keep", "")), out);
});

test("keywords inside strings and quoted identifiers are not touched", () => {
  const out = formatSql("select 'from where' as s, \"Order\" from t", true);
  assert.ok(out.includes("'from where'") && out.includes('"Order"'), out);
});

test("casing option and empty input", () => {
  assert.equal(formatSql("select a from t", false), "select a\nfrom t");
  assert.equal(formatSql("", true), "");
  assert.equal(formatSql("   \n ", true), "");
});

test("a trailing comment does not leave trailing whitespace or a blank last line", () => {
  const out = formatSql("SELECT a FROM t -- end", true);
  assert.equal(out, "SELECT a\nFROM t -- end");
});
