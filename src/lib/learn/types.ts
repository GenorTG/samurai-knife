/**
 * Shared course types. Metadata only (no I/O, no React): the browser, the API routes and the unit tests all import
 * the lessons. docs/LEARN.md explains how to add a lesson or a course.
 */

export interface LessonModule {
  id: string;
  title: string;
  /** One line under the module heading. */
  summary: string;
}

/** A required construct: `pattern` (case-insensitive regex source) must occur in the learner's SQL outside comments and strings. */
export interface MustUse {
  pattern: string;
  message: string;
}

export type LessonCheck =
  | {
      /** Compare the LAST result set of the learner's run with the reference solution's (src/lib/learn/sql/compare.ts). */
      kind: "result";
      /** Only when the task asks for an order (ORDER BY). */
      ordered: boolean;
      columnNames?: "ignore" | "match";
      decimals?: number;
      mustUse?: MustUse[];
    }
  | {
      /** EXPLAIN lessons: the text of the last result (the plan) must match `mustMatch` (regex) and not `mustNotMatch`. */
      kind: "plan";
      mustMatch: string;
      mustNotMatch?: string;
      /** What the plan should show, for the feedback line. */
      describe: string;
      mustUse?: MustUse[];
    };

export interface Lesson {
  /** Stable id: progress is stored under it. Never rename one. */
  id: string;
  module: string;
  title: string;
  /** Short markdown: the idea plus a tiny example. */
  explanation: string;
  /** Markdown: what to write. */
  task: string;
  starter: string;
  /** Reference solution; must pass its own check against the seeded data (tests/learn_db_e2e.py). */
  solution: string;
  check: LessonCheck;
  /** 2-3 progressive hints, vaguest first. */
  hints: string[];
  concepts: string[];
}

export interface Course {
  /** Progress key and API segment. */
  id: string;
  title: string;
  /** Sidecar service the course runs against. */
  sidecar: string;
  modules: LessonModule[];
  lessons: Lesson[];
}
