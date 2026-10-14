import type { CvData, Profile } from "./schema";

/**
 * Pure structural diff of two master profiles, reported as id-paths (same addressing as `ops.ts`:
 * `/experience/id=exp-1/bullets/id=b2/text/en`). Drives the live "something changed" cue in the CV tabs, so a change made
 * by the assistant (knife_cv_* tools) or by the user flashes the field and raises an Undo toast. Relative imports only
 * (the node test loader does not resolve `@/`).
 */

export interface FieldChange {
  /** `changed` = a field's value differs; `added` / `removed` = a whole list item (or field that gained/lost a value). */
  kind: "changed" | "added" | "removed";
  path: string;
  /** Human label, e.g. `Experience › Acme › bullet b2 › text (EN)`. */
  label: string;
  before: unknown;
  after: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isObjectList(v: unknown): v is Record<string, unknown>[] {
  return Array.isArray(v) && v.length > 0 && v.every((item) => isRecord(item) && typeof item.id === "string");
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const SECTION_LABEL: Record<string, string> = {
  contact: "Contact", summary: "Summary", experience: "Experience", projects: "Projects", skills: "Skills",
  education: "Education", languages: "Languages", consent: "Consent clause", extras: "Extras",
};

const FIELD_LABEL: Record<string, string> = {
  org: "employer", role: "role", start: "start", end: "end", location: "location", note: "note", text: "text",
  name: "name", url: "link", summary: "summary", tech: "tech", items: "items", headline: "headline", email: "e-mail",
  phone: "phone", links: "links", institution: "institution", detail: "detail", level: "level", tags: "tags",
  verified: "verified", bullets: "bullets",
};

function segmentId(seg: string): string | null {
  return seg.startsWith("id=") ? seg.slice(3) : null;
}

/** `Experience › Acme › bullet b2 › text (EN)`: readable form of an id-path, resolving item names from `profile`. */
export function labelForPath(profile: Profile | null, path: string): string {
  const segs = path.split("/").filter(Boolean);
  const parts: string[] = [];
  let node: unknown = profile;
  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i];
    const prev = segs[i - 1];
    const id = segmentId(seg);
    if (id !== null) {
      const found = Array.isArray(node) ? node.find((item) => isRecord(item) && item.id === id) : undefined;
      node = found;
      const named = isRecord(found) ? (found.org ?? found.name ?? found.institution) : undefined;
      if (prev === "bullets") parts.push(`bullet ${id}`);
      else parts.push(typeof named === "string" && named ? named : id);
      continue;
    }
    if (seg === "pl" || seg === "en") {
      parts[parts.length - 1] = `${parts[parts.length - 1]} (${seg.toUpperCase()})`;
      node = isRecord(node) ? node[seg] : undefined;
      continue;
    }
    node = isRecord(node) ? node[seg] : undefined;
    if (i === 0) parts.push(SECTION_LABEL[seg] ?? seg);
    else if (seg !== "bullets" && seg !== "-") parts.push(FIELD_LABEL[seg] ?? seg);
  }
  return parts.join(" › ") || "Profile";
}

function walk(prev: unknown, next: unknown, path: string, out: { path: string; kind: FieldChange["kind"]; before: unknown; after: unknown }[]): void {
  if (sameValue(prev, next)) return;
  if (isRecord(prev) && isRecord(next)) {
    for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) walk(prev[key], next[key], `${path}/${key}`, out);
    return;
  }
  const prevItems = isObjectList(prev) ? prev : prev === undefined || (Array.isArray(prev) && prev.length === 0) ? [] : null;
  const nextItems = isObjectList(next) ? next : next === undefined || (Array.isArray(next) && next.length === 0) ? [] : null;
  if (prevItems && nextItems) {
    const nextById = new Map(nextItems.map((item) => [String(item.id), item]));
    const prevIds = new Set(prevItems.map((item) => String(item.id)));
    for (const item of prevItems) {
      const id = String(item.id);
      const counterpart = nextById.get(id);
      if (counterpart) walk(item, counterpart, `${path}/id=${id}`, out);
      else out.push({ path: `${path}/id=${id}`, kind: "removed", before: item, after: undefined });
    }
    for (const item of nextItems) {
      if (!prevIds.has(String(item.id))) out.push({ path: `${path}/id=${String(item.id)}`, kind: "added", before: undefined, after: item });
    }
    const order = (items: Record<string, unknown>[], keep: Set<string>): string => items.map((x) => String(x.id)).filter((id) => keep.has(id)).join(",");
    const common = new Set([...prevIds].filter((id) => nextById.has(id)));
    if (order(prevItems, common) !== order(nextItems, common)) {
      out.push({ path, kind: "changed", before: order(prevItems, common), after: order(nextItems, common) });
    }
    return;
  }
  // Leaf: primitive, string list or a type change.
  out.push({ path, kind: "changed", before: prev, after: next });
}

/** Changed id-paths between two profiles. Deterministic order (document order of `next`, then removals). Empty = identical. */
export function diffCv(prev: Profile | null | undefined, next: Profile | null | undefined): FieldChange[] {
  if (!prev || !next) return [];
  const raw: { path: string; kind: FieldChange["kind"]; before: unknown; after: unknown }[] = [];
  walk(prev, next, "", raw);
  return raw.map((c) => ({ ...c, label: labelForPath(c.kind === "removed" ? prev : next, c.path) }));
}

/** One-line rendering of a value for a toast: strings clipped, lists joined, objects as their name or id. */
export function previewValue(value: unknown, max = 60): string {
  let text: string;
  if (value === undefined || value === null || value === "") text = "(empty)";
  else if (typeof value === "string") text = value;
  else if (Array.isArray(value)) text = value.map((v) => (typeof v === "string" ? v : isRecord(v) ? String(v.id ?? "item") : String(v))).join(", ") || "(empty)";
  else if (isRecord(value)) text = String(value.org ?? value.name ?? value.institution ?? value.id ?? "item");
  else text = String(value);
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Toast line: `Updated <label>: before -> after`, `Added <label>: …` or `Removed <label>`. */
export function describeChange(change: FieldChange): string {
  if (change.kind !== "changed") {
    const verb = change.kind === "added" ? "Added" : "Removed";
    const tail = previewValue(change.kind === "added" ? change.after : change.before);
    const wholeItem = /^\/(jobs|variants|applications)\/id=[^/]+$/.test(change.path);
    return wholeItem || change.label.endsWith(tail) ? `${verb} ${change.label}` : `${verb} ${change.label}: ${tail}`;
  }
  return `Updated ${change.label}: ${previewValue(change.before)} -> ${previewValue(change.after)}`;
}

/** Collapse many changes into the single toast line (first change spelled out, the rest counted). */
export function describeChanges(changes: readonly FieldChange[]): string {
  if (changes.length === 0) return "";
  if (changes.length === 1) return describeChange(changes[0]);
  return `${describeChange(changes[0])} (+${changes.length - 1} more)`;
}

type Collection = "jobs" | "variants" | "applications";
const COLLECTION_NOUN: Record<Collection, string> = { jobs: "Job offer", variants: "CV version", applications: "Application" };

function itemName(kind: Collection, item: Record<string, unknown>): string {
  const parts = kind === "jobs" ? [item.company, item.title] : kind === "variants" ? [item.name] : [item.company, item.role];
  return parts.filter((p): p is string => typeof p === "string" && p !== "").join(" - ") || String(item.id);
}

/**
 * Changes in the jobs / variants / applications lists (by id), so the assistant adding an offer or moving an application
 * shows up live too. A changed item yields one entry per changed top-level field, addressed `/applications/id=x/status`.
 */
export function diffCollections(prev: CvData | null | undefined, next: CvData | null | undefined): FieldChange[] {
  if (!prev || !next) return [];
  const out: FieldChange[] = [];
  for (const kind of ["jobs", "variants", "applications"] as const) {
    const before = prev[kind] as unknown as Record<string, unknown>[];
    const after = next[kind] as unknown as Record<string, unknown>[];
    const beforeById = new Map(before.map((item) => [String(item.id), item]));
    const afterIds = new Set(after.map((item) => String(item.id)));
    for (const item of after) {
      const id = String(item.id);
      const old = beforeById.get(id);
      const base = `/${kind}/id=${id}`;
      const label = `${COLLECTION_NOUN[kind]} ${itemName(kind, item)}`;
      if (!old) {
        out.push({ kind: "added", path: base, label, before: undefined, after: item });
        continue;
      }
      for (const key of Object.keys(item)) {
        if (sameValue(old[key], item[key])) continue;
        out.push({ kind: "changed", path: `${base}/${key}`, label: `${label} › ${key}`, before: old[key], after: item[key] });
      }
    }
    for (const item of before) {
      if (!afterIds.has(String(item.id))) out.push({ kind: "removed", path: `/${kind}/id=${String(item.id)}`, label: `${COLLECTION_NOUN[kind]} ${itemName(kind, item)}`, before: item, after: undefined });
    }
  }
  return out;
}
