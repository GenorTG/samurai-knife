import { computeDiffView, type DiffViewTasks } from "./diff-view";
import { serveTasks } from "./workers/runtime";

serveTasks<DiffViewTasks>({ diff: (input) => computeDiffView(input) });
