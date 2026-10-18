import { domainToASCII } from "node:url";

/**
 * Email address parsing and the canonical mailbox key (docs/ACCOUNTS.md "Email address policy"). Pure, no I/O, no lists:
 * imported by the rate limits and the pending-account caps as well as by the full policy (email-policy.ts).
 * Threat model: `victim+1@gmail.com`, `v.ictim@googlemail.com` and `VICTIM@gmail.com` are one mailbox; every budget and
 * limit keyed on an address must key on `canonicalEmailKey`, or each variant gets a fresh bucket (audit abuse #5a). The
 * address itself is stored as typed; the key is only for counting.
 */

const csv = (value: string | undefined): string[] => (value ?? "").split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);

/** Providers that ignore dots in the local part (googlemail is folded into gmail first). */
const DOTLESS_DOMAINS = new Set(["gmail.com"]);
const DOMAIN_ALIASES: Record<string, string> = { "googlemail.com": "gmail.com" };
/** Providers where `base-keyword@` is an alias of `base@` (Yahoo disposable addresses). KNIFE_EMAIL_DASH_TAG_DOMAINS replaces it. */
const DEFAULT_DASH_TAG_DOMAINS = ["yahoo.com", "ymail.com", "rocketmail.com"];

/**
 * Big webmail providers (KNIFE_MAIL_BIG_DOMAINS adds more): their own per-domain mail budget, and no per-domain cap on
 * pending sign-ups (a few dozen fake sign-ups must never block every gmail.com registration).
 */
export const BIG_PROVIDERS: ReadonlySet<string> = new Set([
  "gmail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com", "aol.com", "icloud.com",
  "me.com", "mac.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net", "gmx.de", "web.de", "wp.pl", "o2.pl",
  "onet.pl", "op.pl", "interia.pl", "poczta.fm", "tlen.pl", "yandex.com", "zoho.com",
]);

export function isBigProvider(domain: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const folded = DOMAIN_ALIASES[domain] ?? domain;
  return BIG_PROVIDERS.has(folded) || csv(env.KNIFE_MAIL_BIG_DOMAINS).includes(folded);
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** Lowercased, trimmed, IDN -> punycode, trailing dot removed; null when the domain cannot be a host name. */
export function asciiDomain(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!trimmed || trimmed.length > 253) return null;
  if (trimmed.startsWith("[")) return trimmed; // address literal: reported as ip_literal by the static checks
  const ascii = domainToASCII(trimmed);
  if (!ascii || ascii.length > 253) return null;
  return ascii.split(".").every((label) => LABEL.test(label)) ? ascii : null;
}

/** Splits at the LAST `@`; null when either side is empty or the domain is not a host name. */
export function splitAddress(raw: string): { local: string; domain: string } | null {
  const value = raw.trim();
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) return null;
  const local = value.slice(0, at).normalize("NFC").toLowerCase();
  const domain = asciiDomain(value.slice(at + 1));
  if (!domain || local.length > 64 || /[\s@<>()[\]\\,;:"]/.test(local)) return null;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  return { local, domain };
}

/**
 * The mailbox key used for every per-mailbox budget, flow limit and the suppression list: `Vic.Tim+x@GoogleMail.com` ->
 * `victim@gmail.com`. Over-merging only makes a budget stricter, so `+` is cut for every provider. Null = not an address.
 */
export function canonicalEmailKey(raw: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const parts = splitAddress(raw);
  if (!parts) return null;
  const domain = DOMAIN_ALIASES[parts.domain] ?? parts.domain;
  let local = parts.local.split("+")[0];
  const dashDomains = env.KNIFE_EMAIL_DASH_TAG_DOMAINS === undefined ? DEFAULT_DASH_TAG_DOMAINS : csv(env.KNIFE_EMAIL_DASH_TAG_DOMAINS);
  if (dashDomains.includes(domain)) local = local.split("-")[0];
  if (DOTLESS_DOMAINS.has(domain)) local = local.replace(/\./g, "");
  if (!local) return null;
  return `${local}@${domain}`;
}

/** Key for a per-address limit: the canonical mailbox, else the lowercased input (never lets a variant escape a bucket). */
export function emailLimitKey(raw: string): string {
  return canonicalEmailKey(raw) ?? raw.trim().toLowerCase();
}

/** Canonical domain of an address (googlemail -> gmail), or "" when it is not an address. */
export function canonicalDomain(raw: string | null | undefined): string {
  const key = raw ? canonicalEmailKey(raw) : null;
  return key ? key.slice(key.lastIndexOf("@") + 1) : "";
}

/** The domain itself and every parent with at least two labels: a.b.mailinator.com -> [a.b.mailinator.com, b.mailinator.com, mailinator.com]. */
export function domainAndParents(domain: string): string[] {
  const labels = domain.split(".");
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i += 1) out.push(labels.slice(i).join("."));
  return out;
}
