/** Draft handling for numeric inputs: the raw text stays editable while typing, the computed value is clamped. Pure (see NumberField in ui.tsx). */

export interface NumberDraftSpec {
  min: number;
  max: number;
  /** Round down to a whole number before clamping. */
  integer?: boolean;
  /** Value used when the text is blank or not a number once editing ends. Defaults to `min`. */
  fallback?: number;
}

function clamp(n: number, spec: NumberDraftSpec): number {
  const whole = spec.integer ? Math.floor(n) : n;
  return Math.max(spec.min, Math.min(spec.max, whole));
}

/** Clamped value for text typed so far, or null while it is not (yet) a number: blank, "-", "1e". */
export function liveDraftValue(text: string, spec: NumberDraftSpec): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? clamp(n, spec) : null;
}

/** Final value when editing ends (blur or Enter): the clamped number, or the fallback for blank/invalid text. */
export function commitDraftValue(text: string, spec: NumberDraftSpec): number {
  return liveDraftValue(text, spec) ?? clamp(spec.fallback ?? spec.min, spec);
}
