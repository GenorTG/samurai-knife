import { statSync, readFileSync } from "node:fs";
import { msg } from "@/lib/i18n/msg";
import { Resolver } from "node:dns/promises";
import { join } from "node:path";
import { dataDir } from "@/lib/accounts/store";
import { isPublicMode } from "@/lib/accounts/mode";
import { blockedAddressReason, isIpAddress, parseIPv4 } from "@/lib/net/address-policy";
import { DISPOSABLE_SNAPSHOT } from "@/lib/accounts/email-lists/disposable-snapshot";
import { asciiDomain, canonicalEmailKey, domainAndParents, splitAddress } from "@/lib/accounts/email-address";

/**
 * Email address policy: which addresses may own an account and receive mail (docs/ACCOUNTS.md "Email address policy").
 * Threat model: open registration lets anyone make the server mail any address. Disposable inboxes make verified accounts
 * free, made-up/null-MX/internal domains bounce and burn the mail server's reputation, and `+tag`/dot variants of one
 * mailbox would each get their own budget. So: one canonical key per mailbox (for budgets only; the address is stored as
 * typed), static rejects, a disposable-domain blocklist (domain and every parent), owner allow/deny files that win, and a
 * resolver-only DNS check with a bounded cache. A DNS failure accepts but flags `mailRisk` (strict budget in the mail
 * layer). The answer depends only on the address itself, never on whether an account uses it.
 *
 * Lists live in `$KNIFE_DATA_DIR/email-policy/`: `disposable.txt` (written by `npm run email-lists -- update`, else the
 * vendored CC0 snapshot), `allow.txt` and `deny.txt` (owner-maintained: domains, or full addresses in deny). Reloaded when
 * a file's mtime/size changes (checked at most every few seconds).
 */

/** What the routes answer for every refused address: it says nothing about accounts. */
export const EMAIL_POLICY_MESSAGE = msg("We can't send mail to that address.");

export type EmailRejectReason =
  | "syntax"
  | "reserved_local"
  | "ip_literal"
  | "single_label"
  | "reserved_tld"
  | "own_domain"
  | "disposable"
  | "denied"
  | "no_domain"
  | "no_mail"
  | "null_mx"
  | "private_mx";

export type EmailPolicyResult =
  | { ok: true; email: string; canonical: string; domain: string; mailRisk: boolean }
  | { ok: false; reason: EmailRejectReason; domain: string | null };

/** `enforce` (default in public mode) or `off` (default in private mode: the owner types the addresses). */
export function emailPolicyEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.KNIFE_EMAIL_POLICY?.trim().toLowerCase();
  if (value === "off") return false;
  if (value === "enforce") return true;
  return isPublicMode(env);
}

/** `KNIFE_EMAIL_DNS=off` skips the MX check (air-gapped hosts, the e2e suites' example.com addresses). Default on. */
function dnsCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KNIFE_EMAIL_DNS?.trim().toLowerCase() !== "off";
}

export { asciiDomain, BIG_PROVIDERS, canonicalEmailKey, domainAndParents, isBigProvider, splitAddress } from "@/lib/accounts/email-address";

const csv = (value: string | undefined): string[] => (value ?? "").split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);

/* ---------------------------------------------------------------------------------------- static rules */

/** Special-use and never-delegated TLDs (RFC 2606, 6761, 6762, 7686, 9476, and common private ones). */
const RESERVED_TLDS = new Set(["invalid", "test", "example", "localhost", "local", "internal", "onion", "alt", "arpa", "lan", "home", "corp", "localdomain", "intranet", "private"]);

/** Role/system mailboxes nobody signs up with: spam traps and mail loops, never a person. */
export const RESERVED_LOCAL_PARTS: ReadonlySet<string> = new Set([
  "postmaster", "abuse", "mailer-daemon", "noreply", "no-reply", "donotreply", "do-not-reply", "nobody", "hostmaster",
  "webmaster", "root", "devnull", "null", "bounce", "bounces", "spam", "listserv", "majordomo",
]);

function hostOf(url: string | undefined): string | null {
  if (!url?.trim()) return null;
  try {
    return asciiDomain(new URL(url.trim()).hostname);
  } catch {
    return null;
  }
}

/** The app's own names (KNIFE_PUBLIC_URL, KNIFE_OFFICE_PUBLIC_URL, KNIFE_CRAFT_PUBLIC_URL, KNIFE_EMAIL_OWN_DOMAINS) and their subdomains. */
function ownDomains(env: NodeJS.ProcessEnv): string[] {
  return [hostOf(env.KNIFE_PUBLIC_URL), hostOf(env.KNIFE_OFFICE_PUBLIC_URL), hostOf(env.KNIFE_CRAFT_PUBLIC_URL), ...csv(env.KNIFE_EMAIL_OWN_DOMAINS).map(asciiDomain)]
    .filter((d): d is string => Boolean(d) && !isIpAddress(d as string));
}

function fromAddressKey(env: NodeJS.ProcessEnv): string | null {
  const from = env.KNIFE_SMTP_FROM?.trim();
  if (!from) return null;
  const match = /<([^>]+)>/.exec(from);
  return canonicalEmailKey(match ? match[1] : from, env);
}

/** Checks that need neither lists nor DNS. */
export function staticReject(raw: string, env: NodeJS.ProcessEnv = process.env): EmailRejectReason | null {
  const value = raw.trim();
  const at = value.lastIndexOf("@");
  const rawDomain = at > 0 ? value.slice(at + 1).trim().replace(/\.$/, "") : "";
  if (rawDomain.startsWith("[") || isIpAddress(rawDomain)) return "ip_literal";
  const parts = splitAddress(value);
  if (!parts) return "syntax";
  const labels = parts.domain.split(".");
  if (labels.length < 2) return "single_label";
  const tld = labels[labels.length - 1];
  if (/^\d+$/.test(tld) || parseIPv4(parts.domain)) return "ip_literal";
  if (RESERVED_TLDS.has(tld)) return "reserved_tld";
  if (RESERVED_LOCAL_PARTS.has(parts.local.split("+")[0])) return "reserved_local";
  const own = ownDomains(env);
  if (own.some((d) => parts.domain === d || parts.domain.endsWith(`.${d}`))) return "own_domain";
  const fromKey = fromAddressKey(env);
  if (fromKey && fromKey === canonicalEmailKey(value, env)) return "own_domain";
  return null;
}

/* --------------------------------------------------------------------------------------------- lists */

export interface ParsedList {
  domains: Set<string>;
  addresses: Set<string>;
  invalid: number;
}

/** One entry per line, `#` comments; domains (IDN ok), and full addresses when `addresses` is on (matched canonically). */
export function parseDomainList(text: string, options: { addresses?: boolean } = {}): ParsedList {
  const out: ParsedList = { domains: new Set(), addresses: new Set(), invalid: 0 };
  for (const line of text.split(/\r?\n/)) {
    const entry = line.replace(/#.*$/, "").trim().toLowerCase();
    if (!entry) continue;
    if (entry.includes("@")) {
      const key = options.addresses ? canonicalEmailKey(entry) : null;
      if (key) out.addresses.add(key);
      else out.invalid += 1;
      continue;
    }
    const domain = asciiDomain(entry);
    if (domain && domain.includes(".") && !isIpAddress(domain)) out.domains.add(domain);
    else out.invalid += 1;
  }
  return out;
}

/** Domains a downloaded blocklist must never contain (a poisoned or broken list would lock everybody out). */
export const NEVER_DISPOSABLE = ["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "proton.me", "wp.pl", "o2.pl", "onet.pl", "interia.pl"];
/** Domains every real disposable list contains (a truncated or unrelated download would miss them). */
export const SURELY_DISPOSABLE = ["mailinator.com", "guerrillamail.com", "10minutemail.com", "yopmail.com"];

/** Why a downloaded disposable list must not replace the current one; null = acceptable. */
export function disposableListProblem(list: ParsedList, previousCount = 0): string | null {
  if (list.domains.size < 1_000) return `only ${list.domains.size} domains`;
  if (list.domains.size > 1_000_000) return `${list.domains.size} domains is implausibly many`;
  if (list.invalid > Math.max(10, list.domains.size / 100)) return `${list.invalid} lines are not domains`;
  const bad = NEVER_DISPOSABLE.filter((d) => list.domains.has(d));
  if (bad.length > 0) return `it lists ${bad.join(", ")}`;
  const missing = SURELY_DISPOSABLE.filter((d) => !list.domains.has(d));
  if (missing.length > 0) return `it lacks ${missing.join(", ")}`;
  if (previousCount > 0 && list.domains.size < previousCount / 2) return `it shrank from ${previousCount} to ${list.domains.size} domains`;
  return null;
}

export function emailPolicyDir(): string {
  return join(dataDir(), "email-policy");
}

interface Lists {
  disposable: Set<string>;
  disposableSource: "download" | "snapshot";
  allow: ParsedList;
  deny: ParsedList;
}

interface ListState {
  dir: string;
  lists: Lists;
  signature: string;
  checkedAt: number;
}

const LIST_RECHECK_MS = 5_000;
const LIST_MAX_BYTES = 20 * 1024 * 1024;
let listState: ListState | null = null;
let snapshot: Set<string> | null = null;

function fileSignature(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "-";
  }
}

function readSmall(path: string): string {
  try {
    if (statSync(path).size > LIST_MAX_BYTES) return "";
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** The current lists, reloaded when a file changed. */
export function emailLists(now = Date.now()): Lists {
  const dir = emailPolicyDir();
  if (listState && listState.dir === dir && now - listState.checkedAt < LIST_RECHECK_MS) return listState.lists;
  const files = ["disposable.txt", "allow.txt", "deny.txt"].map((name) => join(dir, name));
  const signature = [dir, ...files.map(fileSignature)].join("|");
  if (listState && listState.signature === signature) {
    listState.checkedAt = now;
    return listState.lists;
  }
  const downloaded = parseDomainList(readSmall(files[0]));
  let disposable: Set<string>;
  let disposableSource: Lists["disposableSource"];
  if (!disposableListProblem(downloaded)) {
    disposable = downloaded.domains;
    disposableSource = "download";
  } else {
    snapshot ??= parseDomainList(DISPOSABLE_SNAPSHOT).domains;
    disposable = snapshot;
    disposableSource = "snapshot";
  }
  const lists: Lists = {
    disposable,
    disposableSource,
    allow: parseDomainList(readSmall(files[1])),
    deny: parseDomainList(readSmall(files[2]), { addresses: true }),
  };
  listState = { lists, signature, dir, checkedAt: now };
  return lists;
}

/** Owner deny > owner allow > disposable list; the most specific owner entry wins (a tie goes to deny). */
export function listReject(domain: string, canonical: string, lists: Lists = emailLists()): "disposable" | "denied" | null {
  if (lists.deny.addresses.has(canonical)) return "denied";
  const chain = domainAndParents(domain);
  for (const candidate of chain) {
    if (lists.deny.domains.has(candidate)) return "denied";
    if (lists.allow.domains.has(candidate)) return null;
  }
  return chain.some((candidate) => lists.disposable.has(candidate)) ? "disposable" : null;
}

/* ----------------------------------------------------------------------------------------------- DNS */

export interface MxRecord {
  exchange: string;
  priority: number;
}

/** The resolver calls the check needs (node:dns/promises Resolver satisfies it; tests pass a fake). */
export interface MailResolver {
  resolveMx(host: string): Promise<MxRecord[]>;
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
}

export type DomainVerdict = { status: "ok" } | { status: "risk" } | { status: "reject"; reason: "no_domain" | "no_mail" | "null_mx" | "private_mx" };

const NOT_FOUND = new Set(["ENOTFOUND", "NXDOMAIN"]);
const NO_DATA = new Set(["ENODATA", "ENONAME"]);

function errorCode(error: unknown): string {
  return typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : "";
}

type Lookup<T> = { ok: true; value: T } | { ok: false; kind: "notfound" | "nodata" | "fail" };

async function lookup<T>(fn: () => Promise<T>): Promise<Lookup<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    const code = errorCode(error);
    return { ok: false, kind: NOT_FOUND.has(code) ? "notfound" : NO_DATA.has(code) ? "nodata" : "fail" };
  }
}

/** A + AAAA of one host: public addresses found / only blocked ones / none / lookups failed. */
async function hostAddresses(resolver: MailResolver, host: string): Promise<"public" | "private" | "none" | "fail"> {
  if (isIpAddress(host)) return blockedAddressReason(host) ? "private" : "public";
  const [v4, v6] = await Promise.all([lookup(() => resolver.resolve4(host)), lookup(() => resolver.resolve6(host))]);
  const addresses = [...(v4.ok ? v4.value : []), ...(v6.ok ? v6.value : [])];
  if (addresses.some((address) => !blockedAddressReason(address))) return "public";
  if (addresses.length > 0) return "private";
  return (!v4.ok && v4.kind === "fail") || (!v6.ok && v6.kind === "fail") ? "fail" : "none";
}

const MAX_MX_HOSTS = 5;

/**
 * MX check (RFC 5321 / 7505): MX records, else the implicit MX (the domain's own A/AAAA). Rejects NXDOMAIN, no records,
 * a null MX, and mail hosts that resolve only to private/loopback/reserved addresses. Lookup failures -> `risk`.
 */
export async function checkMailDomain(domain: string, resolver: MailResolver): Promise<DomainVerdict> {
  const mx = await lookup(() => resolver.resolveMx(domain));
  if (!mx.ok) {
    if (mx.kind === "notfound") return { status: "reject", reason: "no_domain" };
    if (mx.kind === "fail") return { status: "risk" };
    const implicit = await hostAddresses(resolver, domain); // NODATA: no MX, the domain itself receives
    if (implicit === "public") return { status: "ok" };
    if (implicit === "private") return { status: "reject", reason: "private_mx" };
    return implicit === "fail" ? { status: "risk" } : { status: "reject", reason: "no_mail" };
  }
  const hosts = mx.value
    .map((record) => ({ host: record.exchange.trim().toLowerCase().replace(/\.$/, ""), priority: record.priority }))
    .filter((record) => record.host !== "");
  if (mx.value.length > 0 && hosts.length === 0) return { status: "reject", reason: "null_mx" };
  if (hosts.length === 0) return { status: "reject", reason: "no_mail" };
  hosts.sort((a, b) => a.priority - b.priority);
  const results = await Promise.all(hosts.slice(0, MAX_MX_HOSTS).map((record) => hostAddresses(resolver, record.host)));
  if (results.includes("public")) return { status: "ok" };
  if (results.includes("fail")) return { status: "risk" };
  if (results.includes("private")) return { status: "reject", reason: "private_mx" };
  return { status: "reject", reason: "no_mail" };
}

const DNS_TIMEOUT_MS = 2_000;
const DNS_DEADLINE_MS = 5_000;
const DNS_CONCURRENCY = 8;
const DNS_WAITING_MAX = 64;
const CACHE_MAX = 50_000;
const TTL_OK_MS = 24 * 60 * 60_000;
const TTL_REJECT_MS = 60 * 60_000;
const TTL_RISK_MS = 5 * 60_000;

interface DnsState {
  resolver: MailResolver | null;
  cache: Map<string, { verdict: DomainVerdict; expiresAt: number }>;
  pending: Map<string, Promise<DomainVerdict>>;
  running: number;
  waiting: (() => void)[];
  stats: { lookups: number; cacheHits: number; overload: number };
}

const DNS_KEY = Symbol.for("samurai-knife.email-policy.dns.v1");
const holder = globalThis as unknown as Record<symbol, DnsState | undefined>;

function dnsState(): DnsState {
  let state = holder[DNS_KEY];
  if (!state || !(state.cache instanceof Map)) {
    state = { resolver: null, cache: new Map(), pending: new Map(), running: 0, waiting: [], stats: { lookups: 0, cacheHits: 0, overload: 0 } };
    holder[DNS_KEY] = state;
  }
  return state;
}

function systemResolver(): MailResolver {
  return new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
}

/** Tests: swap the resolver (null = the system one) and empty the cache. */
export function setMailResolverForTests(resolver: MailResolver | null): void {
  const state = dnsState();
  state.resolver = resolver;
  state.cache.clear();
  state.pending.clear();
}

function cachePut(state: DnsState, domain: string, verdict: DomainVerdict, now: number): void {
  const ttl = verdict.status === "ok" ? TTL_OK_MS : verdict.status === "reject" ? TTL_REJECT_MS : TTL_RISK_MS;
  state.cache.delete(domain);
  if (state.cache.size >= CACHE_MAX) {
    for (const [key, entry] of state.cache) if (entry.expiresAt <= now) state.cache.delete(key);
    for (const key of state.cache.keys()) {
      if (state.cache.size < CACHE_MAX) break;
      state.cache.delete(key); // a cache entry only saves a lookup: evicting the oldest is safe
    }
  }
  state.cache.set(domain, { verdict, expiresAt: now + ttl });
}

async function withSlot<T>(state: DnsState, fn: () => Promise<T>): Promise<T | null> {
  if (state.running >= DNS_CONCURRENCY) {
    if (state.waiting.length >= DNS_WAITING_MAX) return null;
    await new Promise<void>((resolve) => state.waiting.push(resolve));
  }
  state.running += 1;
  try {
    return await fn();
  } finally {
    state.running -= 1;
    state.waiting.shift()?.();
  }
}

/** Cached, de-duplicated, bounded DNS verdict for one domain. Overload or a deadline counts as a DNS failure (`risk`). */
export async function mailDomainVerdict(domain: string, now = Date.now()): Promise<DomainVerdict> {
  const state = dnsState();
  const cached = state.cache.get(domain);
  if (cached && cached.expiresAt > now) {
    state.stats.cacheHits += 1;
    return cached.verdict;
  }
  const inflight = state.pending.get(domain);
  if (inflight) return inflight;
  const resolver = state.resolver ?? systemResolver();
  const run = (async (): Promise<DomainVerdict> => {
    state.stats.lookups += 1;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<DomainVerdict>((resolve) => {
      timer = setTimeout(() => resolve({ status: "risk" }), DNS_DEADLINE_MS);
      timer.unref?.();
    });
    const verdict = await withSlot(state, () => Promise.race([checkMailDomain(domain, resolver), deadline]));
    clearTimeout(timer);
    if (!verdict) {
      state.stats.overload += 1;
      return { status: "risk" };
    }
    cachePut(state, domain, verdict, Date.now());
    return verdict;
  })().finally(() => state.pending.delete(domain));
  state.pending.set(domain, run);
  return run;
}

/* --------------------------------------------------------------------------------------------- check */

const rejects = new Map<EmailRejectReason, number>();

function reject(reason: EmailRejectReason, domain: string | null): EmailPolicyResult {
  rejects.set(reason, (rejects.get(reason) ?? 0) + 1);
  return { ok: false, reason, domain };
}

/** Everything except DNS: syntax, static rules, owner lists and the disposable list. Sync (GitHub sign-up uses it inline). */
export function checkEmailPolicySync(raw: string, env: NodeJS.ProcessEnv = process.env): EmailPolicyResult {
  const parts = splitAddress(raw);
  const canonical = canonicalEmailKey(raw, env);
  if (!emailPolicyEnforced(env)) {
    return parts && canonical ? { ok: true, email: raw.trim().toLowerCase(), canonical, domain: parts.domain, mailRisk: false } : reject("syntax", null);
  }
  const statically = staticReject(raw, env);
  if (statically || !parts || !canonical) return reject(statically ?? "syntax", parts?.domain ?? null);
  const listed = listReject(parts.domain, canonical);
  if (listed) return reject(listed, parts.domain);
  return { ok: true, email: raw.trim().toLowerCase(), canonical, domain: parts.domain, mailRisk: false };
}

/**
 * The full policy for one address: the sync checks, then (enforced, KNIFE_EMAIL_DNS not off) the cached MX check. The
 * registration flow calls the sync checks before proof-of-work and this full DNS check after proof-of-work, because a
 * lookup is outbound work; concurrency and waiters are capped. A refusal answers 400 EMAIL_POLICY_MESSAGE.
 */
export async function checkEmailPolicy(raw: string, env: NodeJS.ProcessEnv = process.env): Promise<EmailPolicyResult> {
  const result = checkEmailPolicySync(raw, env);
  if (!result.ok || !emailPolicyEnforced(env) || !dnsCheckEnabled(env)) return result;
  const verdict = await mailDomainVerdict(result.domain);
  if (verdict.status === "reject") return reject(verdict.reason, result.domain);
  return { ...result, mailRisk: verdict.status === "risk" };
}

export function emailPolicyStats(): {
  enforced: boolean;
  dns: boolean;
  disposable: { source: "download" | "snapshot"; domains: number };
  allow: number;
  deny: number;
  rejects: Partial<Record<EmailRejectReason, number>>;
  cache: { entries: number; lookups: number; hits: number; overload: number };
} {
  const lists = emailLists();
  const state = dnsState();
  return {
    enforced: emailPolicyEnforced(),
    dns: dnsCheckEnabled(),
    disposable: { source: lists.disposableSource, domains: lists.disposable.size },
    allow: lists.allow.domains.size,
    deny: lists.deny.domains.size + lists.deny.addresses.size,
    rejects: Object.fromEntries(rejects),
    cache: { entries: state.cache.size, lookups: state.stats.lookups, hits: state.stats.cacheHits, overload: state.stats.overload },
  };
}
