import { MAIL_HASH, PersistedFile } from "@/lib/mail/persist";

/**
 * Suppression list: mailboxes the mail server said do not exist (SMTP 5xx on RCPT with a 5.1.x / 5.2.1 status, or a
 * bounce fed in through `suppressMailbox`) get no mail for KNIFE_MAIL_SUPPRESS_DAYS (30). Repeated mail to dead
 * mailboxes is what gets a sender listed. Keys are keyed hashes of the canonical mailbox (`hash`, persist.ts
 * `mailKeyHash`), so the file (`$KNIFE_DATA_DIR/mail/suppressed.json`) holds no address; it survives restarts (async
 * load, debounced async saves). Bounded: at most `max` entries, the soonest to expire evicted first (forgetting one only
 * means one more attempt).
 */

interface Entry {
  until: number;
  reason: string;
}

export interface SuppressionOptions {
  /** File to persist to; null = memory only (tests). */
  path: string | null;
  hash: (canonical: string) => string;
  ttlMs: number;
  max: number;
}

const MAX_FILE_BYTES = 16 * 1024 * 1024;

export class SuppressionList {
  private readonly entries = new Map<string, Entry>();
  private readonly options: SuppressionOptions;
  private readonly file: PersistedFile | null;

  constructor(options: SuppressionOptions) {
    this.options = options;
    this.file = options.path
      ? new PersistedFile({
        path: options.path,
        maxBytes: MAX_FILE_BYTES,
        serialize: (now) => JSON.stringify({ v: 1, rows: [...this.entries].filter(([, e]) => e.until > now).map(([k, e]) => [k, e.until, e.reason]) }),
        restore: (data, now) => this.restore(data, now),
      })
      : null;
  }

  /** Resolves once the previous process's list is loaded. */
  ready(): Promise<void> {
    return this.file?.ready() ?? Promise.resolve();
  }

  private restore(data: unknown, now: number): void {
    const rows = (data as { v?: unknown; rows?: unknown })?.rows;
    if ((data as { v?: unknown })?.v !== 1 || !Array.isArray(rows)) return;
    for (const row of rows.slice(0, this.options.max)) {
      if (!Array.isArray(row) || row.length !== 3) continue;
      const [k, until, reason] = row as [unknown, unknown, unknown];
      if (typeof k !== "string" || !MAIL_HASH.test(k) || typeof until !== "number" || until <= now) continue;
      const capped = Math.min(until, now + this.options.ttlMs);
      // An entry added in this process before the load finished wins.
      if (!this.entries.has(k)) this.entries.set(k, { until: capped, reason: typeof reason === "string" ? reason.slice(0, 120) : "" });
    }
    this.trim(now);
  }

  private trim(now: number): void {
    const map = this.entries;
    if (map.size <= this.options.max) return;
    for (const [k, e] of map) if (e.until <= now) map.delete(k);
    if (map.size <= this.options.max) return;
    const byExpiry = [...map].sort((a, b) => a[1].until - b[1].until);
    for (const [k] of byExpiry.slice(0, map.size - this.options.max)) map.delete(k);
  }

  has(canonical: string, now: number): boolean {
    const entry = this.entries.get(this.options.hash(canonical));
    return Boolean(entry && entry.until > now);
  }

  add(canonical: string, reason: string, now: number): void {
    this.entries.set(this.options.hash(canonical), { until: now + this.options.ttlMs, reason: reason.replace(/[\r\n]/g, " ").slice(0, 120) });
    this.trim(now);
    this.file?.changed();
  }

  remove(canonical: string): boolean {
    if (!this.entries.delete(this.options.hash(canonical))) return false;
    this.file?.changed();
    return true;
  }

  size(now: number): number {
    let n = 0;
    for (const entry of this.entries.values()) if (entry.until > now) n += 1;
    return n;
  }

  /** Writes pending changes now (tests, shutdown). */
  save(): Promise<void> {
    return this.file?.save() ?? Promise.resolve();
  }

  dispose(): Promise<void> {
    return this.file?.dispose() ?? Promise.resolve();
  }
}

/**
 * Classifies a failed SMTP send. `recipient` = the server refused this mailbox for good (5xx at RCPT TO whose enhanced
 * status is 5.1.x or 5.2.1, or none given with 550/551/553): suppress it. `permanent` = another 5xx (policy, content, our
 * own auth): no retry, no suppression. `transient` = 4xx, timeouts, connection errors: retry later.
 */
export function classifySmtpError(error: unknown): "recipient" | "permanent" | "transient" {
  const e = (typeof error === "object" && error ? error : {}) as { responseCode?: unknown; command?: unknown; code?: unknown; response?: unknown };
  const status = typeof e.responseCode === "number" ? e.responseCode : NaN;
  if (!(status >= 500 && status < 600)) return "transient";
  const atRecipient = e.code === "EENVELOPE" || (typeof e.command === "string" && /^RCPT/i.test(e.command));
  if (!atRecipient) return "permanent";
  const enhanced = typeof e.response === "string" ? /\b5\.(\d{1,3})\.(\d{1,3})\b/.exec(e.response) : null;
  if (enhanced) return enhanced[1] === "1" || (enhanced[1] === "2" && enhanced[2] === "1") ? "recipient" : "permanent";
  return status === 550 || status === 551 || status === 553 ? "recipient" : "permanent";
}
