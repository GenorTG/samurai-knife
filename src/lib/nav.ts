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

const craftItems: NavItem[] = CRAFT_ORDER.flatMap((id) => {
  const app = ARTCRAFT_APPS.find((candidate) => candidate.id === id);
  return app ? [{ slug: "artcraft", tab: app.id, label: app.name, hint: app.kind }] : [];
});

export const NAV: readonly NavSection[] = [
  {
    id: "documents",
    label: "Documents and PDF",
    icon: "documents",
    items: [{ slug: "office" }, { slug: "pdf" }, { slug: "markdown" }, { slug: "file-compressor" }],
  },
  {
    id: "images",
    label: "Images",
    icon: "images",
    items: [{ slug: "image-resize" }, { slug: "image-crop" }, { slug: "svg-optimize" }, { slug: "image-compare" }, { slug: "qr" }],
  },
  { id: "craft", label: "Craft apps", icon: "craft", items: craftItems },
  {
    id: "data",
    label: "Data and databases",
    icon: "data",
    items: [{ slug: "csv" }, { slug: "json" }, { slug: "sql-lab" }, { slug: "nosql-lab" }],
  },
  {
    id: "text",
    label: "Text",
    icon: "text",
    items: [{ slug: "text" }, { slug: "regex" }, { slug: "diff" }, { slug: "reading-grade" }, { slug: "characters", label: "Characters and encoding" }],
  },
  {
    id: "dev",
    label: "Web and code",
    icon: "dev",
    items: [
      { slug: "css" },
      { slug: "web" },
      { slug: "ids" },
      { slug: "dates" },
      { slug: "semver" },
      { slug: "stacktrace" },
      { slug: "batch-rename" },
      { slug: "heading-audit" },
    ],
  },
  { id: "career", label: "Career", icon: "career", items: [{ slug: "cv-studio" }, { slug: "site-studio" }] },
  { id: "automate", label: "Automation", icon: "automate", items: [{ slug: "workflows" }] },
  { id: "learn", label: "Learning", icon: "learn", items: [{ slug: "db-course" }] },
];

/** Utilities under the sections: setting up services and outside agents. */
export const NAV_FOOTER: readonly NavItem[] = [{ slug: "sidecars", label: "Services" }, { slug: "mcp-connect", label: "Connect an agent (MCP)" }];

/** The section a tool is listed in (breadcrumbs use its label). */
export function navSectionOf(slug: string): NavSection | undefined {
  return NAV.find((section) => section.items.some((item) => item.slug === slug));
}
