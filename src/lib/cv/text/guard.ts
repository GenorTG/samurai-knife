import type { CvChange } from "../ops";
import { droppedFacts } from "./translation";

/**
 * Fact guard for edits: a rewrite of a `/pl` or `/en` text must keep hard facts. Returns one warning per changed
 * text that lost numbers, URLs, emails, versions or proper names. Never blocks: the edit is applied and the caller
 * (tool or route) passes the warnings on so the model or the user can restore them.
 */

const SIDES = ["pl", "en"] as const;

function isBi(value: unknown): value is { pl: string; en: string } {
  return typeof value === "object" && value !== null && typeof (value as { pl?: unknown }).pl === "string" && typeof (value as { en?: unknown }).en === "string";
}

export function factWarnings(changes: readonly CvChange[]): string[] {
  const out: string[] = [];
  const check = (path: string, before: unknown, after: unknown, lang: string): void => {
    if (typeof before !== "string" || typeof after !== "string" || !before.trim()) return;
    const lost = droppedFacts(before, after, lang);
    if (lost.length) out.push(`${path}: the new text drops ${lost.join(", ")}. Restore them unless the user asked to remove them.`);
  };
  for (const change of changes) {
    if (change.op !== "set") continue;
    const last = change.path.slice(change.path.lastIndexOf("/") + 1);
    if (last === "pl" || last === "en") {
      check(change.path, change.before, change.after, last);
    } else if (isBi(change.before) && isBi(change.after)) {
      // a whole {pl,en} value replaced in one op: check each side
      for (const lang of SIDES) check(`${change.path.replace(/\/+$/, "")}/${lang}`, change.before[lang], change.after[lang], lang);
    }
  }
  return out;
}

/** Every text of the profile, lower-cased, for "does the user's profile say this anywhere?" checks. */
export function profileCorpus(value: unknown): string {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === "string") out.push(node);
    else if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === "object") Object.values(node).forEach(visit);
  };
  visit(value);
  return out.join("\n").toLowerCase();
}

/**
 * Words that make a claim stronger than plain wording does: scale, seniority, ownership, production use. A rewrite may
 * keep them, never introduce them (stem match, Polish and English). Kept short on purpose: every entry is a claim.
 */
const STRENGTHENERS: { stem: RegExp; label: string }[] = [
  { stem: /\bprodukcyj\p{L}*|\bproduction\b|\bw produkcji\b|\bin production\b/iu, label: "production" },
  { stem: /\benterprise\b|\bkorporacyj\p{L}*/iu, label: "enterprise" },
  { stem: /\bskalowaln\p{L}*|\bscalab\p{L}*|\bat scale\b|\bna dużą skalę\b|\bhigh[- ]load\b/iu, label: "scale" },
  { stem: /\bsenior\p{L}*|\bekspert\p{L}*|\bexpert\p{L}*/iu, label: "seniority" },
  { stem: /\bled\b|\bleading\b|\blead\b|\bkierowa\p{L}*|\bprowadzi\p{L}* zesp\p{L}*|\bmanag\p{L}* (?:a |the )?team/iu, label: "leadership" },
  { stem: /\barchitekt\p{L}*|\barchitect\p{L}*/iu, label: "architecture ownership" },
  { stem: /\bod zera\b|\bfrom scratch\b|\bsamodzielnie\b|\bsingle-handed\p{L}*|\bon my own\b|\bindependently\b/iu, label: "sole ownership" },
  { stem: /\bmilion\p{L}*|\bmillion\p{L}*|\btysi\p{L}*|\bthousands\b/iu, label: "volume" },
  { stem: /\bawans\p{L}*|\bpromot\p{L}*/iu, label: "promotion" },
];

/** Claim-strengthening words present in `after` but not in `before`. */
export function addedClaims(before: string, after: string): string[] {
  return STRENGTHENERS.filter(({ stem }) => stem.test(after) && !stem.test(before)).map(({ stem, label }) => `${label} (“${(after.match(stem) ?? [""])[0]}”)`);
}

/**
 * Guard for a per-version rewording of a master text: warns when the new wording drops a hard fact of the master text,
 * or ADDS a number, URL, version or name that appears nowhere in the user's profile (a likely invention). Facts taken
 * from elsewhere in the profile (a technology from the skills list, a project name) are allowed.
 */
export function rewriteWarnings(path: string, master: { pl: string; en: string }, rewrite: { pl: string; en: string }, corpus: string): string[] {
  const out: string[] = [];
  for (const lang of SIDES) {
    const before = master[lang];
    const after = rewrite[lang];
    if (!after.trim()) continue;
    if (before.trim()) {
      const lost = droppedFacts(before, after, lang);
      if (lost.length) out.push(`${path}/${lang}: the rewrite drops ${lost.join(", ")} from the profile text. Keep them unless the user asked to remove them.`);
    }
    const added = droppedFacts(after, before, lang).filter((fact) => {
      const value = fact.slice(fact.indexOf(" ") + 1).toLowerCase();
      return !corpus.includes(value);
    });
    if (added.length) out.push(`${path}/${lang}: the rewrite adds ${added.join(", ")}, which the profile does not contain anywhere. Remove it, or ask the user and add it to the profile first.`);
    const claims = before.trim() ? addedClaims(before, after) : [];
    if (claims.length) out.push(`${path}/${lang}: the rewrite makes a stronger claim than the profile text: ${claims.join(", ")}. Remove it unless the user confirms it is true for this item.`);
    // the opposite also costs the user: a true claim of the profile silently dropped (promoted -> "grew")
    const weaker = before.trim() ? addedClaims(after, before) : [];
    if (weaker.length) out.push(`${path}/${lang}: the rewrite drops a claim the profile makes: ${weaker.join(", ")}. Keep it: it is true and it sells.`);
  }
  return out;
}
