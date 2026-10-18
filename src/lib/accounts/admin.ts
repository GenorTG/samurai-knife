import { mutateStore, readStore, type AccountRole } from "@/lib/accounts/store";
import { accountStorageBytes } from "@/lib/accounts/data";
import { revokeAllSessions, sessionCount } from "@/lib/accounts/session";
import { issueVerification, isLastAdmin, purgeAccount } from "@/lib/accounts/flows";
import { sendMail } from "@/lib/mail";
import { accountDeletedMail } from "@/lib/mail/templates";
import { normalizeBaseUrl } from "@/lib/accounts/provider";

/** User management for the admin page (/account/admin, API /api/admin/users). Every caller has passed requireAdmin. */

export interface AdminUserRow {
  id: string;
  email: string | null;
  emailVerified: boolean;
  role: AccountRole;
  status: "pending" | "active" | "disabled";
  createdAt: string;
  lastLoginAt: string | null;
  hasPassword: boolean;
  storageBytes: number;
  storageQuotaBytes: number | null;
  sessions: number;
  /** Provider requests may reach private addresses (public mode, honoured for admins only). */
  privateNetwork: boolean;
  /** Public mode: the custom provider base URL an admin approved for this account (null = known providers only). */
  approvedProviderUrl: string | null;
  /** Public mode: a website an admin approved this account to audit without GitHub verification (null = none). */
  approvedSiteUrl: string | null;
}

export function listUsers(): AdminUserRow[] {
  return readStore().accounts.map((account) => ({
    id: account.id,
    email: account.email,
    emailVerified: account.emailVerifiedAt !== null,
    role: account.role,
    status: account.status,
    createdAt: account.createdAt,
    lastLoginAt: account.lastLoginAt,
    hasPassword: Boolean(account.passwordHash),
    storageBytes: accountStorageBytes(account.id),
    storageQuotaBytes: account.storageQuotaBytes,
    sessions: sessionCount(account.id),
    privateNetwork: account.privateNetwork,
    approvedProviderUrl: account.approvedProviderUrl,
    approvedSiteUrl: account.approvedSiteUrl,
  }));
}

export type AdminAction =
  | { action: "disable" }
  | { action: "enable" }
  | { action: "delete" }
  | { action: "quota"; bytes: number | null }
  | { action: "role"; role: AccountRole }
  | { action: "resend-verification" }
  | { action: "network"; privateNetwork: boolean }
  | { action: "provider-url"; baseUrl: string | null }
  | { action: "site-url"; url: string | null };

export type AdminResult = { ok: true; detail?: string; removed?: string[] } | { ok: false; status: number; error: string };

export function adminAct(actorId: string, targetId: string, body: AdminAction): AdminResult {
  const store = readStore();
  const target = store.accounts.find((account) => account.id === targetId);
  if (!target) return { ok: false, status: 404, error: "unknown_user" };
  const selfOrLast = (verb: string): AdminResult | null => {
    if (targetId === actorId) return { ok: false, status: 409, error: `You cannot ${verb} your own account here (use your account page).` };
    if (isLastAdmin(targetId, store)) return { ok: false, status: 409, error: `Refusing to ${verb} the only active administrator.` };
    return null;
  };
  switch (body.action) {
    case "disable": {
      const refused = selfOrLast("disable");
      if (refused) return refused;
      mutateStore((s) => {
        const account = s.accounts.find((a) => a.id === targetId);
        if (account) account.status = "disabled";
      });
      return { ok: true, detail: `${revokeAllSessions(targetId)} session(s) ended` };
    }
    case "enable":
      mutateStore((s) => {
        const account = s.accounts.find((a) => a.id === targetId);
        if (account && account.status === "disabled") account.status = account.emailVerifiedAt === null && account.email ? "pending" : "active";
      });
      return { ok: true };
    case "delete": {
      const refused = selfOrLast("delete");
      if (refused) return refused;
      const result = purgeAccount(targetId);
      if (!result) return { ok: false, status: 404, error: "unknown_user" };
      if (result.email) sendMail(result.email, accountDeletedMail(targetId));
      return { ok: true, removed: result.removed };
    }
    case "quota":
      mutateStore((s) => {
        const account = s.accounts.find((a) => a.id === targetId);
        if (account) account.storageQuotaBytes = body.bytes;
      });
      return { ok: true };
    case "role": {
      if (body.role !== "admin") {
        const refused = selfOrLast("demote");
        if (refused) return refused;
      }
      mutateStore((s) => {
        const account = s.accounts.find((a) => a.id === targetId);
        if (account) account.role = body.role;
      });
      return { ok: true };
    }
    case "network":
      if (body.privateNetwork && target.role !== "admin") return { ok: false, status: 409, error: "Only an administrator's provider may reach private addresses." };
      mutateStore((s) => {
        const account = s.accounts.find((a) => a.id === targetId);
        if (account) account.privateNetwork = body.privateNetwork;
      });
      return { ok: true };
    case "provider-url": {
      const url = body.baseUrl === null ? null : normalizeBaseUrl(body.baseUrl);
      if (body.baseUrl !== null && !url) return { ok: false, status: 400, error: "baseUrl must be an http(s) URL without credentials, query or fragment." };
      mutateStore((s) => {
        const account = s.accounts.find((a) => a.id === targetId);
        if (account) account.approvedProviderUrl = url;
      });
      return { ok: true, detail: url ? `${targetId} may use ${url}` : `${targetId} may use the known providers only` };
    }
    case "site-url": {
      const url = body.url === null ? null : siteOrigin(body.url);
      if (body.url !== null && !url) return { ok: false, status: 400, error: "url must be an http(s) URL without credentials." };
      mutateStore((s) => {
        const account = s.accounts.find((a) => a.id === targetId);
        if (account) account.approvedSiteUrl = url;
      });
      return { ok: true, detail: url ? `${targetId} may audit ${url}` : `${targetId} may audit GitHub-verified sites only` };
    }
    case "resend-verification":
      return issueVerification((account) => account.id === targetId)
        ? { ok: true, detail: "A new confirmation link was sent." }
        : { ok: false, status: 409, error: "This account has no unconfirmed address." };
  }
}

/** An approved site is stored as its origin; null when not an http(s) URL without credentials. */
function siteOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}
