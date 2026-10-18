import {
  flushSecurityEvents as flushCore,
  loadSecurityHistory as loadCore,
  onSecurityEvent as onCore,
  recentSecurityEvents as recentCore,
  recordSecurityEvent as recordCore,
  SECURITY_EVENT_KINDS,
} from "./events-core.mjs";

/**
 * Security events: the ONE API every module calls when it refuses or notices something for abuse reasons. Threat model:
 * an attacker controls how often events happen, so recording never blocks, throws or grows without bound (coalescing,
 * a bounded buffer, async appends: src/lib/security/events-core.mjs, shared with the abuse-guard preload), and no event
 * holds a secret, a password, a token, a full email or a full client address.
 *
 * Log: `$KNIFE_DATA_DIR/security/events-<UTC day>.jsonl` (0600, one file per day, 30 days kept). Admins read it through
 * `GET /api/admin/security`; src/lib/security/alerts.ts mails a digest of the ones that need a human.
 *
 * Calling it (both shapes are the same event):
 *
 *   recordSecurityEvent({ kind: "pending_full", ipPrefix: clientPrefix(ip) });
 *   recordSecurityEvent({ kind: "outbound_budget", account: account.id, detail: { purpose: "page", limit: 30 } });
 *   recordSecurityEvent("mail_suppressed", { domain: "example.com", reason: "hard bounce" });   // positional
 *   recordSecurityEvent("tool_timeout", "pdf: ocr killed after 120 s", { account: id });
 *
 * Fields: `kind` (below), `ipPrefix` (a client prefix, `clientPrefix(ip)` / network.ts `clientIp`; a raw address is
 * reduced to its prefix), `account` (account id, never an email), `credHash` (opaque hash, abuse guard), `path` (query
 * stripped), `status`, `count` (default 1), `detail` (a short string, or a flat record of at most 8 short scalar fields).
 * Accepted aliases from older call sites: `type` for `kind` (`"outbound-budget"` -> `outbound_budget`), `accountId` for
 * `account`, `ip` for `ipPrefix`. Unknown kinds are stored as `other` with the original as `label`.
 *
 * Kinds: rate_block (a request budget refused a client), scanner_block (the abuse guard blocked a prefix), login_lockout
 * (an identifier's failure bucket filled), pow_fail (a wrong proof-of-work), hash_busy (the scrypt gate refused work),
 * pending_full (pending sign-ups at capacity), oauth_flow_full (GitHub OAuth flow table full), github_app_access_lost,
 * quota_full (a bounded table or quota refused new work), queue_full (a work queue refused a job), outbound_refused /
 * outbound_budget (an outbound request refused by policy / by a budget), tool_timeout (a tool or worker killed by its
 * timeout), mail_budget / mail_suppressed and any other `mail_<name>` (mail module), register_surge, disk_low, unblock
 * (an admin lifted a block), other. A new kind is added here and in events-core.mjs `SECURITY_EVENT_KINDS`.
 */
export type KnownSecurityEventKind =
  | "rate_block"
  | "scanner_block"
  | "login_lockout"
  | "pow_fail"
  | "hash_busy"
  | "pending_full"
  | "oauth_flow_full"
  | "github_app_access_lost"
  | "quota_full"
  | "queue_full"
  | "outbound_refused"
  | "outbound_budget"
  | "tool_timeout"
  | "mail_budget"
  | "mail_suppressed"
  | "register_surge"
  | "disk_low"
  | "unblock"
  | "other";

export type SecurityEventKind = KnownSecurityEventKind | `mail_${string}`;

/** A short string, or a flat record of at most 8 scalar fields (strings capped at 120 characters). */
export type SecurityEventDetail = string | Record<string, string | number | boolean>;

export interface SecurityEventInput {
  kind?: SecurityEventKind;
  /** Alias of `kind` (older call sites): normalised, `"github-app-access-lost"` -> `github_app_access_lost`. */
  type?: string;
  /** Client prefix (IPv4 /32, IPv6 /64); a raw address is reduced to its prefix. */
  ipPrefix?: string;
  /** Alias of `ipPrefix`. */
  ip?: string;
  /** Account id, never an email. */
  account?: string;
  /** Alias of `account`. */
  accountId?: string;
  /** Opaque credential hash (abuse guard). */
  credHash?: string;
  /** Request path or form name (query strings are stripped). */
  path?: string;
  status?: number;
  /** How many occurrences this stands for (default 1). */
  count?: number;
  detail?: SecurityEventDetail;
}

/** A stored event (the shape on disk, in the admin API and given to listeners). */
export interface SecurityEvent {
  ts: string;
  kind: SecurityEventKind;
  /** The original kind when it was not a known one (`kind` is then `other`). */
  label?: string;
  ipPrefix?: string;
  account?: string;
  credHash?: string;
  path?: string;
  status?: number;
  count: number;
  detail?: SecurityEventDetail;
}

export const securityEventKinds = SECURITY_EVENT_KINDS as readonly string[];

/** Records one event. Never throws, never blocks. */
export function recordSecurityEvent(event: SecurityEventInput): void;
export function recordSecurityEvent(kind: SecurityEventKind, detail?: SecurityEventDetail, extra?: Omit<SecurityEventInput, "kind" | "type" | "detail">): void;
export function recordSecurityEvent(first: SecurityEventInput | SecurityEventKind, detail?: SecurityEventDetail, extra?: Omit<SecurityEventInput, "kind" | "type" | "detail">): void {
  recordCore(typeof first === "string" ? { ...extra, kind: first, detail } : first);
}

/** Most recent events in memory (newest last, at most 500). Call `loadSecurityHistory()` first to include past days. */
export function recentSecurityEvents(limit = 500): SecurityEvent[] {
  return recentCore(limit) as SecurityEvent[];
}

/** Loads the tail of the newest day files into memory once (async, bounded); for the admin view after a restart. */
export function loadSecurityHistory(): Promise<void> {
  return loadCore();
}

/** In-process listener for every recorded event; returns the unsubscribe function. */
export function onSecurityEvent(listener: (event: SecurityEvent) => void): () => void {
  return onCore(listener as (event: unknown) => void) as () => void;
}

/** Writes the buffer now (tests, shutdown). */
export function flushSecurityEvents(): Promise<void> {
  return flushCore();
}

/** One line for mails and logs: `kind  prefix  account  path  detail  xN`. */
export function describeSecurityEvent(event: SecurityEvent): string {
  const detail = typeof event.detail === "string" ? event.detail : event.detail ? Object.entries(event.detail).map(([k, v]) => `${k}=${v}`).join(" ") : "";
  return [event.label ? `${event.kind}(${event.label})` : event.kind, event.ipPrefix ?? "", event.account ? `account ${event.account}` : "", event.path ?? "", detail, event.count > 1 ? `x${event.count}` : ""]
    .filter(Boolean)
    .join("  ");
}
