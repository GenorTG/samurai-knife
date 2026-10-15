import type { CourseProgress } from "@/lib/learn/progress";
import type { CompareResult } from "@/lib/learn/sql/compare";
import type { RunOutput, SchemaTable, SeedInfo } from "@/lib/learn/sql/db";
import { request } from "@/tools/sidecars/client";

/** Typed browser helpers for /api/learn (same-origin JSON, errors as ApiError with the API's `error` text). */

export type { CourseProgress, CompareResult, RunOutput, SchemaTable, SeedInfo };

export interface CheckResponse {
  pass: boolean;
  message: string;
  compare: CompareResult | null;
  run: RunOutput;
  progress: CourseProgress;
}

export function setupCourse(force = false): Promise<SeedInfo> {
  return request<{ seed: SeedInfo }>("POST", "/api/learn/sql/setup", { force }).then((r) => r.seed);
}

export function runSql(sql: string, lessonId?: string): Promise<{ run: RunOutput; progress?: CourseProgress }> {
  return request("POST", "/api/learn/sql/run", lessonId ? { sql, lessonId } : { sql });
}

export function checkSql(sql: string, lessonId: string): Promise<CheckResponse> {
  return request("POST", "/api/learn/sql/check", { sql, lessonId });
}

export function getSchema(): Promise<SchemaTable[]> {
  return request<{ tables: SchemaTable[] }>("GET", "/api/learn/sql/schema").then((r) => r.tables);
}

export function getProgress(course: string): Promise<CourseProgress> {
  return request<{ progress: CourseProgress }>("GET", `/api/learn/progress?course=${encodeURIComponent(course)}`).then((r) => r.progress);
}

export type ProgressAction =
  | { action: "select" | "hint" | "solution" | "reset-query"; lessonId: string }
  | { action: "save"; lessonId: string; sql: string }
  | { action: "reset-course" };

export function progressAction(course: string, body: ProgressAction): Promise<CourseProgress> {
  return request<{ progress: CourseProgress }>("POST", "/api/learn/progress", { course, ...body }).then((r) => r.progress);
}
