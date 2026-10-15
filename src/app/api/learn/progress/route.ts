import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { findCourse, findLesson } from "@/lib/learn/courses";
import { readProgress, resetCourse, setCurrent, updateLesson } from "@/lib/learn/progress";
import { learnError } from "@/lib/learn/sql/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const lessonId = z.string().max(80);
const bodySchema = z.discriminatedUnion("action", [
  /** Open a lesson (remembered as the current one). */
  z.object({ action: z.literal("select"), course: z.string().max(40), lessonId }).strict(),
  /** One more hint shown (progressive); answers the new count. */
  z.object({ action: z.literal("hint"), course: z.string().max(40), lessonId }).strict(),
  z.object({ action: z.literal("solution"), course: z.string().max(40), lessonId }).strict(),
  /** Remember the editor text without running it. */
  z.object({ action: z.literal("save"), course: z.string().max(40), lessonId, sql: z.string().max(20_000) }).strict(),
  /** "Reset query": forget the lesson's last query (the starter comes back). */
  z.object({ action: z.literal("reset-query"), course: z.string().max(40), lessonId }).strict(),
  z.object({ action: z.literal("reset-course"), course: z.string().max(40) }).strict(),
]);

/** GET /api/learn/progress?course=sql -> { progress }: this account's progress in that course. */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const courseId = new URL(request.url).searchParams.get("course") ?? "";
  if (!findCourse(courseId)) return jsonError("unknown_course", 404);
  try {
    return json({ progress: readProgress(auth.account.id, courseId) });
  } catch (error) {
    return learnError(error);
  }
}

/** POST /api/learn/progress { action, course, lessonId?, ... } -> { progress }. */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const read = await readJsonBody(request, 64 * 1024);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) return jsonError(`Bad request: ${parsed.error.issues[0].path.join("/") || "body"}: ${parsed.error.issues[0].message}`, 422);
  const body = parsed.data;
  const course = findCourse(body.course);
  if (!course) return jsonError("unknown_course", 404);
  const account = auth.account.id;
  try {
    if (body.action === "reset-course") return json({ progress: resetCourse(account, course.id) });
    const lesson = findLesson(course, body.lessonId);
    if (!lesson) return jsonError("unknown_lesson", 404);
    switch (body.action) {
      case "select":
        return json({ progress: setCurrent(account, course.id, lesson.id) });
      case "hint":
        return json({ progress: updateLesson(account, course.id, lesson.id, (p) => ({ ...p, hintsShown: Math.min(lesson.hints.length, p.hintsShown + 1) })) });
      case "solution": {
        const current = readProgress(account, course.id).lessons[lesson.id];
        if (!current || (current.failedChecks === 0 && current.hintsShown < lesson.hints.length)) {
          return jsonError("Check a query first (or open every hint): the solution unlocks after a failed check.", 409, { code: "solution_locked" });
        }
        return json({ progress: updateLesson(account, course.id, lesson.id, (p) => ({ ...p, solutionShown: true })) });
      }
      case "save":
        return json({ progress: updateLesson(account, course.id, lesson.id, (p) => ({ ...p, lastQuery: body.sql })) });
      case "reset-query":
        return json({ progress: updateLesson(account, course.id, lesson.id, (p) => ({ ...p, lastQuery: undefined, lastError: undefined })) });
    }
  } catch (error) {
    return learnError(error);
  }
}
