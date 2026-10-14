import { profileSchema, type CvLang, type Profile } from "./schema";

/**
 * Atomic, id-addressed edits to a profile with a before/after record per change.
 * Paths are JSON-pointer-like: `/experience/id=exp-1/bullets/id=b2/text/en`.
 * A list segment is `id=<id>`, a numeric index, or `-` (append, `add` only).
 * Edits apply to a copy and the result is validated as a whole: one bad op leaves the profile untouched.
 */

export type CvOp =
  | { op: "set"; path: string; value: unknown }
  | { op: "add"; path: string; value: unknown }
  | { op: "remove"; path: string };

export interface CvChange {
  op: CvOp["op"];
  path: string;
  before?: unknown;
  after?: unknown;
}

export class CvOpError extends Error {}

type Container = Record<string, unknown> | unknown[];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function split(path: string): string[] {
  if (!path.startsWith("/")) throw new CvOpError("path must start with '/'");
  return path.split("/").slice(1).filter((s) => s !== "");
}

/** The object key or list index that `seg` addresses inside `container`. */
function locate(container: unknown, seg: string, allowAppend: boolean): string | number {
  if (isRecord(container)) {
    if (!(seg in container)) throw new CvOpError(`no field '${seg}' (have: ${Object.keys(container).join(", ") || "none"})`);
    return seg;
  }
  if (Array.isArray(container)) {
    if (seg === "-") {
      if (allowAppend) return container.length;
      throw new CvOpError("'-' is only valid for add");
    }
    if (seg.startsWith("id=")) {
      const wanted = seg.slice(3);
      const idx = container.findIndex((item) => isRecord(item) && item.id === wanted);
      if (idx >= 0) return idx;
      const ids = container.filter(isRecord).map((item) => String(item.id));
      throw new CvOpError(`no item with id '${wanted}' (have: ${ids.join(", ")})`);
    }
    if (/^\d+$/.test(seg) && Number(seg) < container.length) return Number(seg);
    throw new CvOpError(`bad list segment '${seg}'`);
  }
  throw new CvOpError(`cannot descend into ${container === null ? "null" : typeof container} with '${seg}'`);
}

function walk(data: unknown, segs: string[]): unknown {
  let node = data;
  for (const seg of segs) node = (node as Record<string | number, unknown>)[locate(node, seg, false)];
  return node;
}

function applyOne(data: Record<string, unknown>, op: CvOp): CvChange {
  const segs = split(op.path);
  if (segs.length === 0) throw new CvOpError("empty path");
  const parent = walk(data, segs.slice(0, -1)) as Container;
  const key = locate(parent, segs[segs.length - 1], op.op === "add");
  const slot = parent as Record<string | number, unknown>;

  if (op.op === "set") {
    const before = structuredClone(slot[key]);
    slot[key] = structuredClone(op.value);
    return { op: "set", path: op.path, before, after: op.value };
  }
  if (op.op === "add") {
    if (!Array.isArray(parent)) throw new CvOpError("add targets a list; use set for fields");
    parent.splice(key as number, 0, structuredClone(op.value));
    return { op: "add", path: op.path, after: op.value };
  }
  const before = structuredClone(slot[key]);
  if (Array.isArray(parent)) parent.splice(key as number, 1);
  else throw new CvOpError("remove targets a list item; use set to clear a field");
  return { op: "remove", path: op.path, before };
}

export function applyOps(profile: Profile, ops: readonly CvOp[]): { profile: Profile; changes: CvChange[] } {
  const data = structuredClone(profile) as unknown as Record<string, unknown>;
  const changes: CvChange[] = [];
  ops.forEach((op, i) => {
    try {
      changes.push(applyOne(data, op));
    } catch (error) {
      if (error instanceof CvOpError) throw new CvOpError(`op ${i} (${op.op} ${op.path}): ${error.message}`);
      throw error;
    }
  });
  const parsed = profileSchema.safeParse(data);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new CvOpError(`result invalid at ${first.path.join("/") || "/"}: ${first.message}`);
  }
  return { profile: parsed.data, changes };
}

/** Resolve a path to a value for reads (same addressing as edits). */
export function readPath(profile: Profile, path: string): unknown {
  try {
    return walk(profile, split(path));
  } catch (error) {
    if (error instanceof CvOpError) throw error;
    throw new CvOpError(`cannot resolve '${path}'`);
  }
}

/** Paths of Bi fields written in the other language but empty in `lang`: the translation backlog. */
export function missingTranslations(profile: Profile, lang: CvLang): string[] {
  const other: CvLang = lang === "pl" ? "en" : "pl";
  const found: string[] = [];
  const visit = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, `${path}/${isRecord(item) && typeof item.id === "string" ? `id=${item.id}` : "?"}`));
    } else if (isRecord(node)) {
      const keys = Object.keys(node);
      if (keys.length === 2 && "pl" in node && "en" in node) {
        if (!node[lang] && node[other]) found.push(path || "/");
        return;
      }
      for (const [k, v] of Object.entries(node)) visit(v, `${path}/${k}`);
    }
  };
  visit(profile, "");
  return found;
}
