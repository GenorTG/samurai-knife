/**
 * Semantic checks for MongoDB filters, projections, sorts, updates, aggregation pipelines and index specs.
 * The rule tables live in `mongo-operators.ts` (each cites its manual page); this file only applies them.
 *
 * Behaviour reference:
 *  - query operators        https://www.mongodb.com/docs/manual/reference/mql/query-predicates/
 *  - update operators       https://www.mongodb.com/docs/manual/reference/mql/update/
 *  - aggregation stages     https://www.mongodb.com/docs/manual/reference/mql/aggregation-stages/
 *  - aggregation expressions / accumulators / variables
 *      https://www.mongodb.com/docs/manual/reference/mql/expressions/ , .../accumulators/ , .../aggregation-variables/
 *  - projection             https://www.mongodb.com/docs/manual/reference/mql/projection/
 *  - createIndex            https://www.mongodb.com/docs/manual/reference/method/db.collection.createIndex/
 *  - $near/$where limits in countDocuments  https://www.mongodb.com/docs/manual/reference/method/db.collection.countDocuments/
 */
import { didYouMean, isInt, isObj, joinPath, makeIssue, describe, type NosqlIssue, type Obj } from "./common";
import { asTyped } from "./mongo-ejson";
import {
  AGGREGATION_STAGES,
  ATLAS_ONLY_STAGES,
  BSON_TYPE_ALIASES,
  BSON_TYPE_NUMBERS,
  EXPRESSION_OPERATORS,
  FIRST_STAGE_ONLY,
  GROUP_ACCUMULATORS,
  INDEX_KEY_TYPES,
  INDEX_OPTIONS,
  LAST_STAGE_ONLY,
  PARTIAL_FILTER_OPERATORS,
  QUERY_OPERATORS,
  REGEX_OPTION_LETTERS,
  SYSTEM_VARIABLES,
  TOP_LEVEL_FILTER_OPERATORS,
  UPDATE_MODIFIERS,
  UPDATE_OPERATORS,
} from "./mongo-operators";

type Out = NosqlIssue[];

const FIELD_OPERATORS = QUERY_OPERATORS.filter((op) => !(TOP_LEVEL_FILTER_OPERATORS as readonly string[]).includes(op) || op === "$comment");
const FIELD_ONLY = FIELD_OPERATORS.filter((op) => op !== "$comment");
const LOGICAL = ["$and", "$or", "$nor"];
const NO_ARRAY_VALUE = new Set(["$eq", "$ne", "$gt", "$gte", "$lt", "$lte"]);
const MAX_DEPTH = 100;

/** Anything that behaves as a number in an update/expression operand: JSON numbers, bigint and numeric Extended JSON wrappers. */
function isNumeric(value: unknown): boolean {
  if (typeof value === "number" || typeof value === "bigint") return true;
  const typed = asTyped(value);
  return !!typed && "typed" in typed && ["long", "int", "double", "decimal"].includes(typed.typed.kind);
}

function isTyped(value: unknown): boolean {
  const typed = asTyped(value);
  return !!typed && "typed" in typed;
}

function foreignOperatorHint(op: string): string | undefined {
  if ((UPDATE_OPERATORS as readonly string[]).includes(op)) return `${op} is an update operator: it belongs in "update", not in a filter.`;
  if ((AGGREGATION_STAGES as readonly string[]).includes(op)) return `${op} is an aggregation stage: use the aggregate operation and put it in "pipeline".`;
  if ((EXPRESSION_OPERATORS as readonly string[]).includes(op)) return `${op} is an aggregation expression. Inside a filter wrap it in $expr, e.g. {"$expr": {"${op}": [...]}}.`;
  return undefined;
}

/* ------------------------------------------------------------------- filters */

export interface FilterContext {
  /** Inside `$match`: `$where`, `$near` are rejected and `$text` must be in the first stage. */
  inMatch?: boolean;
  firstStage?: boolean;
  /** `countDocuments` rejects `$where`, `$near`, `$nearSphere`. */
  count?: boolean;
  /** Index partialFilterExpression: only a small operator set is allowed. */
  partial?: boolean;
  /** Default `$$vars` visible to `$expr`. */
  vars?: Set<string>;
}

export function checkFilter(filter: unknown, path: string, out: Out, ctx: FilterContext = {}, depth = 0): void {
  if (!isObj(filter)) {
    out.push(makeIssue("error", path, `A filter must be an object, got ${describe(filter)}.`, 'Use {} to match everything or {"field": value}.'));
    return;
  }
  if (depth > MAX_DEPTH) {
    out.push(makeIssue("error", path, "Filter is nested too deeply."));
    return;
  }
  const typed = asTyped(filter);
  if (typed) {
    out.push(makeIssue("error", path, "A filter must be a plain object of fields, not a BSON value like $oid/$date.", 'To match by id write {"_id": {"$oid": "..."}}.'));
    return;
  }
  for (const [key, value] of Object.entries(filter)) {
    const here = joinPath(path, key);
    if (key.startsWith("$")) {
      checkTopLevelOperator(key, value, here, out, ctx, depth);
      continue;
    }
    if (key === "") out.push(makeIssue("error", here, "Empty field name.", "Field names cannot be empty strings in a filter."));
    if (key.includes("\0")) out.push(makeIssue("error", here, "Field names cannot contain a null character."));
    if (/^\.|\.$|\.\./.test(key)) out.push(makeIssue("error", here, `"${key}" is not a valid dotted path (empty segment).`));
    checkFieldCondition(key, value, here, out, ctx, depth);
  }
}

function checkTopLevelOperator(key: string, value: unknown, here: string, out: Out, ctx: FilterContext, depth: number): void {
  if (ctx.partial && !(PARTIAL_FILTER_OPERATORS as readonly string[]).includes(key)) {
    out.push(makeIssue("error", here, `${key} is not allowed in an index partialFilterExpression.`, `Allowed: ${PARTIAL_FILTER_OPERATORS.join(", ")}.`));
    return;
  }
  if (LOGICAL.includes(key)) {
    if (!Array.isArray(value) || value.length === 0) {
      out.push(makeIssue("error", here, `${key} needs a non-empty array of filter objects.`, `Write ${key}: [ {...}, {...} ].`));
      return;
    }
    value.forEach((clause, index) => checkFilter(clause, joinPath(here, index), out, { ...ctx, firstStage: false }, depth + 1));
    if (value.length === 1) out.push(makeIssue("info", here, `${key} with a single clause is the same as writing that clause directly.`));
    return;
  }
  switch (key) {
    case "$expr":
      checkExpression(value, here, out, ctx.vars ?? new Set());
      return;
    case "$text":
      if (!isObj(value) || typeof value.$search !== "string") out.push(makeIssue("error", here, '$text needs {"$search": "words"}.'));
      else {
        for (const sub of Object.keys(value)) if (!["$search", "$language", "$caseSensitive", "$diacriticSensitive"].includes(sub)) out.push(makeIssue("error", joinPath(here, sub), `Unknown $text option ${sub}.${didYouMean(sub, ["$search", "$language", "$caseSensitive", "$diacriticSensitive"])}`));
      }
      out.push(makeIssue("info", here, "$text needs a text index on the collection and only one $text clause is allowed per query.", 'Create one first: createIndex {"field": "text"}.'));
      if (ctx.inMatch && !ctx.firstStage) out.push(makeIssue("error", here, "$text is only allowed in the first $match stage of a pipeline."));
      return;
    case "$where":
      if (ctx.inMatch) out.push(makeIssue("error", here, "$where cannot be used inside $match.", "Use $expr instead."));
      else if (ctx.count) out.push(makeIssue("error", here, "countDocuments does not support $where.", "Use $expr or filter with an aggregation $match + $count."));
      else out.push(makeIssue("warning", here, "$where runs JavaScript for every document: slow, cannot use indexes, and disabled on many hosted clusters.", "Rewrite it with normal operators or $expr."));
      if (typeof value !== "string" && !isTyped(value)) out.push(makeIssue("error", here, "$where needs a JavaScript expression string."));
      return;
    case "$comment":
    case "$jsonSchema":
      if (key === "$jsonSchema" && !isObj(value)) out.push(makeIssue("error", here, "$jsonSchema needs a schema object."));
      return;
    case "$rand":
      if (!isObj(value) || Object.keys(value).length) out.push(makeIssue("error", here, '$rand takes an empty object: {"$rand": {}}.'));
      return;
    case "$sampleRate":
      if (typeof value !== "number" || value < 0 || value > 1) out.push(makeIssue("error", here, "$sampleRate must be a number between 0 and 1."));
      return;
    default:
  }
  if ((FIELD_ONLY as readonly string[]).includes(key)) {
    out.push(makeIssue("error", here, `${key} must be applied to a field, not used as a top-level key.`, `Write {"yourField": {"${key}": ...}}.`));
    return;
  }
  const hint = foreignOperatorHint(key);
  out.push(makeIssue("error", here, hint ?? `Unknown query operator ${key}.${didYouMean(key, QUERY_OPERATORS)}`, hint ? undefined : "Check the spelling against the MongoDB query-predicates list."));
}

function checkFieldCondition(field: string, value: unknown, here: string, out: Out, ctx: FilterContext, depth: number): void {
  if (field === "_id") checkIdLiteral(value, here, out);
  if (value instanceof RegExp) return;
  if (!isObj(value) || isTyped(value)) {
    if (Array.isArray(value) && field === "_id") out.push(makeIssue("error", here, "_id cannot be an array.", "Match a set of ids with {\"_id\": {\"$in\": [...]}}."));
    return;
  }
  const keys = Object.keys(value);
  if (keys.length === 0) return; // {field: {}} equality to an empty document
  const operatorKeys = keys.filter((k) => k.startsWith("$"));
  if (operatorKeys.length === 0) return; // embedded document equality
  if (operatorKeys.length !== keys.length) {
    out.push(makeIssue("error", here, "A field condition cannot mix $operators with plain field names.", 'To match a sub-field use a dotted path, e.g. {"address.city": "Oslo"}.'));
    return;
  }
  checkOperatorObject(field, value, here, out, ctx, depth);
}

function checkIdLiteral(value: unknown, here: string, out: Out): void {
  const looksLikeOid = (v: unknown) => typeof v === "string" && /^[0-9a-fA-F]{24}$/.test(v);
  if (looksLikeOid(value) || (isObj(value) && Array.isArray(value.$in) && value.$in.some(looksLikeOid))) {
    out.push(makeIssue("warning", here, "This _id is a plain string that looks like an ObjectId, so it will NOT match documents whose _id is a real ObjectId.", 'Write {"$oid": "<24 hex chars>"} if the ids are ObjectIds.'));
  }
}

function checkOperatorObject(field: string, ops: Obj, here: string, out: Out, ctx: FilterContext, depth: number): void {
  const hasRegex = "$regex" in ops;
  for (const [op, operand] of Object.entries(ops)) {
    const at = joinPath(here, op);
    if (ctx.partial && !(PARTIAL_FILTER_OPERATORS as readonly string[]).includes(op)) {
      out.push(makeIssue("error", at, `${op} is not allowed in an index partialFilterExpression.`, `Allowed: ${PARTIAL_FILTER_OPERATORS.join(", ")}.`));
      continue;
    }
    if (!(FIELD_ONLY as readonly string[]).includes(op)) {
      if (LOGICAL.includes(op) || ["$expr", "$text", "$where", "$jsonSchema"].includes(op)) out.push(makeIssue("error", at, `${op} cannot be nested under a field.`, `Move it to the top level of the filter: {"${op}": ...}.`));
      else out.push(makeIssue("error", at, foreignOperatorHint(op) ?? `Unknown query operator ${op}.${didYouMean(op, FIELD_ONLY)}`));
      continue;
    }
    if (ctx.inMatch && (op === "$near" || op === "$nearSphere")) out.push(makeIssue("error", at, `${op} is not allowed inside $match.`, "Use the $geoNear stage as the first stage instead."));
    if (ctx.count && (op === "$near" || op === "$nearSphere")) out.push(makeIssue("error", at, `countDocuments does not support ${op}.`, "Use $geoWithin with $centerSphere instead."));
    checkOperand(field, op, operand, at, out, ctx, depth);
  }
  if ("$options" in ops && !hasRegex) out.push(makeIssue("error", joinPath(here, "$options"), "$options only works together with $regex.", 'Write {"$regex": "pattern", "$options": "i"}.'));
}

function checkOperand(field: string, op: string, operand: unknown, at: string, out: Out, ctx: FilterContext, depth: number): void {
  switch (op) {
    case "$in":
    case "$nin":
    case "$all":
      if (!Array.isArray(operand)) {
        out.push(makeIssue("error", at, `${op} needs an array, got ${describe(operand)}.`, `Write ${op}: [value1, value2].`));
        return;
      }
      if (field === "_id") operand.forEach((item, index) => checkIdLiteral(item, joinPath(at, index), out));
      if (operand.length === 0) out.push(makeIssue("info", at, op === "$in" ? "$in with an empty array matches nothing." : op === "$nin" ? "$nin with an empty array matches everything." : "$all with an empty array matches nothing."));
      if (op === "$nin") out.push(makeIssue("info", at, "$nin also matches documents where the field is missing, and cannot use an index efficiently."));
      return;
    case "$exists":
      if (typeof operand !== "boolean") out.push(makeIssue("warning", at, "$exists expects true or false.", "Use true to require the field, false to require it to be absent."));
      return;
    case "$size":
      if (!isInt(operand) || operand < 0) out.push(makeIssue("error", at, "$size needs a whole number of 0 or more.", "$size matches an exact array length; for ranges use $expr with $size."));
      return;
    case "$mod":
      if (!Array.isArray(operand) || operand.length !== 2 || !operand.every((n) => typeof n === "number")) out.push(makeIssue("error", at, "$mod needs [divisor, remainder], two numbers.", 'Example: {"$mod": [4, 0]}.'));
      else if (operand[0] === 0) out.push(makeIssue("error", at, "$mod divisor cannot be 0."));
      return;
    case "$type": {
      const items = Array.isArray(operand) ? operand : [operand];
      if (!items.length) out.push(makeIssue("error", at, "$type needs at least one type."));
      items.forEach((item, index) => {
        const where = Array.isArray(operand) ? joinPath(at, index) : at;
        if (typeof item === "string") {
          if (!(BSON_TYPE_ALIASES as readonly string[]).includes(item)) out.push(makeIssue("error", where, `"${item}" is not a BSON type alias.${didYouMean(item, BSON_TYPE_ALIASES)}`, `Known aliases: ${BSON_TYPE_ALIASES.join(", ")}.`));
        } else if (typeof item !== "number" || !(BSON_TYPE_NUMBERS as readonly number[]).includes(item)) out.push(makeIssue("error", where, "$type needs a BSON type alias string or number.", 'Example: {"$type": "string"}.'));
      });
      return;
    }
    case "$regex": {
      if (typeof operand !== "string" && !(isTyped(operand) && JSON.stringify(Object.keys(operand as Obj)) === '["$regularExpression"]')) {
        out.push(makeIssue("error", at, "$regex needs a pattern string (or a regular expression value).", 'Example: {"$regex": "^ab", "$options": "i"}.'));
        return;
      }
      if (typeof operand === "string" && !operand.startsWith("^")) out.push(makeIssue("info", at, "A $regex that does not start with ^ scans every value: it cannot use an index for a prefix search.", "Anchor it with ^ when you mean 'starts with'."));
      return;
    }
    case "$options":
      if (typeof operand !== "string" || ![...operand].every((c) => REGEX_OPTION_LETTERS.includes(c))) out.push(makeIssue("error", at, `$options may only contain the letters ${[...REGEX_OPTION_LETTERS].join(", ")}.`, "i = case-insensitive, m = multiline, x = extended, s = dot matches newline."));
      else if (operand.includes("i")) out.push(makeIssue("info", at, "Case-insensitive regex cannot use a normal index efficiently.", "Consider a collation index with strength 2 instead."));
      return;
    case "$elemMatch":
      if (!isObj(operand)) {
        out.push(makeIssue("error", at, "$elemMatch needs an object of conditions.", 'Example: {"$elemMatch": {"qty": {"$gt": 5}}}.'));
        return;
      }
      if (Object.keys(operand).length && Object.keys(operand).every((k) => k.startsWith("$") && !LOGICAL.includes(k) && k !== "$expr" && k !== "$text" && k !== "$where")) checkOperatorObject(field, operand, at, out, { ...ctx, firstStage: false }, depth + 1);
      else checkFilter(operand, at, out, { ...ctx, firstStage: false }, depth + 1);
      return;
    case "$not": {
      const typedRegex = isTyped(operand) && Object.keys(operand as Obj)[0] === "$regularExpression";
      if (isObj(operand) && !typedRegex && Object.keys(operand).length && Object.keys(operand).every((k) => k.startsWith("$"))) checkOperatorObject(field, operand, at, out, ctx, depth + 1);
      else if (!typedRegex) out.push(makeIssue("error", at, '$not needs an operator expression such as {"$gt": 5} (not a plain value).', 'To negate equality use {"$ne": value}.'));
      out.push(makeIssue("info", at, "$not and $ne cannot use an index efficiently and also match documents missing the field."));
      return;
    }
    case "$ne":
      out.push(makeIssue("info", at, "$ne also matches documents where the field is missing and cannot use an index efficiently."));
      return;
    case "$near":
    case "$nearSphere":
      if (!isObj(operand)) out.push(makeIssue("error", at, `${op} needs a GeoJSON point (or $geometry) object.`));
      out.push(makeIssue("info", at, `${op} requires a 2dsphere (or 2d) index on the field.`));
      return;
    case "$geoWithin":
    case "$geoIntersects":
      if (!isObj(operand)) out.push(makeIssue("error", at, `${op} needs an object like {"$geometry": {...}}.`));
      return;
    case "$bitsAllClear":
    case "$bitsAllSet":
    case "$bitsAnyClear":
    case "$bitsAnySet":
      if (!(isInt(operand) && operand >= 0) && !(Array.isArray(operand) && operand.every((n) => isInt(n) && n >= 0)) && !isTyped(operand)) out.push(makeIssue("error", at, `${op} needs a bitmask integer or an array of bit positions.`));
      return;
    default:
      if (NO_ARRAY_VALUE.has(op) && ctx.partial && Array.isArray(operand)) out.push(makeIssue("error", at, `${op} cannot take an array in a partialFilterExpression.`));
  }
}

/* --------------------------------------------------------------- projection */

export function checkProjection(projection: unknown, path: string, out: Out): void {
  if (!isObj(projection)) {
    out.push(makeIssue("error", path, "A projection must be an object.", 'Example: {"name": 1, "email": 1}.'));
    return;
  }
  const included: string[] = [];
  const excluded: string[] = [];
  for (const [key, value] of Object.entries(projection)) {
    const here = joinPath(path, key);
    if (key.startsWith("$")) {
      out.push(makeIssue("error", here, `${key} is not a field name; projection operators like $slice go inside a field: {"tags": {"$slice": 3}}.`));
      continue;
    }
    if (value === 0 || value === false) {
      if (key !== "_id") excluded.push(key);
    } else if (value === 1 || value === true) {
      if (key !== "_id") included.push(key);
    } else if (typeof value === "number") {
      out.push(makeIssue("warning", here, `Projection value ${value} is treated as "include"; MongoDB documents 1 and 0.`, "Use 1 to include or 0 to exclude."));
      if (key !== "_id" && value !== 0) included.push(key);
    } else if (isObj(value) && !isTyped(value)) {
      const ops = Object.keys(value);
      const known = ["$slice", "$elemMatch", "$meta"];
      for (const op of ops) if (!known.includes(op) && op.startsWith("$") && !(EXPRESSION_OPERATORS as readonly string[]).includes(op)) out.push(makeIssue("error", joinPath(here, op), `Unknown projection operator ${op}.${didYouMean(op, known)}`));
      if (ops.some((op) => !known.includes(op))) included.push(key);
      if (ops.includes("$elemMatch")) checkFilter(value.$elemMatch, joinPath(here, "$elemMatch"), out);
    } else if (typeof value === "string" && value.startsWith("$")) included.push(key);
    else out.push(makeIssue("error", here, `Projection value for "${key}" must be 1, 0, true, false or an operator object.`));
  }
  if (included.length && excluded.length) out.push(makeIssue("error", path, `A projection cannot mix inclusion (${included[0]}: 1) and exclusion (${excluded[0]}: 0).`, "Pick one style; only _id may be excluded in an inclusion projection."));
}

/* --------------------------------------------------------------------- sort */

export function checkSort(sort: unknown, path: string, out: Out): void {
  const entries: [string, unknown][] = Array.isArray(sort) ? sort.map((pair) => [String((pair as unknown[])[0]), (pair as unknown[])[1]] as [string, unknown]) : isObj(sort) ? Object.entries(sort) : [];
  if (!Array.isArray(sort) && !isObj(sort)) {
    out.push(makeIssue("error", path, "sort must be an object like {\"age\": -1}.", "1 = ascending, -1 = descending."));
    return;
  }
  if (entries.length > 32) out.push(makeIssue("error", path, "A sort can use at most 32 keys."));
  for (const [key, dir] of entries) {
    const here = joinPath(path, key);
    if (dir === 1 || dir === -1) continue;
    if (isObj(dir) && Object.keys(dir).length === 1 && dir.$meta === "textScore") continue;
    out.push(makeIssue("error", here, `Sort direction must be 1 (ascending) or -1 (descending), got ${JSON.stringify(typeof dir === "bigint" ? String(dir) : dir)}.`, 'For text relevance use {"$meta": "textScore"}.'));
  }
}

/* ------------------------------------------------------------ expressions */

const FIXED_ARITY: Record<string, number> = {
  $subtract: 2, $divide: 2, $mod: 2, $pow: 2, $cmp: 2, $eq: 2, $ne: 2, $gt: 2, $gte: 2, $lt: 2, $lte: 2, $arrayElemAt: 2, $in: 2, $log: 2, $strcasecmp: 2, $atan2: 2, $setDifference: 2, $setIsSubset: 2,
};

/** Walks an aggregation expression: operator names, `$$variables`, fixed-arity operators. */
export function checkExpression(expr: unknown, path: string, out: Out, vars: Set<string>, depth = 0): void {
  if (depth > MAX_DEPTH) {
    out.push(makeIssue("error", path, "Expression is nested too deeply."));
    return;
  }
  if (typeof expr === "string") {
    if (expr.startsWith("$$")) checkVariable(expr, path, out, vars);
    else if (expr === "$") out.push(makeIssue("error", path, '"$" alone is not a field path.', 'Write "$fieldName".'));
    return;
  }
  if (Array.isArray(expr)) {
    expr.forEach((item, index) => checkExpression(item, joinPath(path, index), out, vars, depth + 1));
    return;
  }
  if (!isObj(expr) || isTyped(expr)) return;
  const keys = Object.keys(expr);
  const dollar = keys.filter((k) => k.startsWith("$"));
  if (dollar.length === 0) {
    for (const [key, value] of Object.entries(expr)) checkExpression(value, joinPath(path, key), out, vars, depth + 1);
    return;
  }
  if (keys.length !== 1) {
    out.push(makeIssue("error", path, `An expression object must have exactly one operator key, found ${keys.join(", ")}.`, 'Wrap separate fields in their own object: {"a": {"$sum": "$x"}, "b": 1}.'));
    return;
  }
  const op = keys[0];
  const here = joinPath(path, op);
  const operand = expr[op];
  if (op === "$literal") return;
  if (!(EXPRESSION_OPERATORS as readonly string[]).includes(op)) {
    const hint = (UPDATE_OPERATORS as readonly string[]).includes(op)
      ? `${op} is an update operator, not an aggregation expression.`
      : (AGGREGATION_STAGES as readonly string[]).includes(op)
        ? `${op} is a pipeline stage, not an expression: put it in its own stage.`
        : op === "$regex"
          ? "Use $regexMatch inside expressions; $regex is for query filters."
          : `Unknown aggregation operator ${op}.${didYouMean(op, EXPRESSION_OPERATORS)}`;
    out.push(makeIssue("error", here, hint));
    return;
  }
  const scoped = new Set(vars);
  if (op === "$let" && isObj(operand)) {
    if (!isObj(operand.vars)) out.push(makeIssue("error", joinPath(here, "vars"), "$let needs vars: {name: expression}."));
    else for (const name of Object.keys(operand.vars)) scoped.add(name);
    if (operand.in === undefined) out.push(makeIssue("error", joinPath(here, "in"), "$let needs an `in` expression."));
    if (isObj(operand.vars)) for (const [name, value] of Object.entries(operand.vars)) checkExpression(value, joinPath(joinPath(here, "vars"), name), out, vars, depth + 1);
    if (operand.in !== undefined) checkExpression(operand.in, joinPath(here, "in"), out, scoped, depth + 1);
    return;
  }
  if ((op === "$map" || op === "$filter") && isObj(operand)) {
    for (const required of op === "$map" ? ["input", "in"] : ["input", "cond"]) if (!(required in operand)) out.push(makeIssue("error", joinPath(here, required), `${op} needs "${required}".`));
    scoped.add(typeof operand.as === "string" ? operand.as : "this");
    for (const [key, value] of Object.entries(operand)) checkExpression(value, joinPath(here, key), out, key === "input" ? vars : scoped, depth + 1);
    return;
  }
  if (op === "$reduce" && isObj(operand)) {
    for (const required of ["input", "initialValue", "in"]) if (!(required in operand)) out.push(makeIssue("error", joinPath(here, required), `$reduce needs "${required}".`));
    scoped.add("this");
    scoped.add("value");
    for (const [key, value] of Object.entries(operand)) checkExpression(value, joinPath(here, key), out, key === "in" ? scoped : vars, depth + 1);
    return;
  }
  if (op === "$cond") {
    const ok = Array.isArray(operand) ? operand.length === 3 : isObj(operand) && ["if", "then", "else"].every((k) => k in operand);
    if (!ok) out.push(makeIssue("error", here, "$cond needs [if, then, else] or {if, then, else}."));
  } else if (op === "$switch") {
    if (!isObj(operand) || !Array.isArray(operand.branches) || !operand.branches.length) out.push(makeIssue("error", here, "$switch needs branches: [{case, then}, ...].", "Add a `default` for values that match no branch."));
    else if (!("default" in operand)) out.push(makeIssue("info", here, "$switch without a default raises an error when no branch matches."));
  } else if (op === "$ifNull" && Array.isArray(operand) && operand.length < 2) out.push(makeIssue("error", here, "$ifNull needs at least two arguments: [value, replacement]."));
  const arity = FIXED_ARITY[op];
  if (arity !== undefined && Array.isArray(operand) && operand.length !== arity) out.push(makeIssue("error", here, `${op} takes exactly ${arity} arguments, got ${operand.length}.`));
  checkExpression(operand, here, out, vars, depth + 1);
}

function checkVariable(text: string, path: string, out: Out, vars: Set<string>): void {
  const name = text.slice(2).split(".")[0];
  if (!name) {
    out.push(makeIssue("error", path, '"$$" is not a variable name.'));
    return;
  }
  if ((SYSTEM_VARIABLES as readonly string[]).includes(name) || vars.has(name)) return;
  if (/^[A-Z]/.test(name)) out.push(makeIssue("error", path, `$$${name} is not a system variable.${didYouMean(name, SYSTEM_VARIABLES).replace(/\?$/, "?")}`, "User-defined variables must start with a lowercase letter."));
  else out.push(makeIssue("warning", path, `Variable $$${name} is not defined by an enclosing $let, $map, $filter or $reduce.`, "Define it in vars/as, or check the spelling."));
}

/* ----------------------------------------------------------------- pipeline */

const NO_REDUCE_BEFORE_MATCH = ["$group", "$project", "$addFields", "$set", "$unwind", "$lookup", "$replaceRoot", "$replaceWith", "$bucket", "$bucketAuto", "$facet", "$count", "$sortByCount"];
const UPDATE_PIPELINE_STAGES = ["$addFields", "$set", "$project", "$unset", "$replaceRoot", "$replaceWith"];

export interface PipelineContext {
  /** Pipeline used as an update (`updateOne` with an array): only a few stages are legal. */
  asUpdate?: boolean;
  /** Inside $facet / $lookup / $unionWith sub-pipelines. */
  nested?: boolean;
  vars?: Set<string>;
}

export function checkPipeline(pipeline: unknown, path: string, out: Out, ctx: PipelineContext = {}): void {
  if (!Array.isArray(pipeline)) {
    out.push(makeIssue("error", path, "A pipeline must be an array of stages.", 'Example: [{"$match": {...}}, {"$group": {...}}].'));
    return;
  }
  if (pipeline.length === 0) out.push(makeIssue("info", path, "An empty pipeline just returns every document."));
  const names: (string | null)[] = [];
  pipeline.forEach((stage, index) => {
    const here = joinPath(path, index);
    if (!isObj(stage) || Object.keys(stage).length !== 1 || !Object.keys(stage)[0].startsWith("$")) {
      out.push(makeIssue("error", here, 'Each stage must be an object with exactly one $stage key, e.g. {"$match": {...}}.', isObj(stage) && Object.keys(stage).length > 1 ? "Put each stage in its own object." : undefined));
      names.push(null);
      return;
    }
    const name = Object.keys(stage)[0];
    names.push(name);
    const stageAt = joinPath(here, name);
    if (!(AGGREGATION_STAGES as readonly string[]).includes(name)) {
      const hint = (UPDATE_OPERATORS as readonly string[]).includes(name) ? `${name} is an update operator, not a pipeline stage.` : (QUERY_OPERATORS as readonly string[]).includes(name) ? `${name} is a query operator: put it inside a $match stage.` : `Unknown pipeline stage ${name}.${didYouMean(name, AGGREGATION_STAGES)}`;
      out.push(makeIssue("error", stageAt, hint));
      return;
    }
    if (ctx.asUpdate && !UPDATE_PIPELINE_STAGES.includes(name)) out.push(makeIssue("error", stageAt, `${name} is not allowed in an update pipeline.`, `Allowed: ${UPDATE_PIPELINE_STAGES.join(", ")}.`));
    if (FIRST_STAGE_ONLY[name] && index !== 0) out.push(makeIssue("error", stageAt, `${FIRST_STAGE_ONLY[name]}.`));
    if ((ATLAS_ONLY_STAGES as readonly string[]).includes(name)) out.push(makeIssue("info", stageAt, `${name} only works on MongoDB Atlas (or a deployment with Atlas Search / Vector Search).`));
    if ((LAST_STAGE_ONLY as readonly string[]).includes(name) && index !== pipeline.length - 1) out.push(makeIssue("error", stageAt, `${name} writes results to a collection, so it must be the last stage.`));
    checkStage(name, stage[name], stageAt, out, { ...ctx, first: index === 0, index, names });
  });
  // Order sanity (docs: "Aggregation Pipeline Optimization": $match early, $sort before $limit).
  names.forEach((name, index) => {
    if (name === "$limit") {
      const later = names.slice(index + 1).indexOf("$sort");
      if (later >= 0) out.push(makeIssue("warning", joinPath(path, index), "$limit runs before $sort, so only the first N arbitrary documents get sorted.", "Put $sort first, then $limit, to get the top N."));
    }
    if (name === "$skip" && names.slice(index + 1).includes("$sort")) out.push(makeIssue("warning", joinPath(path, index), "$skip runs before $sort, so the sort only sees the remaining documents.", "Sort first, then $skip and $limit."));
    if (name === "$limit" && names.slice(index + 1).includes("$skip")) out.push(makeIssue("warning", joinPath(path, index), "$skip after $limit skips within the already-limited set.", "Use $skip first, then $limit, for pagination."));
    if (name === "$match" && index > 0 && !names.slice(0, index).includes("$match")) {
      const blocker = names.slice(0, index).find((n) => n && NO_REDUCE_BEFORE_MATCH.includes(n));
      if (blocker) out.push(makeIssue("warning", joinPath(path, index), `This $match comes after ${blocker}. If it filters on original fields, move it to the start so MongoDB can use an index and process fewer documents.`, "Ignore this if it filters on a field that stage creates."));
    }
  });
  if (!ctx.nested && !ctx.asUpdate && names.includes("$sort") && names.includes("$group") && names.indexOf("$sort") > names.indexOf("$group") && !names.includes("$limit")) {
    out.push(makeIssue("info", path, "A $sort after $group sorts all groups in memory (100 MB limit unless allowDiskUse is on)."));
  }
}

interface StageContext extends PipelineContext {
  first: boolean;
  index: number;
  names: (string | null)[];
}

function checkStage(name: string, body: unknown, at: string, out: Out, ctx: StageContext): void {
  const vars = ctx.vars ?? new Set<string>();
  switch (name) {
    case "$match":
      checkFilter(body, at, out, { inMatch: true, firstStage: ctx.first, vars });
      return;
    case "$group": {
      if (!isObj(body)) {
        out.push(makeIssue("error", at, "$group needs an object with an _id.", 'Example: {"_id": "$status", "total": {"$sum": 1}}.'));
        return;
      }
      if (!("_id" in body)) out.push(makeIssue("error", at, "$group needs an _id: the field(s) to group by.", 'Use "_id": null to put every document in one group.'));
      else checkExpression(body._id, joinPath(at, "_id"), out, vars);
      for (const [key, value] of Object.entries(body)) {
        if (key === "_id") continue;
        const here = joinPath(at, key);
        if (key.includes(".") || key.startsWith("$")) out.push(makeIssue("error", here, `Output field names in $group cannot start with $ or contain a dot: "${key}".`));
        if (!isObj(value) || Object.keys(value).length !== 1 || isTyped(value)) {
          out.push(makeIssue("error", here, `Every $group output field needs an accumulator like {"$sum": ...}, got ${describe(value)}.`, 'Example: "total": {"$sum": "$amount"}.'));
          continue;
        }
        const acc = Object.keys(value)[0];
        if (!(GROUP_ACCUMULATORS as readonly string[]).includes(acc)) {
          out.push(makeIssue("error", joinPath(here, acc), `${acc} is not a $group accumulator.${didYouMean(acc, GROUP_ACCUMULATORS)}`, `Accumulators: ${GROUP_ACCUMULATORS.join(", ")}.`));
          continue;
        }
        if ((acc === "$first" || acc === "$last") && !ctx.names.slice(0, ctx.index).includes("$sort")) out.push(makeIssue("info", joinPath(here, acc), `${acc} without an earlier $sort returns an arbitrary document's value.`, "Add a $sort stage before $group."));
        checkExpression(value[acc], joinPath(here, acc), out, vars);
      }
      return;
    }
    case "$project":
      checkProjection(body, at, out);
      return;
    case "$addFields":
    case "$set":
      if (!isObj(body) || !Object.keys(body).length) out.push(makeIssue("error", at, `${name} needs an object of new fields: {"total": {"$add": [...]}}.`));
      else for (const [key, value] of Object.entries(body)) checkExpression(value, joinPath(at, key), out, vars);
      return;
    case "$unset":
      if (!(typeof body === "string" && body) && !(Array.isArray(body) && body.length && body.every((s) => typeof s === "string"))) out.push(makeIssue("error", at, "$unset needs a field name or an array of field names."));
      return;
    case "$sort":
      checkSort(body, at, out);
      if (isObj(body) && !Object.keys(body).length) out.push(makeIssue("error", at, "$sort needs at least one field."));
      return;
    case "$limit":
      if (!isInt(body) || body < 1) out.push(makeIssue("error", at, "$limit needs a whole number of 1 or more."));
      return;
    case "$skip":
      if (!isInt(body) || body < 0) out.push(makeIssue("error", at, "$skip needs a whole number of 0 or more."));
      return;
    case "$count":
      if (typeof body !== "string" || !body || body.startsWith("$") || body.includes(".")) out.push(makeIssue("error", at, '$count needs a non-empty output field name that does not start with $ or contain a dot, e.g. {"$count": "total"}.'));
      return;
    case "$sample":
      if (!isObj(body) || !isInt(body.size) || (body.size as number) < 1) out.push(makeIssue("error", at, '$sample needs {"size": N} with N >= 1.'));
      return;
    case "$unwind":
      if (typeof body === "string") {
        if (!body.startsWith("$")) out.push(makeIssue("error", at, `$unwind needs a field path that starts with $, got "${body}".`, `Write "$${body}".`));
      } else if (isObj(body)) {
        if (typeof body.path !== "string" || !body.path.startsWith("$")) out.push(makeIssue("error", joinPath(at, "path"), '$unwind.path must be a string starting with $, e.g. "$tags".'));
        for (const key of Object.keys(body)) if (!["path", "includeArrayIndex", "preserveNullAndEmptyArrays"].includes(key)) out.push(makeIssue("error", joinPath(at, key), `Unknown $unwind option "${key}".${didYouMean(key, ["path", "includeArrayIndex", "preserveNullAndEmptyArrays"])}`));
      } else out.push(makeIssue("error", at, '$unwind needs "$arrayField" or {"path": "$arrayField"}.'));
      return;
    case "$lookup": {
      if (!isObj(body)) {
        out.push(makeIssue("error", at, "$lookup needs an object with from, as and either localField/foreignField or pipeline."));
        return;
      }
      for (const key of Object.keys(body)) if (!["from", "as", "localField", "foreignField", "let", "pipeline"].includes(key)) out.push(makeIssue("error", joinPath(at, key), `Unknown $lookup field "${key}".${didYouMean(key, ["from", "as", "localField", "foreignField", "let", "pipeline"])}`));
      if (typeof body.as !== "string" || !body.as) out.push(makeIssue("error", joinPath(at, "as"), "$lookup needs `as`: the output array field name."));
      if (typeof body.from !== "string" && !("pipeline" in body && !body.from)) out.push(makeIssue("error", joinPath(at, "from"), "$lookup needs `from`: the collection to join."));
      const simple = "localField" in body || "foreignField" in body;
      if (simple && !("localField" in body && "foreignField" in body)) out.push(makeIssue("error", at, "Use localField and foreignField together."));
      if (!simple && !("pipeline" in body)) out.push(makeIssue("error", at, "$lookup needs localField + foreignField, or a pipeline."));
      if (isObj(body.let)) for (const [k, v] of Object.entries(body.let)) checkExpression(v, joinPath(joinPath(at, "let"), k), out, vars);
      if ("pipeline" in body) {
        const inner = new Set(vars);
        if (isObj(body.let)) for (const k of Object.keys(body.let)) inner.add(k);
        checkPipeline(body.pipeline, joinPath(at, "pipeline"), out, { nested: true, vars: inner });
      }
      return;
    }
    case "$facet":
      if (!isObj(body) || !Object.keys(body).length) out.push(makeIssue("error", at, "$facet needs an object of named sub-pipelines."));
      else for (const [key, sub] of Object.entries(body)) {
        checkPipeline(sub, joinPath(at, key), out, { nested: true, vars });
        if (Array.isArray(sub)) sub.forEach((stage, i) => isObj(stage) && ["$out", "$merge", "$facet", "$search", "$searchMeta", "$vectorSearch", "$geoNear", "$collStats", "$indexStats"].includes(Object.keys(stage)[0]) && out.push(makeIssue("error", joinPath(joinPath(at, key), i), `${Object.keys(stage)[0]} is not allowed inside $facet.`)));
      }
      return;
    case "$unionWith":
      if (typeof body === "string") return;
      if (!isObj(body) || typeof body.coll !== "string") out.push(makeIssue("error", at, '$unionWith needs a collection name or {"coll": "name", "pipeline": [...]}.'));
      else if ("pipeline" in body) checkPipeline(body.pipeline, joinPath(at, "pipeline"), out, { nested: true, vars });
      return;
    case "$replaceRoot":
      if (!isObj(body) || !("newRoot" in body)) out.push(makeIssue("error", at, '$replaceRoot needs {"newRoot": <expression>}.'));
      else checkExpression(body.newRoot, joinPath(at, "newRoot"), out, vars);
      return;
    case "$replaceWith":
      checkExpression(body, at, out, vars);
      return;
    case "$sortByCount":
      if (typeof body !== "string" && !isObj(body)) out.push(makeIssue("error", at, '$sortByCount needs a field path like "$tags" or an expression.'));
      else checkExpression(body, at, out, vars);
      return;
    case "$bucket": {
      if (!isObj(body)) return void out.push(makeIssue("error", at, "$bucket needs groupBy and boundaries."));
      if (!("groupBy" in body)) out.push(makeIssue("error", joinPath(at, "groupBy"), '$bucket needs groupBy, e.g. "$price".'));
      const bounds = body.boundaries;
      if (!Array.isArray(bounds) || bounds.length < 2) out.push(makeIssue("error", joinPath(at, "boundaries"), "$bucket needs boundaries: an array of at least 2 ascending values."));
      else if (bounds.every((b) => typeof b === "number") && bounds.some((b, i) => i && (b as number) <= (bounds[i - 1] as number))) out.push(makeIssue("error", joinPath(at, "boundaries"), "$bucket boundaries must be strictly ascending."));
      if (!("default" in body)) out.push(makeIssue("info", at, "Without `default`, a document outside every bucket raises an error."));
      return;
    }
    case "$bucketAuto":
      if (!isObj(body) || !("groupBy" in body) || !isInt(body.buckets) || (body.buckets as number) < 1) out.push(makeIssue("error", at, '$bucketAuto needs {"groupBy": ..., "buckets": N}.'));
      return;
    case "$out":
      if (typeof body !== "string" && !isObj(body)) out.push(makeIssue("error", at, '$out needs a collection name or {"db": ..., "coll": ...}.'));
      else out.push(makeIssue("warning", at, "$out replaces the target collection entirely.", "Use $merge to upsert into an existing collection."));
      return;
    case "$merge":
      if (typeof body !== "string" && !(isObj(body) && "into" in body)) out.push(makeIssue("error", at, '$merge needs a collection name or {"into": ...}.'));
      return;
    case "$geoNear":
      if (!isObj(body) || !("near" in body) || typeof body.distanceField !== "string") out.push(makeIssue("error", at, '$geoNear needs "near" and "distanceField".'));
      return;
    case "$redact":
      checkExpression(body, at, out, new Set([...vars]));
      return;
    default:
      if (!isObj(body) && !Array.isArray(body) && typeof body !== "string" && typeof body !== "number") out.push(makeIssue("warning", at, `${name} has an unexpected value type (${describe(body)}).`));
  }
}

/* ------------------------------------------------------------------ updates */

const UPDATE_PATH_OPS = new Set(["$set", "$setOnInsert", "$unset", "$inc", "$mul", "$min", "$max", "$currentDate", "$rename", "$push", "$addToSet", "$pull", "$pullAll", "$pop", "$bit"]);

export function checkUpdate(update: unknown, path: string, out: Out, upsert: boolean): Set<string> {
  const identifiers = new Set<string>();
  if (Array.isArray(update)) {
    checkPipeline(update, path, out, { asUpdate: true });
    return identifiers;
  }
  if (!isObj(update)) {
    out.push(makeIssue("error", path, "update must be an object of operators like {\"$set\": {...}} or an aggregation pipeline array."));
    return identifiers;
  }
  const keys = Object.keys(update);
  if (!keys.length) out.push(makeIssue("error", path, "update is empty.", 'Add an operator, e.g. {"$set": {"status": "done"}}.'));
  const plain = keys.filter((k) => !k.startsWith("$"));
  if (plain.length) {
    out.push(makeIssue("error", joinPath(path, plain[0]), `"${plain[0]}" is a field name, but an update must use operators.`, `Wrap it: {"$set": {"${plain[0]}": ...}}. To swap in a whole new document use the replaceOne operation.`));
  }
  const seen: { path: string[]; op: string }[] = [];
  for (const [op, operand] of Object.entries(update)) {
    if (!op.startsWith("$")) continue;
    const here = joinPath(path, op);
    if (!(UPDATE_OPERATORS as readonly string[]).includes(op)) {
      out.push(makeIssue("error", here, foreignOperatorHint(op) ?? `Unknown update operator ${op}.${didYouMean(op, UPDATE_OPERATORS)}`, `Update operators: ${UPDATE_OPERATORS.join(", ")}.`));
      continue;
    }
    if (!isObj(operand) || isTyped(operand)) {
      out.push(makeIssue("error", here, `${op} needs an object of fields, e.g. {"${op}": {"field": value}}.`));
      continue;
    }
    if (!Object.keys(operand).length) out.push(makeIssue("info", here, `${op} with an empty object does nothing.`));
    if (op === "$setOnInsert" && !upsert) out.push(makeIssue("warning", here, "$setOnInsert only has an effect when the update inserts (options.upsert: true).", 'Add "options": {"upsert": true}.'));
    for (const [field, value] of Object.entries(operand)) {
      const at = joinPath(here, field);
      if (UPDATE_PATH_OPS.has(op)) {
        const segments = field.split(".");
        for (const seg of segments) {
          const m = /^\$\[([A-Za-z][A-Za-z0-9_]*)\]$/.exec(seg);
          if (m) identifiers.add(m[1]);
        }
        for (const prior of seen) {
          const n = Math.min(prior.path.length, segments.length);
          if (prior.path.slice(0, n).join(".") === segments.slice(0, n).join(".")) out.push(makeIssue("error", at, `Updating "${field}" conflicts with "${prior.path.join(".")}" from ${prior.op}: MongoDB rejects two operators touching the same path.`, "Merge them into a single operator."));
        }
        seen.push({ path: segments, op });
      }
      checkUpdateValue(op, field, value, at, out);
    }
  }
  return identifiers;
}

function checkUpdateValue(op: string, field: string, value: unknown, at: string, out: Out): void {
  switch (op) {
    case "$inc":
    case "$mul":
      if (!isNumeric(value)) out.push(makeIssue("error", at, `${op} needs a number, got ${describe(value)}.`, op === "$inc" ? 'Example: {"$inc": {"views": 1}}.' : 'Example: {"$mul": {"price": 1.1}}.'));
      return;
    case "$rename":
      if (typeof value !== "string" || !value) out.push(makeIssue("error", at, '$rename needs the new field name as a string: {"$rename": {"old": "new"}}.'));
      else if (value === field) out.push(makeIssue("error", at, "$rename old and new names are the same."));
      return;
    case "$pop":
      if (value !== 1 && value !== -1) out.push(makeIssue("error", at, "$pop needs 1 (remove last) or -1 (remove first)."));
      return;
    case "$currentDate":
      if (value !== true && !(isObj(value) && (value.$type === "date" || value.$type === "timestamp"))) out.push(makeIssue("error", at, '$currentDate needs true or {"$type": "date" | "timestamp"}.'));
      return;
    case "$pullAll":
      if (!Array.isArray(value)) out.push(makeIssue("error", at, "$pullAll needs an array of values to remove."));
      return;
    case "$push":
    case "$addToSet":
      if (isObj(value) && "$each" in value) {
        if (!Array.isArray(value.$each)) out.push(makeIssue("error", joinPath(at, "$each"), "$each needs an array."));
        for (const mod of Object.keys(value)) {
          if (mod === "$each") continue;
          if (!(UPDATE_MODIFIERS as readonly string[]).includes(mod)) out.push(makeIssue("error", joinPath(at, mod), `Unknown modifier ${mod}.${didYouMean(mod, UPDATE_MODIFIERS)}`));
          else if (op === "$addToSet") out.push(makeIssue("error", joinPath(at, mod), `${op} only supports $each; ${mod} is a $push modifier.`));
        }
        if ("$position" in value && !isInt(value.$position)) out.push(makeIssue("error", joinPath(at, "$position"), "$position needs a whole number."));
        if ("$slice" in value && !isInt(value.$slice)) out.push(makeIssue("error", joinPath(at, "$slice"), "$slice needs a whole number."));
        if ("$sort" in value) checkSort(isObj(value.$sort) ? value.$sort : value.$sort === 1 || value.$sort === -1 ? {} : value.$sort, joinPath(at, "$sort"), out);
      }
      return;
    case "$bit":
      if (!isObj(value) || Object.keys(value).length !== 1 || !["and", "or", "xor"].includes(Object.keys(value)[0])) out.push(makeIssue("error", at, '$bit needs {"and" | "or" | "xor": integer}.'));
      return;
    case "$set":
      if (field === "_id") out.push(makeIssue("warning", at, "_id is immutable: $set on _id fails unless the value is unchanged."));
      return;
    default:
  }
}

export function checkArrayFilters(filters: unknown, path: string, out: Out, used: Set<string>): void {
  if (filters === undefined) {
    for (const id of used) out.push(makeIssue("error", path || "options.arrayFilters", `The update uses $[${id}] but options.arrayFilters does not define "${id}".`, `Add "options": {"arrayFilters": [{"${id}.field": value}]}.`));
    return;
  }
  if (!Array.isArray(filters)) {
    out.push(makeIssue("error", path, "arrayFilters must be an array of filter objects."));
    return;
  }
  const defined = new Set<string>();
  const collect = (clause: unknown, here: string) => {
    if (!isObj(clause)) return void out.push(makeIssue("error", here, "Each arrayFilters entry must be an object."));
    for (const [key, value] of Object.entries(clause)) {
      if (LOGICAL.includes(key) && Array.isArray(value)) value.forEach((sub, i) => collect(sub, joinPath(joinPath(here, key), i)));
      else defined.add(key.split(".")[0]);
    }
  };
  filters.forEach((clause, i) => collect(clause, joinPath(path, i)));
  for (const id of used) if (!defined.has(id)) out.push(makeIssue("error", path, `The update uses $[${id}] but no arrayFilters entry starts with "${id}".`, `Add {"${id}.field": value} to arrayFilters.`));
  for (const id of defined) if (!used.has(id)) out.push(makeIssue("error", path, `arrayFilters defines "${id}" but the update never uses $[${id}].`, "Remove the filter or use the identifier in an update path like items.$[" + id + "].field."));
}

/* ---------------------------------------------------------------- documents */

export function checkDocument(doc: unknown, path: string, out: Out, depth = 0): void {
  if (!isObj(doc) || isTyped(doc)) {
    out.push(makeIssue("error", path, `A document must be an object, got ${describe(doc)}.`));
    return;
  }
  if (depth > MAX_DEPTH) {
    out.push(makeIssue("error", path, "Document is nested more than 100 levels (BSON limit)."));
    return;
  }
  for (const [key, value] of Object.entries(doc)) {
    const here = joinPath(path, key);
    if (depth === 0 && key.startsWith("$")) out.push(makeIssue("error", here, `Top-level field names cannot start with $ ("${key}").`, "Rename the field."));
    if (key.includes("\0")) out.push(makeIssue("error", here, "Field names cannot contain a null character."));
    if (key.includes(".") && !key.startsWith("$")) out.push(makeIssue("warning", here, `Field name "${key}" contains a dot: allowed since MongoDB 5.0 but it breaks dotted-path queries.`, "Use nested objects instead."));
    if (key === "_id" && depth === 0) {
      if (Array.isArray(value)) out.push(makeIssue("error", here, "_id cannot be an array."));
    }
    if (isObj(value) && !isTyped(value)) checkDocument(value, here, out, depth + 1);
    else if (Array.isArray(value)) value.forEach((item, index) => isObj(item) && !isTyped(item) && checkDocument(item, joinPath(here, index), out, depth + 1));
  }
}

/* -------------------------------------------------------------------- index */

export function checkIndex(keys: unknown, options: unknown, path: string, out: Out): void {
  if (!isObj(keys) || !Object.keys(keys).length) {
    out.push(makeIssue("error", `${path}keys`, 'keys must be an object like {"email": 1} (1 ascending, -1 descending).'));
    return;
  }
  const entries = Object.entries(keys);
  if (entries.length > 32) out.push(makeIssue("error", `${path}keys`, "An index can have at most 32 keys."));
  let hashed = false;
  let special = false;
  for (const [key, dir] of entries) {
    const here = joinPath(`${path}keys`, key);
    if (dir === 1 || dir === -1) continue;
    if (typeof dir === "string" && (INDEX_KEY_TYPES as readonly string[]).includes(dir)) {
      special = true;
      if (dir === "hashed") hashed = true;
      continue;
    }
    out.push(makeIssue("error", here, `Index direction must be 1, -1 or one of ${INDEX_KEY_TYPES.map((t) => `"${t}"`).join(", ")}; got ${JSON.stringify(typeof dir === "bigint" ? String(dir) : dir)}.`));
  }
  if (entries.length === 1 && entries[0][0] === "_id" && entries[0][1] === 1) out.push(makeIssue("info", `${path}keys`, "An index on _id: 1 exists on every collection already."));
  if (options === undefined) return;
  if (!isObj(options)) {
    out.push(makeIssue("error", `${path}options`, "options must be an object."));
    return;
  }
  for (const [key, value] of Object.entries(options)) {
    const here = joinPath(`${path}options`, key);
    if (!(INDEX_OPTIONS as readonly string[]).includes(key)) out.push(makeIssue("error", here, `Unknown index option "${key}".${didYouMean(key, INDEX_OPTIONS)}`, `Index options: ${INDEX_OPTIONS.join(", ")}.`));
    if (["unique", "sparse", "hidden", "background"].includes(key) && typeof value !== "boolean") out.push(makeIssue("error", here, `${key} must be true or false.`));
    if (key === "name" && (typeof value !== "string" || !value)) out.push(makeIssue("error", here, "name must be a non-empty string."));
    if (key === "expireAfterSeconds" && (!isInt(value) || (value as number) < 0)) out.push(makeIssue("error", here, "expireAfterSeconds must be a whole number of seconds, 0 or more."));
    if (key === "background") out.push(makeIssue("info", here, "background is ignored since MongoDB 4.2 (all index builds are non-blocking)."));
  }
  if ("expireAfterSeconds" in options && (entries.length !== 1 || special)) out.push(makeIssue("error", `${path}options.expireAfterSeconds`, "A TTL index must be a single-field ascending/descending index on a date field.", "Create one index per TTL field."));
  if (options.unique === true && hashed) out.push(makeIssue("error", `${path}options.unique`, "Hashed indexes cannot be unique."));
  if (options.sparse === true && "partialFilterExpression" in options) out.push(makeIssue("error", `${path}options`, "sparse and partialFilterExpression cannot be combined.", "Use partialFilterExpression alone: it is a superset of sparse."));
  if ("partialFilterExpression" in options) checkFilter(options.partialFilterExpression, `${path}options.partialFilterExpression`, out, { partial: true });
}
