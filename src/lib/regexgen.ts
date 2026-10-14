/**
 * Reverse regex: examples in, pattern out.
 *
 * The approach is deliberately mechanical so the output stays explainable:
 *   1. classify every character of each positive example (digit / lower /
 *      upper / space / literal) and collapse runs,
 *   2. factor out the literal prefix and suffix shared by all positives,
 *   3. alternate the generalised middles,
 *   4. add look-ahead guards built from the shortest substring that appears in
 *      a matching negative and in no positive.
 *
 * It then *verifies* the result against the examples and reports the truth,
 * including the cases it could not satisfy. Pure module: used by the Regex lab
 * UI and by the MCP tool surface.
 */

export const CLASS_ATOM: Record<string, string> = {
  d: "\\d",
  l: "[a-z]",
  u: "[A-Z]",
  s: "\\s",
};

export const CLASS_LEGEND: [string, string][] = [
  ["\\d", "any digit 0-9"],
  ["[a-z]", "any lowercase letter"],
  ["[A-Z]", "any uppercase letter"],
  ["\\s", "space or tab"],
  ["literal", "that exact character, escaped"],
];

export type AnchorMode = "line" | "string" | "off";

export interface Generation {
  pattern: string;
  flags: string;
  notes: string[];
  guards: string[];
  positives: string[];
  negatives: string[];
  positiveHits: boolean[];
  negativeHits: boolean[];
  clean: boolean;
}

export function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function classOf(ch: string): string {
  if (/[0-9]/.test(ch)) return "d";
  if (/[a-z]/.test(ch)) return "l";
  if (/[A-Z]/.test(ch)) return "u";
  if (/\s/.test(ch)) return "s";
  return `lit:${ch}`;
}

/** Collapse a string into a generalised pattern: runs of a class become `+`. */
export function generalize(text: string): string {
  const runs: { key: string; count: number; ch: string }[] = [];
  for (const ch of text) {
    const key = classOf(ch);
    const last = runs[runs.length - 1];
    if (last && last.key === key) last.count += 1;
    else runs.push({ key, count: 1, ch });
  }
  return runs
    .map((run) => {
      if (run.key.startsWith("lit:")) {
        const literal = escapeLiteral(run.ch.repeat(run.count));
        return run.count > 1 ? `(?:${literal})` : literal;
      }
      const atom = CLASS_ATOM[run.key];
      return run.count > 1 ? `${atom}+` : atom;
    })
    .join("");
}

export function commonPrefix(values: string[]): string {
  if (values.length === 0) return "";
  let prefix = "";
  for (let i = 0; i < values[0].length; i += 1) {
    const ch = values[0][i];
    if (values.every((value) => value[i] === ch)) prefix += ch;
    else break;
  }
  return prefix;
}

export function commonSuffix(values: string[]): string {
  if (values.length === 0) return "";
  let suffix = "";
  for (let i = 0; i < values[0].length; i += 1) {
    const ch = values[0][values[0].length - 1 - i];
    if (values.every((value) => value[value.length - 1 - i] === ch)) suffix = ch + suffix;
    else break;
  }
  return suffix;
}

/** Shortest substring of `needle` that appears in none of the positives. */
export function shortestGuard(needle: string, positives: string[]): string | null {
  const cap = Math.min(needle.length, 60);
  for (let len = 1; len <= cap; len += 1) {
    for (let start = 0; start + len <= needle.length; start += 1) {
      const slice = needle.slice(start, start + len);
      if (!positives.some((positive) => positive.includes(slice))) return slice;
    }
  }
  return null;
}

export function exampleLines(text: string, limit = 40): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, limit);
}

export function testAll(pattern: string, flags: string, samples: string[]): boolean[] {
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags.replace(/[gy]/g, ""));
  } catch {
    return samples.map(() => false);
  }
  return samples.map((sample) => re.test(sample));
}

export function buildGeneration(
  positiveText: string,
  negativeText: string,
  anchor: AnchorMode = "line",
): Generation | null {
  const positives = exampleLines(positiveText);
  const negatives = exampleLines(negativeText);
  if (!positives.length) return null;

  const prefix = commonPrefix(positives);
  const suffix = commonSuffix(positives);
  const middles = [
    ...new Set(
      positives.map((value) => {
        const middle = value.slice(prefix.length, Math.max(prefix.length, value.length - suffix.length));
        return middle.length ? generalize(middle) : "";
      }),
    ),
  ];

  const core =
    middles.length === 0
      ? escapeLiteral(`${prefix}${suffix}`)
      : middles.length === 1
        ? `${escapeLiteral(prefix)}${middles[0]}${escapeLiteral(suffix)}`
        : `${escapeLiteral(prefix)}(?:${middles.join("|")})${escapeLiteral(suffix)}`;

  const flags = anchor === "off" ? "g" : "gm";
  const head = anchor === "off" ? "" : "^";
  const tail = anchor === "off" ? "" : "$";
  let pattern = `${head}${core}${tail}`;

  const notes: string[] = [];
  if (prefix) notes.push(`shared literal prefix: ${JSON.stringify(prefix)}`);
  if (suffix) notes.push(`shared literal suffix: ${JSON.stringify(suffix)}`);
  if (middles.length > 1) notes.push(`${middles.length} alternatives in the middle`);

  // Grow guards until no negative matches, or we run out of distinguishing text.
  const guards: string[] = [];
  for (let pass = 0; pass < 6; pass += 1) {
    const hits = testAll(pattern, flags, negatives);
    const offender = negatives.findIndex((_, index) => hits[index]);
    if (offender === -1) break;
    const guard = shortestGuard(negatives[offender], positives);
    if (!guard) {
      notes.push(
        `no guard found for ${JSON.stringify(negatives[offender])} — it shares every substring with a positive`,
      );
      break;
    }
    guards.push(guard);
    const guardAlt = guards.map((g) => escapeLiteral(g)).join("|");
    pattern = `${head}(?!.*(?:${guardAlt}))${core}${tail}`;
    notes.push(`guard added: ${JSON.stringify(guard)}`);
  }

  const positiveHits = testAll(pattern, flags, positives);
  const negativeHits = testAll(pattern, flags, negatives);
  const clean = positiveHits.every(Boolean) && negativeHits.every((hit) => !hit);

  return {
    pattern,
    flags,
    notes,
    guards,
    positives,
    negatives,
    positiveHits,
    negativeHits,
    clean,
  };
}
