import { existsSync, readFileSync } from "node:fs";
import { EMPTY_BUCKET, addUsage, type Usage, type UsageBucket, type UsageSummary } from "@/lib/usage";
import { writeAccountFile } from "@/lib/storage/quota";
import { accountScope, isValidAccountId, parentDir } from "@/lib/storage/scope";
import { dataDir } from "./store";

/**
 * Per-account token ledger: `$KNIFE_DATA_DIR/usage/<account id>.json`, daily buckets plus per-model totals, 90 days kept.
 * Server only. Writes are synchronous and tiny (one per model round), so the single Node thread serialises them.
 * The ledger holds counters only: never prompts, answers or keys.
 */

interface LedgerFile {
  version: 1;
  days: Record<string, UsageBucket>;
  models: Record<string, UsageBucket>;
}

const KEEP_DAYS = 90;
function ledgerPath(accountId: string): string | null {
  if (!isValidAccountId(accountId)) return null;
  const file = accountScope(accountId).usageFile;
  parentDir(file);
  return file;
}

function today(now = new Date()): string {
  // Server-local calendar day (this module never renders in the browser, so locale cannot cause a hydration mismatch).
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function read(path: string): LedgerFile {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LedgerFile>;
    if (parsed && parsed.version === 1 && parsed.days && parsed.models) return parsed as LedgerFile;
  } catch {
    /* missing or unreadable: start fresh */
  }
  return { version: 1, days: {}, models: {} };
}

function merge(bucket: UsageBucket | undefined, usage: Usage | null, ms: number, failed: boolean): UsageBucket {
  const base = bucket ?? EMPTY_BUCKET;
  const sum = usage ? addUsage(base, usage) : { ...base };
  return { ...sum, requests: base.requests + 1, errors: base.errors + (failed ? 1 : 0), ms: base.ms + Math.max(0, Math.round(ms)) };
}

export interface RoundRecord {
  model: string;
  usage: Usage | null;
  ms: number;
  failed: boolean;
}

export function recordRound(accountId: string, round: RoundRecord, now = new Date()): void {
  const path = ledgerPath(accountId);
  if (!path) return;
  try {
    const file = read(path);
    const day = today(now);
    file.days[day] = merge(file.days[day], round.usage, round.ms, round.failed);
    const model = round.model.slice(0, 120) || "unknown";
    file.models[model] = merge(file.models[model], round.usage, round.ms, round.failed);
    const keep = Object.keys(file.days).sort().slice(-KEEP_DAYS);
    file.days = Object.fromEntries(keep.map((d) => [d, file.days[d]]));
    writeAccountFile(accountId, path, JSON.stringify(file), { enforce: false });
  } catch {
    /* telemetry must never break a chat round */
  }
}

function sumBuckets(buckets: UsageBucket[]): UsageBucket {
  return buckets.reduce<UsageBucket>((acc, b) => ({ ...addUsage(acc, b), requests: acc.requests + b.requests, errors: acc.errors + b.errors, ms: acc.ms + b.ms }), EMPTY_BUCKET);
}

export function usageSummary(accountId: string, now = new Date()): UsageSummary {
  const path = ledgerPath(accountId);
  const file = path && existsSync(path) ? read(path) : { version: 1 as const, days: {}, models: {} };
  const dates = Object.keys(file.days).sort().reverse();
  const todayKey = today(now);
  const weekCutoff = today(new Date(now.getTime() - 6 * 86_400_000));
  return {
    today: file.days[todayKey] ?? EMPTY_BUCKET,
    last7Days: sumBuckets(dates.filter((d) => d >= weekCutoff).map((d) => file.days[d])),
    total: sumBuckets(dates.map((d) => file.days[d])),
    days: dates.slice(0, 30).map((date) => ({ date, bucket: file.days[date] })),
    models: Object.entries(file.models).map(([model, bucket]) => ({ model, bucket })).sort((a, b) => b.bucket.requests - a.bucket.requests).slice(0, 12),
  };
}

export { dataDir as ledgerDataDir };
