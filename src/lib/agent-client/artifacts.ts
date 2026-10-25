/**
 * Files the tools hand to the user ("Download" buttons), captured so the assistant can pass
 * one tool's output to the next without ever holding the bytes (models corrupt base64).
 *
 * Every tool in the app produces downloads the same way: it builds a Blob, makes an object URL
 * and clicks a `<a download>`. Rather than wiring each tool, `installArtifactCapture` wraps
 * `URL.createObjectURL` and `HTMLAnchorElement.prototype.click` once; the real download still
 * happens. The model sees small handles ("f1": name, type, size) and refers to them from
 * `upload_file {from_file}` and `read_text`. Module state survives client-side navigation.
 */

export interface ArtifactInfo {
  id: string;
  name: string;
  mime: string;
  bytes: number;
}

interface Artifact extends ArtifactInfo {
  blob: Blob;
  announced: boolean;
}

export const ARTIFACT_ID = /^f\d+$/;
const MAX_ARTIFACTS = 16;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const TEXT_PREVIEW_LIMIT = 20000;

const store = new Map<string, Artifact>();
const blobsByUrl = new Map<string, Blob>();
let counter = 0;
let installed = false;

function total(): number {
  let sum = 0;
  for (const a of store.values()) sum += a.blob.size;
  return sum;
}

function record(blob: Blob, filename: string): string {
  // Oldest first out when over the count or memory budget; never evict the file just recorded.
  const id = `f${++counter}`;
  store.set(id, { id, name: filename.replace(/[\\/]/g, "_").slice(0, 120) || "download", mime: blob.type || "application/octet-stream", bytes: blob.size, blob, announced: false });
  while (store.size > MAX_ARTIFACTS || (store.size > 1 && total() > MAX_TOTAL_BYTES)) {
    const oldest = store.keys().next().value;
    if (oldest === undefined || oldest === id) break;
    store.delete(oldest);
  }
  return id;
}

/** A file a tool made without a download (a Craft app's screenshot or export): into the chain; the tool's own result
 *  names it, so it is not announced again as new_files. */
export function addArtifact(blob: Blob, filename: string): ArtifactInfo {
  const id = record(blob, filename);
  const entry = store.get(id);
  if (entry) entry.announced = true;
  return artifactInfo(id) as ArtifactInfo;
}

/** Wrap the two browser APIs every tool's download goes through. Idempotent; browser only. */
export function installArtifactCapture(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const create = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (obj: Blob | MediaSource): string => {
    const url = create(obj);
    if (obj instanceof Blob) blobsByUrl.set(url, obj);
    return url;
  };
  const revoke = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = (url: string): void => {
    blobsByUrl.delete(url);
    revoke(url);
  };

  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement): void {
    if (this.hasAttribute("download") && this.href.startsWith("blob:")) {
      const blob = blobsByUrl.get(this.href);
      if (blob) record(blob, this.download);
    }
    click.call(this);
  };
}

export function artifactInfo(id: string): ArtifactInfo | null {
  const a = store.get(id);
  return a ? { id: a.id, name: a.name, mime: a.mime, bytes: a.bytes } : null;
}

export function listArtifacts(): ArtifactInfo[] {
  return Array.from(store.values(), ({ id, name, mime, bytes }) => ({ id, name, mime, bytes }));
}

/** Files produced since the last call; the model learns about each exactly once, right after the action that made it. */
export function drainNewArtifacts(): ArtifactInfo[] {
  const fresh: ArtifactInfo[] = [];
  for (const a of store.values()) {
    if (a.announced) continue;
    a.announced = true;
    fresh.push({ id: a.id, name: a.name, mime: a.mime, bytes: a.bytes });
  }
  return fresh;
}

/** A real File for a file input, named like the original unless overridden. */
export function artifactFile(id: string, name?: string): File | null {
  const a = store.get(id);
  return a ? new File([a.blob], name?.trim() || a.name, { type: a.mime }) : null;
}

function isTextual(a: Artifact): boolean {
  return /^text\//.test(a.mime) || /json|xml|yaml|svg|javascript/.test(a.mime);
}

/** Text of a produced text file (OCR output, CSV, JSON…), clipped; binary files are refused. */
export async function readArtifactText(id: string): Promise<{ text: string; chars: number } | { error: string }> {
  const a = store.get(id);
  if (!a) return { error: `No produced file ${id}. Produced files are listed as "files" in page_snapshot and "new_files" after a click.` };
  if (!isTextual(a)) return { error: `${a.name} is binary (${a.mime}); pass it to a tool with upload_file {from_file:"${id}"} instead of reading it.` };
  const full = await a.blob.text();
  return { text: full.length > TEXT_PREVIEW_LIMIT ? `${full.slice(0, TEXT_PREVIEW_LIMIT)}\n…[truncated, ${full.length} chars total]` : full, chars: full.length };
}

export function clearArtifacts(): void {
  store.clear();
  blobsByUrl.clear();
}
