import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appVersion } from "@/lib/version";

/**
 * What the "What's new" window compares with (src/lib/release-notes.ts): this server's MAJOR.MINOR.PATCH and the newest
 * edition of the default legal texts (legal/versions.json). Read directly so the account store can stamp new accounts
 * without importing the legal module (which imports the store). Server only.
 */
export function currentRelease(): string {
  return appVersion().split(".").slice(0, 3).join(".");
}

export function currentLegalEdition(): number | null {
  try {
    const parsed = JSON.parse(readFileSync(join(process.cwd(), "legal", "versions.json"), "utf8")) as { editions?: { edition?: unknown }[] };
    const editions = (parsed.editions ?? []).map((e) => e.edition).filter((e): e is number => Number.isInteger(e));
    return editions.length ? Math.max(...editions) : null;
  } catch {
    return null;
  }
}

/** A new account has seen everything up to now: it gets no "What's new" window for what existed before it. */
export function seenNow(): { version: string; legalEdition: number | null; at: string } {
  return { version: currentRelease(), legalEdition: currentLegalEdition(), at: new Date().toISOString() };
}
