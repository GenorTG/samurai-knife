import * as z from "zod/v4";

/**
 * The assistant's per-turn budget (docs/ACCOUNTS.md "Assistant preferences"): how many model rounds one message may take,
 * how many tool calls they may make together and, optionally, how many prompt (input) tokens all its rounds may send,
 * before the loop stops and asks the model to summarise. Stored on the
 * account (`assistant` in accounts.json) so it follows the user to every browser. Shared by the server (validation) and
 * the browser (the loop and the settings form): no side effects.
 */
export const TURN_LIMIT_BOUNDS = {
  maxRounds: { min: 4, max: 100, default: 24 },
  maxToolCalls: { min: 4, max: 200, default: 40 },
  /** Off by default (no field): one long tool-heavy message can otherwise send millions of prompt tokens. */
  maxInputTokens: { min: 10_000, max: 10_000_000 },
} as const;

export const turnLimitsSchema = z.object({
  maxRounds: z.number().int().min(TURN_LIMIT_BOUNDS.maxRounds.min).max(TURN_LIMIT_BOUNDS.maxRounds.max),
  maxToolCalls: z.number().int().min(TURN_LIMIT_BOUNDS.maxToolCalls.min).max(TURN_LIMIT_BOUNDS.maxToolCalls.max),
  maxInputTokens: z.number().int().min(TURN_LIMIT_BOUNDS.maxInputTokens.min).max(TURN_LIMIT_BOUNDS.maxInputTokens.max).optional(),
}).strict();

export type TurnLimits = z.infer<typeof turnLimitsSchema>;

export const DEFAULT_TURN_LIMITS: TurnLimits = {
  maxRounds: TURN_LIMIT_BOUNDS.maxRounds.default,
  maxToolCalls: TURN_LIMIT_BOUNDS.maxToolCalls.default,
};

/**
 * The limits to use: the numbers of a value (other fields, like the public view's `custom`, are ignored) when they are
 * within bounds, else the defaults (a hand-edited value out of bounds counts as unset). An out-of-bounds token budget
 * alone is dropped (off), keeping the round and tool limits.
 */
export function resolveTurnLimits(stored: unknown): TurnLimits {
  if (typeof stored !== "object" || stored === null) return DEFAULT_TURN_LIMITS;
  const { maxRounds, maxToolCalls, maxInputTokens } = stored as Record<string, unknown>;
  const parsed = turnLimitsSchema.safeParse({ maxRounds, maxToolCalls });
  if (!parsed.success) return DEFAULT_TURN_LIMITS;
  const budget = turnLimitsSchema.shape.maxInputTokens.safeParse(maxInputTokens);
  return budget.success && budget.data !== undefined ? { ...parsed.data, maxInputTokens: budget.data } : parsed.data;
}
