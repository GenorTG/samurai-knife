/** Shapes of a website audit (docs/WEBSITE-STUDIO.md "Audit"). Pure types, shared by server, MCP and the UI. */

export type IssueSeverity = "high" | "medium" | "low";
export type IssueCategory = "seo" | "content" | "copy" | "accessibility" | "security" | "performance" | "alignment" | "lighthouse";

export interface Issue {
  /** Stable kind, e.g. "seo.title.missing": the same problem keeps its id between runs (progress tracking). */
  id: string;
  severity: IssueSeverity;
  category: IssueCategory;
  title: string;
  detail: string;
  /** Page URL the issue was found on; "" = the site as a whole. */
  page: string;
  /** What to change, in one sentence. */
  fix: string;
}

export interface HeadingItem {
  level: number;
  text: string;
}

export interface PageFacts {
  url: string;
  finalUrl: string;
  status: number;
  bytes: number;
  ttfbMs: number;
  redirects: number;
  lang: string;
  title: string;
  metaDescription: string;
  canonical: string;
  robotsMeta: string;
  viewport: boolean;
  og: Record<string, string>;
  twitterCard: string;
  jsonLdTypes: string[];
  hreflang: { lang: string; href: string }[];
  favicon: boolean;
  headings: HeadingItem[];
  images: { count: number; missingAlt: number };
  links: {
    internal: number;
    external: number;
    emptyText: number;
    genericText: number;
    contacts: string[];
    profiles: string[];
    /** Every absolute http(s) link target of the page (anchors), capped; optional in runs stored before 0.13. */
    all?: string[];
    /** http(s) URLs named in JSON-LD (url, sameAs, any string value), capped. */
    jsonLd?: string[];
  };
  scripts: { external: number; inlineBytes: number };
  stylesheets: number;
  /** Visible text (header, nav, footer and buttons included: CTAs live there), capped. */
  text: string;
  wordCount: number;
  /** Texts of links/buttons that ask the reader to act. */
  ctas: string[];
}

export interface CopyMetrics {
  lang: "pl" | "en" | "unknown";
  words: number;
  sentences: number;
  avgSentenceWords: number;
  longSentenceShare: number;
  /** EN: Flesch reading ease (higher = easier). PL: FOG-PL (Pisarek; grade-like, lower = easier). */
  readability: { formula: "flesch" | "fog-pl" | "none"; value: number; label: string };
  ctaCount: number;
  proofSignals: number;
  youShare: number;
  buzzwords: string[];
  newestYear: number | null;
  copyrightYear: number | null;
  /** 0-100 per dimension and the weighted total. */
  scores: Record<"readability" | "sentences" | "hero" | "cta" | "proof" | "focus" | "buzzwords" | "substance", number>;
  score: number;
}

export interface AlignmentItem {
  /** link = a profile (LinkedIn, GitHub account...); projectLink = any other page the CV links (a github.io demo, an app). */
  kind: "name" | "headline" | "role" | "project" | "skill" | "link" | "projectLink" | "email";
  /** The URL behind a link item, so a finding can name it. */
  url?: string;
  label: string;
  onSite: boolean;
}

export interface Alignment {
  score: number;
  items: AlignmentItem[];
  /** Tech words on the site that the CV does not list (a CV gap or stale site copy). */
  siteOnly: string[];
  note: string;
}

export interface LighthouseResult {
  strategy: "mobile" | "desktop";
  ok: boolean;
  error: string;
  /** 0-100 per Lighthouse category. */
  scores: Partial<Record<"performance" | "accessibility" | "best-practices" | "seo", number>>;
  metrics: Partial<Record<"fcp" | "lcp" | "tbt" | "cls" | "si", string>>;
  /** Failing audits, heaviest first. */
  failing: { id: string; title: string; display: string; score: number }[];
  /** PageSpeed runs behind this result (the median one is kept); 1 when absent. */
  runs?: number;
  /** Lowest and highest performance score over those runs. */
  spread?: { min: number; max: number };
}

/** An audited path that is not a web page (robots.txt, a sitemap, llms.txt, any other file): checked as a file only. */
export interface ResourceCheck {
  path: string;
  url: string;
  kind: "html" | "robots" | "sitemap" | "llms" | "file";
  status: number;
  contentType: string;
}

export interface SiteFacts {
  origin: string;
  httpsRedirect: boolean | null;
  robots: { status: number; sitemaps: string[]; blocksAll: boolean };
  sitemap: { url: string; status: number; urls: number };
  notFoundStatus: number;
  securityHeaders: Record<string, boolean>;
}

export type ScoreKey = "overall" | "seo" | "copy" | "alignment" | "security" | "performance" | "accessibility" | "bestPractices" | "lighthouseSeo";

export interface AuditRun {
  id: string;
  startedAt: string;
  finishedAt: string;
  /** "production" | "preview" | "custom" */
  target: string;
  baseUrl: string;
  scores: Partial<Record<ScoreKey, number>>;
  issues: Issue[];
  pages: (Omit<PageFacts, "text"> & { textPreview: string; copy: CopyMetrics })[];
  site: SiteFacts | null;
  lighthouse: LighthouseResult[];
  alignment: Alignment | null;
  notes: string[];
  /** Audited paths answered by something other than HTML: no page/copy/accessibility checks, no effect on those scores. */
  resources?: ResourceCheck[];
}
