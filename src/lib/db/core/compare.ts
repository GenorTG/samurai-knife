import { createHash } from "node:crypto";
import type { AccountCodec, CoreLoad, CoreSnapshot } from "@/lib/db/core/types";

/**
 * Record digests for cut-over checks (db-import --verify, KNIFE_DB_VERIFY=1): canonical JSON (sorted keys, timestamps
 * normalised to toISOString) of every OPENED record, SHA-256 per record. Two snapshots match when their digest maps are
 * equal; `diffDigests` names what differs by kind and id only (never a value: they hold password hashes and keys).
 */

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const iso = (value: string | null): string | null => {
  if (value === null) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? value : new Date(time).toISOString();
};

const sha = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");

/** Decodes a repository load the way the server does (validate, migrate v1, open secrets). */
export function decodeLoad(load: CoreLoad, codec: AccountCodec): CoreSnapshot {
  const store = codec.parse({ defaultAccountId: load.defaultAccountId ?? "", accounts: load.accounts.map((row) => row.doc) }, load.legacyV1);
  codec.openSecrets(store);
  return { store, sessions: load.sessions, keys: load.keys };
}

export function digestSnapshot(snapshot: CoreSnapshot): Map<string, string> {
  const out = new Map<string, string>();
  out.set("default", sha(snapshot.store.defaultAccountId));
  for (const account of snapshot.store.accounts) out.set(`accounts/${account.id}`, sha(account));
  for (const session of snapshot.sessions) {
    out.set(`sessions/${session.hash.slice(0, 12)}`, sha({ ...session, createdAt: iso(session.createdAt), expiresAt: iso(session.expiresAt), lastSeenAt: iso(session.lastSeenAt) }));
  }
  for (const key of snapshot.keys) {
    out.set(`keys/${key.id}`, sha({ ...key, scope: key.scope ?? "full", createdAt: iso(key.createdAt), lastUsedAt: iso(key.lastUsedAt) }));
  }
  return out;
}

export function diffDigests(a: Map<string, string>, b: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [key, value] of a) {
    const other = b.get(key);
    if (other === undefined) out.push(`${key}: only in the first`);
    else if (other !== value) out.push(`${key}: differs`);
  }
  for (const key of b.keys()) if (!a.has(key)) out.push(`${key}: only in the second`);
  return out;
}

/** Counts and one digest over all records (the import manifest). */
export function manifest(snapshot: CoreSnapshot): { accounts: number; profiles: number; sessions: number; keys: number; sha256: string } {
  const digests = [...digestSnapshot(snapshot).entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  return {
    accounts: snapshot.store.accounts.length,
    profiles: snapshot.store.accounts.reduce((sum, account) => sum + account.providerProfiles.length, 0),
    sessions: snapshot.sessions.length,
    keys: snapshot.keys.length,
    sha256: createHash("sha256").update(digests.map(([key, value]) => `${key}=${value}`).join("\n")).digest("hex"),
  };
}
