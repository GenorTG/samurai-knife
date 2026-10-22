/**
 * Schedule triggers and timed resumes (docs/WORKFLOWS.md "Triggers"), ticking in the server process (started from
 * src/instrumentation.ts). A rule fires at most once per tick and never catches up a backlog after downtime (like
 * n8n): the first tick after activation only records the time. Rules: every N seconds (30 s minimum) / minutes / hours /
 * days / weeks / months at a time of day, or a cron expression, all in the workflow's time zone.
 */
import { consumeLimits, LIMITS } from "@/lib/accounts/rate-limit";
import { getAccount } from "@/lib/accounts/store";
import { matchesCronDate, parseCron, type ParsedCron } from "@/lib/cron";
import type { Item } from "../types";
import { removeWait, activeSchedules, dueWaits, lastFired, markFired } from "./trigger-index";
import { serverZone, startRun } from "./runner";
import { getRun, getWorkflow } from "./store";

const TICK_MS = 15_000;
const KEY = Symbol.for("samurai-knife.workflow-scheduler.v1");

interface Rule {
  every?: string;
  amount?: number;
  atHour?: number;
  atMinute?: number;
  weekday?: string | number;
  dayOfMonth?: number;
  cron?: string;
}

/** Wall-clock parts of `at` in `zone`, as a Date whose local getters return them (what the cron matcher reads). */
export function zonedDate(at: number, zone: string): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
      .formatToParts(new Date(at))
      .map((part) => [part.type, part.value]),
  );
  return new Date(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
}

/** A rule as an interval (ms) or a cron expression; null when the rule is invalid. */
export function ruleSchedule(rule: Rule): { intervalMs: number } | { cron: ParsedCron; everyN?: { unit: "weeks"; n: number } } | null {
  const amount = Math.max(1, Math.floor(Number(rule.amount) || 1));
  const hour = Math.max(0, Math.min(23, Math.floor(Number(rule.atHour) || 0)));
  const minute = Math.max(0, Math.min(59, Math.floor(Number(rule.atMinute) || 0)));
  let expression: string;
  switch (rule.every) {
    case "seconds":
      return { intervalMs: Math.max(30, amount) * 1000 };
    case "minutes":
      return { intervalMs: amount * 60_000 };
    case "hours":
      expression = `${minute} ${amount === 1 ? "*" : `*/${amount}`} * * *`;
      break;
    case "days":
      expression = `${minute} ${hour} ${amount === 1 ? "*" : `*/${amount}`} * *`;
      break;
    case "weeks": {
      const weekday = Math.max(0, Math.min(6, Math.floor(Number(rule.weekday) || 0)));
      const parsed = parseCron(`${minute} ${hour} * * ${weekday}`);
      return parsed.ok ? { cron: parsed.value, ...(amount > 1 ? { everyN: { unit: "weeks" as const, n: amount } } : {}) } : null;
    }
    case "months": {
      const day = Math.max(1, Math.min(31, Math.floor(Number(rule.dayOfMonth) || 1)));
      expression = `${minute} ${hour} ${day} ${amount === 1 ? "*" : `*/${amount}`} *`;
      break;
    }
    case "cron":
      expression = String(rule.cron ?? "").trim();
      break;
    default:
      return null;
  }
  const parsed = parseCron(expression);
  return parsed.ok ? { cron: parsed.value } : null;
}

/** Whether a rule fires in (last, now]; `last` undefined = just activated (never fires). */
export function ruleDue(rule: Rule, last: number | undefined, now: number, zone: string): boolean {
  if (last === undefined) return false;
  const schedule = ruleSchedule(rule);
  if (!schedule) return false;
  if ("intervalMs" in schedule) return now - last >= schedule.intervalMs;
  const firstMinute = Math.floor(last / 60_000) + 1;
  const lastMinute = Math.floor(now / 60_000);
  // At most one day of minutes is looked at (after a long downtime the backlog is skipped).
  for (let minute = Math.max(firstMinute, lastMinute - 1440); minute <= lastMinute; minute += 1) {
    if (matchesCronDate(schedule.cron, zonedDate(minute * 60_000, zone))) {
      if (schedule.everyN && now - last < (schedule.everyN.n * 7 - 1) * 86_400_000) return false;
      return true;
    }
  }
  return false;
}

function tickItem(now: number, zone: string): Item {
  const local = zonedDate(now, zone);
  return {
    json: {
      timestamp: new Date(now).toISOString(),
      "Readable date": local.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
      "Readable time": local.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" }),
      "Day of week": local.toLocaleDateString("en-US", { weekday: "long" }),
      Year: String(local.getFullYear()),
      Month: local.toLocaleDateString("en-US", { month: "long" }),
      "Day of month": String(local.getDate()).padStart(2, "0"),
      Hour: String(local.getHours()).padStart(2, "0"),
      Minute: String(local.getMinutes()).padStart(2, "0"),
      Second: String(local.getSeconds()).padStart(2, "0"),
      Timezone: zone,
    },
  };
}

const running = new Set<string>();
const checked = new Map<string, number>();

export async function schedulerTick(now = Date.now()): Promise<number> {
  let started = 0;
  for (const entry of activeSchedules()) {
    if (getAccount(entry.account)?.status !== "active") continue;
    const zone = entry.timezone || serverZone();
    for (const schedule of entry.schedules) {
      schedule.rules.forEach((rule, index) => {
        const parsed = ruleSchedule((rule ?? {}) as Rule);
        if (!parsed) return;
        const ruleKey = `${entry.account}/${entry.workflowId}/${schedule.node}/${index}`;
        let due: boolean;
        if ("intervalMs" in parsed) {
          // Interval rules persist their fire time (an hourly rule survives a restart without firing twice).
          const last = lastFired(entry.account, entry.workflowId, schedule.node, index);
          due = ruleDue((rule ?? {}) as Rule, last, now, zone);
          if (last === undefined || due) markFired(entry.account, entry.workflowId, schedule.node, index, now);
        } else {
          // Cron rules look at the minutes since the previous tick of this process (no backlog after downtime).
          const last = checked.get(ruleKey);
          checked.set(ruleKey, now);
          due = ruleDue((rule ?? {}) as Rule, last, now, zone);
        }
        if (!due) return;
        const key = `${entry.account}/${entry.workflowId}/${schedule.node}`;
        if (running.has(key)) return;
        if (!consumeLimits([LIMITS.workflowRuns(entry.account)]).ok) return;
        const workflow = getWorkflow(entry.account, entry.workflowId);
        if (!workflow?.active) return;
        running.add(key);
        started += 1;
        void startRun({ accountId: entry.account, workflow, mode: "trigger", startNode: schedule.node, triggerItems: [tickItem(now, zone)] })
          .catch((error: unknown) => console.error(`[workflows] scheduled run of ${entry.workflowId} failed to start: ${error instanceof Error ? error.message : String(error)}`))
          .finally(() => running.delete(key));
      });
    }
  }
  for (const wait of dueWaits(now)) {
    removeWait(wait.runId);
    const workflow = getWorkflow(wait.account, wait.workflowId);
    const record = workflow ? getRun(wait.account, wait.workflowId, wait.runId) : null;
    if (!workflow || !record || record.status !== "waiting") continue;
    started += 1;
    void startRun({ accountId: wait.account, workflow, mode: "resume", resume: { record } }).catch((error: unknown) =>
      console.error(`[workflows] resuming run ${wait.runId} failed: ${error instanceof Error ? error.message : String(error)}`),
    );
  }
  return started;
}

/** Starts the ticker once per process (KNIFE_WF_SCHEDULER=off disables it: tests, a second server on the same data). */
export function startWorkflowScheduler(): void {
  if (process.env.KNIFE_WF_SCHEDULER === "off") return;
  const holder = globalThis as unknown as Record<symbol, NodeJS.Timeout | undefined>;
  if (holder[KEY]) return;
  const timer = setInterval(() => {
    void schedulerTick().catch((error: unknown) => console.error(`[workflows] scheduler tick failed: ${error instanceof Error ? error.message : String(error)}`));
  }, TICK_MS);
  timer.unref();
  holder[KEY] = timer;
}
