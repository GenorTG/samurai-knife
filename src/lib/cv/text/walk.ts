import type { Profile } from "../schema";
import type { TextKind } from "./lint";

/** Enumerate every bilingual text field of a profile, addressed by the same id-paths `applyOps` accepts. */

const BULLET_TEXT = /^(.*\/bullets)\/id=[^/]+\/text$/;
const SUMMARY = /^\/summary$|^\/projects\/id=[^/]+\/summary$/;

/** The scope path does not exist in the profile; the message names what does. */
export class ScopeError extends Error {}

export interface BiField {
  /** Path of the Bi itself, e.g. /experience/id=exp-1/bullets/id=b2/text (append /pl or /en to edit a side). */
  path: string;
  pl: string;
  en: string;
  kind: TextKind;
  /** Path of the bullet list this text belongs to, else null. */
  group: string | null;
}

export const sideOf = (field: BiField, lang: "pl" | "en"): string => (lang === "pl" ? field.pl : field.en);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function kindOf(path: string): { kind: TextKind; group: string | null } {
  const bullet = BULLET_TEXT.exec(path);
  if (bullet) return { kind: "bullet", group: bullet[1] };
  return { kind: SUMMARY.test(path) ? "summary" : "paragraph", group: null };
}

function walk(node: unknown, path: string, out: BiField[]): void {
  if (isRecord(node)) {
    const keys = Object.keys(node);
    if (keys.length === 2 && keys.includes("pl") && keys.includes("en") && typeof node.pl === "string" && typeof node.en === "string") {
      out.push({ path: path || "/", pl: node.pl, en: node.en, ...kindOf(path || "/") });
      return;
    }
    for (const [key, value] of Object.entries(node)) walk(value, `${path}/${key}`, out);
  } else if (Array.isArray(node)) {
    node.forEach((item, i) => walk(item, `${path}/${isRecord(item) && "id" in item ? `id=${String(item.id)}` : i}`, out));
  }
}

function checkScope(data: unknown, scope: string): void {
  let node: unknown = data;
  for (const seg of scope.split("/").filter(Boolean)) {
    if (isRecord(node) && seg in node) {
      node = node[seg];
    } else if (Array.isArray(node) && seg.startsWith("id=")) {
      const found = node.find((item) => isRecord(item) && item.id === seg.slice(3));
      if (!found) {
        const have = node.filter(isRecord).map((item) => String(item.id)).join(", ");
        throw new ScopeError(`no item with ${seg} in scope '${scope}' (have: ${have || "none"})`);
      }
      node = found;
    } else {
      const have = isRecord(node) ? Object.keys(node).join(", ") : "a list or text";
      throw new ScopeError(`cannot resolve '${seg}' in scope '${scope}' (here: ${have})`);
    }
  }
}

/** All Bi fields at or under `scope`, in profile order. A trailing /pl or /en is ignored. */
export function biFields(profile: Profile, scope = "/"): BiField[] {
  const trimmed = scope.trim().replace(/\/(?:pl|en)$/, "") || "/";
  if (!trimmed.startsWith("/")) throw new ScopeError("scope must start with '/' (e.g. '/' or '/experience/id=exp-1')");
  checkScope(profile, trimmed);
  const all: BiField[] = [];
  walk(profile, "", all);
  const prefix = trimmed.replace(/\/+$/, "");
  return all.filter((f) => f.path === trimmed || f.path.startsWith(`${prefix}/`));
}
