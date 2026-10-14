import { countWords, type WordsTasks } from "./words";
import { serveTasks } from "./workers/runtime";

serveTasks<WordsTasks>({ words: (input) => countWords(input) });
