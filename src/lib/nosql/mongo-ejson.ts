/**
 * MongoDB typed values: Extended JSON v2 (relaxed + canonical) <-> mongosh shell syntax <-> PyMongo / Node driver
 * constructors.
 *
 * Extended JSON v2 reference (type table, relaxed vs canonical): https://www.mongodb.com/docs/manual/reference/mongodb-extended-json/
 * Spec: https://github.com/mongodb/specifications/blob/master/source/extended-json/extended-json.md
 * mongosh data types: https://www.mongodb.com/docs/mongodb-shell/reference/data-types/
 * PyMongo bson types: https://pymongo.readthedocs.io/en/stable/api/bson/index.html
 * Node driver (re-exports bson): https://www.mongodb.com/docs/drivers/node/current/data-formats/bson/
 */
import {
  group,
  jsKey,
  isObj,
  jsNumber,
  jsString,
  makeIssue,
  pyFloat,
  pyNumber,
  pyString,
  type Doc,
  type Item,
  type NosqlIssue,
  type Obj,
} from "./common";
import { REGEX_OPTION_LETTERS } from "./mongo-operators";

export type EjsonMode = "relaxed" | "canonical";

export type Typed =
  | { kind: "oid"; hex: string }
  | { kind: "date"; ms: number }
  | { kind: "long"; value: bigint }
  | { kind: "int"; value: number }
  | { kind: "double"; value: number }
  | { kind: "decimal"; value: string }
  | { kind: "regex"; pattern: string; options: string }
  | { kind: "timestamp"; t: number; i: number }
  | { kind: "binary"; base64: string; subType: number }
  | { kind: "uuid"; value: string }
  | { kind: "minKey" }
  | { kind: "maxKey" }
  | { kind: "unsupported"; key: string };

const TYPED_KEYS = [
  "$oid", "$date", "$numberLong", "$numberInt", "$numberDouble", "$numberDecimal", "$regularExpression", "$timestamp",
  "$binary", "$uuid", "$minKey", "$maxKey", "$code", "$symbol", "$undefined", "$dbPointer", "$scope",
];
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
export const INT32_MIN = -(2 ** 31);
export const INT32_MAX = 2 ** 31 - 1;
const MAX_DATE_MS = 8.64e15;

export type TypedResult = { typed: Typed } | { error: string };

function isInt64String(text: unknown): text is string {
  if (typeof text !== "string" || !/^-?\d+$/.test(text)) return false;
  const n = BigInt(text);
  return n >= INT64_MIN && n <= INT64_MAX;
}

/** Normalises the many `$date` spellings to epoch milliseconds. Strings without an offset are read as UTC. */
export function parseDateInput(input: unknown): { ms: number } | { error: string } {
  if (typeof input === "number" && Number.isFinite(input)) return Math.abs(input) <= MAX_DATE_MS ? { ms: input } : { error: "date is out of range" };
  if (typeof input === "bigint") return { ms: Number(input) };
  if (isObj(input) && Object.keys(input).length === 1 && "$numberLong" in input) {
    if (!isInt64String(input.$numberLong)) return { error: '$date.$numberLong must be an integer string like "1565546054692"' };
    const n = Number(input.$numberLong);
    return Math.abs(n) <= MAX_DATE_MS ? { ms: n } : { error: "date is out of range" };
  }
  if (typeof input === "string") {
    const hasZone = /(?:Z|[+-]\d\d(?::?\d\d)?)$/i.test(input) || !/T/.test(input);
    const ms = Date.parse(hasZone ? input : `${input}Z`);
    if (Number.isNaN(ms)) return { error: `"${input}" is not an ISO-8601 date like 2024-05-17T09:30:00Z` };
    return { ms };
  }
  return { error: "a date needs an ISO-8601 string or {\"$numberLong\": \"<millis>\"}" };
}

/** Recognises a single-key Extended JSON wrapper. Returns null for ordinary objects and `{error}` for malformed wrappers. */
export function asTyped(value: unknown): TypedResult | null {
  if (!isObj(value)) return null;
  const keys = Object.keys(value);
  const first = keys[0];
  if (!first || !TYPED_KEYS.includes(first)) return null;
  const only = keys.length === 1;
  switch (first) {
    case "$oid":
      if (only && typeof value.$oid === "string" && /^[0-9a-fA-F]{24}$/.test(value.$oid)) return { typed: { kind: "oid", hex: value.$oid.toLowerCase() } };
      return { error: '$oid must be exactly 24 hexadecimal characters, e.g. {"$oid": "507f1f77bcf86cd799439011"}' };
    case "$date": {
      if (!only) return { error: "$date must be the only key of its object" };
      const parsed = parseDateInput(value.$date);
      return "error" in parsed ? { error: `$date: ${parsed.error}` } : { typed: { kind: "date", ms: parsed.ms } };
    }
    case "$numberLong":
      if (only && isInt64String(value.$numberLong)) return { typed: { kind: "long", value: BigInt(value.$numberLong) } };
      return { error: '$numberLong must be a 64-bit integer written as a string, e.g. {"$numberLong": "9007199254740993"}' };
    case "$numberInt": {
      const n = Number(value.$numberInt);
      if (only && typeof value.$numberInt === "string" && /^-?\d+$/.test(value.$numberInt) && n >= INT32_MIN && n <= INT32_MAX) return { typed: { kind: "int", value: n } };
      return { error: '$numberInt must be a 32-bit integer written as a string, e.g. {"$numberInt": "10"}' };
    }
    case "$numberDouble": {
      const text = value.$numberDouble;
      if (only && typeof text === "string" && (["Infinity", "-Infinity", "NaN"].includes(text) || (/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) && Number.isFinite(Number(text))))) {
        return { typed: { kind: "double", value: Number(text) } };
      }
      return { error: '$numberDouble must be a decimal string such as "10.5", "Infinity" or "NaN"' };
    }
    case "$numberDecimal":
      if (only && typeof value.$numberDecimal === "string" && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$|^[+-]?(?:Infinity|NaN)$/i.test(value.$numberDecimal)) {
        return { typed: { kind: "decimal", value: value.$numberDecimal } };
      }
      return { error: '$numberDecimal must be a decimal string such as "10.99"' };
    case "$regularExpression": {
      const body = value.$regularExpression;
      if (only && isObj(body) && typeof body.pattern === "string" && (body.options === undefined || typeof body.options === "string")) {
        const options = (body.options as string | undefined) ?? "";
        if ([...options].every((c) => REGEX_OPTION_LETTERS.includes(c))) return { typed: { kind: "regex", pattern: body.pattern, options: [...options].sort().join("") } };
        return { error: `regex options may only use the letters ${[...REGEX_OPTION_LETTERS].join(", ")}` };
      }
      return { error: '$regularExpression needs {"pattern": "...", "options": "i"}' };
    }
    case "$timestamp": {
      const body = value.$timestamp;
      if (only && isObj(body) && Number.isInteger(body.t) && Number.isInteger(body.i) && (body.t as number) >= 0 && (body.i as number) >= 0) {
        return { typed: { kind: "timestamp", t: body.t as number, i: body.i as number } };
      }
      return { error: '$timestamp needs positive integers {"t": 1, "i": 1}' };
    }
    case "$binary": {
      const body = value.$binary;
      if (only && isObj(body) && typeof body.base64 === "string" && typeof body.subType === "string" && /^[0-9a-fA-F]{1,2}$/.test(body.subType) && /^[A-Za-z0-9+/]*={0,2}$/.test(body.base64)) {
        return { typed: { kind: "binary", base64: body.base64, subType: parseInt(body.subType, 16) } };
      }
      return { error: '$binary needs {"base64": "...", "subType": "00"} (subType as a 1-2 digit hex string)' };
    }
    case "$uuid":
      if (only && typeof value.$uuid === "string" && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value.$uuid)) {
        return { typed: { kind: "uuid", value: value.$uuid.toLowerCase() } };
      }
      return { error: '$uuid must be a dashed UUID string like "123e4567-e89b-12d3-a456-426614174000"' };
    case "$minKey":
      return only && value.$minKey === 1 ? { typed: { kind: "minKey" } } : { error: '$minKey must be {"$minKey": 1}' };
    case "$maxKey":
      return only && value.$maxKey === 1 ? { typed: { kind: "maxKey" } } : { error: '$maxKey must be {"$maxKey": 1}' };
    default:
      // $code, $symbol, $undefined, $dbPointer, $scope exist in Extended JSON but have no portable shell/driver form here.
      return { typed: { kind: "unsupported", key: first } };
  }
}

/* ------------------------------------------------------------- walk + convert */

/** Visits every wrapper-or-plain node; `visit` returns false to stop descending into that node. */
export function walkValue(value: unknown, path: string, visit: (node: unknown, path: string) => boolean | void): void {
  if (visit(value, path) === false) return;
  if (Array.isArray(value)) value.forEach((item, index) => walkValue(item, `${path}[${index}]`, visit));
  else if (isObj(value)) for (const [key, item] of Object.entries(value)) walkValue(item, path ? `${path}.${key}` : key, visit);
}

/** Collects malformed Extended JSON wrappers anywhere inside `value`. */
export function typedIssues(value: unknown, base: string): NosqlIssue[] {
  const out: NosqlIssue[] = [];
  walkValue(value, base, (node, path) => {
    const typed = asTyped(node);
    if (!typed) return;
    if ("error" in typed) out.push(makeIssue("error", path, `Bad Extended JSON value: ${typed.error}.`));
    else if (typed.typed.kind === "unsupported") out.push(makeIssue("error", path, `The Extended JSON type ${typed.typed.key} is not supported by the code generator.`, "Use a plain string/number, or write this value by hand in the generated code."));
    return false;
  });
  return out;
}

function typedToCanonical(t: Typed): unknown {
  switch (t.kind) {
    case "oid": return { $oid: t.hex };
    case "date": return { $date: { $numberLong: String(t.ms) } };
    case "long": return { $numberLong: t.value.toString() };
    case "int": return { $numberInt: String(t.value) };
    case "double": return { $numberDouble: Number.isNaN(t.value) ? "NaN" : t.value === Infinity ? "Infinity" : t.value === -Infinity ? "-Infinity" : numberToDoubleString(t.value) };
    case "decimal": return { $numberDecimal: t.value };
    case "regex": return { $regularExpression: { pattern: t.pattern, options: t.options } };
    case "timestamp": return { $timestamp: { t: t.t, i: t.i } };
    case "binary": return { $binary: { base64: t.base64, subType: t.subType.toString(16).padStart(2, "0") } };
    case "uuid": return { $uuid: t.value };
    case "minKey": return { $minKey: 1 };
    case "maxKey": return { $maxKey: 1 };
    default: return { [t.key]: null };
  }
}

function numberToDoubleString(n: number): string {
  const text = String(n);
  return /[.eE]/.test(text) ? text : `${text}.0`;
}

function typedToRelaxed(t: Typed): unknown {
  switch (t.kind) {
    case "int": return t.value;
    case "long": return t.value >= BigInt(Number.MIN_SAFE_INTEGER) && t.value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(t.value) : t.value;
    case "double":
      return Number.isFinite(t.value) && !Number.isInteger(t.value) ? t.value : typedToCanonical(t);
    case "date": {
      const year = new Date(t.ms).getUTCFullYear();
      return year >= 1970 && year <= 9999 ? { $date: new Date(t.ms).toISOString() } : typedToCanonical(t);
    }
    default: return typedToCanonical(t);
  }
}

/** Rewrites every typed wrapper (and plain numbers) of an Extended JSON tree in the requested mode. */
export function convertEjson(value: unknown, mode: EjsonMode): unknown {
  const typed = asTyped(value);
  if (typed && "typed" in typed) return mode === "canonical" ? typedToCanonical(typed.typed) : typedToRelaxed(typed.typed);
  if (Array.isArray(value)) return value.map((item) => convertEjson(item, mode));
  if (isObj(value)) {
    const out: Obj = {};
    for (const [key, item] of Object.entries(value)) Object.defineProperty(out, key, { value: convertEjson(item, mode), enumerable: true, writable: true, configurable: true });
    return out;
  }
  if (mode === "canonical") {
    if (typeof value === "bigint") return { $numberLong: value.toString() };
    if (typeof value === "number") {
      if (Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX) return { $numberInt: String(value) };
      if (Number.isInteger(value) && Number.isSafeInteger(value)) return { $numberLong: String(value) };
      return { $numberDouble: Number.isNaN(value) ? "NaN" : value === Infinity ? "Infinity" : value === -Infinity ? "-Infinity" : numberToDoubleString(value) };
    }
  }
  return value;
}

/* --------------------------------------------------------- shell-syntax parser */

export type ShellParse = { ok: true; value: unknown } | { ok: false; message: string; offset: number };

/**
 * Parses what people paste from mongosh/Compass: unquoted keys, single quotes, trailing commas, comments,
 * `ObjectId("…")`, `ISODate("…")`, `new Date("…")`, `NumberLong(…)`, `NumberInt`, `NumberDecimal`, `Timestamp`, `UUID`,
 * `BinData`, `MinKey()/MaxKey()` and `/regex/flags`. The result is relaxed-or-canonical Extended JSON (see `convertEjson`).
 */
export function parseShellValue(text: string): ShellParse {
  let pos = 0;
  const fail = (message: string, at = pos): never => {
    throw Object.assign(new Error(message), { offset: at });
  };
  const skip = () => {
    for (;;) {
      while (pos < text.length && /\s/.test(text[pos])) pos++;
      if (text.startsWith("//", pos)) while (pos < text.length && text[pos] !== "\n") pos++;
      else if (text.startsWith("/*", pos)) {
        const end = text.indexOf("*/", pos + 2);
        if (end < 0) fail("Unterminated /* comment");
        pos = end + 2;
      } else return;
    }
  };
  const expect = (ch: string) => {
    skip();
    if (text[pos] !== ch) fail(`Expected '${ch}'`);
    pos++;
  };
  const readString = (): string => {
    const quote = text[pos++];
    let out = "";
    for (;;) {
      if (pos >= text.length) fail("Unterminated string");
      const ch = text[pos];
      if (ch === quote) {
        pos++;
        return out;
      }
      if (ch === "\\") {
        const next = text[pos + 1];
        const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0", "\\": "\\", "'": "'", '"': '"', "/": "/" };
        if (next in simple) {
          out += simple[next];
          pos += 2;
        } else if (next === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(pos + 2, pos + 6))) {
          out += String.fromCharCode(parseInt(text.slice(pos + 2, pos + 6), 16));
          pos += 6;
        } else if (next === "x" && /^[0-9a-fA-F]{2}$/.test(text.slice(pos + 2, pos + 4))) {
          out += String.fromCharCode(parseInt(text.slice(pos + 2, pos + 4), 16));
          pos += 4;
        } else fail("Bad escape sequence");
      } else {
        out += ch;
        pos++;
      }
    }
  };
  const readNumber = (): number | bigint => {
    const m = /^[+-]?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(text.slice(pos));
    if (!m) return fail("Expected a number");
    pos += m[0].length;
    const isInteger = /^[+-]?(?:\d+|0[xX][0-9a-fA-F]+)$/.test(m[0]);
    if (isInteger) {
      const big = m[0].startsWith("-") ? -BigInt(m[0].slice(1)) : BigInt(m[0].replace(/^\+/, ""));
      return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
    }
    return Number(m[0]);
  };
  const call = (name: string): unknown => {
    const start = pos;
    expect("(");
    const args: unknown[] = [];
    skip();
    if (text[pos] !== ")") {
      for (;;) {
        args.push(value(1));
        skip();
        if (text[pos] === ",") {
          pos++;
          skip();
          if (text[pos] === ")") break;
          continue;
        }
        break;
      }
    }
    expect(")");
    return construct(name, args, start);
  };
  const str = (arg: unknown, what: string, at: number): string => (typeof arg === "string" ? arg : fail(`${what} needs a quoted string argument`, at));
  const construct = (name: string, args: unknown[], at: number): unknown => {
    const intArg = (arg: unknown): string => (typeof arg === "bigint" ? arg.toString() : typeof arg === "number" && Number.isInteger(arg) ? String(arg) : typeof arg === "string" && /^-?\d+$/.test(arg) ? arg : fail(`${name} needs an integer`, at));
    switch (name) {
      case "ObjectId":
        if (!args.length) fail("ObjectId() without an argument makes a new random id when it runs; write the 24-character hex string instead", at);
        return { $oid: str(args[0], "ObjectId", at) };
      case "ISODate":
      case "Date": {
        if (!args.length) fail(`${name}() without an argument means "now"; write the date explicitly, e.g. ISODate("2024-05-17T09:30:00Z")`, at);
        const parsed = parseDateInput(args[0]);
        if ("error" in parsed) return fail(parsed.error, at);
        return { $date: { $numberLong: String(parsed.ms) } };
      }
      case "NumberLong":
      case "Long": return { $numberLong: intArg(args[0]) };
      case "NumberInt":
      case "Int32": return { $numberInt: intArg(args[0]) };
      case "NumberDecimal":
      case "Decimal128": return { $numberDecimal: typeof args[0] === "number" ? String(args[0]) : str(args[0], name, at) };
      case "Double": return { $numberDouble: String(args[0]) };
      case "Timestamp": {
        const body = isObj(args[0]) ? args[0] : { t: args[0], i: args[1] };
        return { $timestamp: { t: body.t, i: body.i } };
      }
      case "UUID": return { $uuid: str(args[0], "UUID", at) };
      case "BinData": return { $binary: { base64: str(args[1], "BinData", at), subType: Number(args[0]).toString(16).padStart(2, "0") } };
      case "MinKey": return { $minKey: 1 };
      case "MaxKey": return { $maxKey: 1 };
      case "BSONRegExp": return { $regularExpression: { pattern: str(args[0], "BSONRegExp", at), options: typeof args[1] === "string" ? args[1] : "" } };
      case "RegExp": return { $regularExpression: { pattern: str(args[0], "RegExp", at), options: typeof args[1] === "string" ? args[1] : "" } };
      default: return fail(`Unknown constructor ${name}(…). Supported: ObjectId, ISODate, Date, NumberLong, NumberInt, NumberDecimal, Timestamp, UUID, BinData, MinKey, MaxKey`, at);
    }
  };
  const value = (depth: number): unknown => {
    if (depth > 200) fail("Nested too deeply");
    skip();
    const ch = text[pos];
    if (ch === "{") {
      pos++;
      const obj: Obj = {};
      for (;;) {
        skip();
        if (text[pos] === "}") {
          pos++;
          return obj;
        }
        let key: string;
        if (text[pos] === '"' || text[pos] === "'") key = readString();
        else {
          const id = /^[A-Za-z_$][A-Za-z0-9_$]*|^\d+/.exec(text.slice(pos));
          if (!id) return fail("Expected a property name");
          key = id[0];
          pos += key.length;
        }
        expect(":");
        Object.defineProperty(obj, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
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
      for (;;) {
        skip();
        if (text[pos] === "]") {
          pos++;
          return arr;
        }
        arr.push(value(depth + 1));
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
    if (ch === '"' || ch === "'") return readString();
    if (ch === "/") {
      const start = pos;
      pos++;
      let inClass = false;
      let pattern = "";
      for (;;) {
        if (pos >= text.length || text[pos] === "\n") fail("Unterminated regular expression", start);
        const c = text[pos];
        if (c === "\\") {
          pattern += c + (text[pos + 1] ?? "");
          pos += 2;
          continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
        pattern += c;
        pos++;
      }
      pos++;
      const flags = /^[a-z]*/.exec(text.slice(pos))?.[0] ?? "";
      pos += flags.length;
      return { $regularExpression: { pattern: pattern.replace(/\\\//g, "/"), options: [...flags].sort().join("") } };
    }
    if (/[-+.\d]/.test(ch ?? "")) {
      if (text.startsWith("-Infinity", pos)) return ((pos += 9), { $numberDouble: "-Infinity" });
      return readNumber();
    }
    const word = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(pos))?.[0];
    if (!word) return fail(pos >= text.length ? "Unexpected end of input" : `Unexpected character ${JSON.stringify(ch)}`);
    if (word === "new") {
      pos += 3;
      skip();
      const ctor = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(pos))?.[0];
      if (!ctor) fail("Expected a constructor after 'new'");
      pos += (ctor as string).length;
      return call(ctor as string);
    }
    pos += word.length;
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    if (word === "Infinity") return { $numberDouble: "Infinity" };
    if (word === "NaN") return { $numberDouble: "NaN" };
    if (word === "undefined") return fail("undefined has no JSON equivalent; use null or leave the field out", pos - word.length);
    skip();
    if (text[pos] === "(") return call(word);
    return fail(`Unexpected word "${word}". Quote strings like "${word}".`, pos - word.length);
  };
  try {
    const result = value(0);
    skip();
    if (pos < text.length) fail("Unexpected text after the value");
    return { ok: true, value: result };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error), offset: (error as { offset?: number }).offset ?? pos };
  }
}

/* ------------------------------------------------------------- code renderers */

export type Target = "mongosh" | "python" | "node";

export interface RenderContext {
  imports: Set<string>;
  issues: NosqlIssue[];
}

export function newContext(): RenderContext {
  return { imports: new Set(), issues: [] };
}

function escapeRegexSlashes(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") out += c + (pattern[++i] ?? "");
    else if (c === "/") out += "\\/";
    else out += c;
  }
  return out;
}

function jsRegexLiteral(pattern: string, options: string): string | null {
  if (!/^[ims]*$/.test(options) || /[\n\r\u2028\u2029]/.test(pattern) || pattern === "") return null;
  try {
    new RegExp(pattern, options);
  } catch {
    return null;
  }
  return `/${escapeRegexSlashes(pattern)}/${options}`;
}

function dateParts(ms: number): { y: number; mo: number; d: number; h: number; mi: number; s: number; us: number } {
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), us: d.getUTCMilliseconds() * 1000 };
}

function typedDoc(t: Typed, target: Target, ctx: RenderContext, path: string): Doc {
  switch (t.kind) {
    case "oid":
      if (target === "mongosh") return `ObjectId(${jsString(t.hex)})`;
      if (target === "python") return (ctx.imports.add("from bson import ObjectId"), `ObjectId(${pyString(t.hex)})`);
      return (ctx.imports.add("ObjectId"), `new ObjectId(${jsString(t.hex)})`);
    case "date": {
      const iso = new Date(t.ms).toISOString();
      if (target === "mongosh") return `ISODate(${jsString(iso)})`;
      if (target === "node") return `new Date(${jsString(iso)})`;
      const p = dateParts(t.ms);
      if (p.y < 1 || p.y > 9999) {
        ctx.issues.push(makeIssue("error", path, "Python's datetime cannot represent years outside 1-9999.", "Use a date inside that range, or build this value by hand with bson.json_util.loads."));
        return "None";
      }
      ctx.imports.add("import datetime");
      const fields = [p.y, p.mo, p.d, p.h, p.mi, p.s, p.us].join(", ");
      return `datetime.datetime(${fields}, tzinfo=datetime.timezone.utc)`;
    }
    case "long":
      if (target === "mongosh") return `NumberLong(${jsString(t.value.toString())})`;
      if (target === "python") return (ctx.imports.add("from bson import Int64"), `Int64(${t.value.toString()})`);
      return (ctx.imports.add("Long"), `Long.fromString(${jsString(t.value.toString())})`);
    case "int":
      return target === "mongosh" ? `NumberInt(${t.value})` : String(t.value);
    case "double":
      if (target === "python") return pyFloat(t.value);
      if (target === "node" && Number.isInteger(t.value)) return (ctx.imports.add("Double"), `new Double(${jsNumber(t.value)})`);
      if (target === "mongosh" && Number.isInteger(t.value) && Number.isFinite(t.value)) return `Double(${jsNumber(t.value)})`;
      return jsNumber(t.value);
    case "decimal":
      if (target === "mongosh") return `NumberDecimal(${jsString(t.value)})`;
      if (target === "python") return (ctx.imports.add("from bson import Decimal128"), `Decimal128(${pyString(t.value)})`);
      return (ctx.imports.add("Decimal128"), `Decimal128.fromString(${jsString(t.value)})`);
    case "regex": {
      if (target === "python") return (ctx.imports.add("from bson import Regex"), `Regex(${pyString(t.pattern)}, ${pyString(t.options)})`);
      const literal = jsRegexLiteral(t.pattern, t.options);
      if (literal) return literal;
      if (target === "mongosh") return `BSONRegExp(${jsString(t.pattern)}, ${jsString(t.options)})`;
      return (ctx.imports.add("BSONRegExp"), `new BSONRegExp(${jsString(t.pattern)}, ${jsString(t.options)})`);
    }
    case "timestamp":
      if (target === "python") return (ctx.imports.add("from bson import Timestamp"), `Timestamp(${t.t}, ${t.i})`);
      if (target === "node") return (ctx.imports.add("Timestamp"), `new Timestamp({ t: ${t.t}, i: ${t.i} })`);
      return `Timestamp({ t: ${t.t}, i: ${t.i} })`;
    case "binary":
      if (target === "mongosh") return `BinData(${t.subType}, ${jsString(t.base64)})`;
      if (target === "python") return (ctx.imports.add("import base64"), ctx.imports.add("from bson import Binary"), `Binary(base64.b64decode(${pyString(t.base64)}), ${t.subType})`);
      return (ctx.imports.add("Binary"), `Binary.createFromBase64(${jsString(t.base64)}, ${t.subType})`);
    case "uuid":
      if (target === "mongosh") return `UUID(${jsString(t.value)})`;
      if (target === "python") return (ctx.imports.add("import uuid"), `uuid.UUID(${pyString(t.value)})`);
      return (ctx.imports.add("UUID"), `new UUID(${jsString(t.value)})`);
    case "minKey":
      return target === "mongosh" ? "MinKey()" : target === "python" ? (ctx.imports.add("from bson import MinKey"), "MinKey()") : (ctx.imports.add("MinKey"), "new MinKey()");
    case "maxKey":
      return target === "mongosh" ? "MaxKey()" : target === "python" ? (ctx.imports.add("from bson import MaxKey"), "MaxKey()") : (ctx.imports.add("MaxKey"), "new MaxKey()");
    default:
      return target === "python" ? "None" : "null";
  }
}

/** Renders an Extended JSON value as a code Doc in the syntax of `target`, recording needed imports in `ctx`. */
export function valueDoc(value: unknown, target: Target, ctx: RenderContext, path = ""): Doc {
  const typed = asTyped(value);
  if (typed) return "typed" in typed ? typedDoc(typed.typed, target, ctx, path) : (target === "python" ? "None" : "null");
  if (value === null) return target === "python" ? "None" : "null";
  if (typeof value === "boolean") return target === "python" ? (value ? "True" : "False") : String(value);
  if (typeof value === "bigint") {
    if (value < INT64_MIN || value > INT64_MAX) {
      ctx.issues.push(makeIssue("error", path, "This integer does not fit in 64 bits.", "MongoDB integers are at most 9223372036854775807; use a string or $numberDecimal."));
      return "0";
    }
    return typedDoc({ kind: "long", value }, target, ctx, path);
  }
  if (typeof value === "number") {
    if (Number.isInteger(value) && (value > INT32_MAX || value < INT32_MIN) && target !== "python") {
      ctx.issues.push(
        makeIssue("info", path, `${value} is larger than 32 bits: ${target === "mongosh" ? "mongosh" : "the Node driver"} stores a plain number like this as a double, Python stores it as a 64-bit int.`, `Write {"$numberLong": "${value}"} to get a 64-bit integer in every language.`),
      );
    }
    return target === "python" ? pyNumber(value) : jsNumber(value);
  }
  if (typeof value === "string") return target === "python" ? pyString(value) : jsString(value);
  if (Array.isArray(value)) return group("[", "]", value.map((item, index) => ({ value: valueDoc(item, target, ctx, `${path}[${index}]`) })));
  if (isObj(value)) {
    const items: Item[] = Object.entries(value).map(([key, item]) => ({
      key: target === "python" ? `${pyString(key)}: ` : `${jsKey(key)}: `,
      value: valueDoc(item, target, ctx, path ? `${path}.${key}` : key),
    }));
    return group("{", "}", items, target !== "python");
  }
  return target === "python" ? "None" : "null";
}

/** Plain relaxed Extended JSON text (valid JSON) of a value, for the "Extended JSON" snippet. */
export function ejsonText(value: unknown, mode: EjsonMode = "relaxed", indent = 2): string {
  const converted = convertEjson(value, mode);
  const marker = "__BIGINT__";
  const body = JSON.stringify(converted, (_k, v) => (typeof v === "bigint" ? `${marker}${v}` : typeof v === "number" && !Number.isFinite(v) ? null : v), indent) ?? "null";
  return body.replace(new RegExp(`"${marker}(-?\\d+)"`, "g"), "$1");
}
