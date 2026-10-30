import { msg, msgf } from "@/lib/i18n/msg";
import { apiJson, type NetDeps } from "../net";
import type { Issue, LighthouseResult } from "./types";

/**
 * Lighthouse scores through Google PageSpeed Insights (Google runs Lighthouse on its own machines against the public
 * URL: nothing heavy runs here). The caller picks the key (`pageSpeedKey`, src/lib/net/outbound.ts: the account's own,
 * the server's `KNIFE_PSI_API_KEY` for admins only, or none = PSI's small anonymous quota, admins only in public mode).
 * A failure is reported in the result, never thrown: the rest of the audit still runs.
 */

export const PSI_API = (): string => process.env.KNIFE_PSI_API_URL?.trim() || "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"] as const;
const METRICS = { fcp: "first-contentful-paint", lcp: "largest-contentful-paint", tbt: "total-blocking-time", cls: "cumulative-layout-shift", si: "speed-index" } as const;

type Json = Record<string, unknown>;

export function parsePsi(body: unknown, strategy: LighthouseResult["strategy"]): LighthouseResult {
  const lh = ((body ?? {}) as Json).lighthouseResult as Json | undefined;
  if (!lh) return { strategy, ok: false, error: "PageSpeed Insights returned no Lighthouse result", scores: {}, metrics: {}, failing: [] };
  const categories = (lh.categories ?? {}) as Record<string, Json>;
  const audits = (lh.audits ?? {}) as Record<string, Json>;
  const scores: LighthouseResult["scores"] = {};
  for (const c of CATEGORIES) {
    const score = categories[c]?.score;
    if (typeof score === "number") scores[c] = Math.round(score * 100);
  }
  const metrics: LighthouseResult["metrics"] = {};
  for (const [key, id] of Object.entries(METRICS)) {
    const display = audits[id]?.displayValue;
    if (typeof display === "string") metrics[key as keyof typeof METRICS] = display.replace(/ /g, " ");
  }
  const weighted = new Map<string, number>();
  for (const c of CATEGORIES) {
    for (const ref of ((categories[c]?.auditRefs ?? []) as Json[])) {
      const id = String(ref.id);
      weighted.set(id, Math.max(weighted.get(id) ?? 0, Number(ref.weight ?? 0)));
    }
  }
  const failing = [...weighted.entries()]
    .map(([id, weight]) => ({ id, weight, audit: audits[id] }))
    .filter(({ audit }) => audit && typeof audit.score === "number" && (audit.score as number) < 0.9 && audit.scoreDisplayMode !== "informative" && audit.scoreDisplayMode !== "notApplicable")
    .sort((a, b) => b.weight * (1 - (b.audit.score as number)) - a.weight * (1 - (a.audit.score as number)) || (a.audit.score as number) - (b.audit.score as number))
    .slice(0, 15)
    .map(({ id, audit }) => ({ id, title: String(audit.title ?? id).slice(0, 200), display: String(audit.displayValue ?? "").replace(/ /g, " ").slice(0, 120), score: Math.round((audit.score as number) * 100) }));
  return { strategy, ok: true, error: "", scores, metrics, failing };
}

export async function runLighthouse(url: string, strategy: LighthouseResult["strategy"], key: string, deps: NetDeps = {}): Promise<LighthouseResult> {
  const params = new URLSearchParams({ url, strategy, locale: "en" });
  for (const c of CATEGORIES) params.append("category", c.toUpperCase().replace("-", "_"));
  if (key) params.set("key", key);
  try {
    const res = await apiJson(`${PSI_API()}?${params}`, { timeoutMs: 120_000, maxBytes: 25_000_000 }, deps);
    if (res.status !== 200) {
      const message = String((((res.body ?? {}) as Json).error as Json | undefined)?.message ?? `HTTP ${res.status}`).slice(0, 300);
      const hint = res.status === 429 ? " (the anonymous PageSpeed quota is used up: add a PageSpeed API key in Connect)" : "";
      return { strategy, ok: false, error: `PageSpeed Insights: ${message}${hint}`, scores: {}, metrics: {}, failing: [] };
    }
    return parsePsi(res.body, strategy);
  } catch (error) {
    return { strategy, ok: false, error: `PageSpeed Insights: ${error instanceof Error ? error.message : String(error)}`, scores: {}, metrics: {}, failing: [] };
  }
}

/**
 * How many mobile runs an audit asks PageSpeed for: 3 with a PageSpeed key (its own quota), 1 on the anonymous quota.
 * `KNIFE_PSI_MOBILE_RUNS` (1-5) overrides both.
 */
export function mobileRuns(hasKey: boolean): number {
  const forced = Number(process.env.KNIFE_PSI_MOBILE_RUNS);
  if (Number.isInteger(forced) && forced >= 1) return Math.min(5, forced);
  return hasKey ? 3 : 1;
}

/** The run with the median performance score, carrying how many runs there were and their spread. */
export function medianResult(results: LighthouseResult[]): LighthouseResult {
  const ok = results.filter((r) => r.ok && r.scores.performance !== undefined);
  if (!ok.length) return results.find((r) => r.ok) ?? results[0];
  const sorted = [...ok].sort((a, b) => (a.scores.performance ?? 0) - (b.scores.performance ?? 0));
  const median = sorted[Math.floor((sorted.length - 1) / 2)];
  const scores = sorted.map((r) => r.scores.performance ?? 0);
  return { ...median, runs: ok.length, spread: { min: scores[0], max: scores[scores.length - 1] } };
}

export function lighthouseIssues(results: LighthouseResult[], page: string): Issue[] {
  const out: Issue[] = [];
  const mobile = results.find((r) => r.ok && r.strategy === "mobile") ?? results.find((r) => r.ok);
  if (!mobile) return out;
  const label: Record<string, string> = { performance: "Performance", accessibility: "Accessibility", "best-practices": "Best practices", seo: "SEO" };
  const runs = mobile.runs ?? 1;
  // PageSpeed's mobile performance is noisy (simulated throttling on shared machines): say so with every score.
  const noise = runs > 1 && mobile.spread
    ? msgf("Median of {runs} PageSpeed runs (lowest {min}, highest {max}); compare medians between audits, not single runs.", { runs, min: mobile.spread.min, max: mobile.spread.max })
    : msg("One PageSpeed run: mobile performance often moves 15-30 points between identical runs, so compare it over several audits before acting on a change.");
  for (const [cat, score] of Object.entries(mobile.scores)) {
    if (score === undefined || score >= 90) continue;
    const perf = cat === "performance";
    const metrics = Object.entries(mobile.metrics).map(([k, v]) => `${k.toUpperCase()} ${v}`).join(", ");
    out.push({
      id: `lighthouse.${cat}`,
      // A single noisy run is never a high finding on its own.
      severity: score < 50 && (!perf || runs > 1) ? "high" : "medium",
      category: "lighthouse",
      title: perf && runs > 1
        ? msgf("Lighthouse {label} {score}/100 ({strategy}, median of {runs} runs)", { label: label[cat] ?? cat, score, strategy: mobile.strategy, runs })
        : msgf("Lighthouse {label} {score}/100 ({strategy})", { label: label[cat] ?? cat, score, strategy: mobile.strategy }),
      detail: perf ? [metrics, noise].filter(Boolean).join(" ") : "",
      page,
      fix: msg("Start with the failing audits listed under Lighthouse, heaviest first."),
    });
  }
  return out;
}
