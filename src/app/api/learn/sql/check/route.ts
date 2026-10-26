import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { findCourse, findLesson } from "@/lib/learn/courses";
import { updateLesson } from "@/lib/learn/progress";
import { learnError, readyConnection } from "@/lib/learn/sql/api";
import { withLearnerSlot } from "@/lib/learn/sql/slots";
import { checkLesson } from "@/lib/learn/sql/check";
import { DEFAULT_ROW_CAP } from "@/lib/learn/sql/db";
import { msgf } from "@/lib/i18n/msg";
import { translator } from "@/lib/i18n/core";
import { requestLocale } from "@/lib/i18n/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ sql: z.string().max(20_000), lessonId: z.string().max(80) }).strict();

/**
 * POST /api/learn/sql/check { lessonId, sql } -> { pass, message, compare?, run, progress }: runs the learner's SQL and
 * the lesson's reference solution (each rolled back) and compares them (src/lib/learn/sql/check.ts). A pass marks the
 * lesson complete; a fail is counted (Show solution unlocks after one).
 */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const read = await readJsonBody(request, 64 * 1024);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) return jsonError(msgf("Bad request: {value}: {message}", { value: parsed.error.issues[0].path.join("/") || "body", message: parsed.error.issues[0].message }), 422);
  const { sql, lessonId } = parsed.data;
  const course = findCourse("sql");
  const lesson = course ? findLesson(course, lessonId) : undefined;
  if (!lesson) return jsonError("unknown_lesson", 404);
  try {
    const info = await readyConnection();
    const outcome = await withLearnerSlot(auth.account.id, () => checkLesson(info, lesson, sql, translator(requestLocale(request))));
    const progress = updateLesson(auth.account.id, "sql", lessonId, (entry) => ({
      ...entry,
      attempts: entry.attempts + 1,
      failedChecks: entry.failedChecks + (outcome.pass ? 0 : 1),
      completedAt: entry.completedAt ?? (outcome.pass ? new Date().toISOString() : undefined),
      lastQuery: sql,
      lastError: outcome.run.error?.message,
      lastCheck: `${outcome.pass ? "PASS" : "FAIL"}: ${outcome.message}`,
    }));
    // The page shows the learner's rows like Run does: the same 500-row window.
    const run = { ...outcome.run, results: outcome.run.results.map((r) => (r.rows.length > DEFAULT_ROW_CAP ? { ...r, rows: r.rows.slice(0, DEFAULT_ROW_CAP), truncated: true } : r)) };
    return json({ pass: outcome.pass, message: outcome.message, compare: outcome.compare ?? null, run, progress });
  } catch (error) {
    return learnError(error);
  }
}
