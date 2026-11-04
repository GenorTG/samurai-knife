import { msg } from "@/lib/i18n/msg";
import type { IconName } from "@/components/category-icons";

/**
 * Tool sets (docs/TOOLSETS.md): the app as people think of it, one set per real job, each with its own page at
 * `/sets/<id>`: what it replaces, in plain words and by name, and the tasks you can start from it. Pure data, browser
 * and server. Every link is checked against the registry by tests/toolsets.test.mjs.
 *
 * Naming a paid product is a comparison, so it has to stay true: `replaces` says what the free tool stands in for, the
 * set's `limits` says where it falls short, and the page always carries the trademark line.
 */

export interface Replacement {
  /** The paid product, by its own name. */
  paid: string;
  /** Our free tool. */
  ours: string;
  /** What it is, in a few words. */
  what: string;
  href: string;
}

export interface SetTask {
  /** What the person wants to do, as they would say it. */
  label: string;
  hint: string;
  href: string;
}

export interface ToolSet {
  id: string;
  icon: IconName;
  /** Short name on cards and in the welcome wizard. */
  name: string;
  /** The headline: says it straight. */
  headline: string;
  pitch: string;
  /** The one thing to start with. */
  start: { label: string; href: string };
  replaces: Replacement[];
  tasks: SetTask[];
  /** An honest limit of the comparison, when there is one. */
  limits?: string;
}

const craft = (id: string) => `/tools/artcraft?tab=${id}`;

export const TOOL_SETS: readonly ToolSet[] = [
  {
    id: "office",
    icon: "documents",
    name: msg("Office and PDF"),
    headline: msg("Stop paying for Microsoft 365"),
    pitch: msg("Write documents, spreadsheets and presentations in your browser with Euro-Office. It opens and saves the same Word, Excel and PowerPoint files you already have. It is free, and there is nothing to install."),
    start: { label: msg("Open Euro-Office"), href: "/tools/office" },
    replaces: [
      { paid: "Microsoft Word", ours: "Euro-Office", what: msg("documents and letters (DOCX)"), href: "/tools/office" },
      { paid: "Microsoft Excel", ours: "Euro-Office", what: msg("spreadsheets and formulas (XLSX)"), href: "/tools/office" },
      { paid: "Microsoft PowerPoint", ours: "Euro-Office", what: msg("presentations (PPTX)"), href: "/tools/office" },
      { paid: "Adobe Acrobat", ours: msg("PDF tools"), what: msg("editing, merging and compressing PDFs"), href: "/tools/pdf" },
    ],
    tasks: [
      { label: msg("Write a document or a letter"), hint: msg("Start a new file or upload a Word document you already have."), href: "/tools/office" },
      { label: msg("Merge, split or shrink a PDF"), hint: msg("Pick the files, choose what to do, download the result."), href: "/tools/pdf?tab=tools" },
      { label: msg("Edit a PDF or add a signature"), hint: msg("Add text, pictures and a drawn signature to any page."), href: "/tools/pdf?tab=editor" },
      { label: msg("Turn a scan into text"), hint: msg("Read the text from a scanned page or a photo of a document."), href: "/tools/pdf?tab=editor" },
    ],
    limits: msg("Euro-Office is an independent open-source editor that this website runs for you. Very complex files can look slightly different than in Microsoft Office: macros are switched off, and it is worth checking the layout of an important document before you send it."),
  },
  {
    id: "creative",
    icon: "craft",
    name: msg("Photos, video and design"),
    headline: msg("Stop paying for Adobe"),
    pitch: msg("Thirteen free apps for photos, graphics, video, sound and page layouts that run in your browser. No Creative Cloud subscription, no installing, no account with anyone else."),
    start: { label: msg("Open the photo editor"), href: craft("photocraft") },
    replaces: [
      { paid: "Adobe Photoshop", ours: "PhotoCraft", what: msg("photo editing and retouching"), href: craft("photocraft") },
      { paid: "Adobe Lightroom", ours: "LightCraft", what: msg("photo library and RAW development"), href: craft("lightcraft") },
      { paid: "Adobe Illustrator", ours: "VectorCraft", what: msg("logos and vector graphics"), href: craft("vectorcraft") },
      { paid: "Adobe Premiere Pro", ours: "FilmCraft", what: msg("video editing"), href: craft("filmcraft") },
      { paid: "Adobe After Effects", ours: "EffectCraft", what: msg("animation and visual effects"), href: craft("effectcraft") },
      { paid: "Adobe InDesign", ours: "DesignCraft", what: msg("leaflets, magazines and page layout"), href: craft("designcraft") },
      { paid: "Adobe Acrobat", ours: "PdfCraft", what: msg("working on PDF files"), href: craft("pdfcraft") },
      { paid: "Adobe Audition", ours: "SoundCraft", what: msg("recording and editing sound"), href: craft("soundcraft") },
      { paid: "Figma, Adobe XD", ours: "FigCraft", what: msg("designing apps and websites"), href: craft("figcraft") },
      { paid: "AutoCAD", ours: "CADCraft", what: msg("technical drawings"), href: craft("cadcraft") },
    ],
    tasks: [
      { label: msg("Make a photo smaller"), hint: msg("For an email or a form: choose the size, download the result."), href: "/tools/image-resize?tab=resize" },
      { label: msg("Crop a picture"), hint: msg("Drag the frame, pick a shape such as a square, save."), href: "/tools/image-crop?tab=crop" },
      { label: msg("Remove hidden data from a photo"), hint: msg("Location and camera details are removed before you share it."), href: "/tools/image-resize?tab=scrub" },
      { label: msg("Edit a photo"), hint: msg("Layers, colours, retouching: a full photo editor."), href: craft("photocraft") },
      { label: msg("Cut a video"), hint: msg("Trim clips, add sound and export a film."), href: craft("filmcraft") },
    ],
    limits: msg("These apps cover everyday and much advanced work, but not every feature of the paid programs. They are young, independent open-source projects, so save your work often. Your work stays in this browser until you save it to your account."),
  },
  {
    id: "career",
    icon: "career",
    name: msg("CV and job search"),
    headline: msg("A professional CV, free, without paying a CV website"),
    pitch: msg("Answer a few simple questions and get a ready CV to download as PDF or Word, in Polish and English. No watermarks and no fee at the moment you want to download it."),
    start: { label: msg("Create my CV"), href: "/tools/cv-studio" },
    replaces: [
      { paid: msg("Paid CV websites"), ours: msg("CV builder"), what: msg("ready-made layouts, PDF and Word download"), href: "/tools/cv-studio" },
    ],
    tasks: [
      { label: msg("Create my CV step by step"), hint: msg("One question at a time. You can stop and come back."), href: "/tools/cv-studio" },
      { label: msg("Adjust my CV to a job offer"), hint: msg("Paste the offer, and see what is missing and what to bring forward."), href: "/tools/cv-studio?tab=jobs" },
      { label: msg("Choose a layout and download"), hint: msg("Pick how it looks and save it as PDF or Word."), href: "/tools/cv-studio?tab=variants" },
      { label: msg("Keep track of my applications"), hint: msg("Where you applied, when, and when to follow up."), href: "/tools/cv-studio?tab=applications" },
    ],
  },
  {
    id: "everyday",
    icon: "everyday",
    name: msg("Everyday helpers"),
    headline: msg("Small jobs, done in a minute"),
    pitch: msg("The little things you would otherwise search the internet for, on a page full of ads. Here they are in one place, and most of them run only on your own device."),
    start: { label: msg("Make a strong password"), href: "/tools/ids?tab=password" },
    replaces: [],
    tasks: [
      { label: msg("Make a strong password"), hint: msg("Generated on your device, never sent anywhere."), href: "/tools/ids?tab=password" },
      { label: msg("Make a QR code"), hint: msg("For a link, a text or your Wi-Fi password."), href: "/tools/qr" },
      { label: msg("Plan a meeting across time zones"), hint: msg("See what time it is for everyone."), href: "/tools/dates?tab=meeting" },
      { label: msg("Count working days between dates"), hint: msg("Skips weekends and the holidays you add."), href: "/tools/dates?tab=workdays" },
      { label: msg("Compare two versions of a text"), hint: msg("See exactly what somebody changed."), href: "/tools/diff" },
      { label: msg("Clean up a text"), hint: msg("Change letter case, remove duplicate lines, count words."), href: "/tools/text?tab=kit" },
    ],
  },
  {
    id: "data",
    icon: "data",
    name: msg("Spreadsheets and data"),
    headline: msg("Clean up tables and data files"),
    pitch: msg("Combine exported tables, remove duplicates and turn a long list into a summary. Your files are processed on your device."),
    start: { label: msg("Open a CSV file"), href: "/tools/csv?tab=convert" },
    replaces: [],
    tasks: [
      { label: msg("Combine several tables into one"), hint: msg("Pick the CSV files and download one table."), href: "/tools/csv?tab=merge" },
      { label: msg("Find duplicate rows"), hint: msg("See which rows repeat, and how many times."), href: "/tools/csv?tab=duplicates" },
      { label: msg("Make a summary table (pivot)"), hint: msg("Add up or count values by group."), href: "/tools/csv?tab=pivot" },
      { label: msg("Compare two tables"), hint: msg("See which cells are different."), href: "/tools/csv?tab=compare" },
      { label: msg("Check a JSON file"), hint: msg("Find the error and tidy the file up."), href: "/tools/json?tab=lint" },
      { label: msg("Work with SQL"), hint: msg("Tidy up, check and convert queries, or run them on a file."), href: "/tools/sql-lab?tab=format" },
    ],
  },
  {
    id: "automate",
    icon: "automate",
    name: msg("Automation and AI"),
    headline: msg("Let the boring tasks run by themselves"),
    pitch: msg("Connect apps on a canvas and let a task run on a schedule or when something happens, without paying per task. It runs free on this server."),
    start: { label: msg("Open Automations"), href: "/tools/workflows" },
    replaces: [
      { paid: "Zapier, Make", ours: msg("Automations"), what: msg("connecting apps and running tasks by themselves"), href: "/tools/workflows" },
    ],
    tasks: [
      { label: msg("Create an automation"), hint: msg("Join blocks together and try it right away."), href: "/tools/workflows?tab=editor" },
      { label: msg("Connect your own AI agent"), hint: msg("For people who already use Claude, Cursor or similar."), href: "/tools/mcp-connect" },
    ],
    limits: msg("It connects fewer services than the big paid platforms, and building an automation takes some patience the first time."),
  },
  {
    id: "web",
    icon: "dev",
    name: msg("Websites and code"),
    headline: msg("For people who build websites"),
    pitch: msg("Check a live website, try out CSS, read a token or test a search pattern, without installing anything."),
    start: { label: msg("Check a website"), href: "/tools/web?tab=check" },
    replaces: [],
    tasks: [
      { label: msg("Check a website"), hint: msg("Broken links, headings, security headers and search-engine basics."), href: "/tools/web?tab=check" },
      { label: msg("Try out CSS live"), hint: msg("Write code and see the result next to it."), href: "/tools/css?tab=playground" },
      { label: msg("Test a search pattern (regex)"), hint: msg("See live what it finds."), href: "/tools/regex" },
      { label: msg("Read a JWT token"), hint: msg("See what is inside, and verify it."), href: "/tools/ids?tab=jwt" },
      { label: msg("Convert a timestamp"), hint: msg("Unix time, time zones and date formats."), href: "/tools/dates?tab=epoch" },
    ],
  },
  {
    id: "learn",
    icon: "learn",
    name: msg("Courses"),
    headline: msg("Learn databases from zero"),
    pitch: msg("Short lessons in SQL and PostGIS with real queries on a real database. Instant checks, and hints when you get stuck."),
    start: { label: msg("Start the course"), href: "/tools/db-course" },
    replaces: [],
    tasks: [
      { label: msg("Start the course"), hint: msg("Your progress is saved in your account."), href: "/tools/db-course" },
    ],
  },
];

/** On every page that names a paid product. */
export const TRADEMARK_NOTE = msg("Microsoft, Word, Excel, PowerPoint, Adobe, Photoshop, Lightroom, Illustrator, Premiere, After Effects, InDesign, Audition, Acrobat, XD, Figma, AutoCAD, Zapier and Make are trademarks of their owners. Smart Knife is not connected with them or endorsed by them; the names only say what these free tools can be used instead of.");

export function findToolSet(id: string): ToolSet | undefined {
  return TOOL_SETS.find((set) => set.id === id);
}

/** The first-screen shortcuts: the jobs most people come for. */
export const TOP_TASKS: readonly SetTask[] = [
  { label: msg("Write a document"), hint: msg("Word, Excel and PowerPoint files, free."), href: "/tools/office" },
  { label: msg("Create my CV"), hint: msg("One question at a time, then download it."), href: "/tools/cv-studio" },
  { label: msg("Edit a PDF"), hint: msg("Add text and a signature to any page."), href: "/tools/pdf?tab=editor" },
  { label: msg("Edit a photo"), hint: msg("Instead of Photoshop."), href: craft("photocraft") },
  { label: msg("Make a photo smaller"), hint: msg("Ready for an email or a form in a minute."), href: "/tools/image-resize?tab=resize" },
  { label: msg("Cut a video"), hint: msg("Instead of Premiere Pro."), href: craft("filmcraft") },
];
