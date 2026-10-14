import type { CvLang, Profile, Variant } from "../schema";
import { effectiveSectionOrder } from "../variant";
import { analyze, termWeight, type Analysis, type JobInput } from "./match";

/**
 * Rank master-profile content by match evidence and propose a Variant spec (never saved here).
 * The model adjusts the proposal, writes headline/summary prose, then calls `knife_cv_variant_create`.
 * Pure; relative imports only.
 */

export const MAX_PROJECTS = 3;
export const MIN_BULLETS_PER_ROLE = 2;

export interface BulletScore {
  /** /experience/id=x/bullets/id=y */
  path: string;
  score: number;
  matchedTerms: string[];
  verified: boolean;
  /** bullet has no text in the requested language */
  needsTranslation: boolean;
}

export interface Suggestion {
  variant: Variant;
  /** Items the user pinned: always kept, listed first. */
  pinned: string[];
  bulletScores: BulletScore[];
  projectScores: Record<string, number>;
  droppedSkillGroups: string[];
  matchedRequired: string[];
  missingRequired: string[];
  notes: string[];
}

/** Evidence weight per owner path (bullet / project / role / skill group), and the terms that produced it. */
function ownerScores(an: Analysis): { score: Map<string, number>; terms: Map<string, string[]> } {
  const score = new Map<string, number>();
  const terms = new Map<string, string[]>();
  for (const t of an.terms) {
    const owners = new Set((an.hits.get(t.key) ?? []).map((u) => u.owner));
    for (const owner of owners) {
      score.set(owner, (score.get(owner) ?? 0) + termWeight(t));
      terms.set(owner, [...(terms.get(owner) ?? []), t.label]);
    }
  }
  return { score, terms };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function suggestVariant(profile: Profile, job: JobInput, lang: CvLang, maxBulletsPerRole = 4): Suggestion {
  const cap = Math.max(1, Math.floor(maxBulletsPerRole));
  const an = analyze(profile, job, lang);
  const { score, terms } = ownerScores(an);
  const scoreOf = (owner: string): number => score.get(owner) ?? 0;
  const notes: string[] = [];

  const experience: { id: string; bulletIds: string[] }[] = [];
  const bulletScores: BulletScore[] = [];
  for (const exp of profile.experience) {
    const base = `/experience/id=${exp.id}/bullets/id=`;
    // score desc; ties keep master order
    const ranked = exp.bullets.map((b, i) => ({ b, i })).sort((x, y) => scoreOf(base + y.b.id) - scoreOf(base + x.b.id) || x.i - y.i).map((x) => x.b);
    // pinned bullets are always kept (and lead); the cap applies to the rest
    // a pinned role keeps every bullet
    const chosen = exp.pinned ? [...exp.bullets] : [...ranked.filter((b) => b.pinned), ...ranked.filter((b) => !b.pinned && scoreOf(base + b.id) > 0).slice(0, cap)];
    const floor = Math.min(MIN_BULLETS_PER_ROLE, cap, exp.bullets.length);
    for (const b of ranked) {
      // a role with <2 bullets reads as empty: pad with the next best
      if (chosen.length >= floor) break;
      if (!chosen.includes(b)) chosen.push(b);
    }
    for (const b of chosen) {
      bulletScores.push({ path: base + b.id, score: round2(scoreOf(base + b.id)), matchedTerms: terms.get(base + b.id) ?? [], verified: b.verified, needsTranslation: !b.text[lang] });
    }
    experience.push({ id: exp.id, bulletIds: chosen.map((b) => b.id) });
  }

  const projectScores: Record<string, number> = {};
  for (const p of profile.projects) {
    const s = scoreOf(`/projects/id=${p.id}`);
    if (s > 0) projectScores[p.id] = round2(s);
  }
  const pinnedProjects = profile.projects.filter((p) => p.pinned).map((p) => p.id);
  const scoredProjects = Object.keys(projectScores).filter((id) => !pinnedProjects.includes(id)).sort((a, b) => projectScores[b] - projectScores[a]);
  const projectIds = [...pinnedProjects, ...scoredProjects.slice(0, Math.max(0, MAX_PROJECTS - pinnedProjects.length))];
  if (profile.projects.length && !projectIds.length) notes.push("No project matches the posting: projectIds left unset (= keep all).");

  const hitGroups = profile.skills.filter((g) => g.pinned || scoreOf(`/skills/id=${g.id}`) > 0);
  let dropped = profile.skills.filter((g) => !hitGroups.includes(g)).map((g) => g.id);
  if (profile.skills.length && !hitGroups.length) {
    notes.push("No skill group matches the posting: skillGroupIds left unset (= keep all).");
    dropped = [];
  }

  if (!(job.requirements.length || job.niceToHave.length)) notes.push("Job has no saved requirements; ranking used the raw posting text (noisier).");
  // Projects before experience when they carry more of this job's evidence, or the user pinned one, unless the
  // user fixed the order in the profile themselves.
  const projectEvidence = profile.projects.reduce((n, p) => n + scoreOf(`/projects/id=${p.id}`) + p.bullets.reduce((m, b) => m + scoreOf(`/projects/id=${p.id}/bullets/id=${b.id}`), 0), 0);
  const experienceEvidence = bulletScores.reduce((n, b) => n + b.score, 0) + profile.experience.reduce((n, e) => n + scoreOf(`/experience/id=${e.id}`), 0);
  let sectionOrder: string[] | null = null;
  if (!profile.sectionOrder && profile.projects.length && (pinnedProjects.length > 0 || projectEvidence > experienceEvidence)) {
    const order = effectiveSectionOrder(profile).filter((k) => k !== "projects");
    order.splice(order.indexOf("experience"), 0, "projects");
    sectionOrder = order;
    notes.push(pinnedProjects.length ? "Projects are printed before experience: you pinned a project." : "Projects are printed before experience: they match this posting better than the roles do.");
  }

  if (bulletScores.some((s) => s.needsTranslation)) notes.push(`Some selected bullets have no '${lang}' text: translate them before rendering.`);

  const required = an.terms.filter((t) => t.section === "required");
  const hit = (key: string): boolean => (an.hits.get(key) ?? []).length > 0;
  const title = job.title ?? "";
  const company = job.company ?? "";
  const variant: Variant = {
    id: `${job.id}-${lang}`.slice(0, 64),
    name: ([company, title].filter(Boolean).join(" ") || job.id).slice(0, 200),
    lang,
    target: ([title, company].filter(Boolean).join(" @ ") || job.url || "").slice(0, 300),
    jobId: job.id,
    headline: null,
    summary: null,
    experience: experience.length ? experience : null,
    projectIds: projectIds.length ? projectIds : null,
    skillGroupIds: hitGroups.length ? hitGroups.map((g) => g.id) : null,
    customSectionIds: null,
    sectionOrder,
    rewrites: [],
    notes: "",
  };
  const pinned = [
    ...profile.experience.flatMap((e) => [...(e.pinned ? [`/experience/id=${e.id}`] : []), ...e.bullets.filter((b) => b.pinned).map((b) => `/experience/id=${e.id}/bullets/id=${b.id}`)]),
    ...pinnedProjects.map((id) => `/projects/id=${id}`),
    ...profile.skills.filter((g) => g.pinned).map((g) => `/skills/id=${g.id}`),
    ...profile.customSections.filter((c) => c.pinned).map((c) => `/customSections/id=${c.id}`),
  ];
  return {
    variant,
    pinned,
    bulletScores,
    projectScores,
    droppedSkillGroups: dropped,
    matchedRequired: required.filter((t) => hit(t.key)).map((t) => t.label),
    missingRequired: required.filter((t) => !hit(t.key)).map((t) => t.label),
    notes,
  };
}
