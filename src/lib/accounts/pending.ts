import { mutateStore, readStore, type Account, type AccountStore } from "@/lib/accounts/store";
import { canonicalDomain, isBigProvider } from "@/lib/accounts/email-address";

/**
 * Pending accounts (registered, address not confirmed yet) hold a username and an address for 24 hours, and every one of
 * them is read by every request that loads the store. Threat: bots squatting names and addresses, or growing
 * accounts.json without bound, and the caps themselves becoming the attack (50 fake gmail.com sign-ups must not block
 * every gmail.com registration for a day). Rules: expired pending records are dropped on a timer (and inline before
 * every registration); KNIFE_PENDING_PER_PREFIX per client address prefix (5, a keyed hash in `pendingIpp`), always;
 * KNIFE_PENDING_PER_DOMAIN per email domain (50, canonical: googlemail = gmail), except big webmail providers
 * (email-address.ts `BIG_PROVIDERS`), which only meet the total; KNIFE_PENDING_MAX overall (2000). The domain and total
 * caps press on prefixes first: at the cap, a prefix that already holds a pending sign-up is refused; a prefix with
 * none still gets in until the hard cap (1.25x). A full cap refuses with 429; it never evicts someone else's record.
 */

export const VERIFY_TTL_MS = 24 * 60 * 60_000;
const SWEEP_EVERY_MS = 10 * 60_000;

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw >= 0 ? raw : fallback;
}

export const pendingCaps = () => ({
  total: envInt("KNIFE_PENDING_MAX", 2_000),
  perDomain: envInt("KNIFE_PENDING_PER_DOMAIN", 50),
  perPrefix: envInt("KNIFE_PENDING_PER_PREFIX", 5),
});

function isExpiredPending(account: Account, now: number): boolean {
  return account.status === "pending"
    && account.emailVerifiedAt === null
    && (!account.verifyToken || Date.parse(account.verifyToken.expiresAt) <= now)
    && now - Date.parse(account.createdAt) > VERIFY_TTL_MS;
}

/** Inside a mutation: frees the username and address of every expired pending account. Returns how many went. */
export function dropExpiredPending(store: AccountStore, now = Date.now()): number {
  const before = store.accounts.length;
  store.accounts = store.accounts.filter((account) => !isExpiredPending(account, now));
  return before - store.accounts.length;
}

/** Domain and total caps: past the soft cap only prefixes without a pending sign-up get in, up to this factor. */
export const PENDING_HARD_FACTOR = 1.25;

export type PendingVerdict = "ok" | "pending_full";

/** Would one more pending account from this domain and address prefix fit? Pure: works on a read copy or inside a mutation. */
export function pendingRoom(store: AccountStore, email: string, ipTag: string, now = Date.now()): PendingVerdict {
  const caps = pendingCaps();
  const pending = store.accounts.filter((account) => account.status === "pending" && !isExpiredPending(account, now));
  const mine = pending.filter((account) => account.pendingIpp === ipTag).length;
  if (mine >= caps.perPrefix) return "pending_full";
  const cap = (soft: number) => (mine > 0 ? soft : Math.ceil(soft * PENDING_HARD_FACTOR));
  if (pending.length >= cap(caps.total)) return "pending_full";
  const domain = canonicalDomain(email);
  if (!isBigProvider(domain) && pending.filter((account) => canonicalDomain(account.email) === domain).length >= cap(caps.perDomain)) return "pending_full";
  return "ok";
}

/** Read-only pre-check (cached store), before any password hashing. */
export function pendingRoomNow(email: string, ipTag: string): PendingVerdict {
  return pendingRoom(readStore(), email, ipTag);
}

/** One sweep: a write only when something expired. */
export function sweepPending(now = Date.now()): number {
  if (!readStore().accounts.some((account) => isExpiredPending(account, now))) return 0;
  return mutateStore((store) => dropExpiredPending(store, now));
}

const TIMER = Symbol.for("samurai-knife.pending-sweeper.v1");

/** Starts the periodic sweep once per process (idempotent, unref'd: never keeps the process alive). */
export function ensurePendingSweeper(): void {
  const g = globalThis as unknown as Record<symbol, ReturnType<typeof setInterval> | undefined>;
  if (g[TIMER]) return;
  const timer = setInterval(() => {
    try {
      sweepPending();
    } catch (error) {
      console.warn(`[accounts] pending sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, SWEEP_EVERY_MS);
  timer.unref?.();
  g[TIMER] = timer;
}
