import { msg } from "@/lib/i18n/msg";
import type { IconName } from "@/components/category-icons";
import { ARTCRAFT_APPS } from "@/lib/services/definitions";

/**
 * The sidebar's layout (src/components/shell/Sidebar.tsx). Metadata only, like the registry; tests/nav.test.mjs keeps
 * the rules below true.
 *
 * Rules (research notes in docs/ARCHITECTURE.md "Sidebar"):
 * - One entry per destination: every tool is listed exactly once. A suite's tabs are local navigation: the sidebar shows
 *   them nested under the tool you are in, never as entries of their own. The one exception is the Craft apps section,
 *   whose suite hides its tabs on the page, so each app is listed once there instead of the suite.
 * - Sections are named by what people work on, with the key word first; no "simple/advanced" levels.
 * - Within a section: the big workspaces first, then the smaller tools by how often they are needed.
 * - Setup pages (services, MCP) are utilities: they sit in the footer, not in a section.
 */

export interface NavItem {
  slug: string;
  /** Only in a section that lists one suite's tabs (Craft apps). */
  tab?: string;
  /** Shown instead of the tool's or the tab's own name. */
  label?: string;
  /** A short second line of scent, e.g. what a Craft app is for. */
  hint?: string;
}

export interface NavSection {
  id: string;
  label: string;
  icon: IconName;
  items: NavItem[];
}

/** Craft apps grouped by medium: photos, graphics and design, video and audio, office documents, CAD. */
const CRAFT_ORDER = ["photocraft", "lightcraft", "vectorcraft", "figcraft", "designcraft", "filmcraft", "effectcraft", "soundcraft", "wordcraft", "gridcraft", "deckcraft", "pdfcraft", "cadcraft"];

/** The second line of a Craft app in the menu: what people know it as. */
const CRAFT_INSTEAD_OF: Record<string, string> = {
  photocraft: msg("instead of Photoshop"),
  lightcraft: msg("instead of Lightroom"),
  vectorcraft: msg("instead of Illustrator"),
  figcraft: msg("instead of Figma"),
  designcraft: msg("instead of InDesign"),
  filmcraft: msg("instead of Premiere"),
  effectcraft: msg("instead of After Effects"),
  soundcraft: msg("instead of Audition"),
  pdfcraft: msg("instead of Acrobat"),
  cadcraft: msg("instead of AutoCAD"),
};

const craftItems: NavItem[] = CRAFT_ORDER.flatMap((id) => {
  const app = ARTCRAFT_APPS.find((candidate) => candidate.id === id);
  return app ? [{ slug: "artcraft", tab: app.id, label: app.name, hint: CRAFT_INSTEAD_OF[app.id] ?? app.kind }] : [];
});

export const NAV: readonly NavSection[] = [
  { id: "documents", label: msg("Office and PDF"), icon: "documents", items: [{ slug: "office" }, { slug: "pdf" }] },
  { id: "career", label: msg("CV and job search"), icon: "career", items: [{ slug: "cv-studio" }] },
  { id: "craft", label: msg("Craft apps: photo, video, design"), icon: "craft", items: craftItems },
  { id: "images", label: msg("Quick picture tools"), icon: "images", items: [{ slug: "image-resize" }, { slug: "image-crop" }, { slug: "image-compare" }, { slug: "svg-optimize" }] },
  { id: "everyday", label: msg("Everyday helpers"), icon: "everyday", items: [{ slug: "ids" }, { slug: "qr" }, { slug: "dates" }] },
  { id: "text", label: msg("Text and writing"), icon: "text", items: [{ slug: "text" }, { slug: "diff" }, { slug: "markdown" }, { slug: "regex" }, { slug: "characters" }] },
  { id: "data", label: msg("Spreadsheets and data"), icon: "data", items: [{ slug: "csv" }, { slug: "json" }, { slug: "sql-lab" }] },
  { id: "dev", label: msg("Websites and code"), icon: "dev", items: [{ slug: "web" }, { slug: "css" }] },
  { id: "automate", label: msg("Automation and AI"), icon: "automate", items: [{ slug: "workflows" }, { slug: "mcp-connect" }] },
  { id: "learn", label: msg("Courses"), icon: "learn", items: [{ slug: "db-course" }] },
];

/** Utilities under the sections: setting up services and outside agents. */
export const NAV_FOOTER: readonly NavItem[] = [{ slug: "sidecars" }];

/** The section a tool is listed in (breadcrumbs use its label). */
export function navSectionOf(slug: string): NavSection | undefined {
  return NAV.find((section) => section.items.some((item) => item.slug === slug));
}
