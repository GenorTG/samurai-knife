import { runRegex, type RegexTasks } from "./regex-run";
import { serveTasks } from "./workers/runtime";

serveTasks<RegexTasks>({
  ping: () => true,
  run: (input) => runRegex(input),
});
