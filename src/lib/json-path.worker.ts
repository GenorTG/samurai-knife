import { evaluateJsonPath, type JsonPathTasks } from "./json-path";
import { serveTasks } from "./workers/runtime";

serveTasks<JsonPathTasks>({ query: (input) => evaluateJsonPath(input) });
