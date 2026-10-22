/**
 * The condition list shared by If, Filter and Switch: `{ combinator: "and" | "or", conditions: [{ leftValue, operator:
 * "<type>:<operation>", rightValue }] }`, values already resolved for the item. Strict types by default (a string "5"
 * is not the number 5) unless `looseTypes`. User regexes run here, inside the workflow worker (killed on timeout).
 */
import { NodeError } from "../engine/node-api";
import { deepEqual, isPlainObject } from "./util";

export interface Condition {
  leftValue?: unknown;
  operator?: string;
  rightValue?: unknown;
}

export interface ConditionSet {
  combinator?: "and" | "or";
  conditions?: Condition[];
}

export interface ConditionOptions {
  ignoreCase?: boolean;
  looseTypes?: boolean;
  /** Runs a user regex (the workflow worker passes a sandboxed, time-limited one; the default is the host engine). */
  regex?: (pattern: string, flags: string, text: string) => boolean;
}

/** `/body/flags` or a bare pattern -> its source and flags (`g` dropped: `test` must not keep state). */
export function regexParts(pattern: unknown, ignoreCase: boolean): { source: string; flags: string } {
  const text = String(pattern ?? "");
  const literal = /^\/(.*)\/([dgimsuvy]*)$/s.exec(text);
  const source = literal ? literal[1] : text;
  let flags = literal ? literal[2].replace("g", "") : "";
  if (ignoreCase && !flags.includes("i")) flags += "i";
  try {
    new RegExp(source, flags);
  } catch (error) {
    throw new NodeError(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { source, flags };
}

export const OPERATORS: Record<string, string[]> = {
  string: ["exists", "notExists", "empty", "notEmpty", "equals", "notEquals", "contains", "notContains", "startsWith", "notStartsWith", "endsWith", "notEndsWith", "regex", "notRegex"],
  number: ["exists", "notExists", "empty", "notEmpty", "equals", "notEquals", "gt", "lt", "gte", "lte"],
  dateTime: ["exists", "notExists", "empty", "notEmpty", "equals", "notEquals", "after", "before", "afterOrEquals", "beforeOrEquals"],
  boolean: ["exists", "notExists", "empty", "notEmpty", "true", "false", "equals", "notEquals"],
  array: ["exists", "notExists", "empty", "notEmpty", "contains", "notContains", "lengthEquals", "lengthNotEquals", "lengthGt", "lengthLt", "lengthGte", "lengthLte"],
  object: ["exists", "notExists", "empty", "notEmpty"],
};

/** Operations that take no right value. */
export const UNARY = new Set(["exists", "notExists", "empty", "notEmpty", "true", "false"]);

const isEmpty = (value: unknown) =>
  value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0) || (isPlainObject(value) && Object.keys(value).length === 0);

function asNumber(value: unknown, loose: boolean, side: string): number {
  if (typeof value === "number") return value;
  if (loose && (typeof value === "string" || typeof value === "boolean") && String(value).trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  throw new NodeError(`The ${side} value ${JSON.stringify(value)} is not a number.`, { description: "Turn on \"Convert types where needed\" or convert the value first." });
}

function asDate(value: unknown, side: string): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  if (isPlainObject(value) && typeof value.ts === "number") return value.ts;
  throw new NodeError(`The ${side} value ${JSON.stringify(value)} is not a date.`);
}

function asString(value: unknown, loose: boolean, side: string): string {
  if (typeof value === "string") return value;
  if (loose || typeof value === "number" || typeof value === "boolean") return value === undefined || value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  throw new NodeError(`The ${side} value ${JSON.stringify(value)} is not text.`, { description: "Turn on \"Convert types where needed\"." });
}

function asBoolean(value: unknown, loose: boolean, side: string): boolean {
  if (typeof value === "boolean") return value;
  if (loose) {
    if (value === "true" || value === 1 || value === "1") return true;
    if (value === "false" || value === 0 || value === "0" || value === "") return false;
  }
  throw new NodeError(`The ${side} value ${JSON.stringify(value)} is not true/false.`);
}

function regexTest(pattern: unknown, ignoreCase: boolean, text: string, options: ConditionOptions): boolean {
  const { source, flags } = regexParts(pattern, ignoreCase);
  return options.regex ? options.regex(source, flags, text) : new RegExp(source, flags).test(text);
}

export function evaluateCondition(condition: Condition, options: ConditionOptions = {}): boolean {
  const [type = "string", operation = "equals"] = String(condition.operator ?? "string:equals").split(":");
  const left = condition.leftValue;
  const right = condition.rightValue;
  const loose = Boolean(options.looseTypes);
  const ic = Boolean(options.ignoreCase);
  if (!OPERATORS[type]?.includes(operation)) throw new NodeError(`Unknown condition "${type}: ${operation}".`);
  switch (operation) {
    case "exists":
      return left !== undefined && left !== null;
    case "notExists":
      return left === undefined || left === null;
    case "empty":
      return isEmpty(left);
    case "notEmpty":
      return !isEmpty(left);
  }
  if (type === "string") {
    let l = asString(left, loose, "left");
    let r = operation === "regex" || operation === "notRegex" ? String(right ?? "") : asString(right, true, "right");
    if (ic && operation !== "regex" && operation !== "notRegex") {
      l = l.toLowerCase();
      r = r.toLowerCase();
    }
    switch (operation) {
      case "equals": return l === r;
      case "notEquals": return l !== r;
      case "contains": return l.includes(r);
      case "notContains": return !l.includes(r);
      case "startsWith": return l.startsWith(r);
      case "notStartsWith": return !l.startsWith(r);
      case "endsWith": return l.endsWith(r);
      case "notEndsWith": return !l.endsWith(r);
      case "regex": return regexTest(r, ic, l, options);
      case "notRegex": return !regexTest(r, ic, l, options);
    }
  }
  if (type === "number") {
    const l = asNumber(left, loose, "left");
    const r = asNumber(right, true, "right");
    switch (operation) {
      case "equals": return l === r;
      case "notEquals": return l !== r;
      case "gt": return l > r;
      case "lt": return l < r;
      case "gte": return l >= r;
      case "lte": return l <= r;
    }
  }
  if (type === "dateTime") {
    const l = asDate(left, "left");
    const r = asDate(right, "right");
    switch (operation) {
      case "equals": return l === r;
      case "notEquals": return l !== r;
      case "after": return l > r;
      case "before": return l < r;
      case "afterOrEquals": return l >= r;
      case "beforeOrEquals": return l <= r;
    }
  }
  if (type === "boolean") {
    const l = asBoolean(left, loose, "left");
    switch (operation) {
      case "true": return l;
      case "false": return !l;
      case "equals": return l === asBoolean(right, true, "right");
      case "notEquals": return l !== asBoolean(right, true, "right");
    }
  }
  if (type === "array") {
    if (!Array.isArray(left)) throw new NodeError(`The left value ${JSON.stringify(left)} is not a list.`);
    const n = () => asNumber(right, true, "right");
    switch (operation) {
      case "contains": return left.some((entry) => deepEqual(entry, right) || (ic && typeof entry === "string" && typeof right === "string" && entry.toLowerCase() === right.toLowerCase()));
      case "notContains": return !left.some((entry) => deepEqual(entry, right));
      case "lengthEquals": return left.length === n();
      case "lengthNotEquals": return left.length !== n();
      case "lengthGt": return left.length > n();
      case "lengthLt": return left.length < n();
      case "lengthGte": return left.length >= n();
      case "lengthLte": return left.length <= n();
    }
  }
  throw new NodeError(`Unknown condition "${type}: ${operation}".`);
}

export function evaluateConditions(set: unknown, options: ConditionOptions = {}): boolean {
  const value = (isPlainObject(set) ? set : {}) as ConditionSet;
  const list = Array.isArray(value.conditions) ? value.conditions : [];
  if (!list.length) return true;
  return value.combinator === "or" ? list.some((c) => evaluateCondition(c, options)) : list.every((c) => evaluateCondition(c, options));
}
