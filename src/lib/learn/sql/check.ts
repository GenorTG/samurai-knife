import { translator, type Translator } from "@/lib/i18n/core";
import type { Lesson, MustUse } from "../types";
import { compareResults, type CompareResult } from "./compare";
import { runLearnerSql, type ConnectionInfo, type RunOutput, type StatementResult } from "./db";
import { codeOnly } from "./statements";

/**
 * Lesson checking: run the learner's SQL and the reference solution (each in its own rolled-back transaction) and
 * compare. `evaluate` is pure (tests/learn_sql.test.mjs); `checkLesson` adds the database.
 */

export const CHECK_ROW_CAP = 5000;

export interface CheckOutcome {
  pass: boolean;
  message: string;
  /** Set for result checks that got as far as comparing. */
  compare?: CompareResult;
  /** The learner's run (results, error), so the page can show it like Run does. */
  run: RunOutput;
}

/** Required constructs the learner's SQL lacks (patterns from the lesson, outside comments and strings). */
export function missingConstructs(sql: string, mustUse: MustUse[] | undefined): MustUse[] {
  if (!mustUse?.length) return [];
  const code = codeOnly(sql);
  return mustUse.filter((rule) => !new RegExp(rule.pattern, "i").test(code));
}

/** The result a lesson looks at: the last statement that returned columns (a SELECT, RETURNING or EXPLAIN). */
export function lastResult(run: RunOutput): StatementResult | null {
  for (let index = run.results.length - 1; index >= 0; index -= 1) {
    if (run.results[index].columns.length > 0) return run.results[index];
  }
  return null;
}

export function planText(result: StatementResult): string {
  return result.rows.map((row) => row.map((cell) => (cell === null ? "" : String(cell))).join(" ")).join("\n");
}

/** Pure part of the check, given both runs. */
export function evaluate(lesson: Lesson, sql: string, mine: RunOutput, reference: RunOutput | null, tr: Translator = translator("en")): CheckOutcome {
  const { t } = tr;
  if (mine.error) return { pass: false, message: t("Your query failed: {message}", { message: mine.error.message }), run: mine };
  const mineLast = lastResult(mine);
  if (!mineLast) return { pass: false, message: t("Your query returned no result set. End with a SELECT (or RETURNING / EXPLAIN) so there is something to check."), run: mine };
  const missing = missingConstructs(sql, lesson.check.mustUse);
  const check = lesson.check;
  if (check.kind === "plan") {
    const text = planText(mineLast);
    if (!new RegExp(check.mustMatch).test(text)) {
      return { pass: false, message: t("The plan should show {describe}, and this one does not.", { describe: t(check.describe) }) + (missing.length ? ` ${t(missing[0].message)}` : ""), run: mine };
    }
    if (check.mustNotMatch && new RegExp(check.mustNotMatch).test(text)) {
      return { pass: false, message: t("The plan still contains \"{found}\"; it should show {describe}.", { found: new RegExp(check.mustNotMatch).exec(text)?.[0], describe: t(check.describe) }), run: mine };
    }
    if (missing.length) return { pass: false, message: t(missing[0].message), run: mine };
    return { pass: true, message: t("Correct: the plan shows {describe}.", { describe: t(check.describe) }), run: mine };
  }
  if (!reference || reference.error) {
    return { pass: false, message: t("The reference solution failed to run ({message}); this is a course bug, not yours.", { message: reference?.error?.message ?? t("no result") }), run: mine };
  }
  const refLast = lastResult(reference);
  if (!refLast) return { pass: false, message: t("The reference solution returned no result set (course bug)."), run: mine };
  if (mineLast.truncated || refLast.truncated) {
    return { pass: false, message: t("The result has more than {cap} rows, too many to check. The expected answer is much smaller: add the missing filter or GROUP BY.", { cap: CHECK_ROW_CAP }), run: mine };
  }
  const compare = compareResults(refLast, mineLast, { ordered: check.ordered, columnNames: check.columnNames, decimals: check.decimals, tr });
  if (compare.pass && missing.length) return { pass: false, message: t("The rows are right, but this lesson practises a specific construct: {construct}", { construct: t(missing[0].message) }), compare, run: mine };
  return { pass: compare.pass, message: compare.message, compare, run: mine };
}

export async function checkLesson(info: ConnectionInfo, lesson: Lesson, sql: string, tr: Translator = translator("en")): Promise<CheckOutcome> {
  const mine = await runLearnerSql(info, sql, { rowCap: CHECK_ROW_CAP });
  if (mine.error || lesson.check.kind === "plan") return evaluate(lesson, sql, mine, null, tr);
  const reference = await runLearnerSql(info, lesson.solution, { rowCap: CHECK_ROW_CAP });
  return evaluate(lesson, sql, mine, reference, tr);
}
