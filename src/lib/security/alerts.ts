import { statfsSync } from "node:fs";
import { isPublicMode } from "@/lib/accounts/mode";
import { dataDir, readStore } from "@/lib/accounts/store";
import { sendMail } from "@/lib/mail";
import type { MailContent } from "@/lib/mail/templates";
import { describeSecurityEvent, onSecurityEvent, recordSecurityEvent, type SecurityEvent } from "./events";

/**
 * Admin alert digest (public mode). Watches the security events (src/lib/security/events.ts) for the ones an administrator
 * must hear about at once: a 24 h block, a mail budget hit (any `mail_budget`), a suppressed mailbox (`mail_suppressed`,
 * the mail server refused it for good), a registration surge, low disk, a tool
 * timeout, a full limiter table or quota, or the global failed-login budget. They are mailed as one digest to every active
 * administrator with a confirmed email, at most once per 15 minutes (KNIFE_ALERT_INTERVAL_MIN), through the mail module's
 * public `sendMail`. Threat model: an attacker can cause events at any rate, so alerts are batched, capped (50 lines a
 * digest) and never block anything. Also checks free disk on the data dir every minute (KNIFE_DISK_FLOOR_MB, default
 * 2048). Started once per server by src/instrumentation.ts.
 */
const KEY = Symbol.for("samurai-knife.security-alerts.v1");
const MAX_PENDING = 50;

interface AlertState {
  started: boolean;
  timer: ReturnType<typeof setInterval> | null;
  pending: SecurityEvent[];
  skipped: number;
  lastSent: number;
  lastDiskAlert: number;
  sent: number;
}

function state(): AlertState {
  const holder = globalThis as unknown as Record<symbol, AlertState | undefined>;
  let current = holder[KEY];
  if (!current || !Array.isArray(current.pending)) {
    current = { started: false, timer: null, pending: [], skipped: 0, lastSent: 0, lastDiskAlert: 0, sent: 0 };
    holder[KEY] = current;
  }
  return current;
}

function minutes(name: string, fallback: number): number {
  const value = Number(process.env[name]?.trim());
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Events that page an administrator. */
export function isAlertWorthy(event: Pick<SecurityEvent, "kind" | "detail">): boolean {
  const detail = typeof event.detail === "string" ? event.detail : "";
  switch (event.kind) {
    case "scanner_block":
      return /\b24h\b/.test(detail);
    case "login_lockout":
      return detail.startsWith("login-global");
    case "mail_budget":
    case "mail_suppressed":
    case "register_surge":
    case "disk_low":
    case "tool_timeout":
    case "quota_full":
      return true;
    default:
      return false;
  }
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);

/** The digest mail for a batch of events. */
export function digestMail(events: SecurityEvent[], skipped = 0, adminUrl = ""): MailContent {
  const lines = events.map((event) => `${event.ts.slice(0, 19).replace("T", " ")}  ${describeSecurityEvent(event)}`);
  if (skipped > 0) lines.push(`... and ${skipped} more`);
  const intro = `Security events on Smart Knife that need an administrator (times in UTC):`;
  const outro = adminUrl ? `Blocks, events and the unblock button: ${adminUrl}` : "Blocks, events and the unblock button are on the Users page.";
  return {
    kind: "admin_alert",
    subject: `Smart Knife security alert: ${events.length + skipped} event(s)`,
    text: `${intro}\n\n${lines.join("\n")}\n\n${outro}\n`,
    html: `<!doctype html><html><body style="font-family:system-ui,sans-serif;font-size:14px"><p>${escapeHtml(intro)}</p><pre>${escapeHtml(lines.join("\n"))}</pre><p>${escapeHtml(outro)}</p></body></html>`,
  };
}

function adminRecipients(): string[] {
  try {
    return readStore().accounts
      .filter((account) => account.role === "admin" && account.status === "active" && account.email && account.emailVerifiedAt)
      .map((account) => account.email as string);
  } catch {
    return [];
  }
}

function checkDisk(s: AlertState, now: number): void {
  if (now - s.lastDiskAlert < 60 * 60_000) return;
  try {
    const stats = statfsSync(dataDir());
    const freeMb = (Number(stats.bavail) * Number(stats.bsize)) / 1024 / 1024;
    const floor = minutes("KNIFE_DISK_FLOOR_MB", 2048);
    if (freeMb < floor) {
      s.lastDiskAlert = now;
      recordSecurityEvent({ kind: "disk_low", detail: `${Math.floor(freeMb)} MB free on the data disk (floor ${floor} MB)` });
    }
  } catch {
    // data dir not created yet
  }
}

/** Sends the digest when something is pending and the interval has passed. Returns how many mails went out. */
export function flushSecurityAlerts(now = Date.now(), force = false): number {
  const s = state();
  if (s.pending.length === 0) return 0;
  if (!force && now - s.lastSent < minutes("KNIFE_ALERT_INTERVAL_MIN", 15) * 60_000) return 0;
  const recipients = adminRecipients();
  const events = s.pending;
  const skipped = s.skipped;
  s.pending = [];
  s.skipped = 0;
  s.lastSent = now;
  if (recipients.length === 0) return 0;
  const base = (process.env.KNIFE_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  const mail = digestMail(events, skipped, base ? `${base}/account/admin` : "");
  for (const to of recipients) sendMail(to, mail);
  s.sent += recipients.length;
  return recipients.length;
}

/** Starts watching (idempotent; public mode only). */
export function startSecurityAlerts(): void {
  const s = state();
  if (s.started || !isPublicMode()) return;
  s.started = true;
  onSecurityEvent((event) => {
    if (!isAlertWorthy(event)) return;
    if (s.pending.includes(event)) return; // a merged event already queued
    if (s.pending.length >= MAX_PENDING) s.skipped += 1;
    else s.pending.push(event);
  });
  s.timer = setInterval(() => {
    const now = Date.now();
    checkDisk(s, now);
    flushSecurityAlerts(now);
  }, 60_000);
  s.timer.unref?.();
}

export function alertStatus(): { watching: boolean; pending: number; lastSent: string | null; mailsSent: number } {
  const s = state();
  return { watching: s.started, pending: s.pending.length + s.skipped, lastSent: s.lastSent ? new Date(s.lastSent).toISOString() : null, mailsSent: s.sent };
}
