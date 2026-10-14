import { resizeImage, type ResizeTasks } from "./image-resize";
import { serveTasks } from "./workers/runtime";

serveTasks<ResizeTasks>({ resize: (input) => resizeImage(input) });
