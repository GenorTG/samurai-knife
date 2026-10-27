import { msg } from "@/lib/i18n/msg";

/**
 * Document layouts and look options shared by the HTML sheet (`CvDocument`), the server PDF/HTML export, the DOCX
 * export and the layout gallery. Pure metadata. The layout ids double as the stored preference and the export `theme`
 * field (`ats`/`modern`/`sidebar`/`elegant` predate the rest and keep their ids).
 */

export const CV_LAYOUTS = [
  "ats", "compact", "minimal", "classic", "modern", "elegant", "executive", "technical",
  "timeline", "banner", "sidebar", "rightbar", "creative", "europass",
] as const;
export type CvLayout = (typeof CV_LAYOUTS)[number];

export const PHOTO_SHAPES = ["round", "square"] as const;
export type PhotoShape = (typeof PHOTO_SHAPES)[number];

/** How the sheet is built: one flow, a side column on the left or right, or section titles in a label column. */
export type CvStructure = "single" | "left" | "right" | "labels";

export interface CvLayoutInfo {
  label: string;
  /** One line for the gallery. */
  description: string;
  /** false = never prints a photo, whatever the photo switch says (ATS parsers choke on images). */
  photo: boolean;
  /** Plain one-column text flow without graphics: what applicant tracking systems read reliably. */
  atsSafe: boolean;
  structure: CvStructure;
  /** The accent colour is used (ATS prints black). */
  accent: boolean;
  /** Accent used until the user picks one. */
  defaultAccent: CvAccent;
  /** Font pair used until the user picks one. */
  defaultFonts: Exclude<CvFonts, "auto">;
}

export const CV_ACCENTS = {
  navy: "#1f5f8b",
  teal: "#0f766e",
  green: "#2f6b3a",
  wine: "#8a2846",
  plum: "#5b3a8a",
  bronze: "#7a5c35",
  slate: "#334155",
  black: "#111111",
} as const;
export type CvAccent = keyof typeof CV_ACCENTS;
export const CV_ACCENT_IDS = Object.keys(CV_ACCENTS) as CvAccent[];

/** Font pairs. All ship with the app (public/cv-fonts, SIL OFL): the preview, the PDF and the HTML file look the same. */
export const CV_FONTS = ["auto", "inter", "serif", "mixed", "geist"] as const;
export type CvFonts = (typeof CV_FONTS)[number];
export const CV_FONT_LABELS: Record<CvFonts, string> = {
  auto: msg("Layout's own"),
  inter: msg("Sans (Inter)"),
  serif: msg("Serif (Source Serif)"),
  mixed: msg("Serif headings, sans text"),
  geist: msg("Geist"),
};

export const CV_DENSITIES = ["comfortable", "compact"] as const;
export type CvDensity = (typeof CV_DENSITIES)[number];
export const CV_PAPERS = ["a4", "letter"] as const;
export type CvPaper = (typeof CV_PAPERS)[number];

/** Extra pages after the CV: none, the projects that have a showcase page, or those pages alone. */
export const CV_PAGE_MODES = ["cv", "cv+pages", "pages"] as const;
export type CvPageMode = (typeof CV_PAGE_MODES)[number];

export const CV_LAYOUT_INFO: Record<CvLayout, CvLayoutInfo> = {
  ats: { label: "ATS", description: msg("Plain single column in black, no photo: safest for applicant tracking systems."), photo: false, atsSafe: true, structure: "single", accent: false, defaultAccent: "black", defaultFonts: "inter" },
  compact: { label: msg("Compact"), description: msg("Tight single column that fits more on one page; ATS-friendly, no photo."), photo: false, atsSafe: true, structure: "single", accent: true, defaultAccent: "slate", defaultFonts: "inter" },
  minimal: { label: msg("Minimal"), description: msg("Quiet monochrome with generous white space and thin rules; ATS-friendly."), photo: false, atsSafe: true, structure: "single", accent: true, defaultAccent: "black", defaultFonts: "inter" },
  classic: { label: msg("Classic"), description: msg("Traditional serif CV with a centred header; ATS-friendly, no photo."), photo: false, atsSafe: true, structure: "single", accent: true, defaultAccent: "black", defaultFonts: "serif" },
  modern: { label: "Modern", description: msg("Single column with an accent colour; photo beside the name."), photo: true, atsSafe: false, structure: "single", accent: true, defaultAccent: "navy", defaultFonts: "inter" },
  elegant: { label: "Elegant", description: msg("Centred serif header with the photo above the name."), photo: true, atsSafe: false, structure: "single", accent: true, defaultAccent: "bronze", defaultFonts: "mixed" },
  executive: { label: msg("Executive"), description: msg("Large name, a highlighted profile and understated serif headings for senior roles."), photo: true, atsSafe: false, structure: "single", accent: true, defaultAccent: "slate", defaultFonts: "mixed" },
  technical: { label: msg("Technical"), description: msg("Skills first, as tags, with a monospace touch: for engineers."), photo: false, atsSafe: false, structure: "single", accent: true, defaultAccent: "teal", defaultFonts: "geist" },
  timeline: { label: msg("Timeline"), description: msg("Dates in a left gutter on a vertical line: the career reads at a glance."), photo: true, atsSafe: false, structure: "single", accent: true, defaultAccent: "navy", defaultFonts: "inter" },
  banner: { label: msg("Banner"), description: msg("A coloured header band with the name, contact and photo."), photo: true, atsSafe: false, structure: "single", accent: true, defaultAccent: "wine", defaultFonts: "inter" },
  sidebar: { label: "Sidebar", description: msg("Two columns: photo, contact, skills, languages and education on the left."), photo: true, atsSafe: false, structure: "left", accent: true, defaultAccent: "navy", defaultFonts: "inter" },
  rightbar: { label: msg("Right column"), description: msg("The story on the left, contact, skills and languages in a column on the right."), photo: true, atsSafe: false, structure: "right", accent: true, defaultAccent: "green", defaultFonts: "inter" },
  creative: { label: msg("Creative"), description: msg("A bold coloured side column with white text: for design and creative roles."), photo: true, atsSafe: false, structure: "left", accent: true, defaultAccent: "plum", defaultFonts: "mixed" },
  europass: { label: "Europass", description: msg("European style: section titles in a label column on the left, content on the right."), photo: true, atsSafe: false, structure: "labels", accent: true, defaultAccent: "navy", defaultFonts: "inter" },
};

/** Everything that decides how a document looks (not what it says). */
export interface CvLook {
  layout: CvLayout;
  accent: CvAccent | "auto";
  fonts: CvFonts;
  density: CvDensity;
  paper: CvPaper;
  /** Contact links printed as full addresses (https://…) instead of the short form (github.com/name). */
  fullUrls: boolean;
  /** Small icons before contact items (layouts that are not ATS-safe). */
  icons: boolean;
}

export const DEFAULT_LOOK: CvLook = { layout: "ats", accent: "auto", fonts: "auto", density: "comfortable", paper: "a4", fullUrls: false, icons: true };

/** The colour a sheet in `look` prints its accent in. */
export function accentOf(look: Pick<CvLook, "layout" | "accent">): string {
  const info = CV_LAYOUT_INFO[look.layout];
  if (!info.accent) return CV_ACCENTS.black;
  return CV_ACCENTS[look.accent === "auto" ? info.defaultAccent : look.accent];
}

export function fontsOf(look: Pick<CvLook, "layout" | "fonts">): Exclude<CvFonts, "auto"> {
  return look.fonts === "auto" ? CV_LAYOUT_INFO[look.layout].defaultFonts : look.fonts;
}

export function iconsOf(look: Pick<CvLook, "layout" | "icons">): boolean {
  return look.icons && !CV_LAYOUT_INFO[look.layout].atsSafe;
}

/** Whether a sheet in `layout` shows the photo: the layout allows one, the user switched it on, and one is stored. */
export function showsPhoto(layout: CvLayout, wanted: boolean, stored: boolean): boolean {
  return CV_LAYOUT_INFO[layout].photo && wanted && stored;
}

/** Paper size in mm (width, height). */
export const PAPER_MM: Record<CvPaper, [number, number]> = { a4: [210, 297], letter: [215.9, 279.4] };

/** The font files a font pair needs (public/cv-fonts): what the server PDF/HTML export copies or embeds. */
export function fontFiles(fonts: Exclude<CvFonts, "auto">): string[] {
  const inter = ["inter"];
  const serif = ["source-serif-4"];
  const families = fonts === "inter" ? inter : fonts === "serif" ? serif : fonts === "mixed" ? [...serif, ...inter] : [];
  const files = families.flatMap((family) =>
    ["latin", "latin-ext"].flatMap((subset) => ["400", "600", "700"].flatMap((weight) => ["normal", "italic"].map((style) => `${family}-${subset}-${weight}-${style}.woff2`))),
  );
  // Geist is the app's own variable font; the monospace touch of Technical and every pair's fallback.
  return [...files, "Geist-latin.woff2", "Geist-latin-ext.woff2", "GeistMono-latin.woff2", "GeistMono-latin-ext.woff2"];
}

/** `hex` mixed with white (`amount` 0..1 of white): the light tint side columns and bands use (no CSS color-mix: the PDF renderer lacks it). */
export function tintOf(hex: string, amount: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amount).toString(16).padStart(2, "0");
  return `#${mix((n >> 16) & 255)}${mix((n >> 8) & 255)}${mix(n & 255)}`;
}
