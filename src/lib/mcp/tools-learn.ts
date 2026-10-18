import * as z from "zod/v4";
import { defineTool, type KnifeToolContext, type KnifeToolDefinition } from "./define";
import { findCourse, findLesson } from "@/lib/learn/courses";
import { readProgress } from "@/lib/learn/progress";
import { readyConnection } from "@/lib/learn/sql/api";
import { LearnDbError, runLearnerSql } from "@/lib/learn/sql/db";
import { withLearnerSlot } from "@/lib/learn/sql/slots";
import { SQL_COURSE } from "@/lib/learn/sql/lessons";

/**
 * Tutor tools for the Database course (group `learn`): an agent reads where the learner is (current lesson, their last
 * query, its error and the latest check feedback) and tries SQL in the same sandbox, so it can give a targeted hint.
 * The reference solution is withheld unless `revealSolution` is set, which the tool description reserves for an
 * explicit request by the learner. Nothing here records progress.
 */

function account(ctx: KnifeToolContext | undefined): string {
  if (!ctx?.accountId) throw new Error("Course tools need an account context.");
  return ctx.accountId;
}

export const LEARN_KNIFE_TOOLS: KnifeToolDefinition[] = [
  defineTool({
    name: "knife_learn_lessons",
    scope: "account",
    effect: "read",
    description:
      "Database course (SQL & PostGIS, page /tools/db-course): the modules and lessons with this learner's status (done, attempts) and the lesson they are on. Use it before tutoring.",
    schema: z.object({}).strict(),
    run(_input, ctx) {
      const progress = readProgress(account(ctx), SQL_COURSE.id);
      return {
        current: progress.current ?? null,
        done: SQL_COURSE.lessons.filter((l) => progress.lessons[l.id]?.completedAt).length,
        total: SQL_COURSE.lessons.length,
        modules: SQL_COURSE.modules.map((m) => ({
          id: m.id,
          title: m.title,
          lessons: SQL_COURSE.lessons
            .filter((l) => l.module === m.id)
            .map((l) => ({ id: l.id, title: l.title, done: Boolean(progress.lessons[l.id]?.completedAt), attempts: progress.lessons[l.id]?.attempts ?? 0 })),
        })),
      };
    },
  }),
  defineTool({
    name: "knife_learn_lesson",
    scope: "account",
    effect: "read",
    description:
      "One Database course lesson (default: the learner's current one): explanation, task, the hints the learner has already opened, their last query, its error and the latest check feedback. To tutor: explain the error or nudge with a hint; do NOT give the full answer. Set revealSolution only when the learner explicitly asks for the solution.",
    schema: z.object({ lessonId: z.string().max(80).optional(), revealSolution: z.boolean().optional() }).strict(),
    run({ lessonId, revealSolution }, ctx) {
      const progress = readProgress(account(ctx), SQL_COURSE.id);
      const course = findCourse("sql") ?? SQL_COURSE;
      const id = lessonId ?? progress.current ?? course.lessons[0].id;
      const lesson = findLesson(course, id);
      if (!lesson) throw new Error(`Unknown lesson ${id}; knife_learn_lessons lists them.`);
      const entry = progress.lessons[lesson.id];
      return {
        id: lesson.id,
        module: lesson.module,
        title: lesson.title,
        explanation: lesson.explanation,
        task: lesson.task,
        concepts: lesson.concepts,
        checkedBy: lesson.check.kind === "plan" ? `the EXPLAIN plan must show ${lesson.check.describe}` : `result set comparison${lesson.check.ordered ? " (row order matters)" : ""}`,
        hintsOpened: lesson.hints.slice(0, entry?.hintsShown ?? 0),
        hintsTotal: lesson.hints.length,
        learner: {
          done: Boolean(entry?.completedAt),
          attempts: entry?.attempts ?? 0,
          failedChecks: entry?.failedChecks ?? 0,
          lastQuery: entry?.lastQuery ?? null,
          lastError: entry?.lastError ?? null,
          lastCheck: entry?.lastCheck ?? null,
        },
        ...(revealSolution ? { solution: lesson.solution } : {}),
      };
    },
  }),
  defineTool({
    name: "knife_learn_run",
    scope: "account",
    effect: "write",
    description:
      "Run SQL in the Database course sandbox (PostgreSQL 16 + PostGIS, schemas shop and geo, low-privilege role, everything rolled back, 5 s limit, first 50 rows). For trying a hint or explaining a result; it does not count as the learner's attempt.",
    schema: z.object({ sql: z.string().min(1).max(20_000) }).strict(),
    async run({ sql }, ctx) {
      try {
        const info = await readyConnection();
        const run = await withLearnerSlot(ctx?.accountId ?? "", () => runLearnerSql(info, sql, { rowCap: 50 }));
        return { error: run.error, notices: run.notices, durationMs: run.durationMs, results: run.results };
      } catch (error) {
        if (error instanceof LearnDbError && error.status === 409) throw new Error(`${error.message} (open /tools/db-course to start it)`);
        if (error instanceof LearnDbError) throw new Error(error.message);
        throw error;
      }
    },
  }),
];
