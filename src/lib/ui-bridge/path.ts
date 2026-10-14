import { canonicalSlug, findTool, resolveAlias } from "../registry";

/**
 * Where an outside agent may send the user's tab: a registered tool, optionally one of its tabs, plus a few known
 * deep-link parameters (an offer, a profile field, a CV version, an office document). Anything else is refused, so a
 * "show" request can never navigate outside the app. Pure.
 */

export const SHOW_PARAMS = ["job", "focus", "variant", "doc"] as const;
export type ShowParam = (typeof SHOW_PARAMS)[number];

export class ShowPathError extends Error {}

export function showPath(slug: string, tab?: string, params: Partial<Record<ShowParam, string>> = {}): string {
  const live = canonicalSlug(slug.trim());
  const tool = findTool(live);
  if (!tool) throw new ShowPathError(`unknown tool '${slug}'. Use knife_search_tools to find a slug.`);
  const query = new URLSearchParams();
  const tabId = tab?.trim() || resolveAlias(slug.trim())?.tab || "";
  if (tabId) {
    if (!tool.tabs?.some((t) => t.id === tabId)) {
      throw new ShowPathError(`'${live}' has no tab '${tabId}'${tool.tabs?.length ? ` (tabs: ${tool.tabs.map((t) => t.id).join(", ")})` : " (no tabs)"}.`);
    }
    query.set("tab", tabId);
  }
  for (const key of SHOW_PARAMS) {
    const value = params[key]?.trim();
    if (value) query.set(key, value.slice(0, 300));
  }
  const q = query.toString();
  return `/tools/${live}${q ? `?${q}` : ""}`;
}
