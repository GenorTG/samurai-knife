import { diagramJson, type DiagramTasks } from "./json-diagram";
import { serveTasks } from "./workers/runtime";

serveTasks<DiagramTasks>({ diagram: (text) => diagramJson(text) });
