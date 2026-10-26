import { translator, type Locale } from "@/lib/i18n/core";
import type { MailKind } from "@/lib/mail/kinds";

/**
 * Account mail, plain text + minimal HTML, in the reader's language (`locale`: the account's interface language, or
 * the language of the page a sign-up / reset came from; English by default). Every value put into HTML is escaped;
 * links are absolute. Each template names its kind, which sets the queue priority and budgets (src/lib/mail/kinds.ts).
 */

export interface MailContent {
  subject: string;
  text: string;
  html: string;
  /** Queue kind; content without one is sent as `other` (lowest priority, dropped first). */
  kind?: MailKind;
}

const APP = "Smart Knife";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
}

type Block = string | { link: string; label: string };

function compose(kind: MailKind, subject: string, blocks: Block[], locale: Locale): MailContent {
  const text = blocks.map((block) => (typeof block === "string" ? block : `${block.label}:\n${block.link}`)).join("\n\n");
  const html = [
    `<!doctype html><html lang="${locale}"><body style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1d1f27">`,
    ...blocks.map((block) => (typeof block === "string"
      ? `<p>${escapeHtml(block)}</p>`
      : `<p><a href="${escapeHtml(block.link)}">${escapeHtml(block.label)}</a><br><span style="font-size:12px;color:#666">${escapeHtml(block.link)}</span></p>`)),
    `</body></html>`,
  ].join("\n");
  return { subject, text: `${text}\n\n-- \n${APP}\n`, html, kind };
}

const ignore = (locale: Locale) => translator(locale).t("If you did not ask for this, ignore this message; nothing changes.");

/**
 * Says plainly who asked: anyone can type any address into the sign-up form, so the person reading this may not be the
 * one who chose the username and the password (audit M3: confirming someone else's sign-up hands them your address).
 */
export function verifyEmailMail(username: string, link: string, locale: Locale = "en"): MailContent {
  const { t } = translator(locale);
  return compose("verify_email", t("Confirm your email for {app}", { app: APP }), [
    t("Someone signed up for {app} with the username \"{username}\" and this email address.", { app: APP, username }),
    t("If that was you, confirm the address to activate the account. The link works once and expires in 24 hours."),
    { link, label: t("Confirm my email") },
    t("If it was not you, do not open the link: ignore this message and no account will use your address. Whoever chose the password would be able to log in to an account you confirm."),
  ], locale);
}

/** Forgot / resend on an unconfirmed sign-up: that sign-up is gone; the owner of the address starts a fresh one. */
export function pendingReleasedMail(link: string, locale: Locale = "en"): MailContent {
  const { t } = translator(locale);
  return compose("pending_released", t("Create your {app} account", { app: APP }), [
    t("Someone (maybe you) asked for a {app} link for this email address. An unconfirmed sign-up that used this address was cancelled, so the address is free.", { app: APP }),
    t("To use {app}, create your account with your own username and password.", { app: APP }),
    { link, label: t("Create my account") },
    ignore(locale),
  ], locale);
}

export function loginLockoutMail(username: string, link: string, locale: Locale = "en"): MailContent {
  const { t } = translator(locale);
  return compose("login_lockout", t("Many failed logins on your {app} account", { app: APP }), [
    t("Hello {username},", { username }),
    t("Someone tried many wrong passwords for your {app} account in the last minutes. Logins from browsers you have used before still work; everyone else now has to wait or solve an extra check.", { app: APP }),
    t("If this was not you, your password is still safe as long as it is not used elsewhere. You can set a new one at any time."),
    { link, label: t("Set a new password") },
  ], locale);
}

export function registerCollisionMail(link: string, locale: Locale = "en"): MailContent {
  const { t } = translator(locale);
  return compose("register_collision", t("Someone tried to sign up for {app} with your address", { app: APP }), [
    t("Someone (maybe you) tried to create a new {app} account with this email address, which already has an account.", { app: APP }),
    t("No new account was created. If it was you, log in instead, or reset your password if you forgot it."),
    { link, label: t("Reset my password") },
    ignore(locale),
  ], locale);
}

export function usernameTakenMail(username: string, link: string, locale: Locale = "en"): MailContent {
  const { t } = translator(locale);
  return compose("username_taken", t("Choose another username for {app}", { app: APP }), [
    t("You tried to create a {app} account with the username \"{username}\", which is not available.", { app: APP, username }),
    t("No account was created. Sign up again with a different username."),
    { link, label: t("Sign up") },
    ignore(locale),
  ], locale);
}

export function resetPasswordMail(username: string, link: string, locale: Locale = "en"): MailContent {
  const { t } = translator(locale);
  return compose("reset_password", t("Reset your {app} password", { app: APP }), [
    t("Hello {username},", { username }),
    t("Someone asked to reset the password of your {app} account. The link works once and expires in 1 hour. Setting a new password signs out every device.", { app: APP }),
    { link, label: t("Set a new password") },
    ignore(locale),
  ], locale);
}

export function changeEmailMail(username: string, newEmail: string, link: string, locale: Locale = "en"): MailContent {
  const { t } = translator(locale);
  return compose("change_email", t("Confirm your new email for {app}", { app: APP }), [
    t("Hello {username},", { username }),
    t("Confirm {newEmail} as the new address of your {app} account. Until you do, the old address stays in use. The link works once and expires in 24 hours.", { app: APP, newEmail }),
    { link, label: t("Confirm the new address") },
    ignore(locale),
  ], locale);
}

export function emailChangedNoticeMail(username: string, newEmail: string, locale: Locale = "en"): MailContent {
  const { t } = translator(locale);
  return compose("email_changed", t("The email of your {app} account changed", { app: APP }), [
    t("Hello {username},", { username }),
    t("The address of your {app} account was changed to {newEmail}. If this was not you, contact the administrator of this server.", { app: APP, newEmail }),
  ], locale);
}

export function emailInUseMail(link: string, locale: Locale = "en"): MailContent {
  const { t } = translator(locale);
  return compose("email_in_use", t("Someone tried to use your address on {app}", { app: APP }), [
    t("Someone tried to move another {app} account to this email address, which already belongs to an account. Nothing was changed.", { app: APP }),
    t("If you forgot your password, you can reset it."),
    { link, label: t("Reset my password") },
  ], locale);
}

export function passwordChangedMail(username: string, mcpKeysRevoked = 0, locale: Locale = "en"): MailContent {
  const { t, tn } = translator(locale);
  return compose("password_changed", t("Your {app} password changed", { app: APP }), [
    t("Hello {username},", { username }),
    t("The password of your {app} account was changed and every other session was signed out.", { app: APP }),
    mcpKeysRevoked > 0
      ? tn("Your {n} MCP key was revoked as well: agents that used it need a new key from Account settings.", "Your {n} MCP keys were revoked as well: agents that used them need a new key from Account settings.", mcpKeysRevoked)
      : t("Any MCP keys of the account were revoked as well; agents need a new key from Account settings."),
    t("If this was not you, reset your password now and contact the administrator."),
  ], locale);
}

export function accountDeletedMail(username: string, locale: Locale = "en"): MailContent {
  const { t } = translator(locale);
  return compose("account_deleted", t("Your {app} account was deleted", { app: APP }), [
    t("Hello {username},", { username }),
    t("Your {app} account and all of its data were deleted. This cannot be undone.", { app: APP }),
  ], locale);
}
