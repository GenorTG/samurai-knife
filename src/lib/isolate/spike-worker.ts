import { parentPort } from "node:worker_threads";
import { validateJsonSchema } from "../json-schema";
parentPort?.on("message", (m: unknown) => parentPort?.postMessage({ ok: validateJsonSchema({ type: "string" }, m) }));
