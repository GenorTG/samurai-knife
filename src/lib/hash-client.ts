import { WorkerPool } from "./workers/pool";
import type { HashName, HashProgress, HashTasks } from "./hash-run";

/** One dedicated hashing worker; Cancel terminates it and the next file respawns it. Create inside an effect. */
export class FileHasher {
  private readonly pool = new WorkerPool<HashTasks>({
    size: 1,
    create: () => new Worker(new URL("./hash.worker.ts", import.meta.url)),
  });

  hash(file: File, algorithm: HashName, options: { signal?: AbortSignal; onProgress?: (p: HashProgress) => void } = {}): Promise<string> {
    return this.pool.call("hashFile", { file, algorithm }, options);
  }

  dispose(): void {
    this.pool.terminateAll();
  }
}
