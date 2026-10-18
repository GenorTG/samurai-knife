import { isPublicMode } from "@/lib/accounts/mode";
import { consumeLimits, LIMITS } from "@/lib/accounts/rate-limit";
import { RESERVED } from "@/lib/accounts/flows";
import { checkEmailPolicySync, EMAIL_POLICY_MESSAGE } from "@/lib/accounts/email-policy";
import { ACCOUNT_ID_PATTERN, DEFAULT_USER_QUOTA_BYTES, getAccount, mutateStore, newAccountRecord, readStore, type Account } from "@/lib/accounts/store";
import type { GithubIdentity } from "./oauth";

/**
 * Accounts and GitHub identities (docs/GITHUB.md). One account per GitHub user id (the stable id, not the login, which
 * can be renamed). Signing in with GitHub never takes over an existing account by email: an account that already has
 * the address must sign in with its password and link GitHub from Account settings.
 */

export function findByGithub(githubId: number): Account | null {
  return readStore().accounts.find((a) => a.github?.id === githubId) ?? null;
}

export type LinkResult = { ok: true } | { ok: false; code: "github_taken" | "unknown_account"; message: string };

export function linkGithub(accountId: string, who: GithubIdentity): LinkResult {
  return mutateStore((store): LinkResult => {
    const other = store.accounts.find((a) => a.github?.id === who.id && a.id !== accountId);
    if (other) return { ok: false, code: "github_taken", message: `GitHub user @${who.login} is already linked to another account.` };
    const account = store.accounts.find((a) => a.id === accountId);
    if (!account) return { ok: false, code: "unknown_account", message: "unknown account" };
    account.github = { id: who.id, login: who.login, linkedAt: new Date().toISOString() };
    return { ok: true };
  });
}

export type UnlinkResult = { ok: true } | { ok: false; message: string };

export function unlinkGithub(accountId: string): UnlinkResult {
  return mutateStore((store): UnlinkResult => {
    const account = store.accounts.find((a) => a.id === accountId);
    if (!account?.github) return { ok: false, message: "No GitHub account is linked." };
    // A GitHub-only account would lock itself out: a password (via "Forgot password") comes first.
    if (isPublicMode() && !account.passwordHash) return { ok: false, message: "This account signs in only with GitHub. Set a password first (Log in → Forgot your password?), then unlink." };
    account.github = null;
    return { ok: true };
  });
}

/** A free username from a GitHub login: lower case, allowed characters only, not reserved, -2, -3... on collisions. */
export function usernameFor(login: string, taken: (id: string) => boolean): string {
  let base = login.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 28) || "user";
  if (!ACCOUNT_ID_PATTERN.test(base)) base = `gh-${base}`.slice(0, 28);
  for (let n = 1; n < 1000; n += 1) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!RESERVED.has(candidate) && !taken(candidate) && ACCOUNT_ID_PATTERN.test(candidate)) return candidate;
  }
  throw new Error("no free username");
}

export type GithubSignIn =
  | { kind: "login"; account: Account }
  | { kind: "registered"; account: Account }
  | { kind: "refused"; code: "disabled" | "email_in_use" | "no_email" | "registration_closed" | "rate_limited" | "email_refused"; message: string };

/**
 * Sign-in or registration with a GitHub identity (public mode). A registration's verified address meets the email policy
 * (static rules, owner lists, disposable domains; email-policy.ts `checkEmailPolicySync`). The DNS part is skipped: GitHub
 * has just delivered a verification mail to that mailbox, and the mail queue re-checks the domain before every send.
 */
export function signInWithGithub(who: GithubIdentity, ip: string, allowRegister: boolean): GithubSignIn {
  const linked = findByGithub(who.id);
  if (linked) {
    if (linked.status === "disabled") return { kind: "refused", code: "disabled", message: "This account is disabled. Contact the administrator." };
    mutateStore((store) => {
      const a = store.accounts.find((x) => x.id === linked.id);
      if (a) {
        a.lastLoginAt = new Date().toISOString();
        if (a.github) a.github.login = who.login; // renamed on GitHub: keep the display current
        // A pending account (registered with a password, never confirmed) is confirmed by a GitHub-verified address.
        if (a.status === "pending" && who.verifiedEmail && a.email === who.verifiedEmail) {
          a.status = "active";
          a.emailVerifiedAt = new Date().toISOString();
        }
      }
    });
    const fresh = getAccount(linked.id)!;
    if (fresh.status === "pending") return { kind: "refused", code: "disabled", message: "Confirm your email address first (the link we sent you)." };
    return { kind: "login", account: fresh };
  }
  if (!allowRegister || !isPublicMode()) return { kind: "refused", code: "registration_closed", message: "No account is linked to this GitHub user. Sign in with your password and link GitHub in Account settings." };
  if (!who.verifiedEmail) return { kind: "refused", code: "no_email", message: "GitHub has no verified primary email for this user: verify one on GitHub (Settings → Emails), then try again." };
  if (!checkEmailPolicySync(who.verifiedEmail).ok) return { kind: "refused", code: "email_refused", message: EMAIL_POLICY_MESSAGE };
  const blocked = consumeLimits([LIMITS.registerIp(ip), LIMITS.registerEmail(who.verifiedEmail)]);
  if (!blocked.ok) return { kind: "refused", code: "rate_limited", message: `Too many sign-ups from here; try again in ${blocked.retryAfterSeconds} s.` };
  const result = mutateStore((store): GithubSignIn => {
    const email = who.verifiedEmail!;
    // GitHub has verified this address; claims nobody proved give way (audit M3: a squatter's pending sign-up, or another
    // account's unconfirmed address change, must not block the address owner forever).
    store.accounts = store.accounts.filter((a) => !(a.email === email && a.status === "pending" && a.emailVerifiedAt === null && a.github === null));
    if (store.accounts.length > 0 && !store.accounts.some((a) => a.id === store.defaultAccountId)) store.defaultAccountId = store.accounts[0].id;
    for (const a of store.accounts) if (a.emailChange?.email === email) delete a.emailChange;
    if (store.accounts.some((a) => a.email === email)) {
      return { kind: "refused", code: "email_in_use", message: `An account with ${email} already exists. Sign in with its password, then link GitHub in Account settings.` };
    }
    const id = usernameFor(who.login, (candidate) => store.accounts.some((a) => a.id === candidate));
    const now = new Date().toISOString();
    const account = newAccountRecord({
      id,
      displayName: (who.name || who.login).slice(0, 80),
      email,
      emailVerifiedAt: now,
      role: "user",
      status: "active",
      storageQuotaBytes: DEFAULT_USER_QUOTA_BYTES,
      lastLoginAt: now,
      github: { id: who.id, login: who.login, linkedAt: now },
    });
    store.accounts.push(account);
    if (store.accounts.length === 1) store.defaultAccountId = id;
    return { kind: "registered", account };
  });
  return result;
}
