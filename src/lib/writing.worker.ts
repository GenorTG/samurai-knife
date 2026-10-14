import { analyzeSentences, checkPunctuation, gradeText, type WritingTasks } from "./writing";
import { serveTasks } from "./workers/runtime";

serveTasks<WritingTasks>({
  grade: (text) => gradeText(text),
  sentences: (text) => analyzeSentences(text),
  punctuation: (text) => checkPunctuation(text),
});
