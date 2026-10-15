import type { Course, Lesson } from "./types";
import { SQL_COURSE } from "./sql/lessons";

/**
 * Every course of the Database course suite (`/tools/db-course`, one tab per course). A new course = its lessons file,
 * an entry here, a tab in the registry and its runner (docs/LEARN.md).
 */
export const COURSES: readonly Course[] = [SQL_COURSE];

export function findCourse(id: string): Course | undefined {
  return COURSES.find((course) => course.id === id);
}

export function findLesson(course: Course, lessonId: string): Lesson | undefined {
  return course.lessons.find((lesson) => lesson.id === lessonId);
}
