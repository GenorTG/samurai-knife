import { applyOps, readPath } from "./ops";
import { BUILTIN_SECTIONS, REWRITE_PATH, type Bi, type Profile, type Variant } from "./schema";

/** Master + variant -> the plain Profile a renderer consumes. Unknown ids are skipped; lint them with `danglingIds`. */
export function resolveVariant(master: Profile, variant: Variant): Profile {
  // Rewrites address the MASTER's ids, so apply them before anything is filtered out.
  let out = applyRewrites(structuredClone(master), variant.rewrites ?? []);
  if (variant.headline) out.contact.headline = variant.headline;
  if (variant.summary) out.summary = variant.summary;
  if (variant.experience) {
    const byId = new Map(out.experience.map((e) => [e.id, e]));
    out.experience = variant.experience.flatMap((ve) => {
      const exp = byId.get(ve.id);
      if (!exp) return [];
      if (ve.bulletIds) {
        const bullets = new Map(exp.bullets.map((b) => [b.id, b]));
        exp.bullets = ve.bulletIds.flatMap((bid) => bullets.get(bid) ?? []);
      }
      return [exp];
    });
  }
  if (variant.projectIds) {
    const byId = new Map(out.projects.map((p) => [p.id, p]));
    out.projects = variant.projectIds.flatMap((pid) => byId.get(pid) ?? []);
  }
  if (variant.skillGroupIds) {
    const byId = new Map(out.skills.map((s) => [s.id, s]));
    out.skills = variant.skillGroupIds.flatMap((sid) => byId.get(sid) ?? []);
  }
  if (variant.customSectionIds) {
    const byId = new Map(out.customSections.map((s) => [s.id, s]));
    out.customSections = variant.customSectionIds.flatMap((sid) => byId.get(sid) ?? []);
  }
  if (variant.sectionOrder) out = { ...out, sectionOrder: variant.sectionOrder };
  return out;
}

/** A rewrite side left empty keeps the master's text in that language. Paths that no longer resolve are skipped. */
function applyRewrites(profile: Profile, rewrites: Variant["rewrites"]): Profile {
  let out = profile;
  for (const rw of rewrites) {
    if (!REWRITE_PATH.test(rw.path)) continue;
    let before: unknown;
    try {
      before = readPath(out, rw.path);
    } catch {
      continue;
    }
    if (!isBi(before)) continue;
    const value: Bi = { pl: rw.text.pl.trim() ? rw.text.pl : before.pl, en: rw.text.en.trim() ? rw.text.en : before.en };
    out = applyOps(out, [{ op: "set", path: rw.path, value }]).profile;
  }
  return out;
}

function isBi(value: unknown): value is Bi {
  return typeof value === "object" && value !== null && typeof (value as Bi).pl === "string" && typeof (value as Bi).en === "string";
}

/** Ids the variant references that the master profile no longer has. */
export function danglingIds(master: Profile, variant: Variant): string[] {
  const bad: string[] = [];
  const exp = new Map(master.experience.map((e) => [e.id, new Set(e.bullets.map((b) => b.id))]));
  for (const ve of variant.experience ?? []) {
    const bullets = exp.get(ve.id);
    if (!bullets) {
      bad.push(`experience:${ve.id}`);
      continue;
    }
    for (const b of ve.bulletIds ?? []) if (!bullets.has(b)) bad.push(`bullet:${ve.id}/${b}`);
  }
  const projects = new Set(master.projects.map((p) => p.id));
  for (const p of variant.projectIds ?? []) if (!projects.has(p)) bad.push(`project:${p}`);
  const skills = new Set(master.skills.map((s) => s.id));
  for (const s of variant.skillGroupIds ?? []) if (!skills.has(s)) bad.push(`skills:${s}`);
  const custom = new Set(master.customSections.map((s) => s.id));
  for (const s of variant.customSectionIds ?? []) if (!custom.has(s)) bad.push(`section:${s}`);
  for (const key of variant.sectionOrder ?? []) if (key.startsWith("custom:") && !custom.has(key.slice(7))) bad.push(`order:${key}`);
  for (const rw of variant.rewrites ?? []) {
    if (!REWRITE_PATH.test(rw.path)) {
      bad.push(`rewrite:${rw.path} (only bullet texts, project summaries, experience notes and custom item texts can be reworded)`);
      continue;
    }
    try {
      if (!isBi(readPath(master, rw.path))) bad.push(`rewrite:${rw.path}`);
    } catch {
      bad.push(`rewrite:${rw.path}`);
    }
  }
  return bad;
}

/** The order sections print in: the explicit order first, then every remaining section in the standard order. */
export function effectiveSectionOrder(profile: Profile): string[] {
  const all = [...BUILTIN_SECTIONS.slice(0, 3), ...profile.customSections.map((s) => `custom:${s.id}`), ...BUILTIN_SECTIONS.slice(3)];
  const wanted = (profile.sectionOrder ?? []).filter((k) => all.includes(k));
  return [...new Set([...wanted, ...all])];
}
