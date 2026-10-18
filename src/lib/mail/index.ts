import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import nodemailer, { type Transporter } from "nodemailer";
import { ensureDataDir, writePrivateFile } from "@/lib/accounts/store";
import { isPublicMode } from "@/lib/accounts/mode";
import { canonicalEmailKey } from "@/lib/accounts/email-address";
import { checkEmailPolicy, emailPolicyStats } from "@/lib/accounts/email-policy";
import { recordSecurityEvent } from "@/lib/security/events";
import { MailBudgets, mailBudgetConfig } from "@/lib/mail/budgets";
import { isMailKind, type MailKind } from "@/lib/mail/kinds";
import { MailQueue, type EnqueueResult, type MailOutcome, type MailQueueConfig, type MailQueueStats } from "@/lib/mail/queue";
import { SuppressionList } from "@/lib/mail/suppression";
import { mailKeyHash, mailStatePath } from "@/lib/mail/persist";
import type { MailContent } from "@/lib/mail/templates";

export type { MailKind } from "@/lib/mail/kinds";
export type { EnqueueResult, MailOutcome } from "@/lib/mail/queue";

/**
 * Outgoing mail. KNIFE_MAIL_TRANSPORT = `smtp` (default in public mode: KNIFE_SMTP_HOST/PORT/SECURE/USER/PASS, from
 * KNIFE_SMTP_FROM; pooled connections) | `outbox` (default in private mode: every message is written as an .eml file to
 * `$KNIFE_DATA_DIR/mail-outbox/`, which the e2e suites read links from). Every message goes through the bounded queue
 * (`queue.ts`: priorities, budgets, address policy, suppression); budgets and suppression survive restarts
 * (`persist.ts`, `$KNIFE_DATA_DIR/mail/`, keyed hashes only); nothing here blocks a response. Failures are logged to
 * the console and `$KNIFE_DATA_DIR/mail-errors.log` (address masked). docs/ACCOUNTS.md "Mail" and "Mail queue".
 *
 * API: `queueMail(kind, to, content)` (the result is for logs/tests, never for an HTTP answer), `sendMail(to, content)`
 * (kind from the template), `sendMailNow` (awaits the outcome), `mailStats()`, `flushMail()` (tests), `suppressMailbox()`.
 */

export type MailTransportKind = "smtp" | "outbox";

export function mailTransportKind(env: NodeJS.ProcessEnv = process.env): MailTransportKind {
  const value = env.KNIFE_MAIL_TRANSPORT?.trim().toLowerCase();
  if (value === "smtp" || value === "outbox") return value;
  return isPublicMode(env) ? "smtp" : "outbox";
}

/** Absolute base for links in mail: KNIFE_PUBLIC_URL, else the bind address (private mode / tests). Never the Host header. */
export function publicBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.KNIFE_PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  return `http://${env.KNIFE_HOST?.trim() || "127.0.0.1"}:${env.KNIFE_PORT?.trim() || "3210"}`;
}

export function outboxDir(): string {
  const dir = join(ensureDataDir(), "mail-outbox");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function fromAddress(env: NodeJS.ProcessEnv = process.env): string {
  return env.KNIFE_SMTP_FROM?.trim() || "Smart Knife <no-reply@knife.invalid>";
}

let smtp: { key: string; transport: Transporter } | null = null;

const intEnv = (value: string | undefined, fallback: number, min: number, max: number): number => {
  const n = Number(value?.trim());
  return value?.trim() && Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** Parallel SMTP connections (and queue workers): KNIFE_MAIL_CONNECTIONS, default 2, at most 5. */
function connections(env: NodeJS.ProcessEnv = process.env): number {
  return intEnv(env.KNIFE_MAIL_CONNECTIONS, 2, 1, 5);
}

function smtpTransport(env: NodeJS.ProcessEnv = process.env): Transporter {
  const host = env.KNIFE_SMTP_HOST?.trim();
  if (!host) throw new Error("KNIFE_SMTP_HOST is not set (or use KNIFE_MAIL_TRANSPORT=outbox)");
  const port = Number(env.KNIFE_SMTP_PORT?.trim() || "587");
  const secure = env.KNIFE_SMTP_SECURE?.trim() === "1" || env.KNIFE_SMTP_SECURE?.trim().toLowerCase() === "true";
  const user = env.KNIFE_SMTP_USER?.trim();
  // Connect to an address (e.g. the mail server's LAN/Tailscale IP when its public name loops back to this machine) but
  // verify the certificate for this name; verification itself is never turned off.
  const servername = env.KNIFE_SMTP_TLS_SERVERNAME?.trim() || undefined;
  const key = JSON.stringify([host, port, secure, user, servername]);
  if (smtp?.key !== key) {
    smtp = {
      key,
      transport: nodemailer.createTransport({
        host,
        port,
        secure,
        auth: user ? { user, pass: env.KNIFE_SMTP_PASS ?? "" } : undefined,
        ...(servername ? { tls: { servername } } : {}),
        // Pooled: a burst reuses a couple of sessions instead of opening one per message; the pool also paces itself.
        pool: true,
        maxConnections: connections(env),
        maxMessages: 100,
        rateDelta: 60_000,
        rateLimit: mailBudgetConfig(env).perMinute,
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 30_000,
      }),
    };
  }
  return smtp.transport;
}

const outboxTransport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });

/** `alice@example.com` -> `a***@example.com`: enough to recognise in a log, not a copy of the address. */
export function maskAddress(to: string): string {
  const at = to.lastIndexOf("@");
  return at <= 0 ? "***" : `${to[0]}***${to.slice(at)}`.replace(/[\r\n\t]/g, " ");
}

function logFailure(to: string, subject: string, error: unknown): void {
  const message = (error instanceof Error ? error.message : String(error)).split(to).join(maskAddress(to));
  console.error(`[mail] sending "${subject}" to ${maskAddress(to)} failed: ${message}`);
  try {
    appendFileSync(join(ensureDataDir(), "mail-errors.log"), `${new Date().toISOString()}\t${maskAddress(to)}\t${subject}\t${message.replace(/[\r\n]/g, " ")}\n`, { mode: 0o600 });
  } catch {
    // The console line is the fallback.
  }
}

async function deliver(to: string, content: MailContent): Promise<void> {
  const message = { from: fromAddress(), to, subject: content.subject, text: content.text, html: content.html };
  if (mailTransportKind() === "outbox") {
    const info = await outboxTransport.sendMail(message);
    const safe = to.toLowerCase().replace(/[^a-z0-9@._-]/g, "_").slice(0, 80);
    const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safe}-${randomBytes(3).toString("hex")}.eml`;
    writePrivateFile(join(outboxDir(), name), info.message as Buffer);
    return;
  }
  await smtpTransport().sendMail(message);
}

/* ------------------------------------------------------------------------------------------------ queue */

export function mailQueueConfig(env: NodeJS.ProcessEnv = process.env): MailQueueConfig {
  return {
    maxQueued: intEnv(env.KNIFE_MAIL_QUEUE_MAX, 500, 10, 10_000),
    maxAgeMs: intEnv(env.KNIFE_MAIL_MAX_AGE_SEC, 1_800, 60, 86_400) * 1_000,
    concurrency: connections(env),
    retryDelaysMs: [60_000, 5 * 60_000],
    eventGapMs: 60_000,
  };
}

interface QueueHolder {
  queue: MailQueue;
  suppression: SuppressionList;
  budgets: MailBudgets;
  dataDir: string;
}

const QUEUE_KEY = Symbol.for("samurai-knife.mail-queue.v2");
const holder = globalThis as unknown as Record<symbol, QueueHolder | undefined>;

function createQueue(dataDir: string): QueueHolder {
  const env = process.env;
  const suppression = new SuppressionList({
    path: mailStatePath("suppressed.json"),
    hash: mailKeyHash,
    ttlMs: intEnv(env.KNIFE_MAIL_SUPPRESS_DAYS, 30, 1, 365) * 24 * 60 * 60_000,
    max: 100_000,
  });
  const budgets = new MailBudgets(mailBudgetConfig(env), { path: mailStatePath("budgets.json"), hash: mailKeyHash });
  const loaded = Promise.all([budgets.ready(), suppression.ready()]).then(() => undefined);
  const queue = new MailQueue({
    config: mailQueueConfig(env),
    budgets,
    deliver,
    policy: (to) => checkEmailPolicy(to),
    suppression,
    event: (kind, detail) => recordSecurityEvent(kind, detail),
    logFailure,
    ready: () => loaded,
  });
  return { queue, suppression, budgets, dataDir };
}

/** The process-wide queue (on globalThis, versioned, so dev HMR keeps one; a new data dir gets a new queue). */
function mailState(): QueueHolder {
  const dir = ensureDataDir();
  const current = holder[QUEUE_KEY];
  if (current && current.dataDir === dir && current.queue instanceof MailQueue && current.suppression instanceof SuppressionList && current.budgets instanceof MailBudgets) return current;
  if (current) void Promise.all([current.budgets?.dispose?.(), current.suppression?.dispose?.()]).catch(() => undefined);
  const fresh = createQueue(dir);
  holder[QUEUE_KEY] = fresh;
  return fresh;
}

const mailQueue = (): MailQueue => mailState().queue;

/** Tests: a fresh queue (counters reloaded from disk) that reads the environment again; pending saves are written first. */
export async function resetMailForTests(): Promise<void> {
  const current = holder[QUEUE_KEY];
  holder[QUEUE_KEY] = undefined;
  if (current) await Promise.all([current.budgets.dispose(), current.suppression.dispose()]);
}

/** Writes the persisted budgets and suppression list now (tests, shutdown). */
export async function saveMailState(): Promise<void> {
  const current = holder[QUEUE_KEY];
  if (current) await Promise.all([current.budgets.save(), current.suppression.save()]);
}

/** Queues one message of `kind`. Never throws or waits; the result is for tests and logs, never for an HTTP answer. */
export function queueMail(kind: MailKind, to: string, content: MailContent): EnqueueResult {
  return mailQueue().enqueue(kind, to, content);
}

/** Fire and forget (kind from the template, `other` = lowest priority when a caller built its own content). */
export function sendMail(to: string, content: MailContent): void {
  queueMail(isMailKind(content.kind) ? content.kind : "other", to, content);
}

/** Awaitable variant for the CLI/tests: through the same queue, rejects when the message was dropped or failed. */
export function sendMailNow(to: string, content: MailContent): Promise<void> {
  return new Promise((resolve, reject) => {
    const settle = (outcome: MailOutcome): void => {
      if (outcome.sent) resolve();
      else reject(new Error(`mail not sent: ${outcome.reason}${outcome.error ? ` (${outcome.error})` : ""}`));
    };
    mailQueue().enqueue(isMailKind(content.kind) ? content.kind : "other", to, content, settle);
  });
}

/** Resolves when the queue is idle (tests). */
export function flushMail(timeoutMs = 30_000): Promise<void> {
  return mailQueue().flush(timeoutMs);
}

export function mailStats(): MailQueueStats & { transport: MailTransportKind; policy: ReturnType<typeof emailPolicyStats> } {
  return { transport: mailTransportKind(), ...mailQueue().stats(), policy: emailPolicyStats() };
}

/**
 * Suppress a mailbox (e.g. from a bounce processor reading VERP returns): no mail to it for KNIFE_MAIL_SUPPRESS_DAYS.
 * Returns false when `email` is not an address.
 */
export function suppressMailbox(email: string, reason = "bounce"): boolean {
  const key = canonicalEmailKey(email);
  if (!key) return false;
  mailState().suppression.add(key, reason, Date.now());
  return true;
}
