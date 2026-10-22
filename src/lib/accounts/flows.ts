import { createHash, randomBytes } from "node:crypto";
import {
  ACCOUNT_ID_PATTERN,
  DEFAULT_USER_QUOTA_BYTES,
  findByEmail,
  mutateStore,
  newAccountRecord,
  normalizeEmail,
  readStore,
  type Account,
  type AccountStore,
} from "@/lib/accounts/store";
import { HashBusyError, hashPasswordAsync, MAX_PASSWORD_CHARS, MIN_PASSWORD_CHARS, verifyPasswordAsync } from "@/lib/accounts/password";
import { consumeLimits, checkLimits, hitLimits, LIMITS, type LimitCheck } from "@/lib/accounts/rate-limit";
import { revokeAllSessions } from "@/lib/accounts/session";
import { deleteAccountData } from "@/lib/accounts/data";
import { revokeAllMcpKeys } from "@/lib/accounts/mcp-keys";
import { checkPow, type PowForm, type PowSolution } from "@/lib/accounts/pow";
import { dropExpiredPending, ensurePendingSweeper, pendingRoom, pendingRoomNow, VERIFY_TTL_MS } from "@/lib/accounts/pending";
import { clientPrefix, prefixTag } from "@/lib/accounts/ip-prefix";
import { recordSecurityEvent } from "@/lib/security/events";
import { checkEmailPolicy, checkEmailPolicySync, EMAIL_POLICY_MESSAGE } from "@/lib/accounts/email-policy";
import { publicBaseUrl, sendMail } from "@/lib/mail";
import { legalVersion, recordLegalVersion } from "@/lib/legal/legal";
import {
  accountDeletedMail,
  changeEmailMail,
  emailChangedNoticeMail,
  emailInUseMail,
  passwordChangedMail,
  pendingReleasedMail,
  registerCollisionMail,
  resetPasswordMail,
  usernameTakenMail,
  verifyEmailMail,
} from "@/lib/mail/templates";

/**
 * Public-mode account flows (docs/ACCOUNTS.md "Flows"). The rule for anything an outsider can call (register, resend,
 * forgot): the answer never depends on whether a username or address exists; what differs goes into the mailbox of that
 * address instead. Links carry 32 random bytes; only their SHA-256 is stored, and a link works once.
 *
 * Cost order for every unauthenticated flow (audit abuse #4, #6): input syntax, proof-of-work (`pow.ts`), rate limits,
 * read-only lookups on the cached store, and only then password hashing (inside the global hash budget, busy -> 503),
 * store writes and mail. A made-up verify/reset token never writes the store or hashes a password. Registration and
 * email change also meet the email address policy (`email-policy.ts`, audit abuse #5, design A): static/list rules after
 * syntax and before proof-of-work; the DNS part (an outbound lookup, cached and bounded) only after proof-of-work. Both
 * precede limits/hash/mail. Per-email limits key on the canonical mailbox (`rate-limit.ts` `emailLimitKey`).
 */

const RESET_TTL_MS = 60 * 60_000;
const MAX_EMAIL = 254;
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
const TOKEN = /^[A-Za-z0-9_-]{20,128}$/;

/** Names nobody may register: they read as the site itself in mail and the UI. */
export const RESERVED = new Set([
  "admin", "administrator", "root", "system", "support", "security", "postmaster", "abuse", "noreply", "no-reply",
  "webmaster", "hostmaster", "mailer-daemon", "knife", "samurai-knife", "api", "account", "accounts",
]);

export type FlowError = { ok: false; status: number; error: string; retryAfterSeconds?: number; bits?: number; message?: string };
export type FlowOk<T = object> = { ok: true } & T;

const TERMS_REQUIRED = "Accept the Terms of Service and the privacy notice to create an account.";
const TERMS_CHANGED = "The Terms of Service or privacy notice changed while this page was open: reload it, read them and try again.";

function fail(status: number, error: string, extra?: { retryAfterSeconds?: number; bits?: number; message?: string }): FlowError {
  return { ok: false, status, error, ...extra };
}

function limited(verdict: LimitCheck): FlowError | null {
  return verdict.ok ? null : fail(429, "rate_limited", { retryAfterSeconds: verdict.retryAfterSeconds });
}

/** Proof-of-work gate as a flow error (428 challenge_required / challenge_invalid, 503 busy), or null when it passed. */
function powGate(form: PowForm, ip: string, pow: PowSolution | null | undefined): FlowError | null {
  const verdict = checkPow(form, ip, pow);
  return verdict.ok ? null : fail(verdict.status, verdict.error, { bits: verdict.bits, retryAfterSeconds: verdict.retryAfterSeconds });
}

function busy(error: unknown): FlowError {
  if (error instanceof HashBusyError) {
    recordSecurityEvent({ kind: "hash_busy" });
    return fail(503, "busy", { retryAfterSeconds: error.retryAfterSeconds, message: error.message });
  }
  throw error;
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

export const GENERIC_REGISTER = "If the details can be used, a message is on its way to that address. Open the link in it to finish.";
export const GENERIC_RESEND = "If that address has an account waiting for confirmation, a new link is on its way.";
export const GENERIC_FORGOT = "If that address belongs to an account, a link to set a new password is on its way.";
export const PENDING_FULL = "Too many sign-ups are waiting for confirmation right now. Try again later.";

/* ------------------------------------------------------------------------------------------- register */

export async function register(input: { username: string; email: string; password: string; acceptTerms?: string | null }, ip: string, pow?: PowSolution | null): Promise<FlowOk<{ message: string }> | FlowError> {
  // The Terms and privacy notice must be accepted before the contract exists; the version the page showed is recorded.
  // A version that changed in between (the operator edited the texts) is refused, so the record names what was shown.
  const terms = legalVersion();
  if (!input.acceptTerms) return fail(400, "terms_required", { message: TERMS_REQUIRED });
  if (input.acceptTerms !== terms) return fail(409, "terms_changed", { message: TERMS_CHANGED });
  recordLegalVersion();
  const username = input.username.trim();
  if (!ACCOUNT_ID_PATTERN.test(username)) {
    return fail(400, "The username needs 1-32 characters: lowercase letters, digits, - and _ (starting with a letter or digit).");
  }
  const email = validateEmail(input.email);
  if (!email) return fail(400, "That does not look like an email address.");
  const problem = passwordProblem(input.password);
  if (problem) return fail(400, problem);
  // Static address rules and cached lists follow syntax validation and precede proof-of-work. DNS is outbound work an
  // outsider could trigger with made-up domains, so it waits for paid proof-of-work; both precede limits, hash and mail.
  if (!checkEmailPolicySync(email).ok) return fail(400, EMAIL_POLICY_MESSAGE);
  const unpaid = powGate("register", ip, pow);
  if (unpaid) return unpaid;
  if (!(await checkEmailPolicy(email)).ok) return fail(400, EMAIL_POLICY_MESSAGE);
  const blocked = limited(consumeLimits([LIMITS.registerIp(ip), LIMITS.registerEmail(email)]));
  if (blocked) return blocked;
  ensurePendingSweeper();
  const ipTag = prefixTag(ip);
  if (pendingRoomNow(email, ipTag) !== "ok") {
    recordSecurityEvent({ kind: "pending_full", ipPrefix: clientPrefix(ip) });
    return fail(429, "pending_full", { message: PENDING_FULL, retryAfterSeconds: 3_600 });
  }

  // Hash before the lock (and on every path, so a taken name costs the same time as a new account).
  let passwordHash: string;
  try {
    passwordHash = await hashPasswordAsync(input.password);
  } catch (error) {
    return busy(error);
  }
  const token = newToken(VERIFY_TTL_MS);
  const outcome = mutateStore((store): "created" | "email_taken" | "username_taken" | "pending_full" => {
    dropExpiredPending(store);
    if (store.accounts.some((account) => account.email === email || account.emailChange?.email === email)) return "email_taken";
    if (RESERVED.has(username) || store.accounts.some((account) => account.id === username)) return "username_taken";
    if (pendingRoom(store, email, ipTag) !== "ok") return "pending_full";
    store.accounts.push(newAccountRecord({
      id: username,
      displayName: username,
      passwordHash,
      email,
      role: "user",
      status: "pending",
      storageQuotaBytes: DEFAULT_USER_QUOTA_BYTES,
      verifyToken: token.record,
      pendingIpp: ipTag,
      termsAcceptedAt: new Date().toISOString(),
      termsVersion: terms,
    }));
    if (store.accounts.length === 1) store.defaultAccountId = username;
    return "created";
  });
  if (outcome === "pending_full") return fail(429, "pending_full", { message: PENDING_FULL, retryAfterSeconds: 3_600 });
  if (outcome === "created") sendMail(email, verifyEmailMail(username, link("/verify", token.raw)));
  else if (outcome === "email_taken") sendMail(email, registerCollisionMail(link("/forgot-password")));
  else sendMail(email, usernameTakenMail(username, link("/register")));
  return { ok: true, message: GENERIC_REGISTER };
}

/* --------------------------------------------------------------------------------------------- verify */

export type VerifyResult = FlowOk<{ kind: "verified" | "email_changed"; username: string }> | FlowError;

/**
 * One endpoint for both links: account activation and a confirmed address change. `sessionToken` is the caller's session
 * cookie: a confirmed address change signs out every other session of the account and drops a pending reset link.
 */
export function verifyToken(raw: string, ip = "local", sessionToken?: string): VerifyResult {
  if (!TOKEN.test(raw)) return fail(400, "invalid_or_expired");
  const hash = hashToken(raw);
  const blocked = limited(consumeLimits([LIMITS.verifyIp(ip), LIMITS.verifyToken(hash)]));
  if (blocked) return blocked;
  // Read-only first: a made-up token never takes the lock or rewrites accounts.json.
  if (!readStore().accounts.some((account) => live(account.verifyToken, hash) || live(account.emailChange, hash))) return fail(400, "invalid_or_expired");
  const result = mutateStore((store) => {
    const now = new Date().toISOString();
    const pending = store.accounts.find((account) => live(account.verifyToken, hash));
    if (pending) {
      delete pending.verifyToken;
      delete pending.pendingIpp;
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
      // A reset link mailed to the old address must not outlive the change.
      delete changing.resetToken;
      return { kind: "email_changed" as const, account: changing, oldEmail };
    }
    return null;
  });
  if (!result) return fail(400, "invalid_or_expired");
  if (result.kind === "email_changed") {
    revokeAllSessions(result.account.id, sessionToken);
    if (result.oldEmail && result.account.email) sendMail(result.oldEmail, emailChangedNoticeMail(result.account.id, result.account.email));
  }
  return { ok: true, kind: result.kind, username: result.account.id };
}

/* --------------------------------------------------------------------------------------------- resend */

/**
 * Audit M3 (pre-registration hijack): a pending sign-up proves nothing about who owns its address. When the owner of the
 * address asks for any link (resend, forgot), that sign-up is cancelled and they get a "create your account" link: the
 * squatter's verification link is never sent to them again. Returns whether a record was released.
 */
function releasePendingFor(email: string): boolean {
  const released = mutateStore((store) => {
    const before = store.accounts.length;
    store.accounts = store.accounts.filter((account) => !(account.email === email && account.status === "pending" && account.emailVerifiedAt === null));
    if (store.accounts.length > 0 && !store.accounts.some((account) => account.id === store.defaultAccountId)) store.defaultAccountId = store.accounts[0].id;
    return store.accounts.length < before;
  });
  if (released) sendMail(email, pendingReleasedMail(link("/register")));
  return released;
}

export function resendVerification(emailInput: string, ip: string, pow?: PowSolution | null): FlowOk<{ message: string }> | FlowError {
  const email = validateEmail(emailInput);
  if (!email) return fail(400, "That does not look like an email address.");
  const unpaid = powGate("resend", ip, pow);
  if (unpaid) return unpaid;
  const blocked = limited(consumeLimits([LIMITS.resendIp(ip), LIMITS.resendEmail(email)]));
  if (blocked) return blocked;
  ensurePendingSweeper();
  const existing = findByEmail(email);
  if (existing?.status === "pending") releasePendingFor(email);
  // An active account without a confirmed address (made by the owner with the CLI) gets a fresh confirmation link.
  else if (existing) issueVerification((account) => account.id === existing.id);
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

export function forgotPassword(emailInput: string, ip: string, pow?: PowSolution | null): FlowOk<{ message: string }> | FlowError {
  const email = validateEmail(emailInput);
  if (!email) return fail(400, "That does not look like an email address.");
  const unpaid = powGate("forgot", ip, pow);
  if (unpaid) return unpaid;
  const blocked = limited(consumeLimits([LIMITS.forgotIp(ip), LIMITS.forgotEmail(email)]));
  if (blocked) return blocked;
  ensurePendingSweeper();
  const existing = findByEmail(email);
  if (existing && existing.status === "pending") {
    releasePendingFor(email);
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

export async function resetPassword(raw: string, password: string, ip = "local", pow?: PowSolution | null): Promise<FlowOk<{ username: string; mcpKeysRevoked: number }> | FlowError> {
  const problem = passwordProblem(password);
  if (problem) return fail(400, problem);
  if (!TOKEN.test(raw)) return fail(400, "invalid_or_expired");
  const unpaid = powGate("reset", ip, pow);
  if (unpaid) return unpaid;
  const hash = hashToken(raw);
  const blocked = limited(consumeLimits([LIMITS.resetIp(ip), LIMITS.resetToken(hash)]));
  if (blocked) return blocked;
  // Read-only first: hash the new password only for a real, live token.
  if (!readStore().accounts.some((candidate) => live(candidate.resetToken, hash) && candidate.status === "active")) return fail(400, "invalid_or_expired");
  let passwordHash: string;
  try {
    passwordHash = await hashPasswordAsync(password);
  } catch (error) {
    return busy(error);
  }
  const account = mutateStore((store) => {
    const target = store.accounts.find((candidate) => live(candidate.resetToken, hash) && candidate.status === "active");
    if (!target) return null;
    delete target.resetToken;
    target.passwordHash = passwordHash;
    return target;
  });
  if (!account) return fail(400, "invalid_or_expired");
  // Whoever had the password may have left credentials behind: every session and every MCP key ends (audit M2).
  revokeAllSessions(account.id);
  const mcpKeysRevoked = revokeAllMcpKeys(account.id);
  if (account.email) sendMail(account.email, passwordChangedMail(account.id, mcpKeysRevoked));
  return { ok: true, username: account.id, mcpKeysRevoked };
}

/* ----------------------------------------------------------------------------- signed-in account changes */

/** Wrong current passwords count against a per-account bucket (the session is already authenticated). */
async function confirmPassword(account: Account, password: string): Promise<FlowError | null> {
  const bucket = [LIMITS.sensitive(account.id)];
  const blocked = limited(checkLimits(bucket));
  if (blocked) return blocked;
  try {
    if (await verifyPasswordAsync(password, account.passwordHash)) return null;
  } catch (error) {
    return busy(error);
  }
  hitLimits(bucket);
  return fail(403, "wrong_password");
}

export async function changePassword(account: Account, current: string, next: string): Promise<FlowOk<{ account: Account; revoked: number; mcpKeysRevoked: number }> | FlowError> {
  const problem = passwordProblem(next);
  if (problem) return fail(400, problem);
  const wrong = await confirmPassword(account, current);
  if (wrong) return wrong;
  let passwordHash: string;
  try {
    passwordHash = await hashPasswordAsync(next);
  } catch (error) {
    return busy(error);
  }
  const updated = mutateStore((store) => {
    const target = store.accounts.find((candidate) => candidate.id === account.id);
    if (!target) return null;
    target.passwordHash = passwordHash;
    delete target.resetToken;
    return target;
  });
  if (!updated) return fail(404, "not_found");
  const revoked = revokeAllSessions(updated.id);
  // A password change is what a user does after noticing a takeover: MCP keys an intruder made go too (audit M2).
  const mcpKeysRevoked = revokeAllMcpKeys(updated.id);
  if (updated.email) sendMail(updated.email, passwordChangedMail(updated.id, mcpKeysRevoked));
  return { ok: true, account: updated, revoked, mcpKeysRevoked };
}

export async function changeEmail(account: Account, password: string, emailInput: string): Promise<FlowOk<{ message: string }> | FlowError> {
  const email = validateEmail(emailInput);
  if (!email) return fail(400, "That does not look like an email address.");
  if (email === account.email) return fail(400, "That is already your address.");
  // Email policy (signed-in caller, so the DNS part needs no proof-of-work): before the password check and the mail.
  if (!(await checkEmailPolicy(email)).ok) return fail(400, EMAIL_POLICY_MESSAGE);
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
