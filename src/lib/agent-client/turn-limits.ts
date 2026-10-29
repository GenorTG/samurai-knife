import * as z from "zod/v4";

/**
 * The assistant's per-turn budget (docs/ACCOUNTS.md "Assistant preferences"): how many model rounds one message may take
 * and how many tool calls they may make together, before the loop stops and asks the model to summarise. Stored on the
 * account (`assistant` in accounts.json) so it follows the user to every browser. Shared by the server (validation) and
 * the browser (the loop and the settings form): no side effects.
 */
export const TURN_LIMIT_BOUNDS = {
  maxRounds: { min: 4, max: 100, default: 24 },
  maxToolCalls: { min: 4, max: 200, default: 40 },
} as const;

export const turnLimitsSchema = z.object({
  maxRounds: z.number().int().min(TURN_LIMIT_BOUNDS.maxRounds.min).max(TURN_LIMIT_BOUNDS.maxRounds.max),
  maxToolCalls: z.number().int().min(TURN_LIMIT_BOUNDS.maxToolCalls.min).max(TURN_LIMIT_BOUNDS.maxToolCalls.max),
}).strict();

export type TurnLimits = z.infer<typeof turnLimitsSchema>;

export const DEFAULT_TURN_LIMITS: TurnLimits = {
  maxRounds: TURN_LIMIT_BOUNDS.maxRounds.default,
  maxToolCalls: TURN_LIMIT_BOUNDS.maxToolCalls.default,
};

/**
 * The limits to use: the two numbers of a value (other fields, like the public view's `custom`, are ignored) when both
 * are within bounds, else the defaults (a hand-edited value out of bounds counts as unset).
 */
export function resolveTurnLimits(stored: unknown): TurnLimits {
  if (typeof stored !== "object" || stored === null) return DEFAULT_TURN_LIMITS;
  const { maxRounds, maxToolCalls } = stored as Record<string, unknown>;
  const parsed = turnLimitsSchema.safeParse({ maxRounds, maxToolCalls });
  return parsed.success ? parsed.data : DEFAULT_TURN_LIMITS;
}
