import { isPublicMode } from "@/lib/accounts/mode";
import { checkLimits, hitLimits, type Limit } from "@/lib/accounts/rate-limit";
import { getAccount } from "@/lib/accounts/store";
import { pythonQueue, QueueFullError, type Admission, type PyLane } from "@/lib/work-queue";

/**
 * Who may put how much work on the shared Python lanes (src/lib/work-queue.ts), in public mode. docs/ARCHITECTURE.md
 * "Server work".
 *
 * Threat model (abuse audit #8): with open registration a handful of accounts could fill the heavy (PDF) or light (SQL)
 * lane and starve everyone, the administrator included. So ordinary accounts get a small share of each lane, a job rate
 * per 10 minutes, and less of both while the account is younger than KNIFE_PY_NEW_ACCOUNT_HOURS; administrators are
 * privileged (the lane's reserved places, started first, no rate). Private mode is unchanged: no rate, the lane's caps.
 *
 * Defaults (env, per lane `LIGHT` / `HEAVY`):
 * - `KNIFE_PY_<LANE>_PER_USER`: running + queued jobs of one ordinary account (light 3, heavy 1); new accounts: light 2, heavy 1.
 * - `KNIFE_PY_<LANE>_PER_10MIN`: jobs one ordinary account may start per 10 minutes (light 120, heavy 30).
 * - `KNIFE_PY_<LANE>_PER_10MIN_NEW`: the same for a new account (light 40, heavy 10).
 * - `KNIFE_PY_NEW_ACCOUNT_HOURS` (24): how long an account counts as new.
 */

const WINDOW_MS = 10 * 60_000;

type LaneName = "LIGHT" | "HEAVY";

function intFromEnv(name: string, fallback: number, min: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(parsed) && parsed >= min ? parsed : fallback;
}

const DEFAULTS: Record<LaneName, { perUser: number; perUserNew: number; rate: number; rateNew: number }> = {
  LIGHT: { perUser: 3, perUserNew: 2, rate: 120, rateNew: 40 },
  HEAVY: { perUser: 1, perUserNew: 1, rate: 30, rateNew: 10 },
};

export interface PythonPolicy extends Admission {
  /** The account's job-rate bucket; absent = no rate (private mode, administrators, ownerless work). */
  rate?: Limit;
}

/** True when the account was created less than KNIFE_PY_NEW_ACCOUNT_HOURS ago (unknown or unparsable = new). */
export function isNewAccount(createdAt: string | undefined, now = Date.now()): boolean {
  const created = createdAt ? Date.parse(createdAt) : Number.NaN;
  if (!Number.isFinite(created)) return true;
  return now - created < intFromEnv("KNIFE_PY_NEW_ACCOUNT_HOURS", 24, 0) * 3_600_000;
}

/** The policy for one submit: pure apart from reading the account record and env. */
export function pythonPolicy(lane: PyLane, owner: string | undefined, now = Date.now()): PythonPolicy {
  if (!isPublicMode() || owner === undefined) return {};
  const account = getAccount(owner);
  if (account?.role === "admin") return { privileged: true };
  const name: LaneName = lane === "heavy" ? "HEAVY" : "LIGHT";
  const fresh = isNewAccount(account?.createdAt, now);
  const defaults = DEFAULTS[name];
  const perUser = intFromEnv(`KNIFE_PY_${name}_PER_USER`, defaults.perUser, 1);
  const ownerLimit = fresh ? Math.min(perUser, defaults.perUserNew) : perUser;
  const max = fresh
    ? intFromEnv(`KNIFE_PY_${name}_PER_10MIN_NEW`, defaults.rateNew, 1)
    : intFromEnv(`KNIFE_PY_${name}_PER_10MIN`, defaults.rate, 1);
  return { privileged: false, ownerLimit, rate: { key: `py-jobs:${lane}:${owner}`, max, windowMs: WINDOW_MS } };
}

function assertRate(lane: PyLane, policy: PythonPolicy, now: number): void {
  if (!policy.rate) return;
  const verdict = checkLimits([policy.rate], now);
  if (!verdict.ok) throw new QueueFullError(lane, policy.rate.max, verdict.retryAfterSeconds, "rate");
}

/**
 * Read-only admission check, for routes that refuse before receiving a (possibly large) upload: throws QueueFullError
 * (`owner` / `rate` = 429, `lane` = 503) when a submit right now would be refused. Counts nothing.
 */
export function assertPythonCapacity(lane: PyLane, owner: string | undefined, now = Date.now()): void {
  const policy = pythonPolicy(lane, owner, now);
  assertRate(lane, policy, now);
  pythonQueue().assertCapacity(lane, owner, policy);
}

/**
 * Admit one job: checks the rate, then `submit` (which applies the lane caps with the returned admission); the job is
 * counted against the rate only once the queue accepted it.
 */
export function admitPythonJob<T>(lane: PyLane, owner: string | undefined, submit: (admission: Admission) => T, now = Date.now()): T {
  const policy = pythonPolicy(lane, owner, now);
  assertRate(lane, policy, now);
  const handle = submit({ privileged: policy.privileged, ownerLimit: policy.ownerLimit });
  if (policy.rate) hitLimits([policy.rate], now);
  return handle;
}
