import type { IconName } from "@/components/category-icons";

/**
 * The sidebar's layout (src/components/shell/Sidebar.tsx): sections by what people want to do, each with optional
 * sub-groups ("Simple" / "Advanced"), each entry a whole tool or one tab of a suite. The Craft apps are listed one by
 * one where they belong (images, documents, video and audio), under "Advanced". Metadata only, like the registry;
 * tests/nav.test.mjs checks that every entry exists and every tool is reachable.
 */

export interface NavItem {
  slug: string;
  /** One tab of a suite; without it the entry opens the suite (its first tab). */
  tab?: string;
  /** Shown instead of the tool's or the tab's own name. */
  label?: string;
}

export interface NavGroup {
  /** Sub-heading ("Simple", "Advanced"); none = the section's plain list. */
  title?: string;
  items: NavItem[];
}

export interface NavSection {
  id: string;
  label: string;
  icon: IconName;
  groups: NavGroup[];
}

const craft = (tab: string): NavItem => ({ slug: "artcraft", tab });

export const NAV: readonly NavSection[] = [
  {
    id: "images",
    label: "Images",
    icon: "images",
    groups: [
      {
        title: "Simple",
        items: [
          { slug: "image-resize", tab: "resize", label: "Resize and convert" },
          { slug: "image-crop", tab: "crop", label: "Crop" },
          { slug: "image-crop", tab: "trim", label: "Trim transparent edges" },
          { slug: "image-resize", tab: "scrub", label: "Remove metadata" },
          { slug: "qr", label: "QR codes" },
        ],
      },
      {
        title: "Advanced",
        items: [
          craft("photocraft"),
          craft("vectorcraft"),
          craft("lightcraft"),
          craft("figcraft"),
          craft("cadcraft"),
          { slug: "svg-optimize" },
          { slug: "image-compare" },
          { slug: "image-resize", tab: "responsive", label: "Responsive image set" },
          { slug: "image-resize", tab: "favicon", label: "Favicons and app icons" },
          { slug: "image-resize", tab: "data-uri", label: "Image to Data URI" },
          { slug: "image-crop", tab: "sheet", label: "Contact sheet" },
        ],
      },
    ],
  },
  {
    id: "documents",
    label: "Documents",
    icon: "documents",
    groups: [
      { title: "Simple", items: [{ slug: "pdf" }, { slug: "file-compressor" }, { slug: "office" }] },
      { title: "Advanced", items: [craft("pdfcraft"), craft("wordcraft"), craft("gridcraft"), craft("deckcraft"), craft("designcraft")] },
      { title: "Career and web", items: [{ slug: "cv-studio" }, { slug: "site-studio" }] },
    ],
  },
  {
    id: "media",
    label: "Video and audio",
    icon: "media",
    groups: [{ title: "Advanced", items: [craft("filmcraft"), craft("effectcraft"), craft("soundcraft")] }],
  },
  {
    id: "data",
    label: "Data",
    icon: "data",
    groups: [{ items: [{ slug: "csv" }, { slug: "json" }, { slug: "sql-lab" }, { slug: "nosql-lab" }] }],
  },
  {
    id: "text",
    label: "Text",
    icon: "text",
    groups: [{ items: [{ slug: "text" }, { slug: "reading-grade" }, { slug: "markdown" }, { slug: "regex" }, { slug: "diff" }, { slug: "characters", label: "Characters and encoding" }] }],
  },
  {
    id: "dev",
    label: "Web and dev",
    icon: "dev",
    groups: [
      {
        items: [
          { slug: "web" },
          { slug: "css" },
          { slug: "dates" },
          { slug: "ids" },
          { slug: "heading-audit" },
          { slug: "stacktrace" },
          { slug: "semver" },
          { slug: "batch-rename" },
        ],
      },
    ],
  },
  { id: "learn", label: "Learn", icon: "learn", groups: [{ items: [{ slug: "db-course" }] }] },
  { id: "setup", label: "Setup", icon: "setup", groups: [{ items: [{ slug: "sidecars" }, { slug: "mcp-connect" }] }] },
];
