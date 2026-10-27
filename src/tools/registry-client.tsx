"use client";

import dynamic from "next/dynamic";
import type { ComponentType } from "react";
import { SuiteShell } from "@/components/SuiteShell";
import { findTool } from "@/lib/registry";
import { ARTCRAFT_APPS } from "@/lib/services/definitions";
import McpConnect from "@/tools/McpConnect";
import { WorkspaceDraft } from "@/components/WorkspaceDraft";
import { useT } from "@/lib/i18n/react";

function ToolLoading() {
  const { t } = useT();
  return (
    <p role="status" className="py-10 text-center text-sm text-muted">
      {t("Loading tool…")}
    </p>
  );
}

const WorkflowsEditor = dynamic(() => import("@/tools/workflows/WorkflowsTab"), { loading: ToolLoading });
const WorkflowCredentials = dynamic(() => import("@/tools/workflows/CredentialsTab"), { loading: ToolLoading });
const ColorTool = dynamic(() => import("@/tools/ColorTool"), { loading: ToolLoading });
const CharacterInspector = dynamic(() => import("@/tools/CharacterInspector"), { loading: ToolLoading });
const CronExplorer = dynamic(() => import("@/tools/CronExplorer"), { loading: ToolLoading });
const CsvConvertTab = dynamic(() => import("@/tools/CsvConvertTab"), { loading: ToolLoading });
const DiffTool = dynamic(() => import("@/tools/DiffTool"), { loading: ToolLoading });
const EpochTool = dynamic(() => import("@/tools/EpochTool"), { loading: ToolLoading });
const IdsTool = dynamic(() => import("@/tools/IdsTool"), { loading: ToolLoading });
const ImageResize = dynamic(() => import("@/tools/ImageResize"), { loading: ToolLoading });
const JsonTool = dynamic(() => import("@/tools/JsonTool"), { loading: ToolLoading });
const JsonSchemaValidator = dynamic(() => import("@/tools/JsonSchemaValidator"), { loading: ToolLoading });
const JwtTool = dynamic(() => import("@/tools/JwtTool"), { loading: ToolLoading });
const MarkdownTool = dynamic(() => import("@/tools/MarkdownTool"), { loading: ToolLoading });
const PasswordTool = dynamic(() => import("@/tools/PasswordTool"), { loading: ToolLoading });
const PlaceholderText = dynamic(() => import("@/tools/PlaceholderText"), { loading: ToolLoading });
const PdfTool = dynamic(() => import("@/tools/PdfTool"), { loading: ToolLoading });
// Browser-only (canvas, pdf.js, OCR workers) and pdf.js is itself imported
// lazily: skipping SSR avoids a preload hint for a chunk the server render
// cannot name consistently in dev.
const PdfEditor = dynamic(() => import("@/tools/PdfEditor"), {
  ssr: false,
  loading: ToolLoading,
});
const QrTool = dynamic(() => import("@/tools/QrTool"), { loading: ToolLoading });
const RegexLab = dynamic(() => import("@/tools/RegexLab"), { loading: ToolLoading });
const TextTransforms = dynamic(() => import("@/tools/TextTransforms"), { loading: ToolLoading });
const UrlTool = dynamic(() => import("@/tools/UrlTool"), { loading: ToolLoading });
const YamlJsonConverter = dynamic(() => import("@/tools/YamlJsonConverter"), { loading: ToolLoading });
const DuplicateRows = dynamic(() => import("@/tools/DuplicateRows"), { loading: ToolLoading });
const CsvProfiler = dynamic(() => import("@/tools/CsvProfiler"), { loading: ToolLoading });
const CssClamp = dynamic(() => import("@/tools/CssClamp"), { loading: ToolLoading });
const BoxShadowBuilder = dynamic(() => import("@/tools/BoxShadowBuilder"), { loading: ToolLoading });
const CssPlayground = dynamic(() => import("@/tools/CssPlayground"), { loading: ToolLoading });
const BorderRadiusBuilder = dynamic(() => import("@/tools/BorderRadiusBuilder"), { loading: ToolLoading });
const JsonPathExplorer = dynamic(() => import("@/tools/JsonPathExplorer"), { loading: ToolLoading });
const CspBuilder = dynamic(() => import("@/tools/CspBuilder"), { loading: ToolLoading });
const RobotsEvaluator = dynamic(() => import("@/tools/RobotsEvaluator"), { loading: ToolLoading });
const CssEasingEditor = dynamic(() => import("@/tools/CssEasingEditor"), { loading: ToolLoading });
const XmlXpathExplorer = dynamic(() => import("@/tools/XmlXpathExplorer"), { loading: ToolLoading });
const SqlFormatter = dynamic(() => import("@/tools/SqlFormatter"), { loading: ToolLoading });
const SqlConvert = dynamic(() => import("@/tools/db/SqlConvert"), { loading: ToolLoading });
const SqlValidate = dynamic(() => import("@/tools/db/SqlValidate"), { loading: ToolLoading });
const SqlSchema = dynamic(() => import("@/tools/db/SqlSchema"), { loading: ToolLoading });
const SqlRun = dynamic(() => import("@/tools/db/SqlRun"), { loading: ToolLoading });
const DbConnect = dynamic(() => import("@/tools/db/DbConnect"), { loading: ToolLoading });
const CsvSelectColumns = dynamic(() => import("@/tools/CsvSelectColumns"), { loading: ToolLoading });
const CsvPivot = dynamic(() => import("@/tools/CsvPivot"), { loading: ToolLoading });
const CsvMerge = dynamic(() => import("@/tools/CsvMerge"), { loading: ToolLoading });
const TableComparator = dynamic(() => import("@/tools/TableComparator"), { loading: ToolLoading });
const SitemapAnalyzer = dynamic(() => import("@/tools/SitemapAnalyzer"), { loading: ToolLoading });
const CurlBuilder = dynamic(() => import("@/tools/CurlBuilder"), { loading: ToolLoading });
const WebsiteCheck = dynamic(() => import("@/tools/WebsiteCheck"), { loading: ToolLoading });
const CssGridPlayground = dynamic(() => import("@/tools/CssGridPlayground"), { loading: ToolLoading });
const TypeScale = dynamic(() => import("@/tools/TypeScale"), { loading: ToolLoading });
const DurationMath = dynamic(() => import("@/tools/DurationMath"), { loading: ToolLoading });
const WorkdayCalculator = dynamic(() => import("@/tools/WorkdayCalculator"), { loading: ToolLoading });
const ImageCrop = dynamic(() => import("@/tools/ImageCrop"), { loading: ToolLoading });
const ImageComparator = dynamic(() => import("@/tools/ImageComparator"), { loading: ToolLoading });
const DateFormatTab = dynamic(() => import("@/tools/DateFormatTab"), { loading: ToolLoading });
const RRulePreview = dynamic(() => import("@/tools/RRulePreview"), { loading: ToolLoading });
const MeetingPlannerTab = dynamic(() => import("@/tools/MeetingPlannerTab"), { loading: ToolLoading });
const JsonDiagram = dynamic(() => import("@/tools/JsonDiagram"), { loading: ToolLoading });
const ImageScrubber = dynamic(() => import("@/tools/ImageScrubber"), { loading: ToolLoading });
const TransparentTrim = dynamic(() => import("@/tools/TransparentTrim"), { loading: ToolLoading });
const ResponsiveImages = dynamic(() => import("@/tools/ResponsiveImages"), { loading: ToolLoading });
const FaviconPackager = dynamic(() => import("@/tools/FaviconPackager"), { loading: ToolLoading });
const SvgSanitizer = dynamic(() => import("@/tools/SvgSanitizer"), { loading: ToolLoading });
const SvgOptimizer = dynamic(() => import("@/tools/SvgOptimizer"), { loading: ToolLoading });
const SvgToPng = dynamic(() => import("@/tools/SvgToPng"), { loading: ToolLoading });
const EncodingDetector = dynamic(() => import("@/tools/EncodingDetector"), { loading: ToolLoading });
const CvProfile = dynamic(() => import("@/tools/cv/framed").then((m) => m.CvProfile), { loading: ToolLoading });
const CvJobs = dynamic(() => import("@/tools/cv/framed").then((m) => m.CvJobs), { loading: ToolLoading });
const CvVariants = dynamic(() => import("@/tools/cv/framed").then((m) => m.CvVariants), { loading: ToolLoading });
const CvShowcase = dynamic(() => import("@/tools/cv/framed").then((m) => m.CvShowcase), { loading: ToolLoading });
const CvWebsite = dynamic(() => import("@/tools/cv/framed").then((m) => m.CvWebsite), { loading: ToolLoading });
const CvApplications = dynamic(() => import("@/tools/cv/framed").then((m) => m.CvApplications), { loading: ToolLoading });
// The editor loads the sidecar's DocsAPI script into the page: browser-only.
const OfficeTool = dynamic(() => import("@/tools/sidecars/OfficeTool"), { ssr: false, loading: ToolLoading });
const SidecarsTool = dynamic(() => import("@/tools/sidecars/SidecarsTool"), { loading: ToolLoading });
// Each ArtCraft tab embeds one app of the `craft` sidecar; client-only like the office page (live sidecar state).
const CraftApp = dynamic(() => import("@/tools/craft/CraftApp"), { ssr: false, loading: ToolLoading });

function craftTab(app: string): ComponentType {
  const Tab = () => <CraftApp app={app} />;
  Tab.displayName = `CraftApp(${app})`;
  return Tab;
}

// Client-only like the office page: everything it shows depends on the course database's live state.
const SqlCourse = dynamic(() => import("@/tools/learn/SqlCourse"), { ssr: false, loading: ToolLoading });

/**
 * slug -> component. Keys must match `src/lib/registry.ts`; the compiler
 * enforces it, so a registry entry without a component fails the build.
 */
const COMPONENTS: Record<string, ComponentType> = {
  "duplicate-rows": DuplicateRows,
  "csv-profile": CsvProfiler,
  "css-clamp": CssClamp,
  "css-playground": CssPlayground,
  "box-shadow": BoxShadowBuilder,
  "border-radius": BorderRadiusBuilder,
  jsonpath: JsonPathExplorer,
  "csp-builder": CspBuilder,
  "robots-txt": RobotsEvaluator,
  "css-easing": CssEasingEditor,
  "xml-xpath": XmlXpathExplorer,
  "sql-format": SqlFormatter,
  "sql-convert": SqlConvert,
  "sql-validate": SqlValidate,
  "sql-schema": SqlSchema,
  "sql-run": SqlRun,
  "db-connect": DbConnect,
  "cv-profile": CvProfile,
  "cv-jobs": CvJobs,
  "cv-variants": CvVariants,
  "cv-applications": CvApplications,
  "cv-showcase": CvShowcase,
  "cv-website": CvWebsite,
  "csv-select-columns": CsvSelectColumns,
  "csv-pivot": CsvPivot,
  "csv-merge": CsvMerge,
  "table-compare": TableComparator,
  "sitemap-xml": SitemapAnalyzer,
  "curl-builder": CurlBuilder,
  "website-check": WebsiteCheck,
  "css-grid": CssGridPlayground,
  "type-scale": TypeScale,
  "duration-math": DurationMath,
  "workday-calculator": WorkdayCalculator,
  "image-crop": ImageCrop,
  "image-compare": ImageComparator,
  "date-format": DateFormatTab,
  "rrule-preview": RRulePreview,
  "meeting-timezones": MeetingPlannerTab,
  "json-diagram": JsonDiagram,
  "image-scrub": ImageScrubber,
  "transparent-trim": TransparentTrim,
  "responsive-images": ResponsiveImages,
  "favicon-packager": FaviconPackager,
  "svg-sanitize": SvgSanitizer,
  "svg-optimize": SvgOptimizer,
  "svg-to-png": SvgToPng,
  "encoding-detect": EncodingDetector,
  "mcp-connect": McpConnect,
  "image-resize": ImageResize,
  pdf: PdfTool,
  "pdf-editor": PdfEditor,
  json: JsonTool,
  "yaml-json": YamlJsonConverter,
  "json-schema": JsonSchemaValidator,
  csv: CsvConvertTab,
  text: TextTransforms,
  regex: RegexLab,
  ids: IdsTool,
  qr: QrTool,
  jwt: JwtTool,
  epoch: EpochTool,
  diff: DiffTool,
  color: ColorTool,
  url: UrlTool,
  password: PasswordTool,
  markdown: MarkdownTool,
  characters: CharacterInspector,
  "placeholder-text": PlaceholderText,
  cron: CronExplorer,
  office: OfficeTool,
  "wf-editor": WorkflowsEditor,
  "wf-credentials": WorkflowCredentials,
  sidecars: SidecarsTool,
  "learn-sql": SqlCourse,
  ...Object.fromEntries(ARTCRAFT_APPS.map((app) => [`craft-${app.id}`, craftTab(app.id)])),
};

function MissingTool({ slug }: { slug: string }) {
  const { t } = useT();
  return (
    <p className="rounded-tool border border-line bg-surface px-4 py-8 text-center text-sm text-muted">
      <span className="font-mono text-ink">{slug}</span> {" "}{t("is registered but has no component yet.")}
    </p>
  );
}

/**
 * Tools whose inputs must not be restored from a draft: they load their own server-held data (a stale draft would
 * overwrite it and autosave the old values back), manage credentials, or generate secrets.
 */
// css-playground keeps its own files (browser storage); the draft snapshot only sees plain fields.
const NO_DRAFT = new Set(["office", "sidecars", "learn-sql", "mcp-connect", "db-connect", "password", "css-playground", "website-check"]);
const NO_DRAFT_PREFIXES = ["cv-", "site-", "craft-", "wf-"];

function renderComponent(key: string) {
  const Component = COMPONENTS[key];
  if (!Component) return <MissingTool slug={key} />;
  if (NO_DRAFT.has(key) || NO_DRAFT_PREFIXES.some((p) => key.startsWith(p))) return <Component />;
  return <WorkspaceDraft key={key} tool={key} Component={Component} />;
}

/**
 * Renders a tool by slug. Suites (registry entries with `tabs`) render a
 * lazy-loaded component per tab inside a SuiteShell; plain tools render their
 * component directly.
 */
export function ToolView({ slug }: { slug: string }) {
  const { t } = useT();
  const tabs = findTool(slug)?.tabs;
  if (!tabs) return renderComponent(slug);

  const components = new Map(tabs.map((tab) => [tab.id, tab.component]));
  return (
    <SuiteShell
      tabs={tabs}
      label={t("{value} sections", { value: findTool(slug)?.name ?? slug })}
      renderTab={(id) => renderComponent(components.get(id) ?? id)}
    />
  );
}
