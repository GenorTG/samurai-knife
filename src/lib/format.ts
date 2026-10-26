import { msgf } from "@/lib/i18n/msg";
/** Small shared helpers. Client-safe only — no Node imports in here. */

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * Locale-pinned number formatting. A bare `n.toLocaleString()` uses the
 * runtime's locale, so server (en-US) and a Polish/German browser render
 * different text ("20,000" vs "20 000") and React throws a hydration error.
 */
export function formatInt(n: number): string {
  return n.toLocaleString("en-US");
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; fall back to a hidden textarea.
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function downloadText(text: string, filename: string, mime = "text/plain"): void {
  downloadBlob(new Blob([text], { type: `${mime};charset=utf-8` }), filename);
}

export function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(msgf("Could not read {name}", { name: file.name })));
    reader.readAsDataURL(file);
  });
}

export function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(msgf("Could not read {name}", { name: file.name })));
    reader.readAsText(file);
  });
}

/**
 * Page-range syntax shared by the PDF tool: "1-3,7,9-11" → zero-based indices.
 * Returns null when the syntax is bad, so callers can show a clean message.
 */
export function parseRanges(input: string, count: number): number[] | null {
  const out: number[] = [];
  const trimmed = input.trim();
  if (!trimmed) return null;

  for (const part of trimmed.split(",")) {
    const chunk = part.trim();
    if (!chunk) return null;
    const range = chunk.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from < 1 || to < from || to > count) return null;
      for (let i = from; i <= to; i += 1) out.push(i - 1);
      continue;
    }
    if (/^\d+$/.test(chunk)) {
      const one = Number(chunk);
      if (one < 1 || one > count) return null;
      out.push(one - 1);
      continue;
    }
    return null;
  }

  return out.length ? [...new Set(out)].sort((a, b) => a - b) : null;
}

export function safeFilename(name: string): string {
  return name.replace(/[^\w.\-]+/g, "_").replace(/^_+|_+$/g, "") || "file";
}
