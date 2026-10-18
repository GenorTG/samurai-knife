import { canonicalEmailKey, isBigProvider } from "@/lib/accounts/email-address";
import type { EmailPolicyResult } from "@/lib/accounts/email-policy";
import { MailBudgets, type BudgetDenial, type BudgetSubject } from "@/lib/mail/budgets";
import { CLASS_PRIORITY, mailClass, type MailClass, type MailKind } from "@/lib/mail/kinds";
import { classifySmtpError } from "@/lib/mail/suppression";
import type { MailContent } from "@/lib/mail/templates";

/**
 * The outgoing mail queue (docs/ACCOUNTS.md "Mail queue"). Threat model: the public flows must never turn the app into a
 * mail cannon. Every message goes through one bounded priority queue; admission is sequential and checks, cheapest
 * first: max age, the global pace (waits), suppression, budgets, then the address policy (cached DNS), then budgets
 * again with the domain's DNS risk. Delivery runs on a few pooled connections; transient failures retry with backoff,
 * a 5xx for the mailbox suppresses it. Every drop is counted and recorded (rate-limited) as a security event. Callers
 * never learn the outcome (the API answers the same either way); `flush()` and `stats()` exist for tests and admins.
 */

export type DropReason = "invalid" | "queue_full" | "stale" | "suppressed" | "policy" | BudgetDenial | "failed";

export type EnqueueResult = { queued: true; id: number } | { queued: false; reason: DropReason };

export type MailOutcome = { sent: true } | { sent: false; reason: DropReason; error?: string };

export interface MailQueueConfig {
  maxQueued: number;
  maxAgeMs: number;
  concurrency: number;
  retryDelaysMs: number[];
  /** Minimum gap between two security events of the same drop reason. */
  eventGapMs: number;
}

export interface MailQueueDeps {
  config: MailQueueConfig;
  budgets: MailBudgets;
  deliver(to: string, content: MailContent): Promise<void>;
  policy(to: string): Promise<EmailPolicyResult>;
  suppression: { has(canonical: string, now: number): boolean; add(canonical: string, reason: string, now: number): void; size(now: number): number };
  /** Security event sink (src/lib/security/events.ts `recordSecurityEvent`, positional form). */
  event(kind: `mail_${string}`, detail: Record<string, string | number | boolean>): void;
  /** Resolves once persisted budgets/suppression are loaded: nothing is admitted before (a restart never resets them). */
  ready?: () => Promise<void>;
  logFailure(to: string, subject: string, error: unknown): void;
  now?: () => number;
}

interface Item {
  id: number;
  kind: MailKind;
  cls: MailClass;
  to: string;
  content: MailContent;
  mailbox: string;
  domain: string;
  enqueuedAt: number;
  notBefore: number;
  attempts: number;
  admitted: boolean;
  settle?: (outcome: MailOutcome) => void;
}

export interface MailQueueStats {
  queued: number;
  inFlight: number;
  byClass: Record<MailClass, number>;
  accepted: number;
  sent: number;
  failed: number;
  retried: number;
  dropped: Partial<Record<DropReason, number>>;
  suppressed: number;
  budget: ReturnType<MailBudgets["usage"]>;
}

export class MailQueue {
  private readonly items: Item[] = [];
  private nextId = 1;
  private inFlight = 0;
  private admitting = false;
  private timer: NodeJS.Timeout | null = null;
  private timerAt = 0;
  private idleWaiters: (() => void)[] = [];
  private readonly counts = { accepted: 0, sent: 0, failed: 0, retried: 0 };
  private readonly dropped = new Map<DropReason, number>();
  private readonly lastEvent = new Map<DropReason, { at: number; pending: number }>();
  private readonly now: () => number;
  private readonly deps: MailQueueDeps;

  constructor(deps: MailQueueDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** Queues a message; never throws, never waits. The result is for tests and logs, not for an HTTP answer. */
  enqueue(kind: MailKind, to: string, content: MailContent, settle?: (outcome: MailOutcome) => void): EnqueueResult {
    const now = this.now();
    const mailbox = canonicalEmailKey(to);
    if (!mailbox) return this.reject(kind, null, "invalid", settle);
    const domain = mailbox.slice(mailbox.lastIndexOf("@") + 1);
    const cls = mailClass(kind);
    if (this.items.length >= this.deps.config.maxQueued) {
      // Full: evict the newest waiting message of the lowest class below this one, else refuse this one.
      let victim = -1;
      for (let i = this.items.length - 1; i >= 0; i -= 1) {
        const candidate = this.items[i];
        if (candidate.admitted || CLASS_PRIORITY[candidate.cls] <= CLASS_PRIORITY[cls]) continue;
        if (victim < 0 || CLASS_PRIORITY[candidate.cls] > CLASS_PRIORITY[this.items[victim].cls]) victim = i;
      }
      if (victim < 0) return this.reject(kind, domain, "queue_full", settle);
      const [evicted] = this.items.splice(victim, 1);
      this.drop(evicted, "queue_full");
    }
    const item: Item = { id: this.nextId++, kind, cls, to: to.trim(), content, mailbox, domain, enqueuedAt: now, notBefore: now, attempts: 0, admitted: false, settle };
    this.items.push(item);
    this.counts.accepted += 1;
    queueMicrotask(() => this.pump());
    return { queued: true, id: item.id };
  }

  stats(): MailQueueStats {
    const now = this.now();
    const byClass: Record<MailClass, number> = { security: 0, verification: 0, notice: 0 };
    for (const item of this.items) byClass[item.cls] += 1;
    return {
      queued: this.items.length,
      inFlight: this.inFlight + (this.admitting ? 1 : 0),
      byClass,
      ...this.counts,
      dropped: Object.fromEntries(this.dropped),
      suppressed: this.deps.suppression.size(now),
      budget: this.deps.budgets.usage(now),
    };
  }

  /** Resolves once nothing is queued, admitting or in flight (waits through paces and retries). Tests and shutdown. */
  flush(timeoutMs = 30_000): Promise<void> {
    if (this.idle()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.idleWaiters = this.idleWaiters.filter((fn) => fn !== done);
        reject(new Error(`mail queue not idle after ${timeoutMs} ms (${this.items.length} queued, ${this.inFlight} in flight)`));
      }, timeoutMs);
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.idleWaiters.push(done);
      this.pump();
    });
  }

  private idle(): boolean {
    return this.items.length === 0 && this.inFlight === 0 && !this.admitting;
  }

  private notifyIdle(): void {
    if (!this.idle()) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const fn of waiters) fn();
  }

  private schedule(delayMs: number): void {
    const at = this.now() + delayMs;
    if (this.timer && this.timerAt <= at) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, Math.max(1, delayMs));
    this.timer.unref?.();
  }

  /** Highest class first, then oldest; only messages that are due. */
  private nextDue(now: number): Item | null {
    let best: Item | null = null;
    for (const item of this.items) {
      if (item.notBefore > now) continue;
      if (!best || CLASS_PRIORITY[item.cls] < CLASS_PRIORITY[best.cls] || (CLASS_PRIORITY[item.cls] === CLASS_PRIORITY[best.cls] && item.id < best.id)) best = item;
    }
    return best;
  }

  private pump(): void {
    if (this.admitting) return;
    while (this.inFlight < this.deps.config.concurrency) {
      const now = this.now();
      const item = this.nextDue(now);
      if (!item) {
        const later = this.items.reduce((min, i) => Math.min(min, i.notBefore), Infinity);
        if (later !== Infinity) this.schedule(later - now);
        break;
      }
      if (now - item.enqueuedAt > this.deps.config.maxAgeMs) {
        this.remove(item);
        this.drop(item, "stale");
        continue;
      }
      if (item.admitted) {
        this.remove(item);
        this.start(item);
        continue;
      }
      const wait = this.deps.budgets.paceDelay(now);
      if (wait > 0) {
        this.schedule(wait);
        break;
      }
      this.remove(item);
      this.admitting = true;
      void this.admit(item).then((ok) => {
        this.admitting = false;
        if (ok) this.start(item);
        this.pump();
      });
      return;
    }
    this.notifyIdle();
  }

  private remove(item: Item): void {
    const index = this.items.indexOf(item);
    if (index >= 0) this.items.splice(index, 1);
  }

  private subject(item: Item, risky: boolean): BudgetSubject {
    return { kind: item.kind, cls: item.cls, mailbox: item.mailbox, domain: item.domain, big: isBigProvider(item.domain), risky };
  }

  private async admit(item: Item): Promise<boolean> {
    if (this.deps.ready) {
      try {
        await this.deps.ready();
      } catch {
        // A load failure starts with empty counters (logged by the loader); never blocks mail forever.
      }
    }
    const now = this.now();
    if (this.deps.suppression.has(item.mailbox, now)) return this.drop(item, "suppressed");
    const first = this.deps.budgets.check(this.subject(item, false), now);
    if (first) return this.drop(item, first);
    let verdict: EmailPolicyResult;
    try {
      verdict = await this.deps.policy(item.to);
    } catch {
      verdict = { ok: false, reason: "syntax", domain: item.domain };
    }
    if (!verdict.ok) return this.drop(item, "policy", verdict.reason);
    const at = this.now();
    const subject = this.subject(item, verdict.mailRisk);
    const second = this.deps.budgets.check(subject, at);
    if (second) return this.drop(item, second);
    this.deps.budgets.commit(subject, at);
    item.admitted = true;
    return true;
  }

  private start(item: Item): void {
    this.inFlight += 1;
    item.attempts += 1;
    void this.deps.deliver(item.to, item.content).then(
      () => {
        this.counts.sent += 1;
        item.settle?.({ sent: true });
      },
      (error: unknown) => this.failed(item, error),
    ).finally(() => {
      this.inFlight -= 1;
      this.pump();
    });
  }

  private failed(item: Item, error: unknown): void {
    const kind = classifySmtpError(error);
    const now = this.now();
    if (kind === "transient" && item.attempts <= this.deps.config.retryDelaysMs.length) {
      this.counts.retried += 1;
      item.notBefore = now + this.deps.config.retryDelaysMs[item.attempts - 1];
      this.items.push(item);
      return;
    }
    this.counts.failed += 1;
    this.deps.logFailure(item.to, item.content.subject, error);
    if (kind === "recipient") {
      this.deps.suppression.add(item.mailbox, "smtp_5xx", now);
      this.deps.event("mail_suppressed", { domain: item.domain, mailKind: item.kind });
    }
    item.settle?.({ sent: false, reason: "failed", error: error instanceof Error ? error.message : String(error) });
  }

  private reject(kind: MailKind, domain: string | null, reason: DropReason, settle?: (outcome: MailOutcome) => void): EnqueueResult {
    this.note(reason, kind, domain);
    settle?.({ sent: false, reason });
    return { queued: false, reason };
  }

  /** Always false, so `admit` can `return this.drop(...)`. */
  private drop(item: Item, reason: DropReason, detail?: string): false {
    this.note(reason, item.kind, item.domain, detail);
    item.settle?.({ sent: false, reason });
    return false;
  }

  private note(reason: DropReason, kind: MailKind, domain: string | null, detail?: string): void {
    this.dropped.set(reason, (this.dropped.get(reason) ?? 0) + 1);
    const now = this.now();
    const last = this.lastEvent.get(reason);
    if (last && now - last.at < this.deps.config.eventGapMs) {
      last.pending += 1;
      return;
    }
    this.lastEvent.set(reason, { at: now, pending: 0 });
    // mail_budget (a budget, the queue cap or the max age dropped mail) is alert-worthy (security/alerts.ts).
    const event = reason === "policy" ? "mail_policy" : reason === "suppressed" ? "mail_suppressed_skip" : reason === "invalid" ? "mail_invalid" : "mail_budget";
    const fields: Record<string, string | number | boolean> = { reason, mailKind: kind, alsoSinceLast: last?.pending ?? 0 };
    if (domain) fields.domain = domain;
    if (detail) fields.detail = detail;
    this.deps.event(event, fields);
  }
}
