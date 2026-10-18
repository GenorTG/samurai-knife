// Database course (src/lib/learn): statement splitting and the runner's statement policy, result comparison, the
// lesson registry (shape, ids, hints, solutions accepted by the runner and using their own required constructs), the
// pure part of the check, the seed script guard and the per-account progress store. No database: the reference
// solutions are run against real Postgres by tests/learn_db_e2e.py.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/learn_sql.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "knife-learn-"));
process.env.KNIFE_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const { splitStatements, classifyStatement, codeOnly, lineColumn } = await import("../src/lib/learn/sql/statements.ts");
const { compareResults, normalizeCell } = await import("../src/lib/learn/sql/compare.ts");
const { SQL_COURSE, SQL_LESSONS, SQL_MODULES } = await import("../src/lib/learn/sql/lessons.ts");
const { COURSES, findCourse, findLesson } = await import("../src/lib/learn/courses.ts");
const { evaluate, missingConstructs, lastResult } = await import("../src/lib/learn/sql/check.ts");
const { seedScript, SEED_VERSION } = await import("../src/lib/learn/sql/seed.ts");
const progress = await import("../src/lib/learn/progress.ts");
const { readAccountText } = await import("../src/lib/storage/sealed.ts");
const { TOOLS, findTool, CATEGORIES } = await import("../src/lib/registry.ts");
const { findSidecar } = await import("../src/lib/services/definitions.ts");

/* ------------------------------------------------------------------------------------------ statements */

test("split: semicolons inside strings, dollar quotes, identifiers and comments do not split", () => {
  const sql = "SELECT 'a;b', $$x;y$$, $t$p;q$t$, \"we;ird\" -- c;\n; /* x; /* nested; */ y; */ SELECT E'it\\'s;' ;  ; \n -- only a comment;\n";
  const parts = splitStatements(sql);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].words[0], "SELECT");
  assert.equal(parts[1].words[0], "SELECT");
  // A leading comment belongs to the statement after it; offsets index the original text.
  assert.equal(sql.slice(parts[1].start, parts[1].start + parts[1].text.length), parts[1].text);
  assert.match(parts[1].text, /^\/\* x; .* \*\/ SELECT E'it\\'s;'$/s);
  assert.equal(splitStatements("  -- nothing\n /* here */ ;").length, 0);
});

test("split: offsets point into the original text (error positions)", () => {
  const sql = "SELECT 1;\n\n  SELECT nme FROM products";
  const [, second] = splitStatements(sql);
  assert.equal(second.start, sql.indexOf("SELECT nme"));
  assert.deepEqual(lineColumn(sql, second.start + 8), { line: 3, column: 10 });
});

test("policy: reads, writes, EXPLAIN, temp objects and savepoints run; transaction control and DDL on course tables do not", () => {
  const verdict = (sql) => classifyStatement(splitStatements(sql)[0]);
  for (const sql of ["SELECT 1", "WITH x AS (SELECT 1) SELECT * FROM x", "VALUES (1)", "TABLE products", "(SELECT 1) UNION (SELECT 2)"]) {
    assert.deepEqual(verdict(sql), { ok: true, kind: "read", cursor: true }, sql);
  }
  assert.equal(verdict("WITH d AS (DELETE FROM orders RETURNING *) SELECT count(*) FROM d").cursor, false, "data-modifying WITH cannot be a cursor");
  assert.equal(verdict("SELECT * INTO t FROM products").cursor, false);
  for (const sql of ["INSERT INTO categories (name) VALUES ('x')", "UPDATE products SET price = 1", "DELETE FROM order_items", "EXPLAIN ANALYZE SELECT 1",
    "CREATE TEMP TABLE t AS SELECT 1", "CREATE TEMPORARY TABLE t (a int)", "CREATE LOCAL TEMP TABLE t (a int)", "CREATE INDEX ON t (a)", "CREATE UNIQUE INDEX i ON t (a)",
    "DROP TABLE t", "ANALYZE t", "SAVEPOINT a", "RELEASE SAVEPOINT a", "ROLLBACK TO SAVEPOINT a", "ROLLBACK TO a", "SET LOCAL enable_seqscan = off", "SHOW search_path"]) {
    assert.equal(verdict(sql).ok, true, sql);
  }
  for (const sql of ["BEGIN", "START TRANSACTION", "COMMIT", "END", "ROLLBACK", "ABORT", "COPY products TO STDOUT", "DO $$ BEGIN END $$", "CALL p()",
    "GRANT ALL ON products TO PUBLIC", "ALTER TABLE products ADD COLUMN x int", "TRUNCATE orders", "CREATE TABLE shop.x (a int)", "CREATE ROLE r",
    "CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql", "DROP SCHEMA shop", "SET statement_timeout = 0", "SET SESSION AUTHORIZATION postgres",
    "SET ROLE postgres", "RESET ALL", "DISCARD ALL", "PREPARE p AS SELECT 1", "EXECUTE p", "LISTEN x", "VACUUM", "LOCK orders", "LOAD 'x'", "PREPARE TRANSACTION 'x'"]) {
    const result = verdict(sql);
    assert.equal(result.ok, false, sql);
    assert.ok(result.reason.length > 10, `${sql} explains why`);
  }
  assert.match(verdict("COMMIT").reason, /rolled back/);
});

test("codeOnly: comments and string contents are blanked, code stays in place", () => {
  const sql = "SELECT 'OVER (x)' -- OVER (\n, a /* OVER ( */ FROM t";
  const code = codeOnly(sql);
  assert.equal(code.length, sql.length);
  assert.doesNotMatch(code, /OVER/);
  assert.match(code, /^SELECT ' {8}'/);
  assert.match(code, /FROM t$/);
});

/* ------------------------------------------------------------------------------------------ compare */

const rs = (columns, rows) => ({ columns, rows });

test("compare: multiset rows, numeric text vs numbers, column order by name, NULLs", () => {
  const expected = rs(["name", "total"], [["a", "10.50"], ["b", 3], ["c", null]]);
  assert.equal(compareResults(expected, rs(["name", "total"], [["c", null], ["a", 10.5], ["b", "3"]]), { ordered: false }).pass, true);
  assert.equal(compareResults(expected, rs(["TOTAL", "Name"], [[10.5, "a"], [3, "b"], [null, "c"]]), { ordered: false }).pass, true, "same names, other order");
  const wrong = compareResults(expected, rs(["x", "y"], [["a", 10.5], ["b", 3], ["b", 3], ["d", 1]]), { ordered: false });
  assert.equal(wrong.pass, false);
  assert.equal(wrong.missing, 1);
  assert.equal(wrong.extra, 2);
  assert.deepEqual(wrong.examples.missing, ["(c, NULL)"]);
  assert.match(wrong.message, /4 rows, the expected result has 3/);
});

test("compare: duplicates count (multiset, not set)", () => {
  const expected = rs(["v"], [[1], [1], [2]]);
  assert.equal(compareResults(expected, rs(["v"], [[1], [2], [2]]), { ordered: false }).pass, false);
  assert.equal(compareResults(expected, rs(["v"], [[2], [1], [1]]), { ordered: false }).pass, true);
});

test("compare: column count, required names, order only when asked", () => {
  const expected = rs(["name", "price"], [["x", 1], ["y", 2]]);
  const columns = compareResults(expected, rs(["name"], [["x"], ["y"]]), { ordered: false });
  assert.equal(columns.pass, false);
  assert.match(columns.columnProblem, /Expected 2 columns/);
  assert.equal(compareResults(expected, rs(["n", "p"], [["x", 1], ["y", 2]]), { ordered: false, columnNames: "match" }).pass, false);
  const reversed = rs(["name", "price"], [["y", 2], ["x", 1]]);
  assert.equal(compareResults(expected, reversed, { ordered: false }).pass, true);
  const ordered = compareResults(expected, reversed, { ordered: true });
  assert.equal(ordered.pass, false);
  assert.equal(ordered.firstOrderMismatch, 0);
  assert.match(ordered.message, /order/);
});

test("compare: rounding, dates vs midnight timestamps, booleans vs text", () => {
  assert.equal(normalizeCell("69.54", 1), normalizeCell(69.5432, 1));
  assert.notEqual(normalizeCell(1.24, 2), normalizeCell(1.25, 2));
  assert.equal(normalizeCell("2024-03-01 00:00:00"), normalizeCell("2024-03-01"));
  assert.notEqual(normalizeCell("2024-03-01 10:00:00"), normalizeCell("2024-03-01"));
  assert.notEqual(normalizeCell(true), normalizeCell("true"));
  assert.notEqual(normalizeCell(null), normalizeCell("null"));
  assert.equal(normalizeCell(-0.001, 2), normalizeCell(0, 2));
});

/* ------------------------------------------------------------------------------------------ lessons */

test("lesson registry: unique ids, known modules, every module used, about 30+ lessons", () => {
  const ids = SQL_LESSONS.map((lesson) => lesson.id);
  assert.equal(new Set(ids).size, ids.length, "unique ids");
  assert.ok(SQL_LESSONS.length >= 30, `${SQL_LESSONS.length} lessons`);
  const modules = new Set(SQL_MODULES.map((m) => m.id));
  for (const lesson of SQL_LESSONS) {
    assert.match(lesson.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, lesson.id);
    assert.ok(modules.has(lesson.module), `${lesson.id}: module ${lesson.module}`);
  }
  for (const group of SQL_MODULES) assert.ok(SQL_LESSONS.some((l) => l.module === group.id), `module ${group.id} has lessons`);
  // Lessons of a module are contiguous (the list groups them in this order).
  const order = SQL_LESSONS.map((l) => l.module).filter((m, i, all) => m !== all[i - 1]);
  assert.deepEqual(order, SQL_MODULES.map((m) => m.id));
  assert.deepEqual(COURSES.map((c) => c.id), ["sql"]);
  assert.equal(findCourse("sql"), SQL_COURSE);
  assert.equal(findLesson(SQL_COURSE, "select-all")?.title, "Your first SELECT");
});

test("every lesson: text, task, reference solution, 2-3 hints, concepts; the solution passes the runner policy and its own mustUse", () => {
  for (const lesson of SQL_LESSONS) {
    const where = lesson.id;
    assert.ok(lesson.title.trim() && lesson.explanation.trim().length > 40 && lesson.task.trim().length > 20, `${where}: texts`);
    assert.ok(lesson.solution.trim(), `${where}: solution`);
    assert.ok(lesson.hints.length >= 2 && lesson.hints.length <= 3, `${where}: 2-3 hints`);
    assert.ok(lesson.hints.every((h) => h.trim()), `${where}: empty hint`);
    assert.ok(lesson.concepts.length > 0, `${where}: concepts`);
    const statements = splitStatements(lesson.solution);
    assert.ok(statements.length > 0, `${where}: statements`);
    for (const statement of statements) assert.equal(classifyStatement(statement).ok, true, `${where}: runner accepts "${statement.text.slice(0, 40)}"`);
    assert.deepEqual(missingConstructs(lesson.solution, lesson.check.mustUse), [], `${where}: solution uses its required constructs`);
    if (lesson.check.kind === "plan") {
      assert.doesNotThrow(() => new RegExp(lesson.check.mustMatch), where);
      if (lesson.check.mustNotMatch) assert.doesNotThrow(() => new RegExp(lesson.check.mustNotMatch), where);
    }
    if (lesson.check.kind === "result" && lesson.check.ordered) assert.match(codeOnly(lesson.solution), /ORDER\s+BY/i, `${where}: an ordered check needs ORDER BY in the solution`);
    if (lesson.starter.trim()) assert.notEqual(lesson.starter.trim(), lesson.solution.trim(), `${where}: the starter is not the answer`);
  }
});

/* ------------------------------------------------------------------------------------------ check (pure) */

const lessonOf = (id) => SQL_LESSONS.find((l) => l.id === id);
const run = (results, error = null) => ({ results, notices: [], durationMs: 1, error, rolledBack: true });
const res = (columns, rows, extra = {}) => ({ command: "SELECT", columns, rows, rowCount: rows.length, truncated: false, ...extra });

test("evaluate: last result set counts; errors, missing result, mustUse and truncation fail with a reason", () => {
  const lesson = lessonOf("select-null");
  const reference = run([res(["customer_id", "first_name", "last_name"], [[3, "Anna", "Mazur"]])]);
  const ok = evaluate(lesson, "SELECT customer_id, first_name, last_name FROM customers WHERE email IS NULL", run([res(["a"], [[1]]), res(["customer_id", "first_name", "last_name"], [[3, "Anna", "Mazur"]])]), reference);
  assert.equal(ok.pass, true);
  assert.equal(lastResult(run([res(["a"], [[1]]), { command: "UPDATE", columns: [], rows: [], rowCount: 3, truncated: false }])).columns[0], "a");
  const construct = evaluate(lesson, "SELECT customer_id, first_name, last_name FROM customers WHERE coalesce(email, '') = ''", run([res(["customer_id", "first_name", "last_name"], [[3, "Anna", "Mazur"]])]), reference);
  assert.equal(construct.pass, false);
  assert.match(construct.message, /IS NULL/);
  const failed = evaluate(lesson, "SELECT x", run([], { message: "column \"x\" does not exist", statement: 0 }), reference);
  assert.match(failed.message, /does not exist/);
  assert.equal(evaluate(lesson, "UPDATE t SET a = 1", run([{ command: "UPDATE", columns: [], rows: [], rowCount: 1, truncated: false }]), reference).pass, false);
  const big = evaluate(lesson, "SELECT * FROM events", run([res(["customer_id", "first_name", "last_name"], [], { truncated: true })]), reference);
  assert.match(big.message, /too many to check/);
});

test("evaluate: plan lessons match the plan text", () => {
  const lesson = lessonOf("idx-create");
  const plan = (lines) => run([res(["QUERY PLAN"], lines.map((line) => [line]))]);
  const sql = "CREATE TEMP TABLE ev AS SELECT * FROM events; CREATE INDEX ON ev (customer_id); EXPLAIN SELECT * FROM ev WHERE customer_id = 42";
  assert.equal(evaluate(lesson, sql, plan(["Bitmap Heap Scan on ev", "  ->  Bitmap Index Scan on ev_customer_id_idx"]), null).pass, true);
  assert.equal(evaluate(lesson, sql, plan(["Seq Scan on ev  (cost=0.00..3971.00 rows=997 width=29)"]), null).pass, false);
  assert.equal(evaluate(lesson, "EXPLAIN SELECT * FROM events WHERE event_id = 1", plan(["Index Scan using events_pkey on events"]), null).pass, false, "no CREATE INDEX");
});

/* ------------------------------------------------------------------------------------------ seed */

test("seed script: versioned, deterministic (no random()), learner password must be hex", () => {
  assert.ok(Number.isInteger(SEED_VERSION) && SEED_VERSION >= 1);
  assert.throws(() => seedScript("x'; DROP ROLE postgres; --"));
  const script = seedScript("abcdef0123456789abcd");
  assert.doesNotMatch(script, /\brandom\s*\(/i, "deterministic: knife_admin.rnd, never random()");
  assert.match(script, /seed_version/);
  assert.match(script, /NOSUPERUSER/);
  assert.match(script, /GRANT SELECT ON ALL TABLES IN SCHEMA shop, geo TO knife_learner/);
  assert.doesNotMatch(script, /GRANT [^;]*\b(INSERT|UPDATE|DELETE)\b[^;]*SCHEMA[^;]*\bgeo\b/, "geo stays read-only");
  assert.doesNotMatch(script, /\$\{/, "no unrendered template");
});

test("seed script: one learner cannot signal, or find, another learner's backend (SEED_VERSION >= 3)", () => {
  assert.ok(SEED_VERSION >= 3, "the revokes need a rebuild of existing installs");
  const script = seedScript("abcdef0123456789abcd");
  for (const revoke of [
    "REVOKE EXECUTE ON FUNCTION pg_catalog.pg_terminate_backend(integer, bigint) FROM PUBLIC, knife_learner;",
    "REVOKE EXECUTE ON FUNCTION pg_catalog.pg_cancel_backend(integer) FROM PUBLIC, knife_learner;",
    "REVOKE SELECT ON pg_catalog.pg_locks FROM PUBLIC;",
    "REVOKE EXECUTE ON FUNCTION pg_catalog.pg_lock_status() FROM PUBLIC;",
    "REVOKE EXECUTE ON FUNCTION pg_catalog.pg_stat_get_backend_idset() FROM PUBLIC;",
    "REVOKE EXECUTE ON FUNCTION pg_catalog.pg_stat_get_backend_pid(integer) FROM PUBLIC;",
    "REVOKE SELECT ON pg_catalog.pg_stat_activity FROM PUBLIC;",
  ]) {
    assert.ok(script.includes(revoke), revoke);
  }
});

/* ------------------------------------------------------------------------------------------ progress */

test("progress: per account and course, private file, attempts/hints/completion, reset", () => {
  assert.deepEqual(progress.readProgress("alice", "sql"), { lessons: {} });
  progress.updateLesson("alice", "sql", "select-all", (p) => ({ ...p, attempts: p.attempts + 1, lastQuery: "SELECT 1", failedChecks: 1 }));
  const after = progress.updateLesson("alice", "sql", "select-all", (p) => ({ ...p, attempts: p.attempts + 1, completedAt: "2026-10-15T10:00:00Z", hintsShown: 2 }));
  assert.equal(after.current, "select-all");
  assert.deepEqual(
    { a: after.lessons["select-all"].attempts, f: after.lessons["select-all"].failedChecks, h: after.lessons["select-all"].hintsShown, q: after.lessons["select-all"].lastQuery },
    { a: 2, f: 1, h: 2, q: "SELECT 1" },
  );
  const file = join(dataDir, "learn", "alice.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(dataDir, "learn")).mode & 0o777, 0o700);
  assert.equal(JSON.parse(readAccountText("alice", file)).version, 1);
  assert.deepEqual(progress.readProgress("bob", "sql"), { lessons: {} }, "accounts are separate");
  progress.updateLesson("alice", "redis", "intro", (p) => p);
  assert.deepEqual(progress.resetCourse("alice", "sql"), { lessons: {} });
  assert.deepEqual(progress.readProgress("alice", "sql"), { lessons: {} });
  assert.ok(progress.readProgress("alice", "redis").lessons.intro, "other courses survive a reset");
  assert.throws(() => progress.readProgress("../etc", "sql"), progress.ProgressError);
  const long = progress.updateLesson("alice", "sql", "select-all", (p) => ({ ...p, lastQuery: "x".repeat(30_000) }));
  assert.equal(long.lessons["select-all"].lastQuery.length, 20_000);
});

/* ------------------------------------------------------------------------------------------ registry */

test("registry: Learn category and the db-course suite with the sql tab on the learn-db sidecar", () => {
  assert.ok(CATEGORIES.some((c) => c.id === "learn" && c.label === "Learn"));
  const tool = findTool("db-course");
  assert.equal(tool.category, "learn");
  assert.equal(tool.sidecar, "learn-db");
  assert.deepEqual(tool.tabs.map((t) => [t.id, t.component]), [["sql", "learn-sql"]]);
  assert.equal(findSidecar("learn-db").usedBy[0], "db-course");
  assert.equal(TOOLS.filter((t) => t.slug === "db-course").length, 1);
});
