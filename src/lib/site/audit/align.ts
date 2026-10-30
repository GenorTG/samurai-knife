import { msg, msgf } from "@/lib/i18n/msg";
import type { CvData } from "@/lib/cv/schema";
import { hostOf, isProfileUrl, linkPresent, normalizeUrl } from "./links";
import type { Alignment, AlignmentItem, Issue } from "./types";

/**
 * CV <-> website alignment (pure): which facts of the CV studio profile the site shows, and which tech words the site
 * uses that the CV does not list. Matching is accent- and case-insensitive on whole words; a multi-word item matches
 * when all of its significant words are present.
 */

export function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9+#.]+/g, " ")
    // A dot stays only inside a name (next.js, llama.cpp), not at the end of a sentence.
    .replace(/\.(?![a-z0-9])|(?<![a-z0-9])\./g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP = new Set(["the", "and", "for", "with", "and", "of", "a", "an", "to", "in", "on", "i", "oraz", "dla", "w", "z", "na", "do", "i", "o", "od", "po", "się", "sie", "jako"]);

function present(haystack: string, needle: string): boolean {
  const words = fold(needle).split(" ").filter((w) => w.length > 1 && !STOP.has(w));
  if (!words.length) return false;
  const padded = ` ${haystack} `;
  return words.every((w) => padded.includes(` ${w} `) || (w.length >= 6 && padded.includes(` ${w.slice(0, -2)}`)));
}

/** Technology names worth noticing on a site (lower case, folded). */
export const TECH_WORDS = [
  "python", "typescript", "javascript", "react", "next.js", "nextjs", "node.js", "nodejs", "docker", "kubernetes", "terraform", "aws", "azure", "gcp",
  "postgresql", "postgres", "mongodb", "redis", "linux", "tailscale", "ollama", "llama.cpp", "lm studio", "comfyui", "openclaw", "langchain", "pytorch",
  "tensorflow", "fastapi", "django", "flask", "vue", "angular", "svelte", "tailwind", "three.js", "godot", "unity", "rust", "go", "java", "c#", ".net",
  "home assistant", "nextcloud", "n8n", "openai", "claude", "rag", "lora", "fine-tuning", "gguf", "vercel", "supabase", "firebase", "graphql", "kotlin", "android", "ios", "flutter",
];

/**
 * `siteLinks`: every link target the audited pages carry (anchors and JSON-LD url/sameAs), `siteOrigin`: the audited
 * site, so a CV link to the site itself counts as present.
 */
export function alignCvWithSite(cv: CvData, siteText: string, siteLinks: string[], siteEmails: string[], siteOrigin = ""): Alignment {
  const p = cv.profile;
  const hay = fold(siteText);
  const items: AlignmentItem[] = [];
  const add = (kind: AlignmentItem["kind"], label: string, onSite: boolean, url?: string) => items.push(url ? { kind, label, onSite, url } : { kind, label, onSite });
  const siteHost = hostOf(normalizeUrl(siteOrigin));
  const linkOnSite = (url: string): boolean => {
    const n = normalizeUrl(url);
    if (!n) return false;
    if (siteHost && n === siteHost) return true;
    // A URL written out in the page text ("github.com/jan") counts too.
    return linkPresent(url, siteLinks) || ` ${hay} `.includes(` ${fold(n)} `);
  };
  if (p.contact.name) add("name", p.contact.name, present(hay, p.contact.name));
  for (const headline of [p.contact.headline.pl, p.contact.headline.en].filter(Boolean)) {
    // A headline matches when at least half of its significant words appear.
    const words = fold(headline).split(" ").filter((w) => w.length > 3 && !STOP.has(w));
    const hits = words.filter((w) => ` ${hay} `.includes(` ${w}`)).length;
    add("headline", headline, words.length > 0 && hits / words.length >= 0.5);
  }
  for (const job of p.experience.filter((e) => e.end === null)) {
    add("role", [job.role.en || job.role.pl, job.org].filter(Boolean).join(" @ "), present(hay, job.org) || present(hay, job.role.pl) || present(hay, job.role.en));
  }
  const projects = [...p.projects].sort((a, b) => Number(b.pinned) - Number(a.pinned)).slice(0, 12);
  for (const project of projects) add("project", project.name, present(hay, project.name) || (!!project.url && linkPresent(project.url, siteLinks)));
  const groups = [...p.skills].sort((a, b) => Number(b.pinned) - Number(a.pinned));
  for (const skill of groups.flatMap((g) => g.items).slice(0, 30)) add("skill", skill, present(hay, skill));
  for (const link of p.contact.links.filter((l) => normalizeUrl(l.url))) {
    // Profiles (a LinkedIn or GitHub account) belong on a personal site; other pages (a github.io demo, a live app) are
    // project links, reported apart and only when the site names neither the link nor the page.
    if (isProfileUrl(link.url)) add("link", link.label || link.url, linkOnSite(link.url), link.url);
    else if (hostOf(normalizeUrl(link.url)) !== siteHost) add("projectLink", link.label || link.url, linkOnSite(link.url), link.url);
  }
  if (p.contact.email) add("email", p.contact.email, siteEmails.some((e) => e.toLowerCase().includes(p.contact.email.toLowerCase())) || hay.includes(fold(p.contact.email)));

  const cvWords = fold([JSON.stringify(p.skills), JSON.stringify(p.projects.map((x) => x.tech)), p.summary.en, p.summary.pl].join(" "));
  const siteOnly = TECH_WORDS.filter((t) => ` ${hay} `.includes(` ${fold(t)} `) && !` ${cvWords} `.includes(` ${fold(t)} `));

  if (!items.length) return { score: 0, items, siteOnly, note: msg("The CV studio profile is empty: fill it (or import your CV) to compare it with the site.") };
  // Weights: who you are and what you do now count most, then projects, then skills.
  const weight: Record<AlignmentItem["kind"], number> = { name: 3, headline: 3, role: 3, email: 1, link: 1, projectLink: 0.5, project: 2, skill: 0.5 };
  const total = items.reduce((n, i) => n + weight[i.kind], 0);
  const got = items.reduce((n, i) => n + (i.onSite ? weight[i.kind] : 0), 0);
  return { score: Math.round((got / total) * 100), items, siteOnly, note: "" };
}

export function alignmentIssues(a: Alignment): Issue[] {
  const out: Issue[] = [];
  const missing = (kind: AlignmentItem["kind"]) => a.items.filter((i) => i.kind === kind && !i.onSite).map((i) => i.label);
  const add = (id: string, severity: Issue["severity"], title: string, detail: string, fix: string) => out.push({ id, severity, category: "alignment", title, detail, page: "", fix });
  const roles = missing("role");
  if (roles.length) add("align.role", "high", msg("The site does not show your current role"), roles.join("; "), msg("Say what you do now (role and company or your own business) in the hero or About section."));
  const heads = missing("headline");
  if (heads.length && heads.length === a.items.filter((i) => i.kind === "headline").length) add("align.headline", "medium", msg("The CV headline is not reflected on the site"), heads.join(" | "), msg("Use the same positioning line (or a sharper version) on the site so recruiters see one story."));
  const projects = missing("project");
  if (projects.length) add("align.projects", projects.length > 2 ? "high" : "medium", msgf("{length} CV project(s) are not on the site", { length: projects.length }), projects.slice(0, 10).join(", "), msg("Showcase them: one card each with the problem, what you built, the result and a link."));
  const skills = missing("skill");
  const skillCount = a.items.filter((i) => i.kind === "skill").length;
  if (skillCount && skills.length / skillCount > 0.5) add("align.skills", "low", msgf("{length} of {skillCount} CV skills are not mentioned", { length: skills.length, skillCount }), skills.slice(0, 15).join(", "), msg("Name the key skills where you describe projects or services."));
  const named = (kind: AlignmentItem["kind"]) => a.items.filter((i) => i.kind === kind && !i.onSite).map((i) => (i.url && i.url !== i.label ? `${i.label} (${i.url})` : i.label));
  const links = named("link");
  if (links.length) add("align.links", "medium", msg("Profile links from the CV are missing on the site"), links.join(", "), msgf("Link {links} from the site (a visible link, and in JSON-LD sameAs).", { links: links.join(", ") }));
  const projectLinks = named("projectLink");
  if (projectLinks.length) add("align.project-links", "low", msg("Project pages linked in the CV are not linked from the site"), projectLinks.join(", "), msgf("Link {links} where you describe that project (optional: they are project pages, not profiles).", { links: projectLinks.join(", ") }));
  if (a.siteOnly.length) add("align.site-only", "low", msgf("The site names tech the CV does not list: {value}", { value: a.siteOnly.slice(0, 8).join(", ") }), msg("Either the CV misses current skills or the site shows old ones."), msg("Add them to the CV skills (CV studio) or update the site copy."));
  return out;
}
