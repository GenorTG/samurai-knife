# Database course (Learn)

A hands-on course inside the app: read a short explanation, write a query, run it against a **real** PostgreSQL +
PostGIS database, get it checked, open hints when stuck. Launcher category **Learn**, suite `db-course`
(`/tools/db-course`), one tab per course. The first course is **SQL & PostGIS** (tab `sql`): 46 lessons in 9 modules,
from `SELECT` to window functions, `EXPLAIN`, PostGIS catchments and interview drills.

## Pieces

| Where | What |
| --- | --- |
| `src/lib/learn/types.ts` | `Course`, `LessonModule`, `Lesson`, `LessonCheck` (metadata only, imported by browser and server). |
| `src/lib/learn/courses.ts` | `COURSES`: every course (today `sql`). |
| `src/lib/learn/sql/lessons.ts` | Modules and lessons of the SQL course (explanation, task, starter, reference solution, check, hints, concepts). |
| `src/lib/learn/sql/seed.ts` | The course data as one SQL script (`SEED_VERSION`), plus the learner role and its privileges. |
| `src/lib/learn/sql/statements.ts` | Pure: split learner SQL into statements (Postgres lexical rules) and the runner's statement policy. |
| `src/lib/learn/sql/db.ts` | Server: connection from the sidecar state/secrets, seeding (`ensureSeeded`), the learner runner, the schema browser query. |
| `src/lib/learn/sql/compare.ts`, `check.ts` | Pure result comparison and lesson checking (`evaluate`), plus `checkLesson` (runs both queries). |
| `src/lib/learn/progress.ts` | Per-account progress in `$KNIFE_DATA_DIR/learn/<account>.json` (600; dir 700). |
| `src/app/api/learn/…` | `POST sql/run`, `POST sql/check`, `GET sql/schema`, `POST sql/setup`, `GET|POST progress`. |
| `src/tools/learn/` | `SqlCourse` (install/start/seed gate, lesson list, lesson pane, editor, results, schema browser). |
| `src/lib/mcp/tools-learn.ts` | Tutor tools `knife_learn_lessons`, `knife_learn_lesson`, `knife_learn_run` (group `learn`). |

## The database (sidecar `learn-db`)

- `postgis/postgis:16-3.4` (PostgreSQL 16 + PostGIS 3.4), compose project `samurai-knife-learn-db`, port published on
  KNIFE_HOST only, named volume `pgdata`, `mem_limit` 1 GB, idle stop after 30 min, health = Postgres wire probe (see
  docs/SIDECARS.md). Secrets `POSTGRES_PASSWORD` (superuser, seeding only) and `LEARNER_PASSWORD` are generated at
  install into `secrets.env` and never leave the server.
- The page shows the install card (`SidecarCard`) while it is missing; when installed, opening the course runs a lazy
  start (`ensure`) and then `POST /api/learn/sql/setup`, each with `role=status` text. Measured: install (image cached)
  to lessons ~10 s, stopped to lessons ~3 s, seed ~2.5 s.

## Seed

`seedScript()` (`seed.ts`) runs as the superuser in ONE transaction under an advisory lock. It drops and rebuilds two
schemas and records `knife_admin.meta.seed_version`. `ensureSeeded` runs it when the stored version differs from
`SEED_VERSION` (or the role is missing) and caches "seeded" per container start; **bump `SEED_VERSION` whenever the
seed changes** and every install rebuilds at its next use. "Rebuild course data" (`setup {force:true}`) rebuilds now.

- `shop`: `categories` (two levels; Garden has no products), `products` (36, two never ordered), `customers` (200; some
  without email; 181-200 never order), `employees` (15, `manager_id` hierarchy, two earn more than their manager),
  `orders` (1200 in 2023-2024, statuses, NULL `employee_id` = online), `order_items`, `events` (200 000 clickstream rows,
  index on `created_at`, deliberately none on `customer_id`).
- `geo` (SRID 4326, `geometry` columns; lessons cast to `geography` for metres): `regions` (five rough rectangles, not
  real borders), `cities` (30 Polish cities, Silesia-heavy: approximate centre and rounded population, public facts),
  `chains` (invented: FreshMart, BudgetBox, CornerGo, MegaHome, GreenLeaf), `stores` (140 around city centres, GiST on
  `geom` and `geom::geography`), `candidate_sites` (Site A/B/C), `population_grid` (4464 synthetic ~1 km cells over the
  Upper Silesian metro area; each Silesian city spreads its population as a Gaussian).
- Deterministic without `random()`: every "random" choice is `knife_admin.rnd(stream, i)` (md5 of stream and row), so
  the data is identical on every machine and Postgres version. Nothing is a dump; nothing is private data.

## Privileges and the runner (the sandbox)

The real boundary is the role. `knife_learner`: `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`, connection limit
20, `CONNECT, TEMPORARY` on database `learn` only (CONNECT revoked from PUBLIC on `learn` and `postgres`), `USAGE` +
`SELECT` on `shop` and `geo`, `INSERT/UPDATE/DELETE` on `shop` only, no `CREATE` anywhere (PUBLIC's `CREATE` on `public`
revoked), role defaults `search_path = shop, geo, public`, `statement_timeout = 5s`, `temp_file_limit = 256MB`.
`knife_admin` is invisible to it. TEMP tables are the learner's scratch area (they die with the run).
Every learner shares this one role, and a role sees its own sessions' query text, so the seed revokes `SELECT` on
`pg_stat_activity` and `EXECUTE` on `pg_stat_get_activity` / `pg_stat_get_backend_activity` from `PUBLIC` in the course
database (SEED_VERSION 2): nobody reads another learner's SQL.

Fair share (`src/lib/learn/sql/slots.ts`): one run (or check) in flight per account (`KNIFE_LEARN_RUNS_PER_ACCOUNT`,
default 1; a second one is refused with 429 `run_in_progress`), at most `KNIFE_LEARN_MAX_RUNS` (default 12) on the server,
below the role's connection limit; a run waits up to 15 s for a server slot, then 503 `course_db_busy`. Rebuilding the
course data (`setup {force:true}`) and starting the database are admin-only in public mode (docs/ACCOUNTS.md "Roles").

Every run (`runLearnerSql`):

1. Split into statements (strings, `$tag$` quotes, quoted identifiers and comments respected; max 25 statements, 20 000
   characters) and vet each one (`classifyStatement`). Accepted: `SELECT/WITH/VALUES/TABLE/SHOW`, `EXPLAIN [ANALYZE]`,
   `INSERT/UPDATE/DELETE/MERGE`, `CREATE TEMP TABLE`, `CREATE [UNIQUE] INDEX`, `DROP TABLE/INDEX`, `ANALYZE`,
   `SAVEPOINT / RELEASE / ROLLBACK TO`, `SET LOCAL`. Refused with a reason and the statement's position: `BEGIN/COMMIT/
   ROLLBACK/END/ABORT` (they would end the runner's transaction), `COPY`, `DO`, `CALL`, `GRANT/REVOKE`, `ALTER`,
   `TRUNCATE`, session `SET`, `RESET`, `DISCARD`, `PREPARE/EXECUTE`, `LISTEN/NOTIFY`, other `CREATE/DROP`… This is the
   friendly layer; privileges decide the rest (e.g. `CREATE INDEX` on a course table fails with "must be owner").
2. A **fresh connection** as `knife_learner` (nothing a run sets survives it), `BEGIN`, `SET LOCAL search_path`.
3. Each statement in order. Plain queries go through `DECLARE … CURSOR` + `FETCH 501` inside a savepoint, so at most
   500 rows (5000 for checks) ever leave the server; the rest run directly. The first error stops the run; its
   position is mapped back to line/column of the learner's text.
4. `ROLLBACK`, always. Writes are visible to the later statements of the same run and gone afterwards.
5. Time: `statement_timeout` 5 s per statement; as a backstop the learner cannot `set_config` away, the backend is
   terminated from a superuser connection 1.5 s after the run's limit.

## Checking

`POST /api/learn/sql/check` runs the learner's SQL and the reference solution (each in its own rolled-back run) and
compares the **last result set** of each (`compare.ts`): same column count; columns matched by name when both use the
same names (any order, case-insensitive), else by position; rows as a multiset unless the lesson is `ordered`; numbers
and numeric text rounded to `decimals` (default 2); a date equals the same day's midnight timestamp. The feedback says
how many rows are missing/extra (with examples) or where the order first differs. `mustUse` rules (regex on the SQL
without comments/strings) make a lesson practise its construct (e.g. `ST_DWithin`, `OVER (`, `SAVEPOINT`). Plan
lessons (`kind: "plan"`) match the `EXPLAIN` text instead (e.g. an index scan on the learner's TEMP copy). A pass marks
the lesson done; a failed check unlocks "Show solution" (so do all hints; enforced server-side).

## Progress

`$KNIFE_DATA_DIR/learn/<account>.json`: per course, the current lesson and per lesson `completedAt`, `attempts`,
`failedChecks`, `hintsShown`, `solutionShown`, `lastQuery`, `lastError`, `lastCheck`. Run/check record it; the page
also saves an edited query when you leave a lesson. "Reset query" forgets the lesson's query, "Reset progress…" the
course's.

## Tutor tools

`knife_learn_lessons` (lessons + status), `knife_learn_lesson {lessonId?, revealSolution?}` (lesson text, the hints the
learner opened, their last query, error and check feedback; the solution only with `revealSolution`, which the
description reserves for an explicit request), `knife_learn_run {sql}` (same sandbox, 50 rows, not recorded). In the
widget the group `learn` is preloaded on `/tools/db-course` only (page-only, not in `load_tools`); MCP clients always
have it.

## Adding a lesson

1. Add a `Lesson` to the module's array in `src/lib/learn/sql/lessons.ts` (new stable kebab-case `id`; never rename
   one, it is a progress key). Explanation: the idea plus a tiny example; task: exact columns and order; 2-3 hints,
   vaguest first; `ordered: true` only when the task asks for an order (and give a tie-break).
2. If it needs new data, change `seed.ts` and bump `SEED_VERSION`.
3. `node --test` `tests/learn_sql.test.mjs` (shape, solution passes the runner policy and its own `mustUse`), then
   `python3 tests/learn_db_e2e.py` (every reference solution must pass its own check on the real database; no starter
   may pass as is).

## Adding a course (Redis, MongoDB, LangGraph…)

1. `src/lib/learn/<course>/lessons.ts` exporting a `Course`; add it to `COURSES`.
2. Its runner/API under `src/app/api/learn/<course>/…` (a sidecar of its own if it needs a server: docs/SIDECARS.md).
3. A tab in the `db-course` registry entry (`{ id, label, component }`) and the component in `src/tools/learn/`.
   Progress (`progress.ts`) is already keyed by course id.

## Tests

- Unit: `tests/learn_sql.test.mjs` (splitting/policy, comparison, lesson registry, `evaluate`, seed guard, progress,
  registry entry), `tests/services.test.mjs` (learn-db compose, Postgres health probe).
- Real docker: `python3 tests/learn_db_e2e.py [--host <tailscale-ip>] [--hold] [--remove-image]` — scratch server on the
  Tailscale address with its own compose project; install from the page; every lesson's reference solution through the
  API; sandbox probes (refusals, privileges, rollback, time limit + backstop, row cap, error position, schema); the
  Playwright lesson flow (wrong → hint → right, Ctrl+Enter, persistence across reload); tutor tools; stop + lazy start;
  remove with purge. ~1.5 min with a cached image. Not in `run_all.py` (needs docker).
