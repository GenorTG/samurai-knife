import type { Profile, Variant } from "../../lib/cv/schema";
import { danglingIds } from "../../lib/cv/variant";

/**
 * Pure helpers for the CV-versions editor. A stored Variant is an overlay where `null` = "keep everything"; the editor works
 * on an explicit selection (ordered ids) and writes back `null` whenever the selection equals the master, so new master items
 * keep flowing into such a version. Relative imports only (node test loader).
 */

export interface Selection {
  experience: { id: string; bulletIds: string[] }[];
  projectIds: string[];
  skillGroupIds: string[];
  customSectionIds: string[];
}

export function selectionOf(master: Profile, v: Variant): Selection {
  const roleById = new Map(master.experience.map((e) => [e.id, e]));
  const experience = (v.experience ?? master.experience.map((e) => ({ id: e.id, bulletIds: null }))).flatMap((ve) => {
    const role = roleById.get(ve.id);
    return role ? [{ id: ve.id, bulletIds: (ve.bulletIds ?? role.bullets.map((b) => b.id)).filter((b) => role.bullets.some((x) => x.id === b)) }] : [];
  });
  return {
    experience,
    projectIds: (v.projectIds ?? master.projects.map((p) => p.id)).filter((id) => master.projects.some((p) => p.id === id)),
    skillGroupIds: (v.skillGroupIds ?? master.skills.map((s) => s.id)).filter((id) => master.skills.some((s) => s.id === id)),
    customSectionIds: (v.customSectionIds ?? master.customSections.map((s) => s.id)).filter((id) => master.customSections.some((s) => s.id === id)),
  };
}

const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

export function applySelection(master: Profile, v: Variant, sel: Selection): Variant {
  const everyRole = same(sel.experience.map((e) => e.id), master.experience.map((e) => e.id));
  const everyBullet = everyRole && sel.experience.every((e, i) => same(e.bulletIds, master.experience[i].bullets.map((b) => b.id)));
  const projectsAll = same(sel.projectIds, master.projects.map((p) => p.id));
  const skillsAll = same(sel.skillGroupIds, master.skills.map((s) => s.id));
  const customAll = same(sel.customSectionIds, master.customSections.map((s) => s.id));
  return {
    ...v,
    experience: everyBullet ? null : sel.experience.map((e) => ({ id: e.id, bulletIds: e.bulletIds })),
    projectIds: projectsAll ? null : sel.projectIds,
    skillGroupIds: skillsAll ? null : sel.skillGroupIds,
    customSectionIds: customAll ? null : sel.customSectionIds,
  };
}

/** Add `id` at the position it has in `masterOrder` relative to the ids already selected. */
export function insertByMasterOrder(list: readonly string[], id: string, masterOrder: readonly string[]): string[] {
  const rank = (x: string): number => masterOrder.indexOf(x);
  const at = list.findIndex((x) => rank(x) > rank(id));
  return at < 0 ? [...list, id] : [...list.slice(0, at), id, ...list.slice(at)];
}

export function toggleId(list: readonly string[], id: string, masterOrder: readonly string[]): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : insertByMasterOrder(list, id, masterOrder);
}

export function moveId(list: readonly string[], id: string, delta: -1 | 1): string[] {
  const i = list.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return [...list];
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

export function toggleRole(master: Profile, sel: Selection, roleId: string): Selection {
  if (sel.experience.some((e) => e.id === roleId)) return { ...sel, experience: sel.experience.filter((e) => e.id !== roleId) };
  const role = master.experience.find((e) => e.id === roleId);
  if (!role) return sel;
  const order = insertByMasterOrder(sel.experience.map((e) => e.id), roleId, master.experience.map((e) => e.id));
  const withNew = [...sel.experience, { id: roleId, bulletIds: role.bullets.map((b) => b.id) }];
  return { ...sel, experience: order.map((id) => withNew.find((e) => e.id === id) as { id: string; bulletIds: string[] }) };
}

export function moveRole(sel: Selection, roleId: string, delta: -1 | 1): Selection {
  const ids = moveId(sel.experience.map((e) => e.id), roleId, delta);
  return { ...sel, experience: ids.map((id) => sel.experience.find((e) => e.id === id) as { id: string; bulletIds: string[] }) };
}

export function updateBullets(master: Profile, sel: Selection, roleId: string, action: { toggle: string } | { move: string; delta: -1 | 1 }): Selection {
  const role = master.experience.find((e) => e.id === roleId);
  if (!role) return sel;
  const masterOrder = role.bullets.map((b) => b.id);
  return {
    ...sel,
    experience: sel.experience.map((e) => {
      if (e.id !== roleId) return e;
      return { ...e, bulletIds: "toggle" in action ? toggleId(e.bulletIds, action.toggle, masterOrder) : moveId(e.bulletIds, action.move, action.delta) };
    }),
  };
}

/** Drop references to ids the master profile no longer has (what `danglingIds` reports). */
export function pruneDangling(master: Profile, v: Variant): Variant {
  const sel = selectionOf(master, v);
  const custom = new Set(master.customSections.map((s) => s.id));
  const bad = new Set(danglingIds(master, v).filter((d) => d.startsWith("rewrite:")).map((d) => d.slice(8).split(" ")[0]));
  return {
    ...v,
    experience: v.experience === null ? null : sel.experience.map((e) => ({ id: e.id, bulletIds: e.bulletIds })),
    projectIds: v.projectIds === null ? null : sel.projectIds,
    skillGroupIds: v.skillGroupIds === null ? null : sel.skillGroupIds,
    customSectionIds: v.customSectionIds === null ? null : sel.customSectionIds,
    sectionOrder: v.sectionOrder === null ? null : v.sectionOrder.filter((k) => !k.startsWith("custom:") || custom.has(k.slice(7))),
    rewrites: v.rewrites.filter((r) => !bad.has(r.path)),
  };
}

/** Counts shown in the editor summary. */
export function selectionCounts(sel: Selection): { roles: number; bullets: number; projects: number; skills: number } {
  return { roles: sel.experience.length, bullets: sel.experience.reduce((n, e) => n + e.bulletIds.length, 0), projects: sel.projectIds.length, skills: sel.skillGroupIds.length };
}
