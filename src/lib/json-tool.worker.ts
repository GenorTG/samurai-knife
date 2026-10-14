import { runJsonTool, type JsonToolTasks } from "./json-tool";
import { serveTasks } from "./workers/runtime";

serveTasks<JsonToolTasks>({ json: (input) => runJsonTool(input) });
