import type { Locale } from "@/lib/i18n/core";
import SQL_PL from "./sql/lessons.pl.json" with { type: "json" };
import type { Course } from "./types";

/**
 * Course text in the reader's language. The English course (`sql/lessons.ts`) is the source: ids, starters, solutions
 * and checks live there only; `sql/lessons.pl.json` overlays title, explanation, task and hints per lesson id, and
 * module titles/summaries (tests/learn_sql.test.mjs keeps the two in step).
 */
interface Overlay {
  title: string;
  modules: Record<string, { title: string; summary: string }>;
  lessons: Record<string, { title: string; explanation: string; task: string; hints: string[] }>;
}

const OVERLAYS: Partial<Record<Locale, Record<string, Overlay>>> = { pl: { sql: SQL_PL as Overlay } };
const cache = new Map<string, Course>();

export function localizeCourse(course: Course, locale: Locale): Course {
  const overlay = OVERLAYS[locale]?.[course.id];
  if (!overlay) return course;
  const key = `${locale}:${course.id}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const localized: Course = {
    ...course,
    title: overlay.title || course.title,
    modules: course.modules.map((m) => ({ ...m, ...overlay.modules[m.id] })),
    lessons: course.lessons.map((l) => {
      const text = overlay.lessons[l.id];
      return text ? { ...l, title: text.title, explanation: text.explanation, task: text.task, hints: text.hints.length === l.hints.length ? text.hints : l.hints } : l;
    }),
  };
  cache.set(key, localized);
  return localized;
}
