/**
 * Fit a tool result into `limit` characters without breaking it (src/lib/agent-client/loop.ts, /api/agent/tool): a
 * JSON result stays valid JSON with every key kept; the largest strings are shortened and the largest arrays thinned
 * from the middle (with an "items omitted" marker) until it fits, so fields near the end (checks, state) survive.
 * Non-JSON text is cut with a note. Pure: the widget and the server both use it.
 */

const OMITTED = /^…\[(\d+) items omitted\]$/;
/** Strings at or below this length are never shortened: the marker would make them longer. */
const MIN_CLIP = 200;

type Container = unknown[] | Record<string, unknown>;
interface Candidate { parent: Container; key: number | string; item: string | unknown[]; size: number }

function largest(root: unknown): Candidate | null {
  let best: Candidate | null = null;
  const consider = (parent: Container, key: number | string, item: unknown) => {
    const eligible = (typeof item === "string" && item.length > MIN_CLIP) || (Array.isArray(item) && item.length > 1);
    if (eligible) {
      const size = JSON.stringify(item).length;
      if (!best || size > best.size) best = { parent, key, item: item as string | unknown[], size };
    }
    visit(item);
  };
  const visit = (current: unknown) => {
    if (Array.isArray(current)) current.forEach((item, index) => consider(current, index, item));
    else if (current && typeof current === "object") for (const [key, item] of Object.entries(current)) consider(current as Record<string, unknown>, key, item);
  };
  visit(root);
  return best;
}

function thin(items: unknown[]): void {
  const drop = Math.max(1, Math.ceil(items.length / 3));
  const at = Math.floor((items.length - drop) / 2);
  const removed = items.slice(at, at + drop);
  let count = 0;
  for (const item of removed) {
    const marker = typeof item === "string" ? OMITTED.exec(item) : null;
    count += marker ? Number(marker[1]) : 1;
  }
  items.splice(at, drop, `…[${count} items omitted]`);
}

export function clipJsonText(content: string, limit: number): string {
  if (content.length <= limit) return content;
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return `${content.slice(0, Math.max(0, limit - 80))}\n…[truncated, ${content.length} chars total]`;
  }
  if (!value || typeof value !== "object") return `${content.slice(0, Math.max(0, limit - 80))}\n…[truncated, ${content.length} chars total]`;
  for (let guard = 0; guard < 600; guard++) {
    const text = JSON.stringify(value);
    if (text.length <= limit) return text;
    const target = largest(value);
    if (!target) break;
    if (typeof target.item === "string") {
      const keep = Math.max(MIN_CLIP / 2, Math.floor(target.item.length / 2));
      (target.parent as Record<string, unknown>)[target.key] = `${target.item.slice(0, keep)}…[${target.item.length} chars]`;
    } else {
      thin(target.item);
    }
  }
  return JSON.stringify({ ok: false, error: `Tool result exceeded ${limit} characters and could not be compacted safely (${content.length} original characters).` });
}
