import * as z from "zod/v4";
import { existsSync } from "node:fs";
import { readAccountText } from "@/lib/storage/sealed";
import { writeAccountFile } from "@/lib/storage/quota";
import { accountScope, isValidAccountId, parentDir } from "@/lib/storage/scope";

/**
 * Course progress per account: `$KNIFE_DATA_DIR/learn/<account>.json` (file 600, dir 700), never in the repo.
 * One entry per course id and lesson id: completion, attempts, hints shown, the last query and its error.
 */

const MAX_QUERY_CHARS = 20_000;

const lessonSchema = z.object({
  completedAt: z.string().optional(),
  /** Runs + checks. */
  attempts: z.number().int().min(0).default(0),
  failedChecks: z.number().int().min(0).default(0),
  hintsShown: z.number().int().min(0).default(0),
  solutionShown: z.boolean().default(false),
  lastQuery: z.string().max(MAX_QUERY_CHARS).optional(),
  lastError: z.string().max(2000).optional(),
  /** Feedback of the latest check (pass or fail). */
  lastCheck: z.string().max(2000).optional(),
  updatedAt: z.string().optional(),
});

const courseSchema = z.object({
  current: z.string().optional(),
  lessons: z.record(z.string(), lessonSchema).default({}),
});

const fileSchema = z.object({
  version: z.literal(1),
  courses: z.record(z.string(), courseSchema).default({}),
});

export type LessonProgress = z.infer<typeof lessonSchema>;
export type CourseProgress = z.infer<typeof courseSchema>;
type ProgressFile = z.infer<typeof fileSchema>;

export class ProgressError extends Error {}

function progressPath(accountId: string): string {
  if (!isValidAccountId(accountId)) throw new ProgressError(`invalid account id ${accountId}`);
  const file = accountScope(accountId).learnFile;
  parentDir(file);
  return file;
}

function readFile(accountId: string): ProgressFile {
  const path = progressPath(accountId);
  if (!existsSync(path)) return { version: 1, courses: {} };
  try {
    return fileSchema.parse(JSON.parse(readAccountText(accountId, path)));
  } catch (error) {
    throw new ProgressError(`learn/${accountId}.json is damaged: ${(error as Error).message}`);
  }
}

function writeFile(accountId: string, data: ProgressFile): void {
  // Bookkeeping (small, bounded per lesson): counted by the quota but never refused.
  writeAccountFile(accountId, progressPath(accountId), `${JSON.stringify(data, null, 2)}\n`, { enforce: false });
}

export function readProgress(accountId: string, courseId: string): CourseProgress {
  return readFile(accountId).courses[courseId] ?? { lessons: {} };
}

const EMPTY: LessonProgress = { attempts: 0, failedChecks: 0, hintsShown: 0, solutionShown: false };

/** Read-modify-write of one lesson entry; returns the course's new progress. */
export function updateLesson(
  accountId: string,
  courseId: string,
  lessonId: string,
  change: (lesson: LessonProgress) => LessonProgress,
  options: { makeCurrent?: boolean } = {},
): CourseProgress {
  const data = readFile(accountId);
  const course = data.courses[courseId] ?? { lessons: {} };
  const next = change({ ...EMPTY, ...course.lessons[lessonId] });
  if (next.lastQuery && next.lastQuery.length > MAX_QUERY_CHARS) next.lastQuery = next.lastQuery.slice(0, MAX_QUERY_CHARS);
  if (next.lastError && next.lastError.length > 2000) next.lastError = next.lastError.slice(0, 2000);
  if (next.lastCheck && next.lastCheck.length > 2000) next.lastCheck = next.lastCheck.slice(0, 2000);
  course.lessons[lessonId] = { ...next, updatedAt: new Date().toISOString() };
  if (options.makeCurrent ?? true) course.current = lessonId;
  data.courses[courseId] = course;
  writeFile(accountId, data);
  return course;
}

export function setCurrent(accountId: string, courseId: string, lessonId: string): CourseProgress {
  const data = readFile(accountId);
  const course = data.courses[courseId] ?? { lessons: {} };
  course.current = lessonId;
  data.courses[courseId] = course;
  writeFile(accountId, data);
  return course;
}

/** Forget one course's progress (keeps other courses). */
export function resetCourse(accountId: string, courseId: string): CourseProgress {
  const data = readFile(accountId);
  delete data.courses[courseId];
  writeFile(accountId, data);
  return { lessons: {} };
}
