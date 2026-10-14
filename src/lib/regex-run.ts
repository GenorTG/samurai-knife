/** Runs the user's regex against the subject. Pure: executes inside regex.worker.ts, never on the page's main thread. */

export interface RegexMatch {
  index: number;
  length: number;
  value: string;
  groups: string[];
}

export interface RegexRunInput {
  pattern: string;
  flags: string;
  text: string;
  replacement: string;
  maxMatches: number;
}

export interface RegexRunOutput {
  matches: RegexMatch[];
  /** More matches exist beyond `maxMatches`. */
  truncated: boolean;
  replaced: string;
}

export type RegexTasks = {
  ping: { payload: null; result: true };
  run: { payload: RegexRunInput; result: RegexRunOutput };
};

export function runRegex({ pattern, flags, text, replacement, maxMatches }: RegexRunInput): RegexRunOutput {
  if (!pattern || !text) return { matches: [], truncated: false, replaced: "" };
  // Private regex so the loop owns its own lastIndex.
  const scan = new RegExp(pattern, flags.includes("g") ? flags : `${flags}g`);
  const matches: RegexMatch[] = [];
  let truncated = false;
  let m = scan.exec(text);
  while (m) {
    if (matches.length >= maxMatches) {
      truncated = true;
      break;
    }
    matches.push({ index: m.index, length: m[0].length, value: m[0], groups: m.slice(1).map((g) => g ?? "") });
    scan.lastIndex = m.index + (m[0].length === 0 ? 1 : m[0].length);
    m = scan.exec(text);
  }
  return { matches, truncated, replaced: text.replace(new RegExp(pattern, flags), replacement) };
}
