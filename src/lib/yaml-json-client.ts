import { WorkerPool } from "./workers/pool";
import type { YamlJsonInput, YamlJsonOutput, YamlJsonTasks } from "./yaml-json";

let pool: WorkerPool<YamlJsonTasks> | null = null;

/** Lazy: the worker only starts on the first call (from an effect), never during render/SSR. */
export function convertYamlJsonInWorker(input: YamlJsonInput, signal: AbortSignal): Promise<YamlJsonOutput> {
  pool ??= new WorkerPool<YamlJsonTasks>({ size: 1, create: () => new Worker(new URL("./yaml-json.worker.ts", import.meta.url)) });
  return pool.call("convert", input, { signal });
}
