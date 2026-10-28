// SERVER ONLY. Who may send outbound requests where, and how often (docs/ARCHITECTURE.md "Outbound requests").
import { msgf } from "@/lib/i18n/msg";
import { isPublicMode } from "@/lib/accounts/mode";
import { checkLimits, hitLimits, LIMITS, type Limit, type LimitCheck } from "@/lib/accounts/rate-limit";
import type { ProviderNet } from "@/lib/accounts/provider";
import type { Account } from "@/lib/accounts/store";
import { recordSecurityEvent } from "@/lib/security/events";
import { parseBudgetOverrides, takeBudget, type Budget } from "./budgets";
import type { OutboundPolicy } from "./safe-fetch";

/**
 * Every request the server sends on a user's behalf is admitted here first. Threat: the server as a free crawler, a
 * stolen-API-key checker or a flood source against one third party, multiplied by cheap accounts. Three budgets, all for
 * NON-ADMINS in PUBLIC mode (private mode and admins are the owner, never refused here): per account (`rate-limit.ts`
 * LIMITS), per purpose across all accounts, and per USER-CHOSEN destination host across all accounts (pages, companies,
 * audited sites, an admin-approved custom provider URL). The fixed services (allow-listed model providers, the GitHub
 * API, PageSpeed) have no host bucket: their purpose budget is the cap, and a shared host bucket there would let one bot
 * account cut everyone off. The shared buckets are fair-share (budgets.ts). Server-held credentials (the PageSpeed key,
 * the host's `gh` login) are spent for admins only; everyone else brings their own key or token.
 */

export type OutboundPurpose =
  /** A model round of the assistant (the account's own provider and key). */
  | "provider"
  /** Provider "Test" (GET /models with the account's key). */
  | "provider-test"
  /** One user-named web page: a job posting, `knife_site_page`. */
  | "page"
  /** A company website read as tailoring context. */
  | "company"
  /** One website audit run (its pages are counted per host as they are fetched). */
  | "audit"
  /** One PageSpeed Insights call (an audit makes two). */
  | "psi"
  /** One website-studio operation against the GitHub API with the account's own token or installation. */
  | "github"
  /** One website-studio operation against the Vercel API with the account's own token. */
  | "vercel";

export const OUTBOUND_PURPOSES: readonly OutboundPurpose[] = ["provider", "provider-test", "page", "company", "audit", "psi", "github", "vercel"];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Server-wide defaults (all non-admin accounts together); `KNIFE_OUTBOUND_BUDGETS` overrides any of them, and `host`. */
export const DEFAULT_BUDGETS: Record<OutboundPurpose | "host", Budget> = {
  provider: { max: 3_000, windowMs: 10 * MINUTE },
  "provider-test": { max: 200, windowMs: HOUR },
  page: { max: 1_000, windowMs: HOUR },
  company: { max: 500, windowMs: HOUR },
  audit: { max: 100, windowMs: HOUR },
  psi: { max: 400, windowMs: HOUR },
  github: { max: 10_000, windowMs: HOUR },
  vercel: { max: 5_000, windowMs: HOUR },
  /** One destination host, across all non-admins: user-chosen pages, audited sites, admin-approved provider URLs. */
  host: { max: 60, windowMs: 10 * MINUTE },
};

export function budgetFor(name: OutboundPurpose | "host"): Budget {
  return parseBudgetOverrides(process.env.KNIFE_OUTBOUND_BUDGETS)[name] ?? DEFAULT_BUDGETS[name];
}

function accountLimit(account: Pick<Account, "id">, purpose: OutboundPurpose): Limit | null {
  switch (purpose) {
    case "provider":
      return LIMITS.outboundProvider(account.id);
    case "provider-test":
      return LIMITS.outboundProviderTest(account.id);
    case "audit":
      return LIMITS.outboundAudit(account.id);
    case "github":
    case "vercel":
      return LIMITS.outboundGithub(account.id);
    case "page":
    case "company":
      return LIMITS.outboundPage(account.id);
    case "psi":
      return null; // part of an audit, which the account already paid for
  }
}

/** Budgets apply to non-admins in public mode only. */
export function outboundBudgeted(account: Pick<Account, "role">): boolean {
  return isPublicMode() && account.role !== "admin";
}

export function hostOf(destination: string | URL): string | null {
  try {
    const host = (typeof destination === "string" ? new URL(destination) : destination).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    return host || null;
  } catch {
    return null;
  }
}

export type OutboundVerdict = LimitCheck & { reason?: "account" | "purpose" | "host" };

function refuse(account: Pick<Account, "id">, purpose: OutboundPurpose, reason: "account" | "purpose" | "host", retryAfterSeconds: number, host?: string | null): OutboundVerdict {
  recordSecurityEvent({ kind: "outbound_budget", account: account.id, detail: { purpose, reason, ...(host ? { host } : {}), retryAfterSeconds } });
  return { ok: false, retryAfterSeconds, reason };
}

/**
 * Does `host` get a destination bucket for this purpose? Only hosts a user picked: GitHub and PageSpeed calls go to the
 * fixed service, and a provider round to an allow-listed provider is the account's own key at a big API (its cap is the
 * purpose budget); a custom provider URL (admin-approved) is a user-chosen host like any page.
 */
export function userChosenHost(purpose: OutboundPurpose, host: string): boolean {
  switch (purpose) {
    case "github":
    case "vercel":
    case "psi":
      return false;
    case "provider":
    case "provider-test":
      return !isKnownProviderHost(host);
    case "page":
    case "company":
    case "audit":
      return true;
  }
}

/**
 * Admit one outbound operation (and count it): the account's own limit, the purpose's server-wide budget and, when
 * the `destination` is user-chosen (userChosenHost), that host's budget. A refused attempt costs nothing; an admitted
 * one is counted even when the target then fails, so a refused or failing target costs the same as a good one.
 */
export function admitOutbound(account: Pick<Account, "id" | "role">, purpose: OutboundPurpose, destination?: string | URL | null): OutboundVerdict {
  if (!outboundBudgeted(account)) return { ok: true };
  const limit = accountLimit(account, purpose);
  if (limit) {
    const own = checkLimits([limit]);
    if (!own.ok) return refuse(account, purpose, "account", own.retryAfterSeconds);
  }
  const host = destination ? hostOf(destination) : null;
  const hostBucket = host !== null && userChosenHost(purpose, host);
  const verdict = takeBudget({
    account: account.id,
    purpose: { key: purpose, budget: budgetFor(purpose) },
    ...(hostBucket && host ? { host: { key: host, budget: budgetFor("host") } } : {}),
  });
  if (!verdict.ok) return refuse(account, purpose, verdict.key.startsWith("purpose:") ? "purpose" : "host", verdict.retryAfterSeconds, hostBucket ? host : null);
  if (limit) hitLimits([limit]);
  return { ok: true };
}

/** Kept for callers without a destination (GitHub API operations): the account and purpose budgets. */
export function consumeOutbound(account: Pick<Account, "id" | "role">, purpose: OutboundPurpose, destination?: string | URL | null): LimitCheck {
  return admitOutbound(account, purpose, destination);
}

export class OutboundRefused extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super(outboundLimitMessage(retryAfterSeconds));
    this.name = "OutboundRefused";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Per-request host check for one admitted operation that may touch several URLs (pages, redirects, robots/sitemap,
 * a board's API): every network request is counted, including repeated requests to the same host. The operation's
 * first host is usually already counted by admitOutbound (pass it as `counted`). Throws OutboundRefused when over budget.
 */
export function hostGate(account: Pick<Account, "id" | "role">, purpose: OutboundPurpose, counted?: string | URL | null): (url: URL) => void {
  if (!outboundBudgeted(account)) return () => undefined;
  const first = counted ? hostOf(counted) : null;
  let skippedInitial = false;
  return (url: URL) => {
    const host = hostOf(url);
    if (!host) return;
    if (!skippedInitial && first && host === first) {
      skippedInitial = true;
      return;
    }
    const verdict = takeBudget({ account: account.id, host: { key: host, budget: budgetFor("host") } });
    if (!verdict.ok) {
      refuse(account, purpose, "host", verdict.retryAfterSeconds, host);
      throw new OutboundRefused(verdict.retryAfterSeconds);
    }
  };
}

/* --------------------------------------------------------------------------------------------- providers */

/** Known LLM API hosts a non-admin may use in public mode (`KNIFE_PROVIDER_HOSTS` replaces the list; `*.` = subdomains). */
export const DEFAULT_PROVIDER_HOSTS = [
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "openrouter.ai",
  "api.mistral.ai",
  "api.groq.com",
  "api.deepseek.com",
  "api.together.xyz",
  "api.fireworks.ai",
  "api.x.ai",
  "api.cerebras.ai",
  "api.perplexity.ai",
  "*.openai.azure.com",
];

export function providerHosts(): string[] {
  const raw = process.env.KNIFE_PROVIDER_HOSTS;
  if (raw === undefined || !raw.trim()) return DEFAULT_PROVIDER_HOSTS;
  return raw.split(",").map((h) => h.trim().toLowerCase()).filter((h) => /^(\*\.)?[a-z0-9.-]+$/.test(h));
}

export function isKnownProviderHost(host: string): boolean {
  const h = host.toLowerCase();
  return providerHosts().some((entry) => (entry.startsWith("*.") ? h.endsWith(entry.slice(1)) && h.length > entry.length - 1 : h === entry));
}

/**
 * Public mode, non-admins: the provider base URL must be on a known provider host, or exactly the base URL an admin
 * approved for this account (`approvedProviderUrl`: CLI `approve-provider`, admin API). null = allowed.
 */
export function providerUrlProblem(account: Pick<Account, "role"> & { approvedProviderUrl?: string | null }, baseUrl: string): string | null {
  if (!outboundBudgeted(account)) return null;
  const host = hostOf(baseUrl);
  if (!host) return "baseUrl is not a valid URL.";
  if (isKnownProviderHost(host)) return null;
  if (account.approvedProviderUrl && account.approvedProviderUrl === baseUrl) return null;
  return msgf("{host} is not one of this server's known model providers; ask an administrator to approve this base URL for your account.", { host });
}

/** A provider round or Test: allow-list first, then purpose and destination-host budgets. */
export function admitProvider(account: Pick<Account, "id" | "role"> & { approvedProviderUrl?: string | null }, purpose: "provider" | "provider-test", baseUrl: string): OutboundVerdict & { problem?: string } {
  const problem = providerUrlProblem(account, baseUrl);
  if (problem) {
    recordSecurityEvent({ kind: "outbound_refused", account: account.id, detail: { purpose, host: hostOf(baseUrl) ?? "" } });
    return { ok: false, retryAfterSeconds: 0, problem };
  }
  return admitOutbound(account, purpose, baseUrl);
}

/**
 * Provider requests (chat, Test) go to the account's own base URL. Private mode: the owner's toolbox, any address (LM
 * Studio, the OpenClaw gateway on loopback). Public mode: public addresses only and https only; an ADMIN account with
 * `privateNetwork` (CLI `set-network <id> private` or the admin API) may reach loopback/LAN/Tailscale again (the owner's
 * local models). Every request is still resolved once and pinned (no DNS rebinding) and never follows redirects.
 */
export function providerPolicy(account: Pick<Account, "role" | "privateNetwork">): OutboundPolicy {
  if (!isPublicMode()) return { allowPrivate: true, ports: null, httpsOnly: false };
  const admin = account.role === "admin";
  return { allowPrivate: admin && account.privateNetwork, ports: null, httpsOnly: !admin };
}

/** Raw upstream error bodies may be shown only where the address is the owner's own choice (private mode, admins). */
export function mayEchoUpstream(account: Pick<Account, "role">): boolean {
  return !isPublicMode() || account.role === "admin";
}

export function providerNet(account: Pick<Account, "role" | "privateNetwork">): ProviderNet {
  return { policy: providerPolicy(account), echoUpstream: mayEchoUpstream(account) };
}

/** Public mode: the stricter extra-header rules (no proxy/client-address/hop-by-hop headers) for non-admins. */
export function strictHeaders(account: Pick<Account, "role">): boolean {
  return isPublicMode() && account.role !== "admin";
}

/* ------------------------------------------------------------------------------- server-held credentials */

/**
 * The server's own PageSpeed key (`KNIFE_PSI_API_KEY`) is the admin's: an admin audit may fall back to it; everyone
 * else uses the key saved with their own connection (Connect) or runs without Lighthouse. "" = no key to use.
 */
export function pageSpeedKey(account: Pick<Account, "role">, ownKey: string): { key: string; source: "account" | "server" | "none" } {
  if (ownKey) return { key: ownKey, source: "account" };
  if (!isPublicMode() || account.role === "admin") {
    const server = process.env.KNIFE_PSI_API_KEY?.trim() ?? "";
    if (server) return { key: server, source: "server" };
    return { key: "", source: "none" };
  }
  return { key: "", source: "none" };
}

/** Anonymous PageSpeed calls share the server's address quota: in public mode only admins may make them. */
export function mayUseAnonymousPageSpeed(account: Pick<Account, "role">): boolean {
  return !isPublicMode() || account.role === "admin";
}

export function outboundLimitMessage(retryAfterSeconds: number): string {
  return msgf("Too many outbound requests from this account (or to this destination); try again in {retryAfterSeconds} s.", { retryAfterSeconds });
}
