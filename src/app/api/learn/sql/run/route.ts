import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { findCourse, findLesson } from "@/lib/learn/courses";
import { updateLesson } from "@/lib/learn/progress";
import { learnError, readyConnection } from "@/lib/learn/sql/api";
import { runLearnerSql } from "@/lib/learn/sql/db";
import { withLearnerSlot } from "@/lib/learn/sql/slots";
import { msgf } from "@/lib/i18n/msg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ sql: z.string().max(20_000), lessonId: z.string().max(80).optional() }).strict();

/**
 * POST /api/learn/sql/run { sql, lessonId? } -> { run }: the learner's SQL in one rolled-back transaction as the course
 * role (5 s limit, first 500 rows of each result). With a lessonId the query is remembered as that lesson's last query.
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
  if (lessonId && (!course || !findLesson(course, lessonId))) return jsonError("unknown_lesson", 404);
  try {
    const info = await readyConnection();
    const run = await withLearnerSlot(auth.account.id, () => runLearnerSql(info, sql));
    const progress = lessonId
      ? updateLesson(auth.account.id, "sql", lessonId, (lesson) => ({ ...lesson, attempts: lesson.attempts + 1, lastQuery: sql, lastError: run.error?.message }))
      : undefined;
    return json({ run, progress });
  } catch (error) {
    return learnError(error);
  }
}
