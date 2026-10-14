import * as z from "zod/v4";

/**
 * CV studio data contract. One bilingual master profile per account, plus per-job variants, saved job offers and
 * tracked applications. Pure: imported by server routes, MCP tools and client components (no node/DOM APIs).
 * Every list item has a stable `id` so edits address it without index drift (see `ops.ts`).
 */

export const CV_LANGS = ["pl", "en"] as const;
export type CvLang = (typeof CV_LANGS)[number];

export const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const id = z.string().regex(ID_PATTERN, "id: lowercase letters, digits, '-' or '_' (max 64)");

/** A string in both languages. Empty = not written yet (reported by `missingTranslations`). */
export const biSchema = z.object({ pl: z.string().max(4_000).default(""), en: z.string().max(4_000).default("") }).strict();
export type Bi = z.infer<typeof biSchema>;
const bi = () => biSchema.default({ pl: "", en: "" });

export const bulletSchema = z.object({
  id,
  text: bi(),
  tags: z.array(z.string().max(60)).max(20).default([]),
  /** Provenance guard: true only after the user confirmed the claim. */
  verified: z.boolean().default(false),
  /** Priority: always kept and listed first when a version is tailored for a job. */
  pinned: z.boolean().default(false),
}).strict();

export const linkSchema = z.object({ label: z.string().max(120), url: z.string().max(500) }).strict();

export const contactSchema = z.object({
  name: z.string().max(120).default(""),
  headline: bi(),
  location: bi(),
  email: z.string().max(200).default(""),
  phone: z.string().max(60).default(""),
  links: z.array(linkSchema).max(12).default([]),
}).strict();

export const experienceSchema = z.object({
  id,
  org: z.string().max(200),
  role: bi(),
  start: z.string().max(10).default(""), // YYYY-MM
  end: z.string().max(10).nullable().default(null), // null = present
  location: z.string().max(120).default(""),
  note: bi(),
  bullets: z.array(bulletSchema).max(40).default([]),
  pinned: z.boolean().default(false),
}).strict();

export const projectSchema = z.object({
  id,
  name: z.string().max(200),
  url: z.string().max(500).default(""),
  summary: bi(),
  tech: z.array(z.string().max(60)).max(40).default([]),
  bullets: z.array(bulletSchema).max(40).default([]),
  /** Priority: always kept and listed first when a version is tailored for a job. */
  pinned: z.boolean().default(false),
  /** Where the facts came from, e.g. "github:owner/name" (set by "Add from GitHub"). */
  source: z.string().max(200).default(""),
}).strict();

export const skillGroupSchema = z.object({ id, name: bi(), items: z.array(z.string().max(80)).max(80).default([]), pinned: z.boolean().default(false) }).strict();
export const educationSchema = z.object({
  id,
  institution: z.string().max(200),
  detail: bi(),
  start: z.string().max(10).default(""),
  end: z.string().max(10).nullable().default(null),
}).strict();
export const spokenLanguageSchema = z.object({ id, name: bi(), level: bi() }).strict();

/** One entry of a user-defined section (open source, certificates, awards, publications…). */
export const customItemSchema = z.object({
  id,
  title: bi(),
  text: bi(),
  url: z.string().max(500).default(""),
  /** Free text such as "2025" or "03.2024 — 06.2024". */
  date: z.string().max(40).default(""),
  pinned: z.boolean().default(false),
}).strict();
/** A user-defined CV section, printed like the built-in ones. */
export const customSectionSchema = z.object({
  id,
  title: bi(),
  items: z.array(customItemSchema).max(40).default([]),
  pinned: z.boolean().default(false),
}).strict();
export type CustomSection = z.infer<typeof customSectionSchema>;

/** Built-in printable sections; a custom section is addressed as `custom:<id>`. */
export const BUILTIN_SECTIONS = ["summary", "experience", "projects", "skills", "education", "languages", "extras"] as const;
export type BuiltinSection = (typeof BUILTIN_SECTIONS)[number];
export const SECTION_KEY_PATTERN = /^(?:summary|experience|projects|skills|education|languages|extras|custom:[a-z0-9][a-z0-9_-]{0,63})$/;
const sectionOrder = () => z.array(z.string().regex(SECTION_KEY_PATTERN, "section: summary, experience, projects, skills, education, languages, extras or custom:<id>")).max(40).nullable().default(null);

export const profileSchema = z.object({
  contact: contactSchema.default(() => contactSchema.parse({})),
  summary: bi(),
  experience: z.array(experienceSchema).max(40).default([]),
  projects: z.array(projectSchema).max(40).default([]),
  skills: z.array(skillGroupSchema).max(20).default([]),
  education: z.array(educationSchema).max(20).default([]),
  languages: z.array(spokenLanguageSchema).max(20).default([]),
  /** RODO / GDPR clause, printed on Polish applications. */
  consent: bi(),
  /** Free-form "how I work" paragraph. */
  extras: bi(),
  /** User-defined sections (open source, certificates, awards…). */
  customSections: z.array(customSectionSchema).max(12).default([]),
  /** Print order of the sections; null = the standard order. Sections not listed are printed after the listed ones. */
  sectionOrder: sectionOrder(),
  /** Notes for tailoring, never printed: what to emphasise, what to downplay, positioning (read by the assistant). */
  guidance: z.string().max(4_000).default(""),
}).strict();
export type Profile = z.infer<typeof profileSchema>;

/** A per-job overlay on the master profile: pick/reorder items, override headline/summary. `null` = keep all. */
export const variantSchema = z.object({
  id,
  name: z.string().max(200),
  lang: z.enum(CV_LANGS).default("pl"),
  target: z.string().max(300).default(""),
  jobId: id.nullable().default(null),
  headline: biSchema.nullable().default(null),
  summary: biSchema.nullable().default(null),
  experience: z.array(z.object({ id, bulletIds: z.array(id).nullable().default(null) }).strict()).nullable().default(null),
  projectIds: z.array(id).nullable().default(null),
  skillGroupIds: z.array(id).nullable().default(null),
  customSectionIds: z.array(id).nullable().default(null),
  /** Print order for this version; null = the profile's order. */
  sectionOrder: sectionOrder(),
  /**
   * Per-version wording: replaces one text of the master profile in this version only (the master is untouched).
   * Paths: see REWRITE_PATH (bullet text, project summary, experience note, custom item text). Facts must be kept.
   */
  rewrites: z.array(z.object({ path: z.string().max(300), text: biSchema }).strict()).max(200).default([]),
  notes: z.string().max(4_000).default(""),
}).strict();
export type Variant = z.infer<typeof variantSchema>;

/** Texts a variant may reword: bullet texts, project summaries, experience notes, custom item texts. */
export const REWRITE_PATH = /^\/(?:experience\/id=[a-z0-9][a-z0-9_-]{0,63}\/(?:bullets\/id=[a-z0-9][a-z0-9_-]{0,63}\/text|note)|projects\/id=[a-z0-9][a-z0-9_-]{0,63}\/(?:summary|bullets\/id=[a-z0-9][a-z0-9_-]{0,63}\/text)|customSections\/id=[a-z0-9][a-z0-9_-]{0,63}\/items\/id=[a-z0-9][a-z0-9_-]{0,63}\/text)$/;

/** A skill the posting names (job boards list them with a level). */
export const jobSkillSchema = z.object({
  name: z.string().max(120),
  /** Board level, e.g. justjoin.it 1-5 (nice to have … master); null = not stated. */
  level: z.number().int().min(0).max(10).nullable().default(null),
  required: z.boolean().default(true),
}).strict();
export type JobSkill = z.infer<typeof jobSkillSchema>;

export const JOB_LANGS = ["pl", "en", "unknown"] as const;
export const jobSchema = z.object({
  id,
  url: z.string().max(2_000).default(""),
  title: z.string().max(300).default(""),
  company: z.string().max(300).default(""),
  location: z.string().max(300).default(""),
  lang: z.enum(JOB_LANGS).default("unknown"),
  text: z.string().max(120_000).default(""),
  /** Requirement lines extracted by the assistant and saved back, so matching is sharp. */
  requirements: z.array(z.string().max(500)).max(80).default([]),
  niceToHave: z.array(z.string().max(500)).max(80).default([]),
  /** Structured skills from the board (justjoin.it lists them with levels). */
  skills: z.array(jobSkillSchema).max(80).default([]),
  seniority: z.string().max(60).default(""),
  /** remote / hybrid / office */
  workplace: z.string().max(60).default(""),
  salary: z.string().max(300).default(""),
  /** Spoken languages the offer asks for, e.g. "en B2". */
  languages: z.array(z.string().max(60)).max(10).default([]),
  /** Where to apply, when the board says (often the company's ATS). */
  applyUrl: z.string().max(2_000).default(""),
  /** The company's own website (optional, given by the user or the board). */
  companyUrl: z.string().max(2_000).default(""),
  /** Readable text of the company website (fetched once; context for tailoring, never printed). */
  companyText: z.string().max(20_000).default(""),
  /** The user's own notes: pasted details, recruiter call, what they care about. Read when tailoring. */
  notes: z.string().max(20_000).default(""),
  source: z.enum(["url", "paste", "justjoin", "nofluffjobs"]).default("paste"),
  savedAt: z.string().max(40).default(""), // ISO
}).strict();
export type Job = z.infer<typeof jobSchema>;

export const APPLICATION_STATUSES = ["wishlist", "applied", "screening", "interview", "offer", "rejected", "withdrawn", "ghosted"] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];
export const OPEN_STATUSES: readonly ApplicationStatus[] = ["wishlist", "applied", "screening", "interview"];
/** Statuses that mean "sent and still alive": the ones that count as an open application in progress. */
export const IN_PROGRESS_STATUSES: readonly ApplicationStatus[] = ["applied", "screening", "interview"];

export const applicationSchema = z.object({
  id,
  company: z.string().max(300),
  role: z.string().max(300),
  status: z.enum(APPLICATION_STATUSES).default("wishlist"),
  url: z.string().max(2_000).default(""),
  jobId: id.nullable().default(null),
  variantId: id.nullable().default(null),
  lang: z.enum(CV_LANGS).default("pl"),
  nextAction: z.string().max(500).default(""),
  nextActionDue: z.string().max(10).nullable().default(null), // YYYY-MM-DD
  /** The day the application was sent (YYYY-MM-DD). Filled automatically when the status becomes "applied"; null = not applied or unknown. */
  appliedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "appliedOn: YYYY-MM-DD").nullable().default(null),
  notes: z.string().max(4_000).default(""),
  history: z.array(z.object({ on: z.string().max(10), status: z.enum(APPLICATION_STATUSES), note: z.string().max(500).default("") }).strict()).max(200).default([]),
}).strict();
export type Application = z.infer<typeof applicationSchema>;

export const cvDataSchema = z.object({
  version: z.literal(1),
  /** Bumped on every save; the UI polls it to show the assistant's changes live. */
  revision: z.number().int().min(0).default(0),
  profile: profileSchema.default(() => profileSchema.parse({})),
  variants: z.array(variantSchema).max(200).default([]),
  jobs: z.array(jobSchema).max(500).default([]),
  applications: z.array(applicationSchema).max(1_000).default([]),
}).strict();
export type CvData = z.infer<typeof cvDataSchema>;

export function emptyCvData(): CvData {
  return cvDataSchema.parse({ version: 1 });
}
