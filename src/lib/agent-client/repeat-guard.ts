import { unchangedResult } from "./context";

/**
 * Repetition inside one run. A call answered exactly like the same call before it costs tokens twice for nothing: a
 * read-only one gets a short pointer to the earlier result, and one that keeps repeating is told to stop and then ends
 * the turn. Reset when the turn changes (steering).
 */

/** The result of the same call, this many times in a row: the model is told to stop. */
export const REPEAT_WARN = 3;
/** ...and at this many the run ends with a summary. */
export const REPEAT_STOP = 5;
/** Below this a pointer saves nothing. */
const WORTH_POINTING = 200;
/** Waiting is what these are for: the same answer means "not yet", and they have their own timeouts. */
const WAITS = new Set(["wait", "wait_for", "wait_for_user", "knife_site_verify", "knife_site_previews", "knife_job_status"]);

function callKey(name: string, args: string): string {
  try {
    const value = JSON.parse(args || "{}") as Record<string, unknown>;
    const sorted = Object.keys(value).sort().map((k) => [k, value[k]]);
    return `${name}\0${JSON.stringify(sorted)}`;
  } catch {
    return `${name}\0${args}`;
  }
}

export function createRepeatGuard(isReadOnly: (name: string) => boolean) {
  let seen = new Map<string, { firstId: string; content: string; count: number }>();
  return {
    reset(): void {
      seen = new Map();
    },
    /** `content` = the tool's result. Returns what to send the model instead, and whether the run should stop. */
    check(id: string, name: string, args: string, content: string): { content: string; stop: boolean } {
      if (WAITS.has(name)) return { content, stop: false };
      const key = callKey(name, args);
      const last = seen.get(key);
      if (!last || last.content !== content) {
        seen.set(key, { firstId: id, content, count: 1 });
        return { content, stop: false };
      }
      last.count += 1;
      if (last.count >= REPEAT_WARN) {
        return {
          content: JSON.stringify({ ok: false, error: `Stop repeating this: ${name} with these arguments has returned the same result ${last.count} times. Use what you already have, try something different, or tell the user what is in the way.` }),
          stop: last.count >= REPEAT_STOP,
        };
      }
      if (isReadOnly(name) && content.length >= WORTH_POINTING) return { content: unchangedResult(last.firstId), stop: false };
      return { content, stop: false };
    },
  };
}
