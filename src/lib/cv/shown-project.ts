/**
 * Browser: the CV project the open page shows (set by useCvData from GET /api/cv). Every CV and website request names it
 * (`?project=`), so a switch made by the assistant or another tab never sends this page's edits to another project;
 * the page itself follows the switch on its next poll. docs/CV-STUDIO.md "Projects".
 */
let shown: string | null = null;

export function setShownProject(id: string | null): void {
  shown = id;
}

export function shownProject(): string | null {
  return shown;
}

/** `path` with `project=<shown>` added (unchanged before the first load, when there is nothing to name yet). */
export function withProject(path: string): string {
  if (!shown) return path;
  return `${path}${path.includes("?") ? "&" : "?"}project=${encodeURIComponent(shown)}`;
}

/** Window event: the active CV project changed in this tab; open CV hooks reload at once instead of on their next poll. */
export const CV_PROJECT_EVENT = "knife:cv-project";

export function announceProjectChange(): void {
  window.dispatchEvent(new Event(CV_PROJECT_EVENT));
}
