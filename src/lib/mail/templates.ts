/** Account mail, English, plain text + minimal HTML. Every value put into HTML is escaped; links are absolute. */

export interface MailContent {
  subject: string;
  text: string;
  html: string;
}

const APP = "Smart Knife";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
}

type Block = string | { link: string; label: string };

function compose(subject: string, blocks: Block[]): MailContent {
  const text = blocks.map((block) => (typeof block === "string" ? block : `${block.label}:\n${block.link}`)).join("\n\n");
  const html = [
    `<!doctype html><html><body style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1d1f27">`,
    ...blocks.map((block) => (typeof block === "string"
      ? `<p>${escapeHtml(block)}</p>`
      : `<p><a href="${escapeHtml(block.link)}">${escapeHtml(block.label)}</a><br><span style="font-size:12px;color:#666">${escapeHtml(block.link)}</span></p>`)),
    `</body></html>`,
  ].join("\n");
  return { subject, text: `${text}\n\n-- \n${APP}\n`, html };
}

const IGNORE = "If you did not ask for this, ignore this message; nothing changes.";

/**
 * Says plainly who asked: anyone can type any address into the sign-up form, so the person reading this may not be the
 * one who chose the username and the password (audit M3: confirming someone else's sign-up hands them your address).
 */
export function verifyEmailMail(username: string, link: string): MailContent {
  return compose(`Confirm your email for ${APP}`, [
    `Someone signed up for ${APP} with the username "${username}" and this email address.`,
    `If that was you, confirm the address to activate the account. The link works once and expires in 24 hours.`,
    { link, label: "Confirm my email" },
    `If it was not you, do not open the link: ignore this message and no account will use your address. Whoever chose the password would be able to log in to an account you confirm.`,
  ]);
}

/** Forgot / resend on an unconfirmed sign-up: that sign-up is gone; the owner of the address starts a fresh one. */
export function pendingReleasedMail(link: string): MailContent {
  return compose(`Create your ${APP} account`, [
    `Someone (maybe you) asked for a ${APP} link for this email address. An unconfirmed sign-up that used this address was cancelled, so the address is free.`,
    `To use ${APP}, create your account with your own username and password.`,
    { link, label: "Create my account" },
    IGNORE,
  ]);
}

export function loginLockoutMail(username: string, link: string): MailContent {
  return compose(`Many failed logins on your ${APP} account`, [
    `Hello ${username},`,
    `Someone tried many wrong passwords for your ${APP} account in the last minutes. Logins from browsers you have used before still work; everyone else now has to wait or solve an extra check.`,
    `If this was not you, your password is still safe as long as it is not used elsewhere. You can set a new one at any time.`,
    { link, label: "Set a new password" },
  ]);
}

export function registerCollisionMail(link: string): MailContent {
  return compose(`Someone tried to sign up for ${APP} with your address`, [
    `Someone (maybe you) tried to create a new ${APP} account with this email address, which already has an account.`,
    `No new account was created. If it was you, log in instead, or reset your password if you forgot it.`,
    { link, label: "Reset my password" },
    IGNORE,
  ]);
}

export function usernameTakenMail(username: string, link: string): MailContent {
  return compose(`Choose another username for ${APP}`, [
    `You tried to create a ${APP} account with the username "${username}", which is not available.`,
    `No account was created. Sign up again with a different username.`,
    { link, label: "Sign up" },
    IGNORE,
  ]);
}

export function resetPasswordMail(username: string, link: string): MailContent {
  return compose(`Reset your ${APP} password`, [
    `Hello ${username},`,
    `Someone asked to reset the password of your ${APP} account. The link works once and expires in 1 hour. Setting a new password signs out every device.`,
    { link, label: "Set a new password" },
    IGNORE,
  ]);
}

export function changeEmailMail(username: string, newEmail: string, link: string): MailContent {
  return compose(`Confirm your new email for ${APP}`, [
    `Hello ${username},`,
    `Confirm ${newEmail} as the new address of your ${APP} account. Until you do, the old address stays in use. The link works once and expires in 24 hours.`,
    { link, label: "Confirm the new address" },
    IGNORE,
  ]);
}

export function emailChangedNoticeMail(username: string, newEmail: string): MailContent {
  return compose(`The email of your ${APP} account changed`, [
    `Hello ${username},`,
    `The address of your ${APP} account was changed to ${newEmail}. If this was not you, contact the administrator of this server.`,
  ]);
}

export function emailInUseMail(link: string): MailContent {
  return compose(`Someone tried to use your address on ${APP}`, [
    `Someone tried to move another ${APP} account to this email address, which already belongs to an account. Nothing was changed.`,
    `If you forgot your password, you can reset it.`,
    { link, label: "Reset my password" },
  ]);
}

export function passwordChangedMail(username: string, mcpKeysRevoked = 0): MailContent {
  return compose(`Your ${APP} password changed`, [
    `Hello ${username},`,
    `The password of your ${APP} account was changed and every other session was signed out.`,
    mcpKeysRevoked > 0
      ? `Your ${mcpKeysRevoked} MCP key${mcpKeysRevoked === 1 ? " was" : "s were"} revoked as well: agents that used ${mcpKeysRevoked === 1 ? "it" : "them"} need a new key from Account settings.`
      : `Any MCP keys of the account were revoked as well; agents need a new key from Account settings.`,
    `If this was not you, reset your password now and contact the administrator.`,
  ]);
}

export function accountDeletedMail(username: string): MailContent {
  return compose(`Your ${APP} account was deleted`, [
    `Hello ${username},`,
    `Your ${APP} account and all of its data were deleted. This cannot be undone.`,
  ]);
}
