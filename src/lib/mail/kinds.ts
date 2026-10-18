/**
 * Mail kinds and their classes (docs/ACCOUNTS.md "Mail queue"). The class decides priority and which budgets apply:
 * `security` (a change the owner of the account made or must hear about, operator alerts) goes first, is never evicted
 * from a full queue and only meets the global budget; `verification` (links an outsider can trigger) and `notice`
 * (collision notices) meet every budget, notices are dropped first. Every template in templates.ts names its kind.
 */

export type MailClass = "security" | "verification" | "notice";

export const MAIL_KINDS = {
  password_changed: "security",
  email_changed: "security",
  account_deleted: "security",
  admin_alert: "security",
  /** Once per account per day at most (session.ts onLockout). */
  login_lockout: "security",
  verify_email: "verification",
  reset_password: "verification",
  change_email: "verification",
  /** Forgot/resend on an unconfirmed sign-up (flows.ts releasePendingFor): outsider-triggered, so verification class. */
  pending_released: "verification",
  register_collision: "notice",
  username_taken: "notice",
  email_in_use: "notice",
  other: "notice",
} as const satisfies Record<string, MailClass>;

export type MailKind = keyof typeof MAIL_KINDS;

/** Lower = sent first, dropped last. */
export const CLASS_PRIORITY: Record<MailClass, number> = { security: 0, verification: 1, notice: 2 };

/** "Someone used your address" notices: at most one per mailbox per KNIFE_MAIL_COLLISION_LIMITS window (default 1/day). */
export const COLLISION_KINDS: ReadonlySet<MailKind> = new Set<MailKind>(["register_collision", "username_taken", "email_in_use"]);

export function isMailKind(value: unknown): value is MailKind {
  return typeof value === "string" && Object.hasOwn(MAIL_KINDS, value);
}

export function mailClass(kind: MailKind): MailClass {
  return MAIL_KINDS[kind];
}
