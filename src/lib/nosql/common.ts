/**
 * Shared pieces of the NoSQL lab (`src/lib/nosql/*`): issues, did-you-mean, a lossless JSON parser,
 * string-literal escaping for JS / Python / redis-cli, and a tiny pretty-printer for code snippets.
 * Pure TypeScript, no DOM, no Node APIs: the browser, the knife tools and `node --test` all import it.
 * Imports between these files are extensionless so Next/tsc resolve them; the node tests register
 * `tests/ts-resolve.mjs` to do the same.
 */
import type * as z from "zod/v4";

export type Severity = "error" | "warning" | "info";

export interface NosqlIssue {
  severity: Severity;
  /** Dotted/bracketed path of the offending field inside the spec, e.g. `filter.age.$gtt` or `args[2]`. */
  path: string;
  message: string;
  /** Plain-language suggestion, shown next to the message. */
  fix?: string;
}

export interface Snippet {
  /** Syntax-highlighting / oracle hint: `javascript`, `python`, `shell`, `json`. */
  language: "javascript" | "python" | "shell" | "json";
  label: string;
  code: string;
}

export interface CompileOptions {
  /** One statement per line, no wrapping (the default wraps long values at 80 columns). */
  compact?: boolean;
}

export const WRAP_WIDTH = 80;

export function widthFor(options?: CompileOptions): number {
  return options?.compact ? Infinity : WRAP_WIDTH;
}

export interface CompileResult {
  ok: boolean;
  snippets: Snippet[];
  issues: NosqlIssue[];
}

export function makeIssue(severity: Severity, path: string, message: string, fix?: string): NosqlIssue {
  return fix ? { severity, path, message, fix } : { severity, path, message };
}

export function hasErrors(issues: NosqlIssue[]): boolean {
  return issues.some((item) => item.severity === "error");
}

export function joinPath(base: string, key: string | number): string {
  if (typeof key === "number") return `${base}[${key}]`;
  const part = /^[A-Za-z_][A-Za-z0-9_$]*$|^\$[A-Za-z]+$/.test(key) ? key : JSON.stringify(key);
  return base ? `${base}.${part}` : part;
}

/* ------------------------------------------------------------ did-you-mean */

/** Edit distance counting an adjacent swap ("STE" -> "SET") as one edit (optimal string alignment). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j], prev2[j - 2] + 1);
    }
    prev2 = prev;
    prev = row;
  }
  return prev[b.length];
}

/** Closest candidate within a distance proportional to the name length, case-insensitively; undefined when nothing is close. */
export function suggest(name: string, candidates: readonly string[]): string | undefined {
  const lower = name.toLowerCase();
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = levenshtein(lower, candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  const limit = Math.max(1, Math.min(3, Math.floor(name.length / 3)));
  return best !== undefined && bestDistance <= limit ? best : undefined;
}

export function didYouMean(name: string, candidates: readonly string[]): string {
  const hit = suggest(name, candidates);
  return hit ? ` Did you mean ${hit}?` : "";
}

/* ----------------------------------------------------------- zod -> issues */

export function zodToIssues(error: z.ZodError, knownKeys?: readonly string[]): NosqlIssue[] {
  const out: NosqlIssue[] = [];
  for (const raw of error.issues) {
    let base = "";
    for (const segment of raw.path) base = joinPath(base, typeof segment === "number" ? segment : String(segment));
    if (raw.code === "unrecognized_keys") {
      for (const key of raw.keys) {
        const hit = knownKeys ? suggest(key, knownKeys) : undefined;
        out.push(
          makeIssue(
            "error",
            joinPath(base, key),
            `Unknown field "${key}" for this operation.`,
            hit ? `Did you mean "${hit}"?` : knownKeys ? `Allowed fields: ${knownKeys.join(", ")}.` : undefined,
          ),
        );
      }
      continue;
    }
    out.push(makeIssue("error", base || "(spec)", raw.message.replace(/^Invalid input: /, "")));
  }
  return out;
}

/* ------------------------------------------------------ plain-object guards */

export type Obj = Record<string, unknown>;

export function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof RegExp);
}

export function isNum(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

export function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "bigint") return "a big integer";
  if (isObj(value)) return "an object";
  return `a ${typeof value}`;
}

/**
 * Path of the first object key named `__proto__`, or null. Spec values are parsed into ordinary JavaScript objects
 * (and validated by zod), which drop that key silently; refusing it beats generating code with a field missing.
 */
export function findProtoKey(value: unknown, path = ""): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findProtoKey(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
  } else if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) {
      if (key === "__proto__") return path ? `${path}.__proto__` : "__proto__";
      const hit = findProtoKey((value as Obj)[key], path ? `${path}.${key}` : key);
      if (hit) return hit;
    }
  }
  return null;
}

export const PROTO_KEY_MESSAGE = 'A field named "__proto__" is not supported: JavaScript objects cannot hold it as an ordinary field, so it would silently vanish from the generated code.';

/* ------------------------------------------------------- lossless JSON parse */

export type LosslessResult = { ok: true; value: unknown } | { ok: false; message: string; offset: number };

/**
 * JSON.parse that keeps integers beyond ±2^53 exact by returning them as `bigint` (JSON.parse silently rounds
 * them, which would corrupt IDs and 64-bit counters in generated code). `__proto__` is stored as a normal key.
 */
export function parseJsonLossless(text: string): LosslessResult {
  let pos = 0;
  const fail = (message: string): never => {
    throw Object.assign(new Error(message), { offset: pos });
  };
  const skip = () => {
    while (pos < text.length && " \t\r\n".includes(text[pos])) pos++;
  };
  const parseString = (): string => {
    pos++; // opening quote
    let out = "";
    for (;;) {
      if (pos >= text.length) fail("Unterminated string");
      const ch = text[pos];
      if (ch === '"') {
        pos++;
        return out;
      }
      if (ch === "\\") {
        const next = text[pos + 1];
        const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (next in simple) {
          out += simple[next];
          pos += 2;
        } else if (next === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(pos + 2, pos + 6))) {
          out += String.fromCharCode(parseInt(text.slice(pos + 2, pos + 6), 16));
          pos += 6;
        } else fail("Bad escape sequence in string");
      } else if (ch < " ") {
        fail("Control character inside a string (use \\n or \\t)");
      } else {
        out += ch;
        pos++;
      }
    }
  };
  const parseValue = (depth: number): unknown => {
    if (depth > 200) fail("Nested too deeply");
    skip();
    const ch = text[pos];
    if (ch === "{") {
      pos++;
      const obj: Obj = {};
      skip();
      if (text[pos] === "}") {
        pos++;
        return obj;
      }
      for (;;) {
        skip();
        if (text[pos] !== '"') fail("Expected a quoted property name");
        const key = parseString();
        skip();
        if (text[pos] !== ":") fail("Expected ':' after property name");
        pos++;
        Object.defineProperty(obj, key, { value: parseValue(depth + 1), enumerable: true, writable: true, configurable: true });
        skip();
        if (text[pos] === ",") {
          pos++;
          continue;
        }
        if (text[pos] === "}") {
          pos++;
          return obj;
        }
        fail("Expected ',' or '}'");
      }
    }
    if (ch === "[") {
      pos++;
      const arr: unknown[] = [];
      skip();
      if (text[pos] === "]") {
        pos++;
        return arr;
      }
      for (;;) {
        arr.push(parseValue(depth + 1));
        skip();
        if (text[pos] === ",") {
          pos++;
          continue;
        }
        if (text[pos] === "]") {
          pos++;
          return arr;
        }
        fail("Expected ',' or ']'");
      }
    }
    if (ch === '"') return parseString();
    if (text.startsWith("true", pos)) return ((pos += 4), true);
    if (text.startsWith("false", pos)) return ((pos += 5), false);
    if (text.startsWith("null", pos)) return ((pos += 4), null);
    const num = /^-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(pos));
    if (!num) return fail(pos >= text.length ? "Unexpected end of input" : `Unexpected character ${JSON.stringify(ch)}`);
    pos += num[0].length;
    if (!num[1] && !num[2]) {
      const asNumber = Number(num[0]);
      if (!Number.isSafeInteger(asNumber)) return BigInt(num[0]);
      return Object.is(asNumber, -0) ? -0 : asNumber;
    }
    return Number(num[0]);
  };
  try {
    const value = parseValue(0);
    skip();
    if (pos < text.length) fail("Unexpected text after the JSON value");
    return { ok: true, value };
  } catch (error) {
    const offset = (error as { offset?: number }).offset ?? pos;
    return { ok: false, message: error instanceof Error ? error.message : String(error), offset };
  }
}

export function lineColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  return { line: before.split("\n").length, column: offset - before.lastIndexOf("\n") };
}

/** JSON.stringify that survives bigint (as an exact number literal), for echoing normalised specs back. */
export function stringifyLossless(value: unknown, indent = 2): string {
  const marker = "__BIGINT__";
  const text = JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? `${marker}${item.toString()}` : item), indent);
  return (text ?? "null").replace(new RegExp(`"${marker}(-?\\d+)"`, "g"), "$1");
}

/* --------------------------------------------------------------- escaping */

export function isIdentifier(key: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) && key !== "__proto__";
}

/** An object-literal key for generated JS. `__proto__` must be computed or it would set the prototype instead of a field. */
export function jsKey(key: string): string {
  if (key === "__proto__") return '["__proto__"]';
  return isIdentifier(key) ? key : jsString(key);
}

/** A JS string literal: JSON.stringify is valid JS and keeps U+2028/2029 escaped. */
export function jsString(value: string): string {
  return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** A Python 3 string literal. Escapes by hand: JSON's 😀 surrogate pairs would NOT decode to one character in Python. */
export function pyString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else if (code >= 0xd800 && code <= 0xdfff) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else if (code === 0x2028 || code === 0x2029 || code === 0x85) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

/**
 * A redis-cli argument. redis-cli splits lines with sdssplitargs: bare tokens need no quotes; inside double quotes
 * `\\`, `\"`, `\n`, `\r`, `\t`, `\b`, `\a` and `\xHH` are understood.
 */
export function cliToken(value: string): string {
  if (/^[A-Za-z0-9_.:\-/*@+%]+$/.test(value) && !/^[-+]?$/.test(value)) return value;
  let out = '"';
  for (const byte of new TextEncoder().encode(value)) {
    const ch = String.fromCharCode(byte);
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (byte < 0x20 || byte === 0x7f) out += `\\x${byte.toString(16).padStart(2, "0")}`;
    else if (byte < 0x80) out += ch;
    else out += `\\x${byte.toString(16).padStart(2, "0")}`;
  }
  return `${out}"`;
}

export function pyNumber(n: number): string {
  if (Number.isNaN(n)) return 'float("nan")';
  if (n === Infinity) return 'float("inf")';
  if (n === -Infinity) return 'float("-inf")';
  if (Object.is(n, -0)) return "-0.0";
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return String(n);
  const text = String(n);
  return /[.eE]/.test(text) ? text : `${text}.0`;
}

/** Python float literal for a number that must stay a float (`10.0`, not `10`). */
export function pyFloat(n: number): string {
  const text = pyNumber(n);
  return /^-?\d+$/.test(text) ? `${text}.0` : text;
}

export function jsNumber(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (n === Infinity) return "Infinity";
  if (n === -Infinity) return "-Infinity";
  return Object.is(n, -0) ? "-0" : String(n);
}

/* ----------------------------------------------------------- pretty printer */

export interface Item {
  /** Already rendered, including its separator: `name: ` or `"name": `. */
  key?: string;
  value: Doc;
}
export interface Group {
  open: string;
  close: string;
  items: Item[];
  /** JS objects print `{ a: 1 }` inline; Python dicts and arrays print `{"a": 1}` / `[1]`. */
  pad?: boolean;
}
export type Doc = string | Group;

export function group(open: string, close: string, items: Item[], pad = false): Group {
  return { open, close, items, pad };
}

function inline(doc: Doc): string {
  if (typeof doc === "string") return doc;
  if (!doc.items.length) return doc.open + doc.close;
  const body = doc.items.map((item) => (item.key ?? "") + inline(item.value)).join(", ");
  return doc.pad ? `${doc.open} ${body} ${doc.close}` : doc.open + body + doc.close;
}

/**
 * Lays `doc` out at `level` indentation steps starting at `column`; short structures stay on one line, long ones
 * break one item per line. `reserve` is the number of characters that will follow the doc on its last line.
 */
export function printDoc(doc: Doc, level = 0, column = 0, width = WRAP_WIDTH, unit = "  ", reserve = 0): string {
  const flat = inline(doc);
  if (typeof doc === "string" || column + flat.length + reserve <= width) return flat;
  const pad = unit.repeat(level + 1);
  const lines = doc.items.map((item) => {
    const key = item.key ?? "";
    return `${pad}${key}${printDoc(item.value, level + 1, pad.length + key.length, width, unit, 1)},`;
  });
  return `${doc.open}\n${lines.join("\n")}\n${unit.repeat(level)}${doc.close}`;
}

/** Same layout but with the opening position already known (for `name = <doc>` and `call(<doc>)`). */
export function printAt(doc: Doc, prefixLength: number, level = 0, unit = "  ", width = WRAP_WIDTH, reserve = 0): string {
  return printDoc(doc, level, prefixLength + level * unit.length, width, unit, reserve);
}

export function indentLines(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line ? pad + line : line))
    .join("\n");
}
