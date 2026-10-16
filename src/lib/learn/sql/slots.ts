import { LearnDbError } from "./db";

/**
 * Fair share of the course database (one shared Postgres, the learner role allows CONNECTION LIMIT 20): an account has at
 * most `KNIFE_LEARN_RUNS_PER_ACCOUNT` (default 1) runs in flight, a further one is refused at once (429, the page
 * says "your previous query is still running"); the whole server at most `KNIFE_LEARN_MAX_RUNS` (default 12, below the
 * role limit so the seed/terminate superuser connections always fit). A run waiting for a server slot gives up after
 * 15 s (503). Learner runs are ≤ ~6.5 s each (statement timeout + terminate backstop), so waits stay short.
 */

const WAIT_MS = 15_000;
const GLOBAL_KEY = Symbol.for("samurai-knife.learn-slots.v1");

interface Waiter {
  resolve(): void;
  timer: ReturnType<typeof setTimeout>;
}

interface Slots {
  running: number;
  perAccount: Map<string, number>;
  waiting: Waiter[];
}

function intFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

function slots(): Slots {
  const holder = globalThis as unknown as Record<symbol, Slots | undefined>;
  holder[GLOBAL_KEY] ??= { running: 0, perAccount: new Map(), waiting: [] };
  return holder[GLOBAL_KEY];
}

function release(accountId: string): void {
  const s = slots();
  const mine = (s.perAccount.get(accountId) ?? 1) - 1;
  if (mine > 0) s.perAccount.set(accountId, mine);
  else s.perAccount.delete(accountId);
  const next = s.waiting.shift();
  if (next) {
    // The slot passes straight to the next waiter (running stays the same).
    clearTimeout(next.timer);
    next.resolve();
  } else {
    s.running -= 1;
  }
}

/** Runs `fn` holding one of the account's run slots and one server slot; refuses or times out as described above. */
export async function withLearnerSlot<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  const s = slots();
  const perAccount = intFromEnv("KNIFE_LEARN_RUNS_PER_ACCOUNT", 1);
  const max = intFromEnv("KNIFE_LEARN_MAX_RUNS", 12);
  const mine = s.perAccount.get(accountId) ?? 0;
  if (mine >= perAccount) {
    throw new LearnDbError("run_in_progress", "Your previous query is still running. Wait for it to finish, then run again.", 429);
  }
  s.perAccount.set(accountId, mine + 1);
  if (s.running < max) {
    s.running += 1;
  } else {
    try {
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          resolve,
          timer: setTimeout(() => {
            s.waiting.splice(s.waiting.indexOf(waiter), 1);
            reject(new LearnDbError("course_db_busy", "The course database is busy with other learners' queries. Try again in a few seconds.", 503));
          }, WAIT_MS),
        };
        s.waiting.push(waiter);
      });
    } catch (error) {
      const left = (s.perAccount.get(accountId) ?? 1) - 1;
      if (left > 0) s.perAccount.set(accountId, left);
      else s.perAccount.delete(accountId);
      throw error;
    }
  }
  try {
    return await fn();
  } finally {
    release(accountId);
  }
}

/** For tests and the queue page: runs in flight and waiting. */
export function learnerSlotStats(): { running: number; waiting: number; accounts: number } {
  const s = slots();
  return { running: s.running, waiting: s.waiting.length, accounts: s.perAccount.size };
}
