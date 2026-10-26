/** YAML <-> JSON conversion with lint. Pure: runs inline for small input and in yaml-json.worker.ts for large input. */
import { msgf } from "@/lib/i18n/msg";
import { parseDocument, stringify } from "yaml";

export type YamlJsonFormat = "yaml" | "json";

export interface YamlJsonInput {
  text: string;
  inputFormat: YamlJsonFormat;
  outputFormat: YamlJsonFormat;
  sort: boolean;
}

export interface YamlJsonOutput {
  output: string;
  /** At most `MAX_ERRORS` (the panel never shows more). */
  errors: string[];
  warnings: string[];
}

export type YamlJsonTasks = { convert: { payload: YamlJsonInput; result: YamlJsonOutput } };

/** Input above this many characters is converted in the worker (the yaml parser costs ~2 s per MB). */
export const YAML_JSON_INLINE_LIMIT = 50_000;
/** Large inputs (worker path): the readonly output box holds at most this many characters; Copy and Save use the full text. */
export const YAML_JSON_DISPLAY_LIMIT = 100_000;
export const MAX_ERRORS = 8;

function sortKeys(value: unknown, seen = new WeakMap<object, unknown>(), depth = 0): unknown {
  if (depth > 64) return value;
  if (Array.isArray(value)) {
    const existing = seen.get(value);
    if (existing) return existing;
    const sorted: unknown[] = [];
    seen.set(value, sorted);
    value.forEach((item) => sorted.push(sortKeys(item, seen, depth + 1)));
    return sorted;
  }
  if (value && typeof value === "object") {
    const existing = seen.get(value);
    if (existing) return existing;
    const sorted: Record<string, unknown> = {};
    seen.set(value, sorted);
    for (const [key, child] of Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))) {
      sorted[key] = sortKeys(child, seen, depth + 1);
    }
    return sorted;
  }
  return value;
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

interface NumberScan {
  /** Integers beyond ±(2^53 − 1) and the first path holding one. */
  unsafeInts: number;
  firstUnsafe: string | null;
  /** Numbers JSON cannot hold (`.inf`, `.nan`) and the first path holding one. */
  nonFinite: number;
  firstNonFinite: string | null;
}

function scanNumbers(value: unknown, path: string, scan: NumberScan, seen = new WeakSet<object>(), depth = 0): NumberScan {
  if (typeof value === "bigint") {
    if (value > MAX_SAFE || value < MIN_SAFE) {
      scan.unsafeInts += 1;
      scan.firstUnsafe ??= path;
    }
  } else if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      scan.nonFinite += 1;
      scan.firstNonFinite ??= `${path} (${String(value)})`;
    }
  } else if (value && typeof value === "object" && depth < 64 && !seen.has(value)) {
    seen.add(value);
    if (Array.isArray(value)) value.forEach((item, index) => scanNumbers(item, `${path}[${index}]`, scan, seen, depth + 1));
    else for (const [key, child] of Object.entries(value as Record<string, unknown>)) scanNumbers(child, `${path}.${key}`, scan, seen, depth + 1);
  }
  return scan;
}

/**
 * JSON text for a value tree that may hold BigInts (the parser keeps integers exact). Safe-range integers become plain numbers;
 * the rest are written with every digit through a one-off marker, because JSON.stringify refuses BigInt.
 */
function stringifyJson(value: unknown): string {
  const marker = `__knife_bigint_${Math.random().toString(36).slice(2)}__`;
  const text = JSON.stringify(
    value,
    (_key, item: unknown) => (typeof item === "bigint" ? (item >= MIN_SAFE && item <= MAX_SAFE ? Number(item) : `${marker}${item}`) : item),
    2,
  );
  return text.replace(new RegExp(`"${marker}(-?\\d+)"`, "g"), "$1");
}

export function convertYamlJson({ text: input, inputFormat, outputFormat, sort }: YamlJsonInput): YamlJsonOutput {
  if (!input.trim()) return { output: "", errors: [], warnings: [] };
  const document = parseDocument(input, {
    prettyErrors: true,
    schema: inputFormat === "json" ? "json" : "core",
    uniqueKeys: true,
    // Exact integers: the default turns 9007199254740993 into 9007199254740992 without a word.
    intAsBigInt: true,
  });
  const errors = document.errors.slice(0, MAX_ERRORS).map((issue) => {
    const line = issue.linePos?.[0];
    return `${line ? `Line ${line.line}, column ${line.col}: ` : ""}${issue.message}`;
  });
  const warnings = document.warnings.map((issue) => issue.message);
  if (errors.length) return { output: "", errors, warnings };

  try {
    const raw: unknown = document.toJS();
    const value = sort ? sortKeys(raw) : raw;
    if (outputFormat === "json") {
      const scan = scanNumbers(value, "$", { unsafeInts: 0, firstUnsafe: null, nonFinite: 0, firstNonFinite: null });
      if (scan.unsafeInts) {
        warnings.push(
          scan.unsafeInts === 1
            ? msgf("1 integer beyond ±9007199254740991 (at {firstUnsafe}) written with every digit; JavaScript and other double-based JSON readers will round it.", { firstUnsafe: scan.firstUnsafe })
            : msgf("{count} integers beyond ±9007199254740991 (first at {firstUnsafe}) written with every digit; JavaScript and other double-based JSON readers will round them.", { count: scan.unsafeInts, firstUnsafe: scan.firstUnsafe }),
        );
      }
      if (scan.nonFinite) {
        warnings.push(scan.nonFinite === 1 ? msgf("JSON has no infinity or NaN: 1 value written as null (first at {firstNonFinite}).", { firstNonFinite: scan.firstNonFinite }) : msgf("JSON has no infinity or NaN: {count} values written as null (first at {firstNonFinite}).", { count: scan.nonFinite, firstNonFinite: scan.firstNonFinite }));
      }
      return { output: stringifyJson(value), errors, warnings };
    }
    return { output: stringify(value, { indent: 2, schema: "core", sortMapEntries: sort }), errors, warnings };
  } catch (error) {
    return {
      output: "",
      errors: [error instanceof Error ? error.message : "Could not convert this document."],
      warnings,
    };
  }
}
