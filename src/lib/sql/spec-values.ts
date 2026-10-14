import type { SpecValue } from "./types";

/**
 * One-line text grammar for query-spec values, so a single input can edit any value:
 *   text            -> "text" (a string literal)        12 / -3.5 -> number        true / false / null
 *   :name           -> { param: "name" }               @t.col    -> { col: "t.col" }
 *   'quoted text'   -> string (use for "12", ":x", "null" literals)
 *   =NOW()          -> { fn: "NOW" }                   =LOWER(@name) -> nested function with args
 */

/** Split on top-level commas (not inside quotes or parentheses). */
export function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = false;
  let current = "";
  for (const char of text) {
    if (char === "'") quote = !quote;
    if (!quote && char === "(") depth += 1;
    if (!quote && char === ")") depth = Math.max(0, depth - 1);
    if (!quote && depth === 0 && char === ",") {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim() || parts.length) parts.push(current.trim());
  return parts;
}

export function parseLoose(raw: string): SpecValue {
  const text = raw.trim();
  if (text === "null") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(text) && Number.isFinite(Number(text))) return Number(text);
  if (/^:[A-Za-z_][\w]*$/.test(text)) return { param: text.slice(1) };
  if (/^@[\w.]+$/.test(text)) return { col: text.slice(1) };
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  const fn = text.match(/^=([A-Za-z_]\w*)\((.*)\)$/s);
  if (fn) {
    const args = fn[2].trim() ? splitTopLevel(fn[2]).map(parseLoose) : [];
    return args.length ? { fn: fn[1], args } : { fn: fn[1] };
  }
  return raw;
}

export function formatLoose(value: SpecValue | undefined): string {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") {
    const ambiguous = parseLoose(value) !== value || /^\s|\s$/.test(value) || value === "";
    return ambiguous && value !== "" ? `'${value.replace(/'/g, "''")}'` : value;
  }
  if ("param" in value) return `:${value.param}`;
  if ("col" in value) return `@${value.col}`;
  return `=${value.fn}(${(value.args ?? []).map(formatLoose).join(", ")})`;
}

export function parseLooseList(raw: string): SpecValue[] {
  return raw.trim() ? splitTopLevel(raw).map(parseLoose) : [];
}

export function formatLooseList(values: SpecValue[] | SpecValue | undefined): string {
  if (values === undefined) return "";
  return (Array.isArray(values) ? values : [values]).map(formatLoose).join(", ");
}
