// SERVER ONLY. Who may send outbound requests where, and how often (docs/ARCHITECTURE.md "Outbound requests").
import { isPublicMode } from "@/lib/accounts/mode";
import { consumeLimits, LIMITS, type LimitCheck } from "@/lib/accounts/rate-limit";
import type { ProviderNet } from "@/lib/accounts/provider";
import type { Account } from "@/lib/accounts/store";
import type { OutboundPolicy } from "./safe-fetch";

export type OutboundPurpose = "provider" | "provider-test" | "page";

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

/**
 * Per-account budget for outbound requests (public mode, non-admins; in memory, `rate-limit.ts`). Counts every attempt,
 * so a refused or failing target costs the same as a good one: the server is not a free crawler or port scanner.
 */
export function consumeOutbound(account: Pick<Account, "id" | "role">, purpose: OutboundPurpose): LimitCheck {
  if (!isPublicMode() || account.role === "admin") return { ok: true };
  const limit = purpose === "provider" ? LIMITS.outboundProvider(account.id) : purpose === "provider-test" ? LIMITS.outboundProviderTest(account.id) : LIMITS.outboundPage(account.id);
  return consumeLimits([limit]);
}

export function outboundLimitMessage(retryAfterSeconds: number): string {
  return `Too many outbound requests from this account; try again in ${retryAfterSeconds} s.`;
}
