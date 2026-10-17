import { createHash, randomBytes } from "node:crypto";
import {
  ACCOUNT_ID_PATTERN,
  DEFAULT_USER_QUOTA_BYTES,
  findByEmail,
  mutateStore,
  newAccountRecord,
  normalizeEmail,
  type Account,
  type AccountStore,
} from "@/lib/accounts/store";
import { hashPasswordAsync, MAX_PASSWORD_CHARS, MIN_PASSWORD_CHARS, verifyPasswordAsync } from "@/lib/accounts/password";
import { consumeLimits, checkLimits, hitLimits, LIMITS, type LimitCheck } from "@/lib/accounts/rate-limit";
import { revokeAllSessions } from "@/lib/accounts/session";
import { deleteAccountData } from "@/lib/accounts/data";
import { revokeAllMcpKeys } from "@/lib/accounts/mcp-keys";
import { publicBaseUrl, sendMail } from "@/lib/mail";
import {
  accountDeletedMail,
  changeEmailMail,
  emailChangedNoticeMail,
  emailInUseMail,
  passwordChangedMail,
  registerCollisionMail,
  resetPasswordMail,
  usernameTakenMail,
  verifyEmailMail,
} from "@/lib/mail/templates";

/**
 * Public-mode account flows (docs/ACCOUNTS.md "Flows"). The rule for anything an outsider can call (register, resend,
 * forgot): the answer never depends on whether a username or address exists; what differs goes into the mailbox of that
 * address instead. Links carry 32 random bytes; only their SHA-256 is stored, and a link works once.
 */

const VERIFY_TTL_MS = 24 * 60 * 60_000;
const RESET_TTL_MS = 60 * 60_000;
const MAX_EMAIL = 254;
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

/** Names nobody may register: they read as the site itself in mail and the UI. */
export const RESERVED = new Set([
  "admin", "administrator", "root", "system", "support", "security", "postmaster", "abuse", "noreply", "no-reply",
  "webmaster", "hostmaster", "mailer-daemon", "knife", "samurai-knife", "api", "account", "accounts",
]);

export type FlowError = { ok: false; status: number; error: string; retryAfterSeconds?: number };
export type FlowOk<T = object> = { ok: true } & T;

function fail(status: number, error: string, extra?: { retryAfterSeconds?: number }): FlowError {
  return { ok: false, status, error, ...extra };
}

function limited(verdict: LimitCheck): FlowError | null {
  return verdict.ok ? null : fail(429, "rate_limited", { retryAfterSeconds: verdict.retryAfterSeconds });
}

export function newToken(ttlMs: number): { raw: string; record: { hash: string; expiresAt: string } } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, record: { hash: hashToken(raw), expiresAt: new Date(Date.now() + ttlMs).toISOString() } };
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function live(token: { hash: string; expiresAt: string } | undefined, hash: string): boolean {
  return Boolean(token && token.hash === hash && Date.parse(token.expiresAt) > Date.now());
}

export function validateEmail(value: string): string | null {
  const email = normalizeEmail(value);
  return email.length <= MAX_EMAIL && EMAIL.test(email) ? email : null;
}

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_CHARS) return `The password needs at least ${MIN_PASSWORD_CHARS} characters.`;
  if (password.length > MAX_PASSWORD_CHARS) return `The password can have at most ${MAX_PASSWORD_CHARS} characters.`;
  return null;
}

const link = (path: string, token?: string): string => `${publicBaseUrl()}${path}${token ? `?token=${encodeURIComponent(token)}` : ""}`;

/** Pending accounts whose link expired hold a username and an address nobody confirmed: free both. */
function dropExpiredPending(store: AccountStore): void {
  const now = Date.now();
  store.accounts = store.accounts.filter((account) => !(
    account.status === "pending"
    && account.emailVerifiedAt === null
    && (!account.verifyToken || Date.parse(account.verifyToken.expiresAt) <= now)
    && now - Date.parse(account.createdAt) > VERIFY_TTL_MS
  ));
}

export const GENERIC_REGISTER = "If the details can be used, a message is on its way to that address. Open the link in it to finish.";
export const GENERIC_RESEND = "If that address has an account waiting for confirmation, a new link is on its way.";
export const GENERIC_FORGOT = "If that address belongs to an account, a link to set a new password is on its way.";

/* ------------------------------------------------------------------------------------------- register */

export async function register(input: { username: string; email: string; password: string }, ip: string): Promise<FlowOk<{ message: string }> | FlowError> {
  const username = input.username.trim();
  if (!ACCOUNT_ID_PATTERN.test(username)) {
    return fail(400, "The username needs 1-32 characters: lowercase letters, digits, - and _ (starting with a letter or digit).");
  }
  const email = validateEmail(input.email);
  if (!email) return fail(400, "That does not look like an email address.");
  const problem = passwordProblem(input.password);
  if (problem) return fail(400, problem);
  const blocked = limited(consumeLimits([LIMITS.registerIp(ip), LIMITS.registerEmail(email)]));
  if (blocked) return blocked;

  // Hash before the lock (and on every path, so a taken name costs the same time as a new account).
  const passwordHash = await hashPasswordAsync(input.password);
  const token = newToken(VERIFY_TTL_MS);
  const outcome = mutateStore((store): "created" | "email_taken" | "username_taken" => {
    dropExpiredPending(store);
    if (store.accounts.some((account) => account.email === email || account.emailChange?.email === email)) return "email_taken";
    if (RESERVED.has(username) || store.accounts.some((account) => account.id === username)) return "username_taken";
    store.accounts.push(newAccountRecord({
      id: username,
      displayName: username,
      passwordHash,
      email,
      role: "user",
      status: "pending",
      storageQuotaBytes: DEFAULT_USER_QUOTA_BYTES,
      verifyToken: token.record,
    }));
    if (store.accounts.length === 1) store.defaultAccountId = username;
    return "created";
  });
  if (outcome === "created") sendMail(email, verifyEmailMail(username, link("/verify", token.raw)));
  else if (outcome === "email_taken") sendMail(email, registerCollisionMail(link("/forgot-password")));
  else sendMail(email, usernameTakenMail(username, link("/register")));
  return { ok: true, message: GENERIC_REGISTER };
}

/* --------------------------------------------------------------------------------------------- verify */

export type VerifyResult = FlowOk<{ kind: "verified" | "email_changed"; username: string }> | FlowError;

/** One endpoint for both links: account activation and a confirmed address change. */
export function verifyToken(raw: string): VerifyResult {
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(raw)) return fail(400, "invalid_or_expired");
  const hash = hashToken(raw);
  const result = mutateStore((store) => {
    const now = new Date().toISOString();
    const pending = store.accounts.find((account) => live(account.verifyToken, hash));
    if (pending) {
      delete pending.verifyToken;
      pending.emailVerifiedAt = now;
      if (pending.status === "pending") pending.status = "active";
      return { kind: "verified" as const, account: pending, oldEmail: null };
    }
    const changing = store.accounts.find((account) => live(account.emailChange, hash));
    if (changing && changing.emailChange) {
      const next = changing.emailChange.email;
      delete changing.emailChange;
      if (store.accounts.some((account) => account.id !== changing.id && account.email === next)) return null;
      const oldEmail = changing.email;
      changing.email = next;
      changing.emailVerifiedAt = now;
      return { kind: "email_changed" as const, account: changing, oldEmail };
    }
    return null;
  });
  if (!result) return fail(400, "invalid_or_expired");
  if (result.kind === "email_changed" && result.oldEmail && result.account.email) {
    sendMail(result.oldEmail, emailChangedNoticeMail(result.account.id, result.account.email));
  }
  return { ok: true, kind: result.kind, username: result.account.id };
}

/* --------------------------------------------------------------------------------------------- resend */

export function resendVerification(emailInput: string, ip: string): FlowOk<{ message: string }> | FlowError {
  const email = validateEmail(emailInput);
  if (!email) return fail(400, "That does not look like an email address.");
  const blocked = limited(consumeLimits([LIMITS.resendIp(ip), LIMITS.resendEmail(email)]));
  if (blocked) return blocked;
  issueVerification((account) => account.email === email);
  return { ok: true, message: GENERIC_RESEND };
}

/** New verification link for an unverified account (old links stop working). Returns whether one was sent. */
export function issueVerification(match: (account: Account) => boolean): boolean {
  const token = newToken(VERIFY_TTL_MS);
  const target = mutateStore((store) => {
    const account = store.accounts.find(match);
    if (!account || account.emailVerifiedAt !== null || !account.email || account.status === "disabled") return null;
    account.verifyToken = token.record;
    return account;
  });
  if (target?.email) sendMail(target.email, verifyEmailMail(target.id, link("/verify", token.raw)));
  return Boolean(target);
}

/* --------------------------------------------------------------------------------------- forgot / reset */

export function forgotPassword(emailInput: string, ip: string): FlowOk<{ message: string }> | FlowError {
  const email = validateEmail(emailInput);
  if (!email) return fail(400, "That does not look like an email address.");
  const blocked = limited(consumeLimits([LIMITS.forgotIp(ip), LIMITS.forgotEmail(email)]));
  if (blocked) return blocked;
  const existing = findByEmail(email);
  if (existing && existing.status === "pending") {
    // Never confirmed: the useful mail is the confirmation link (a reset would not let them in either).
    issueVerification((account) => account.id === existing.id);
  } else if (existing && existing.status === "active") {
    const token = newToken(RESET_TTL_MS);
    mutateStore((store) => {
      const account = store.accounts.find((candidate) => candidate.id === existing.id);
      if (account) account.resetToken = token.record;
    });
    sendMail(email, resetPasswordMail(existing.id, link("/reset-password", token.raw)));
  }
  return { ok: true, message: GENERIC_FORGOT };
}

export async function resetPassword(raw: string, password: string): Promise<FlowOk<{ username: string }> | FlowError> {
  const problem = passwordProblem(password);
  if (problem) return fail(400, problem);
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(raw)) return fail(400, "invalid_or_expired");
  const hash = hashToken(raw);
  const passwordHash = await hashPasswordAsync(password);
  const account = mutateStore((store) => {
    const target = store.accounts.find((candidate) => live(candidate.resetToken, hash) && candidate.status === "active");
    if (!target) return null;
    delete target.resetToken;
    target.passwordHash = passwordHash;
    return target;
  });
  if (!account) return fail(400, "invalid_or_expired");
  revokeAllSessions(account.id);
  if (account.email) sendMail(account.email, passwordChangedMail(account.id));
  return { ok: true, username: account.id };
}

/* ----------------------------------------------------------------------------- signed-in account changes */

/** Wrong current passwords count against a per-account bucket (the session is already authenticated). */
async function confirmPassword(account: Account, password: string): Promise<FlowError | null> {
  const bucket = [LIMITS.sensitive(account.id)];
  const blocked = limited(checkLimits(bucket));
  if (blocked) return blocked;
  if (await verifyPasswordAsync(password, account.passwordHash)) return null;
  hitLimits(bucket);
  return fail(403, "wrong_password");
}

export async function changePassword(account: Account, current: string, next: string): Promise<FlowOk<{ account: Account; revoked: number }> | FlowError> {
  const problem = passwordProblem(next);
  if (problem) return fail(400, problem);
  const wrong = await confirmPassword(account, current);
  if (wrong) return wrong;
  const passwordHash = await hashPasswordAsync(next);
  const updated = mutateStore((store) => {
    const target = store.accounts.find((candidate) => candidate.id === account.id);
    if (!target) return null;
    target.passwordHash = passwordHash;
    delete target.resetToken;
    return target;
  });
  if (!updated) return fail(404, "not_found");
  const revoked = revokeAllSessions(updated.id);
  if (updated.email) sendMail(updated.email, passwordChangedMail(updated.id));
  return { ok: true, account: updated, revoked };
}

export async function changeEmail(account: Account, password: string, emailInput: string): Promise<FlowOk<{ message: string }> | FlowError> {
  const email = validateEmail(emailInput);
  if (!email) return fail(400, "That does not look like an email address.");
  if (email === account.email) return fail(400, "That is already your address.");
  const wrong = await confirmPassword(account, password);
  if (wrong) return wrong;
  const token = newToken(VERIFY_TTL_MS);
  const outcome = mutateStore((store) => {
    const target = store.accounts.find((candidate) => candidate.id === account.id);
    if (!target) return "missing" as const;
    if (store.accounts.some((candidate) => candidate.id !== account.id && (candidate.email === email || candidate.emailChange?.email === email))) {
      return "taken" as const;
    }
    target.emailChange = { ...token.record, email };
    return "pending" as const;
  });
  if (outcome === "missing") return fail(404, "not_found");
  if (outcome === "pending") sendMail(email, changeEmailMail(account.id, email, link("/verify", token.raw)));
  else sendMail(email, emailInUseMail(link("/forgot-password")));
  return { ok: true, message: `A confirmation link is on its way to ${email}. Your address changes when you open it.` };
}

/** Removes the account record, its sessions and every data location. Shared by self-deletion and the admin page. */
export function purgeAccount(id: string): { removed: string[]; email: string | null } | null {
  const gone = mutateStore((store) => {
    const target = store.accounts.find((candidate) => candidate.id === id);
    if (!target) return null;
    store.accounts = store.accounts.filter((candidate) => candidate.id !== id);
    if (store.defaultAccountId === id && store.accounts.length > 0) {
      store.defaultAccountId = (store.accounts.find((candidate) => candidate.role === "admin") ?? store.accounts[0]).id;
    }
    return target;
  });
  if (!gone) return null;
  revokeAllSessions(id);
  revokeAllMcpKeys(id);
  const removed = ["accounts.json (record)", "sessions.json (sessions)", "mcp-keys.json (MCP keys)", ...deleteAccountData(id)];
  return { removed, email: gone.email };
}

export function isLastAdmin(id: string, store: AccountStore): boolean {
  const admins = store.accounts.filter((account) => account.role === "admin" && account.status === "active");
  return admins.length === 1 && admins[0].id === id;
}

export async function deleteOwnAccount(account: Account, password: string, store: AccountStore): Promise<FlowOk<{ removed: string[] }> | FlowError> {
  // An account made with "Sign in with GitHub" has no password: the typed username confirms instead.
  if (!account.passwordHash) {
    if (password.trim() !== account.id) return fail(403, "type_username");
  } else {
    const wrong = await confirmPassword(account, password);
    if (wrong) return wrong;
  }
  if (isLastAdmin(account.id, store)) return fail(409, "You are the only administrator. Make someone else an administrator first.");
  const result = purgeAccount(account.id);
  if (!result) return fail(404, "not_found");
  if (result.email) sendMail(result.email, accountDeletedMail(account.id));
  return { ok: true, removed: result.removed };
}
