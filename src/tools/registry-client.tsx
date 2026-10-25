"use client";

import dynamic from "next/dynamic";
import type { ComponentType } from "react";
import { SuiteShell } from "@/components/SuiteShell";
import { findTool } from "@/lib/registry";
import { ARTCRAFT_APPS } from "@/lib/services/definitions";
import McpConnect from "@/tools/McpConnect";
import { WorkspaceDraft } from "@/components/WorkspaceDraft";

function ToolLoading() {
  return (
    <p role="status" className="py-10 text-center text-sm text-muted">
      Loading tool…
    </p>
  );
}

const SiteConnect = dynamic(() => import("@/tools/site/ConnectTab"), { loading: ToolLoading });
const WorkflowsEditor = dynamic(() => import("@/tools/workflows/WorkflowsTab"), { loading: ToolLoading });
const WorkflowCredentials = dynamic(() => import("@/tools/workflows/CredentialsTab"), { loading: ToolLoading });
const SiteScore = dynamic(() => import("@/tools/site/ScoreTab"), { loading: ToolLoading });
const SiteCopy = dynamic(() => import("@/tools/site/CopyTab"), { loading: ToolLoading });
const SiteChanges = dynamic(() => import("@/tools/site/ChangesTab"), { loading: ToolLoading });
const ColorTool = dynamic(() => import("@/tools/ColorTool"), { loading: ToolLoading });
const CharacterInspector = dynamic(() => import("@/tools/CharacterInspector"), { loading: ToolLoading });
const CronExplorer = dynamic(() => import("@/tools/CronExplorer"), { loading: ToolLoading });
const CsvTool = dynamic(() => import("@/tools/CsvTool"), { loading: ToolLoading });
const DiffTool = dynamic(() => import("@/tools/DiffTool"), { loading: ToolLoading });
const EpochTool = dynamic(() => import("@/tools/EpochTool"), { loading: ToolLoading });
const IdsTool = dynamic(() => import("@/tools/IdsTool"), { loading: ToolLoading });
const ImageDataUri = dynamic(() => import("@/tools/ImageDataUri"), { loading: ToolLoading });
const ImageResize = dynamic(() => import("@/tools/ImageResize"), { loading: ToolLoading });
const FileCompressor = dynamic(() => import("@/tools/FileCompressor"), { loading: ToolLoading });
const JsonTool = dynamic(() => import("@/tools/JsonTool"), { loading: ToolLoading });
const JsonSchemaValidator = dynamic(() => import("@/tools/JsonSchemaValidator"), { loading: ToolLoading });
const JsonPointer = dynamic(() => import("@/tools/JsonPointer"), { loading: ToolLoading });
const JwtTool = dynamic(() => import("@/tools/JwtTool"), { loading: ToolLoading });
const MarkdownTool = dynamic(() => import("@/tools/MarkdownTool"), { loading: ToolLoading });
const MarkdownOrganizer = dynamic(() => import("@/tools/MarkdownOrganizer"), { loading: ToolLoading });
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
const TextKit = dynamic(() => import("@/tools/TextKit"), { loading: ToolLoading });
const UrlTool = dynamic(() => import("@/tools/UrlTool"), { loading: ToolLoading });
const YamlJsonConverter = dynamic(() => import("@/tools/YamlJsonConverter"), { loading: ToolLoading });
const LineWrapPreview = dynamic(() => import("@/tools/LineWrapPreview"), { loading: ToolLoading });
const WordFrequency = dynamic(() => import("@/tools/WordFrequency"), { loading: ToolLoading });
const NdjsonValidator = dynamic(() => import("@/tools/NdjsonValidator"), { loading: ToolLoading });
const DelimiterDetector = dynamic(() => import("@/tools/DelimiterDetector"), { loading: ToolLoading });
const AnsiStripper = dynamic(() => import("@/tools/AnsiStripper"), { loading: ToolLoading });
const DuplicateRows = dynamic(() => import("@/tools/DuplicateRows"), { loading: ToolLoading });
const CsvProfiler = dynamic(() => import("@/tools/CsvProfiler"), { loading: ToolLoading });
const TsvMarkdown = dynamic(() => import("@/tools/TsvMarkdown"), { loading: ToolLoading });
const SmartPunctuation = dynamic(() => import("@/tools/SmartPunctuation"), { loading: ToolLoading });
const StacktraceFormatter = dynamic(() => import("@/tools/StacktraceFormatter"), { loading: ToolLoading });
const HttpHeaderInspector = dynamic(() => import("@/tools/HttpHeaderInspector"), { loading: ToolLoading });
const CssClamp = dynamic(() => import("@/tools/CssClamp"), { loading: ToolLoading });
const BoxShadowBuilder = dynamic(() => import("@/tools/BoxShadowBuilder"), { loading: ToolLoading });
const CssPlayground = dynamic(() => import("@/tools/CssPlayground"), { loading: ToolLoading });
const BorderRadiusBuilder = dynamic(() => import("@/tools/BorderRadiusBuilder"), { loading: ToolLoading });
const SemverChecker = dynamic(() => import("@/tools/SemverChecker"), { loading: ToolLoading });
const JsonPathExplorer = dynamic(() => import("@/tools/JsonPathExplorer"), { loading: ToolLoading });
const IniValidator = dynamic(() => import("@/tools/IniValidator"), { loading: ToolLoading });
const CspBuilder = dynamic(() => import("@/tools/CspBuilder"), { loading: ToolLoading });
const RobotsEvaluator = dynamic(() => import("@/tools/RobotsEvaluator"), { loading: ToolLoading });
const CssEasingEditor = dynamic(() => import("@/tools/CssEasingEditor"), { loading: ToolLoading });
const XmlXpathExplorer = dynamic(() => import("@/tools/XmlXpathExplorer"), { loading: ToolLoading });
const SqlFormatter = dynamic(() => import("@/tools/SqlFormatter"), { loading: ToolLoading });
const SqlConvert = dynamic(() => import("@/tools/db/SqlConvert"), { loading: ToolLoading });
const SqlValidate = dynamic(() => import("@/tools/db/SqlValidate"), { loading: ToolLoading });
const SqlBuild = dynamic(() => import("@/tools/db/SqlBuild"), { loading: ToolLoading });
const SqlSchema = dynamic(() => import("@/tools/db/SqlSchema"), { loading: ToolLoading });
const SqlRun = dynamic(() => import("@/tools/db/SqlRun"), { loading: ToolLoading });
const DbConnect = dynamic(() => import("@/tools/db/DbConnect"), { loading: ToolLoading });
const NosqlMongo = dynamic(() => import("@/tools/db/NosqlMongo"), { loading: ToolLoading });
const NosqlChroma = dynamic(() => import("@/tools/db/NosqlChroma"), { loading: ToolLoading });
const NosqlRedis = dynamic(() => import("@/tools/db/NosqlRedis"), { loading: ToolLoading });
const CsvSelectColumns = dynamic(() => import("@/tools/CsvSelectColumns"), { loading: ToolLoading });
const CsvPivot = dynamic(() => import("@/tools/CsvPivot"), { loading: ToolLoading });
const CsvMerge = dynamic(() => import("@/tools/CsvMerge"), { loading: ToolLoading });
const FixedWidthParser = dynamic(() => import("@/tools/FixedWidthParser"), { loading: ToolLoading });
const TableComparator = dynamic(() => import("@/tools/TableComparator"), { loading: ToolLoading });
const SnowflakeDecoder = dynamic(() => import("@/tools/SnowflakeDecoder"), { loading: ToolLoading });
const NpmLockfileAnalyzer = dynamic(() => import("@/tools/NpmLockfileAnalyzer"), { loading: ToolLoading });
const HexViewer = dynamic(() => import("@/tools/HexViewer"), { loading: ToolLoading });
const SitemapAnalyzer = dynamic(() => import("@/tools/SitemapAnalyzer"), { loading: ToolLoading });
const IdnInspector = dynamic(() => import("@/tools/IdnInspector"), { loading: ToolLoading });
const MultipartDecoder = dynamic(() => import("@/tools/MultipartDecoder"), { loading: ToolLoading });
const CurlBuilder = dynamic(() => import("@/tools/CurlBuilder"), { loading: ToolLoading });
const CssGridPlayground = dynamic(() => import("@/tools/CssGridPlayground"), { loading: ToolLoading });
const DesignTokenValidator = dynamic(() => import("@/tools/DesignTokenValidator"), { loading: ToolLoading });
const TypeScale = dynamic(() => import("@/tools/TypeScale"), { loading: ToolLoading });
const DurationMath = dynamic(() => import("@/tools/DurationMath"), { loading: ToolLoading });
const IsoWeekCalculator = dynamic(() => import("@/tools/IsoWeekCalculator"), { loading: ToolLoading });
const WorkdayCalculator = dynamic(() => import("@/tools/WorkdayCalculator"), { loading: ToolLoading });
const ImageCrop = dynamic(() => import("@/tools/ImageCrop"), { loading: ToolLoading });
const ImageComparator = dynamic(() => import("@/tools/ImageComparator"), { loading: ToolLoading });
const SvgSpritePackager = dynamic(() => import("@/tools/SvgSpritePackager"), { loading: ToolLoading });
const LottieInspector = dynamic(() => import("@/tools/LottieInspector"), { loading: ToolLoading });
const DateFormatTester = dynamic(() => import("@/tools/DateFormatTester"), { loading: ToolLoading });
const DstExplorer = dynamic(() => import("@/tools/DstExplorer"), { loading: ToolLoading });
const RRulePreview = dynamic(() => import("@/tools/RRulePreview"), { loading: ToolLoading });
const MeetingTimezones = dynamic(() => import("@/tools/MeetingTimezones"), { loading: ToolLoading });
const BusinessOverlap = dynamic(() => import("@/tools/BusinessOverlap"), { loading: ToolLoading });
const DateDistribution = dynamic(() => import("@/tools/DateDistribution"), { loading: ToolLoading });
const JsonDiagram = dynamic(() => import("@/tools/JsonDiagram"), { loading: ToolLoading });
const BatchRenamePreview = dynamic(() => import("@/tools/BatchRenamePreview"), { loading: ToolLoading });
const FilenameNormalizer = dynamic(() => import("@/tools/FilenameNormalizer"), { loading: ToolLoading });
const FileManifestDiff = dynamic(() => import("@/tools/FileManifestDiff"), { loading: ToolLoading });
const ImageScrubber = dynamic(() => import("@/tools/ImageScrubber"), { loading: ToolLoading });
const TransparentTrim = dynamic(() => import("@/tools/TransparentTrim"), { loading: ToolLoading });
const AlphaInspector = dynamic(() => import("@/tools/AlphaInspector"), { loading: ToolLoading });
const ContactSheet = dynamic(() => import("@/tools/ContactSheet"), { loading: ToolLoading });
const ResponsiveImages = dynamic(() => import("@/tools/ResponsiveImages"), { loading: ToolLoading });
const FaviconPackager = dynamic(() => import("@/tools/FaviconPackager"), { loading: ToolLoading });
const SvgSanitizer = dynamic(() => import("@/tools/SvgSanitizer"), { loading: ToolLoading });
const SvgOptimizer = dynamic(() => import("@/tools/SvgOptimizer"), { loading: ToolLoading });
const SvgPathInspector = dynamic(() => import("@/tools/SvgPathInspector"), { loading: ToolLoading });
const SvgToPng = dynamic(() => import("@/tools/SvgToPng"), { loading: ToolLoading });
const SvgViewBoxFixer = dynamic(() => import("@/tools/SvgViewBoxFixer"), { loading: ToolLoading });
const EncodingDetector = dynamic(() => import("@/tools/EncodingDetector"), { loading: ToolLoading });
const ReadingGrade = dynamic(() => import("@/tools/ReadingGrade"), { loading: ToolLoading });
const PunctuationChecker = dynamic(() => import("@/tools/PunctuationChecker"), { loading: ToolLoading });
const SentenceComplexity = dynamic(() => import("@/tools/SentenceComplexity"), { loading: ToolLoading });
const HeadingAudit = dynamic(() => import("@/tools/HeadingAudit"), { loading: ToolLoading });
const LinkTextAudit = dynamic(() => import("@/tools/LinkTextAudit"), { loading: ToolLoading });
const FormLabelAudit = dynamic(() => import("@/tools/FormLabelAudit"), { loading: ToolLoading });
const LandmarkAudit = dynamic(() => import("@/tools/LandmarkAudit"), { loading: ToolLoading });
const CssVariableResolver = dynamic(() => import("@/tools/CssVariableResolver"), { loading: ToolLoading });
const CvProfile = dynamic(() => import("@/tools/cv/ProfileTab"), { loading: ToolLoading });
const CvJobs = dynamic(() => import("@/tools/cv/JobsTab"), { loading: ToolLoading });
const CvVariants = dynamic(() => import("@/tools/cv/VariantsTab"), { loading: ToolLoading });
const CvShowcase = dynamic(() => import("@/tools/cv/ShowcaseTab"), { loading: ToolLoading });
const CvApplications = dynamic(() => import("@/tools/cv/ApplicationsTab"), { loading: ToolLoading });
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
  "line-wrap": LineWrapPreview,
  "word-frequency": WordFrequency,
  ndjson: NdjsonValidator,
  "delimiter-detect": DelimiterDetector,
  "ansi-strip": AnsiStripper,
  "duplicate-rows": DuplicateRows,
  "csv-profile": CsvProfiler,
  "tsv-markdown": TsvMarkdown,
  "smart-quotes": SmartPunctuation,
  stacktrace: StacktraceFormatter,
  "http-headers": HttpHeaderInspector,
  "css-clamp": CssClamp,
  "css-playground": CssPlayground,
  "box-shadow": BoxShadowBuilder,
  "border-radius": BorderRadiusBuilder,
  semver: SemverChecker,
  jsonpath: JsonPathExplorer,
  ini: IniValidator,
  "csp-builder": CspBuilder,
  "robots-txt": RobotsEvaluator,
  "css-easing": CssEasingEditor,
  "xml-xpath": XmlXpathExplorer,
  "sql-format": SqlFormatter,
  "sql-convert": SqlConvert,
  "sql-validate": SqlValidate,
  "sql-build": SqlBuild,
  "sql-schema": SqlSchema,
  "sql-run": SqlRun,
  "db-connect": DbConnect,
  "nosql-mongo": NosqlMongo,
  "nosql-chroma": NosqlChroma,
  "nosql-redis": NosqlRedis,
  "cv-profile": CvProfile,
  "cv-jobs": CvJobs,
  "cv-variants": CvVariants,
  "cv-applications": CvApplications,
  "cv-showcase": CvShowcase,
  "csv-select-columns": CsvSelectColumns,
  "csv-pivot": CsvPivot,
  "csv-merge": CsvMerge,
  "fixed-width": FixedWidthParser,
  "table-compare": TableComparator,
  "snowflake-decode": SnowflakeDecoder,
  "npm-lockfile": NpmLockfileAnalyzer,
  "hex-viewer": HexViewer,
  "sitemap-xml": SitemapAnalyzer,
  "idn-inspector": IdnInspector,
  "multipart-decoder": MultipartDecoder,
  "curl-builder": CurlBuilder,
  "css-grid": CssGridPlayground,
  "design-tokens": DesignTokenValidator,
  "type-scale": TypeScale,
  "duration-math": DurationMath,
  "iso-week": IsoWeekCalculator,
  "workday-calculator": WorkdayCalculator,
  "image-crop": ImageCrop,
  "image-compare": ImageComparator,
  "svg-symbol-sprite": SvgSpritePackager,
  "lottie-inspector": LottieInspector,
  "date-format": DateFormatTester,
  "dst-explorer": DstExplorer,
  "rrule-preview": RRulePreview,
  "meeting-timezones": MeetingTimezones,
  "business-overlap": BusinessOverlap,
  "date-distribution": DateDistribution,
  "json-diagram": JsonDiagram,
  "batch-rename": BatchRenamePreview,
  "filename-normalizer": FilenameNormalizer,
  "file-manifest-diff": FileManifestDiff,
  "image-scrub": ImageScrubber,
  "transparent-trim": TransparentTrim,
  "alpha-inspector": AlphaInspector,
  "contact-sheet": ContactSheet,
  "responsive-images": ResponsiveImages,
  "favicon-packager": FaviconPackager,
  "svg-sanitize": SvgSanitizer,
  "svg-optimize": SvgOptimizer,
  "svg-paths": SvgPathInspector,
  "svg-to-png": SvgToPng,
  "svg-viewbox": SvgViewBoxFixer,
  "encoding-detect": EncodingDetector,
  "reading-grade": ReadingGrade,
  "punctuation-check": PunctuationChecker,
  "sentence-complexity": SentenceComplexity,
  "heading-audit": HeadingAudit,
  "link-text-audit": LinkTextAudit,
  "form-label-audit": FormLabelAudit,
  "landmark-audit": LandmarkAudit,
  "css-var-resolver": CssVariableResolver,
  "mcp-connect": McpConnect,
  "image-resize": ImageResize,
  "image-to-data-uri": ImageDataUri,
  "file-compressor": FileCompressor,
  pdf: PdfTool,
  "pdf-editor": PdfEditor,
  json: JsonTool,
  "yaml-json": YamlJsonConverter,
  "json-schema": JsonSchemaValidator,
  "json-pointer": JsonPointer,
  csv: CsvTool,
  text: TextKit,
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
  "markdown-organizer": MarkdownOrganizer,
  characters: CharacterInspector,
  "placeholder-text": PlaceholderText,
  cron: CronExplorer,
  office: OfficeTool,
  "site-connect": SiteConnect,
  "wf-editor": WorkflowsEditor,
  "wf-credentials": WorkflowCredentials,
  "site-score": SiteScore,
  "site-copy": SiteCopy,
  "site-changes": SiteChanges,
  sidecars: SidecarsTool,
  "learn-sql": SqlCourse,
  ...Object.fromEntries(ARTCRAFT_APPS.map((app) => [`craft-${app.id}`, craftTab(app.id)])),
};

function MissingTool({ slug }: { slug: string }) {
  return (
    <p className="rounded-tool border border-line bg-surface px-4 py-8 text-center text-sm text-muted">
      <span className="font-mono text-ink">{slug}</span> is registered but has
      no component yet.
    </p>
  );
}

/**
 * Tools whose inputs must not be restored from a draft: they load their own server-held data (a stale draft would
 * overwrite it and autosave the old values back), manage credentials, or generate secrets.
 */
// css-playground keeps its own files (browser storage); the draft snapshot only sees plain fields.
const NO_DRAFT = new Set(["office", "sidecars", "learn-sql", "mcp-connect", "db-connect", "password", "css-playground"]);
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
  const tabs = findTool(slug)?.tabs;
  if (!tabs) return renderComponent(slug);

  const components = new Map(tabs.map((tab) => [tab.id, tab.component]));
  return (
    <SuiteShell
      tabs={tabs}
      label={`${findTool(slug)?.name ?? slug} sections`}
      renderTab={(id) => renderComponent(components.get(id) ?? id)}
    />
  );
}
