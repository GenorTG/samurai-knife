import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import nodemailer, { type Transporter } from "nodemailer";
import { ensureDataDir, writePrivateFile } from "@/lib/accounts/store";
import { isPublicMode } from "@/lib/accounts/mode";
import type { MailContent } from "@/lib/mail/templates";

/**
 * Outgoing mail. KNIFE_MAIL_TRANSPORT = `smtp` (default in public mode: KNIFE_SMTP_HOST/PORT/SECURE/USER/PASS, from
 * KNIFE_SMTP_FROM) | `outbox` (default in private mode: every message is written as an .eml file to
 * `$KNIFE_DATA_DIR/mail-outbox/`, which the e2e suites read links from). Sending never blocks a response: `sendMail`
 * returns at once, a failure is logged to the console and `$KNIFE_DATA_DIR/mail-errors.log`. docs/ACCOUNTS.md "Mail".
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

function smtpTransport(env: NodeJS.ProcessEnv = process.env): Transporter {
  const host = env.KNIFE_SMTP_HOST?.trim();
  if (!host) throw new Error("KNIFE_SMTP_HOST is not set (or use KNIFE_MAIL_TRANSPORT=outbox)");
  const port = Number(env.KNIFE_SMTP_PORT?.trim() || "587");
  const secure = env.KNIFE_SMTP_SECURE?.trim() === "1" || env.KNIFE_SMTP_SECURE?.trim().toLowerCase() === "true";
  const user = env.KNIFE_SMTP_USER?.trim();
  const key = JSON.stringify([host, port, secure, user]);
  if (smtp?.key !== key) {
    smtp = {
      key,
      transport: nodemailer.createTransport({
        host,
        port,
        secure,
        auth: user ? { user, pass: env.KNIFE_SMTP_PASS ?? "" } : undefined,
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 30_000,
      }),
    };
  }
  return smtp.transport;
}

const outboxTransport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });

function logFailure(to: string, subject: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[mail] sending "${subject}" failed: ${message}`);
  try {
    appendFileSync(join(ensureDataDir(), "mail-errors.log"), `${new Date().toISOString()}\t${to.replace(/[\r\n\t]/g, " ")}\t${subject}\t${message.replace(/[\r\n]/g, " ")}\n`, { mode: 0o600 });
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

/** Fire and forget: resolves immediately; delivery and its error log happen in the background. */
export function sendMail(to: string, content: MailContent): void {
  void deliver(to, content).catch((error: unknown) => logFailure(to, content.subject, error));
}

/** Awaitable variant for the CLI/tests. */
export function sendMailNow(to: string, content: MailContent): Promise<void> {
  return deliver(to, content);
}
