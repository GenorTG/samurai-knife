import { convertYamlJson, type YamlJsonTasks } from "./yaml-json";
import { serveTasks } from "./workers/runtime";

serveTasks<YamlJsonTasks>({ convert: (input) => convertYamlJson(input) });
