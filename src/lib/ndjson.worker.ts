import { validateNdjson, type NdjsonTasks } from "./ndjson";
import { serveTasks } from "./workers/runtime";

serveTasks<NdjsonTasks>({ validate: (text) => validateNdjson(text) });
