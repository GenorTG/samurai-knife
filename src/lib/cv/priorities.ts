import type { Profile, Variant } from "./schema";
import { effectiveSectionOrder, resolveVariant } from "./variant";

/**
 * Does a CV version respect what the user marked as a priority? Pinned roles, bullets, projects, skill groups and own
 * sections must be in it, pinned projects lead the project list, and when a project is pinned (and the user did not
 * fix the section order themselves) projects print before experience. One readable warning per breach. Pure.
 */
export function priorityWarnings(master: Profile, variant: Variant): string[] {
  const out: string[] = [];
  const v = resolveVariant(master, variant);
  const has = <T extends { id: string }>(list: readonly T[], id: string) => list.some((x) => x.id === id);

  for (const e of master.experience) {
    const kept = v.experience.find((x) => x.id === e.id);
    if (e.pinned && !kept) out.push(`Pinned role “${e.org}” is left out: add it back (experience).`);
    if (!kept) continue;
    for (const b of e.bullets) if (b.pinned && !has(kept.bullets, b.id)) out.push(`Pinned bullet /experience/id=${e.id}/bullets/id=${b.id} is left out: add it back.`);
  }
  const pinnedProjects = master.projects.filter((p) => p.pinned);
  for (const p of pinnedProjects) if (!has(v.projects, p.id)) out.push(`Pinned project “${p.name}” is left out: add it to projectIds.`);
  const keptPinned = v.projects.filter((p) => p.pinned).length;
  if (keptPinned && v.projects.slice(0, keptPinned).some((p) => !p.pinned)) out.push("Pinned projects must lead the project list: put them first in projectIds.");
  for (const g of master.skills) if (g.pinned && !has(v.skills, g.id)) out.push(`Pinned skill group “${g.name.pl || g.name.en || g.id}” is left out: add it to skillGroupIds.`);
  for (const c of master.customSections) if (c.pinned && !has(v.customSections, c.id)) out.push(`Pinned section “${c.title.pl || c.title.en || c.id}” is left out: add it to customSectionIds.`);

  // roles keep the profile's order (newest first, as the user arranged them): reordering reads as hiding dates
  const masterOrder = master.experience.map((e) => e.id);
  const kept = v.experience.map((e) => e.id);
  const expected = masterOrder.filter((id) => kept.includes(id));
  if (kept.some((id, i) => id !== expected[i])) out.push(`Roles are reordered (${kept.join(", ")}); keep the profile's order (${expected.join(", ")}) unless the user asked otherwise: recruiters and parsers read roles newest first.`);

  if (pinnedProjects.length && !master.sectionOrder) {
    const order = effectiveSectionOrder(v);
    if (order.indexOf("projects") > order.indexOf("experience")) {
      out.push("A project is pinned, so projects print before experience: set sectionOrder with 'projects' before 'experience' (unless the user asked otherwise).");
    }
  }
  return out;
}
