/**
 * The request side of the commit barrier (scripts/db-barrier.mjs, preloaded into the server): a write made while
 * handling an HTTP request registers its commit here, and the preload holds that response (status line, headers, body)
 * until the commit is durable in Postgres; a failed commit turns the response into a 503 instead. So no caller has to
 * await anything and "the answer means it is saved" holds for every route, page and server action. Without the preload
 * (unit tests, scripts) this is a no-op and callers await `flushed()` themselves.
 */

interface RequestCommits {
  pending: Promise<void>[];
}

interface BarrierState {
  als: { getStore(): RequestCommits | undefined };
}

const KEY = Symbol.for("samurai-knife.db.barrier.v1");

/** Holds the current request's response until `commit` settles. Returns false outside a request (nothing held). */
export function holdResponseFor(commit: Promise<void>): boolean {
  const state = (globalThis as unknown as Record<symbol, BarrierState | undefined>)[KEY];
  const commits = state?.als.getStore();
  if (!commits) return false;
  commits.pending.push(commit);
  return true;
}
