/**
 * Token usage, shared by the provider forwarder (server), the usage ledger (server) and the widget (browser).
 * Pure functions and types: no server or browser imports.
 *
 * Providers disagree on field names, so everything is normalised to `Usage`:
 *  - OpenAI-style: prompt_tokens, completion_tokens, prompt_tokens_details.cached_tokens, completion_tokens_details.reasoning_tokens
 *  - DeepSeek:     prompt_cache_hit_tokens (+ prompt_cache_miss_tokens)
 *  - Anthropic-compatible: input_tokens, output_tokens, cache_read_input_tokens
 * A provider that reports nothing yields `null`; callers may then fall back to `estimateUsage` (flagged `estimated`).
 */

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  /** Prompt tokens the provider served from its cache (subset of promptTokens). */
  cachedTokens: number;
  /** Hidden reasoning tokens (subset of completionTokens). */
  reasoningTokens: number;
  /** True when the provider reported nothing and the numbers are chars/4 guesses. */
  estimated?: boolean;
}

export const EMPTY_USAGE: Usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, reasoningTokens: 0 };

type Dict = Record<string, unknown>;
const isDict = (v: unknown): v is Dict => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
const first = (...values: unknown[]): number => {
  for (const v of values) {
    const n = count(v);
    if (n > 0) return n;
  }
  return 0;
};

export function normalizeUsage(raw: unknown): Usage | null {
  if (!isDict(raw)) return null;
  const promptDetails = isDict(raw.prompt_tokens_details) ? raw.prompt_tokens_details : {};
  const completionDetails = isDict(raw.completion_tokens_details) ? raw.completion_tokens_details : {};
  const hitPlusMiss = count(raw.prompt_cache_hit_tokens) + count(raw.prompt_cache_miss_tokens);
  const promptTokens = first(raw.prompt_tokens, raw.input_tokens, hitPlusMiss);
  const completionTokens = first(raw.completion_tokens, raw.output_tokens);
  if (promptTokens === 0 && completionTokens === 0) return null;
  const cachedTokens = first(promptDetails.cached_tokens, raw.prompt_cache_hit_tokens, raw.cache_read_input_tokens);
  const reasoningTokens = first(completionDetails.reasoning_tokens, raw.reasoning_tokens);
  return {
    promptTokens,
    completionTokens,
    cachedTokens: Math.min(cachedTokens, promptTokens),
    reasoningTokens: Math.min(reasoningTokens, completionTokens),
  };
}

/** Validates the normalised shape that crosses the wire from our own server (not a raw provider object). */
export function parseUsage(v: unknown): Usage | null {
  if (!isDict(v)) return null;
  const promptTokens = count(v.promptTokens);
  const completionTokens = count(v.completionTokens);
  if (promptTokens === 0 && completionTokens === 0) return null;
  return {
    promptTokens,
    completionTokens,
    cachedTokens: Math.min(count(v.cachedTokens), promptTokens),
    reasoningTokens: Math.min(count(v.reasoningTokens), completionTokens),
    ...(v.estimated === true ? { estimated: true } : {}),
  };
}

export function addUsage(a: Usage, b: Usage): Usage {
  const sum: Usage = {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
  if (a.estimated || b.estimated) sum.estimated = true;
  return sum;
}

/** chars/4: only used when the provider reports nothing, and always flagged. */
export function estimateUsage(requestChars: number, completionChars: number): Usage {
  return {
    promptTokens: Math.ceil(requestChars / 4),
    completionTokens: Math.ceil(completionChars / 4),
    cachedTokens: 0,
    reasoningTokens: 0,
    estimated: true,
  };
}

/** What one assistant turn (a run of model rounds) cost. */
export interface RunUsage extends Usage {
  rounds: number;
  /** Wall time of the whole run in milliseconds. */
  ms: number;
}

/* ------------------------------------------------------------------ formatting (locale-free: SSR safe) */

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function cacheShare(u: Usage): number {
  return u.promptTokens > 0 ? Math.round((u.cachedTokens / u.promptTokens) * 100) : 0;
}

/** One line for a turn footer: "3 rounds · 21.4k in (91% cached) · 1.6k out (60% reasoning) · 9.8 s". */
export function describeRunUsage(u: RunUsage): string {
  const tilde = u.estimated ? "~" : "";
  const parts = [
    `${u.rounds} ${u.rounds === 1 ? "round" : "rounds"}`,
    `${tilde}${formatTokens(u.promptTokens)} in${u.cachedTokens > 0 ? ` (${cacheShare(u)}% cached)` : ""}`,
    `${tilde}${formatTokens(u.completionTokens)} out${u.reasoningTokens > 0 ? ` (${Math.round((u.reasoningTokens / Math.max(1, u.completionTokens)) * 100)}% reasoning)` : ""}`,
    `${(u.ms / 1000).toFixed(1)} s`,
  ];
  return parts.join(" · ");
}

/* ------------------------------------------------------------------ ledger shapes (server writes, client reads) */

export interface UsageBucket extends Usage {
  requests: number;
  errors: number;
  /** Total model-round wall time in milliseconds. */
  ms: number;
}

export interface UsageSummary {
  today: UsageBucket;
  last7Days: UsageBucket;
  total: UsageBucket;
  /** Per day, newest first, at most 30 entries. */
  days: { date: string; bucket: UsageBucket }[];
  models: { model: string; bucket: UsageBucket }[];
}

export const EMPTY_BUCKET: UsageBucket = { ...EMPTY_USAGE, requests: 0, errors: 0, ms: 0 };
