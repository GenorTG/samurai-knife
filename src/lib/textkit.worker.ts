import { runTextKit, type TextKitTasks } from "./textkit";
import { serveTasks } from "./workers/runtime";

serveTasks<TextKitTasks>({ transform: (input) => runTextKit(input) });
