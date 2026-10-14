export const HASH_NAMES = ["SHA-1", "SHA-256", "SHA-384", "SHA-512"] as const;
export type HashName = (typeof HASH_NAMES)[number];

export interface HashProgress {
  bytes: number;
  total: number;
}

export type HashTasks = {
  /** Stream a File through an incremental digest: constant memory, progress, cancellable by terminating the worker. */
  hashFile: { payload: { file: File; algorithm: HashName }; result: string; progress: HashProgress };
};
