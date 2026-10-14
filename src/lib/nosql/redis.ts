/**
 * Redis operation spec (a list of `{command, args}`) -> validated redis-cli lines, redis-py and node-redis code,
 * with the command table's complexity and pitfalls in `explain`.
 *
 * Command metadata (syntax, arity, complexity, ACL categories) is generated from the official command reference
 * (`redis-grammar.ts`, https://redis.io/docs/latest/commands/). Client syntax:
 *  - redis-cli quoting (sdssplitargs)   https://redis.io/docs/latest/develop/tools/cli/
 *  - redis-py (execute_command, pipelines, pubsub)   https://redis-py.readthedocs.io/en/stable/commands.html
 *  - node-redis (command options `{EX, NX}`, sendCommand, multi/addCommand/exec, subscribe)
 *      https://github.com/redis/node-redis/blob/master/README.md
 */
import * as z from "zod/v4";
import {
  cliToken,
  describe,
  hasErrors,
  isObj,
  jsString,
  makeIssue,
  pyNumber,
  pyString,
  suggest,
  zodToIssues,
  type CompileOptions,
  type CompileResult,
  type NosqlIssue,
  type Obj,
  type Snippet,
} from "./common";
import { REDIS_COMMANDS, isLinearComplexity, keywordsOf, matchArgs, nearestKeyword, PITFALLS, resolveCommand, splitCommandLine, syntaxOf, describeSpec, allCommandNames, type RedisCommandDef } from "./redis-grammar";

export { REDIS_COMMANDS, splitCommandLine, syntaxOf };

export const REDIS_MODES = ["sequential", "pipeline", "transaction"] as const;

/* ------------------------------------------------------------------- schema */

const opSchema = z.strictObject(
  {
    command: z.string({ error: "command is required: the Redis command name, e.g. \"SET\"" }).min(1, { error: "command must not be empty" }),
    args: z.array(z.unknown(), { error: "args must be a list of strings or numbers" }).optional(),
  },
  { error: 'each op must be an object like {"command": "SET", "args": ["key", "value"]}' },
);

export const redisSpecSchema = z.strictObject({
  ops: z.array(opSchema, { error: "ops must be a list of {command, args} objects" }).min(1, { error: "ops needs at least one command" }).max(500, { error: "ops can hold at most 500 commands" }),
  mode: z.enum(REDIS_MODES, { error: `mode must be one of ${REDIS_MODES.join(", ")}` }).optional(),
  connection: z
    .strictObject({
      host: z.string({ error: "connection.host must be a string" }).min(1).optional(),
      port: z.number({ error: "connection.port must be a number" }).int().min(1).max(65535).optional(),
      db: z.number({ error: "connection.db must be a whole number" }).int().min(0).max(15, { error: "connection.db is usually 0-15" }).optional(),
      tls: z.boolean({ error: "connection.tls must be true or false" }).optional(),
    })
    .optional(),
});
export type RedisSpec = z.infer<typeof redisSpecSchema>;

/** Accepts the spec, a bare array of ops, or ops written as redis-cli lines ("SET key value EX 60"). */
export function normalizeInput(input: unknown): { value: unknown; issues: NosqlIssue[] } {
  const issues: NosqlIssue[] = [];
  const toOp = (item: unknown, path: string): unknown => {
    if (typeof item !== "string") return item;
    const words = splitCommandLine(item);
    if (!words) {
      issues.push(makeIssue("error", path, "Unbalanced quotes in this command line."));
      return { command: item };
    }
    if (!words.length) {
      issues.push(makeIssue("error", path, "Empty command line."));
      return { command: "" };
    }
    return { command: words[0], args: words.slice(1) };
  };
  if (Array.isArray(input)) return { value: { ops: input.map((item, i) => toOp(item, `ops[${i}]`)) }, issues };
  if (isObj(input) && Array.isArray(input.ops)) return { value: { ...input, ops: input.ops.map((item, i) => toOp(item, `ops[${i}]`)) }, issues };
  return { value: input, issues };
}

/** Turns pasted redis-cli lines (one command per line, `#` comments allowed) into a spec. */
export function parseCommandLines(text: string): { spec?: RedisSpec; issues: NosqlIssue[] } {
  const issues: NosqlIssue[] = [];
  const ops: { command: string; args: string[] }[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const words = splitCommandLine(trimmed);
    if (!words || !words.length) return void issues.push(makeIssue("error", `line ${index + 1}`, "Unbalanced quotes on this line."));
    ops.push({ command: words[0], args: words.slice(1) });
  });
  if (!ops.length && !issues.length) issues.push(makeIssue("error", "(spec)", "No commands found."));
  return issues.length ? { issues } : { spec: { ops }, issues };
}

/* ---------------------------------------------------------------- resolution */

export interface CmdArg {
  /** the value as the author wrote it */
  raw: string | number;
  /** the string Redis will receive (keywords in canonical upper case) */
  s: string;
  keyword: boolean;
}

export interface Cmd {
  def: RedisCommandDef;
  /** command words in canonical upper case: ["SET"] or ["CLIENT", "SETNAME"] */
  words: string[];
  args: CmdArg[];
}

const NUMKEYS: Record<string, { at: number; tail: boolean }> = {
  ZUNIONSTORE: { at: 1, tail: false }, ZINTERSTORE: { at: 1, tail: false }, ZUNION: { at: 0, tail: false }, ZINTER: { at: 0, tail: false }, ZDIFF: { at: 0, tail: false },
  ZDIFFSTORE: { at: 1, tail: false }, SINTERCARD: { at: 0, tail: false }, LMPOP: { at: 0, tail: false }, ZMPOP: { at: 0, tail: false },
};

function checkOp(op: { command: string; args?: unknown[] }, index: number, mode: string, db: number | undefined, out: NosqlIssue[]): Cmd | null {
  const at = `ops[${index}]`;
  const raw: (string | number)[] = [];
  let bad = false;
  (op.args ?? []).forEach((arg, j) => {
    const path = `${at}.args[${j}]`;
    if (typeof arg === "string") raw.push(arg);
    else if (typeof arg === "number" && Number.isFinite(arg)) raw.push(arg);
    else if (typeof arg === "bigint") raw.push(arg.toString());
    else {
      bad = true;
      const what = typeof arg === "boolean" ? `${arg} (a boolean)` : describe(arg);
      out.push(makeIssue("error", path, `Redis arguments must be strings or numbers, got ${what}.`, typeof arg === "boolean" ? `Write "${arg}" as a string, or 1/0 if the command takes a number.` : arg !== null && typeof arg === "object" ? `Serialize it first: pass ${JSON.stringify(JSON.stringify(arg, (_k, v) => (typeof v === "bigint" ? v.toString() : v)))} as one string.` : "Leave it out."));
    }
  });
  if (bad) return null;
  const commandWords = op.command.trim().split(/\s+/);
  const all: (string | number)[] = [...commandWords, ...raw];
  const first = String(all[0]);
  const resolved = resolveCommand(first, all[1] === undefined ? undefined : String(all[1]));
  if (!resolved.ok) {
    if (resolved.unknown === "subcommand") {
      const hit = resolved.word ? suggest(resolved.word, resolved.candidates) : undefined;
      out.push(makeIssue("error", `${at}.${resolved.word ? "args[0]" : "command"}`, resolved.word ? `${first.toUpperCase()} has no sub-command "${resolved.word}".${hit ? ` Did you mean ${hit}?` : ""}` : `${first.toUpperCase()} needs a sub-command.`, `Sub-commands of ${first.toUpperCase()}: ${resolved.candidates.join(", ")}.`));
    } else {
      const hit = suggest(first, resolved.candidates);
      out.push(makeIssue("error", `${at}.command`, `Unknown command "${first}".${hit ? ` Did you mean ${hit}?` : ""}`, hit ? undefined : "Check the spelling against redis.io/commands."));
    }
    return null;
  }
  const { def, words } = resolved.value;
  const rest = all.slice(words);
  const restArgs = rest.map(String);
  const total = words + restArgs.length;
  const syntax = syntaxOf(def);
  if (def.arity >= 0 && total !== def.arity) {
    out.push(makeIssue("error", `${at}.args`, `${def.name} takes exactly ${def.arity - words} argument${def.arity - words === 1 ? "" : "s"}, got ${restArgs.length}.`, `Syntax: ${syntax}`));
    return null;
  }
  if (def.arity < 0 && total < -def.arity) {
    out.push(makeIssue("error", `${at}.args`, `${def.name} needs at least ${-def.arity - words} argument${-def.arity - words === 1 ? "" : "s"}, got ${restArgs.length}.`, `Syntax: ${syntax}`));
    return null;
  }
  const match = matchArgs(def, restArgs);
  const argOffset = words - commandWords.length; // index of the first rest word inside op.args
  const argPath = (i: number) => `${at}.args[${i + argOffset}]`;
  if (!match.ok) {
    const keywords = keywordsOf(def);
    const f = match.failure;
    if (match.stoppedAt < restArgs.length) {
      const token = restArgs[match.stoppedAt];
      const hit = nearestKeyword(token, keywords);
      if (f && f.reason === "type" && f.pos >= match.stoppedAt && f.pos <= match.stoppedAt + 1) out.push(makeIssue("error", argPath(f.pos), `"${f.token}" is not a valid ${f.spec.t === "double" ? "number" : "integer"} for ${f.spec.n}.`, `Syntax: ${syntax}`));
      else if (keywords.some((k) => k.toUpperCase() === token.toUpperCase())) out.push(makeIssue("error", argPath(match.stoppedAt), `${token.toUpperCase()} needs a value after it${f && f.pos === match.stoppedAt + 1 ? ` (${describeSpec(f.spec)})` : ""}.`, `Syntax: ${syntax}`));
      else out.push(makeIssue("error", argPath(match.stoppedAt), `Unexpected argument "${token}"${hit ? `. Did you mean ${hit}?` : "."}`, hit ? `Syntax: ${syntax}` : `Syntax: ${syntax}${keywords.length ? ` (options: ${keywords.join(", ")})` : ""}`));
    } else if (f) {
      out.push(makeIssue("error", `${at}.args`, f.reason === "type" ? `"${f.token}" is not a valid ${f.spec.t === "double" ? "number" : "integer"} for ${f.spec.n}.` : `${def.name} is missing ${describeSpec(f.spec)}.`, `Syntax: ${syntax}`));
    } else out.push(makeIssue("error", `${at}.args`, `The arguments do not match ${def.name}'s syntax.`, `Syntax: ${syntax}`));
    return null;
  }
  const numkeys = NUMKEYS[def.name];
  if (numkeys) {
    const n = Number(restArgs[numkeys.at]);
    const keywordsUpper = new Set(keywordsOf(def).map((k) => k.toUpperCase()));
    const candidates = restArgs.slice(numkeys.at + 1);
    const firstKeyword = candidates.findIndex((t) => keywordsUpper.has(t.toUpperCase()));
    const actual = firstKeyword === -1 ? candidates.length : firstKeyword;
    if (Number.isInteger(n) && n !== actual) out.push(makeIssue("error", argPath(numkeys.at), `numkeys says ${n} but ${actual} key${actual === 1 ? "" : "s"} follow${actual === 1 ? "s" : ""}.`, "numkeys must equal the number of keys that come right after it."));
  }
  const cmd: Cmd = {
    def,
    words: def.name.split(" "),
    args: restArgs.map((s, i) => (match.keywordAt.has(i) ? { raw: s.toUpperCase(), s: s.toUpperCase(), keyword: true } : { raw: rest[i], s, keyword: false })),
  };
  const head = def.name.split(" ")[0];
  if (def.deprecated) out.push(makeIssue("warning", `${at}.command`, `${def.name} is deprecated since Redis ${def.deprecated}${def.replacedBy ? `; use ${def.replacedBy}` : ""}.`));
  if (["MULTI", "EXEC", "DISCARD"].includes(head)) {
    out.push(makeIssue("error", `${at}.command`, `${head} cannot be written by hand: client libraries need a transaction object, so the generated code would not work.`, 'Remove it and set "mode": "transaction" so MULTI/EXEC are added for you.'));
  } else {
    const pitfall = PITFALLS[def.name] ?? PITFALLS[head];
    if (pitfall) out.push(makeIssue(pitfall.severity, `${at}.command`, pitfall.message, pitfall.fix));
    if (def.name === "LRANGE" && restArgs[1] === "0" && restArgs[2] === "-1") out.push(makeIssue("warning", `${at}.args`, "LRANGE key 0 -1 reads the entire list (O(N)).", "Fetch a small window, e.g. 0 99, and page through."));
    if (def.name === "KEYS" && restArgs[0] === "*") out.push(makeIssue("warning", `${at}.args[0]`, "KEYS * lists every key in the database.", "Use SCAN 0 MATCH pattern COUNT 100 and loop until the cursor is 0."));
    if (isLinearComplexity(def.complexity) && !pitfall) out.push(makeIssue("info", `${at}.command`, `${def.name} costs ${def.complexity}`, "Cost grows with the amount of data it touches."));
  }
  if (def.cats.includes("blocking") && mode !== "sequential") out.push(makeIssue("warning", `${at}.command`, `${def.name} blocks the connection: inside a ${mode} it stalls every other command (or is turned non-blocking by MULTI).`, "Run blocking commands on their own connection in sequential mode."));
  if (["SUBSCRIBE", "PSUBSCRIBE", "SSUBSCRIBE"].includes(head) && mode !== "sequential") out.push(makeIssue("error", `${at}.command`, `${head} cannot be part of a ${mode}: a subscribed connection only receives messages.`, "Put it in its own spec."));
  if (head === "SELECT" && db !== undefined && db !== 0) out.push(makeIssue("warning", `${at}.command`, `SELECT changes the database on this connection but connection.db is already ${db}.`, "Remove one of them."));
  return cmd;
}

export interface Checked {
  spec?: RedisSpec;
  cmds?: Cmd[];
  issues: NosqlIssue[];
}

export function check(input: unknown): Checked {
  const normalized = normalizeInput(input);
  const out = [...normalized.issues];
  if (!isObj(normalized.value)) return { issues: [makeIssue("error", "(spec)", 'The spec must be an object like {"ops": [{"command": "SET", "args": ["k", "v"]}]} (or a list of ops).')] };
  const parsed = redisSpecSchema.safeParse(normalized.value);
  if (!parsed.success) return { issues: [...out, ...zodToIssues(parsed.error, ["ops", "mode", "connection"])] };
  const spec = parsed.data;
  const mode = spec.mode ?? "sequential";
  const cmds: Cmd[] = [];
  let ok = true;
  spec.ops.forEach((op, index) => {
    const cmd = checkOp(op, index, mode, spec.connection?.db, out);
    if (cmd) cmds.push(cmd);
    else ok = false;
  });
  if (spec.ops.length > 100) out.push(makeIssue("info", "ops", "More than 100 commands: consider SCAN-style batching or a Lua script."));
  if (mode === "transaction") out.push(makeIssue("info", "mode", "A transaction (MULTI/EXEC) runs all commands atomically, but a command with a wrong type still fails at EXEC without rolling back the others."));
  return { spec, cmds: ok ? cmds : undefined, issues: out };
}

export function validate(input: unknown): { ok: boolean; issues: NosqlIssue[] } {
  const { issues } = check(input);
  return { ok: !hasErrors(issues), issues };
}

/* ------------------------------------------------------------------ renderers */

export function cliLine(cmd: Cmd): string {
  return [...cmd.words, ...cmd.args.map((a) => a.s)].map(cliToken).join(" ");
}

const isInt = (a: CmdArg): number | null => (/^[-+]?\d+$/.test(a.s) && Number.isSafeInteger(Number(a.s)) ? Number(a.s) : null);
const isNum = (a: CmdArg): boolean => /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(a.s);

const pyLit = (a: CmdArg): string => (typeof a.raw === "number" && !a.keyword ? pyNumber(a.raw) : pyString(a.s));
const pyNum = (a: CmdArg): string => (isInt(a) !== null ? String(isInt(a)) : a.s);

/** Method call text for redis-py (without the `r.` receiver), or null when the generic execute_command is safer. */
function pyFriendly(cmd: Cmd): string | null {
  const a = cmd.args;
  const name = cmd.def.name;
  const lits = (items: CmdArg[]) => items.map(pyLit).join(", ");
  const simple: Record<string, string> = {
    GET: "get", GETDEL: "getdel", TTL: "ttl", PTTL: "pttl", PERSIST: "persist", TYPE: "type", INCR: "incr", DECR: "decr", STRLEN: "strlen", HGETALL: "hgetall", HKEYS: "hkeys", HVALS: "hvals", HLEN: "hlen",
    LLEN: "llen", SMEMBERS: "smembers", SCARD: "scard", ZCARD: "zcard", KEYS: "keys", XLEN: "xlen", SPOP: "spop",
  };
  if (simple[name] && (a.length === 1 || (name === "SPOP" && a.length === 2))) return name === "SPOP" && a.length === 2 ? `spop(${pyLit(a[0])}, ${pyNum(a[1])})` : `${simple[name]}(${pyLit(a[0])})`;
  switch (name) {
    case "SET": {
      if (a.length < 2) return null;
      const kws: string[] = [];
      for (let i = 2; i < a.length; i++) {
        const k = a[i].s.toUpperCase();
        if (["EX", "PX", "EXAT", "PXAT"].includes(k) && a[i + 1] && isInt(a[i + 1]) !== null) kws.push(`${k.toLowerCase()}=${isInt(a[++i])}`);
        else if (k === "KEEPTTL") kws.push("keepttl=True");
        else if (k === "NX" || k === "XX" || k === "GET") kws.push(`${k.toLowerCase()}=True`);
        else return null;
      }
      return `set(${[pyLit(a[0]), pyLit(a[1]), ...kws].join(", ")})`;
    }
    case "DEL": return `delete(${lits(a)})`;
    case "EXISTS": return `exists(${lits(a)})`;
    case "UNLINK": return `unlink(${lits(a)})`;
    case "EXPIRE":
    case "PEXPIRE":
    case "EXPIREAT":
    case "PEXPIREAT":
      return a.length === 2 && isInt(a[1]) !== null ? `${name.toLowerCase()}(${pyLit(a[0])}, ${isInt(a[1])})` : null;
    case "INCRBY":
    case "DECRBY":
      return a.length === 2 && isInt(a[1]) !== null ? `${name.toLowerCase()}(${pyLit(a[0])}, ${isInt(a[1])})` : null;
    case "INCRBYFLOAT": return a.length === 2 && isNum(a[1]) ? `incrbyfloat(${pyLit(a[0])}, ${pyNum(a[1])})` : null;
    case "APPEND": return `append(${pyLit(a[0])}, ${pyLit(a[1])})`;
    case "SETNX": return `setnx(${pyLit(a[0])}, ${pyLit(a[1])})`;
    case "SETEX": return isInt(a[1]) !== null ? `setex(${pyLit(a[0])}, ${isInt(a[1])}, ${pyLit(a[2])})` : null;
    case "MGET": return `mget([${lits(a)}])`;
    case "MSET": {
      if (a.length % 2) return null;
      const keys = a.filter((_, i) => i % 2 === 0).map((x) => x.s);
      if (new Set(keys).size !== keys.length) return null;
      return `mset({${a.reduce<string[]>((acc, x, i) => (i % 2 === 0 ? [...acc, `${pyString(x.s)}: ${pyLit(a[i + 1])}`] : acc), []).join(", ")}})`;
    }
    case "HSET": {
      if (a.length === 3) return `hset(${lits(a)})`;
      if (a.length % 2 === 0) return null;
      const fields = a.slice(1).filter((_, i) => i % 2 === 0).map((x) => x.s);
      if (new Set(fields).size !== fields.length) return null;
      return `hset(${pyLit(a[0])}, mapping={${a.slice(1).reduce<string[]>((acc, x, i) => (i % 2 === 0 ? [...acc, `${pyString(x.s)}: ${pyLit(a[i + 2])}`] : acc), []).join(", ")}})`;
    }
    case "HGET":
    case "HEXISTS":
      return `${name.toLowerCase()}(${lits(a)})`;
    case "HDEL": return `hdel(${lits(a)})`;
    case "HMGET": return `hmget(${pyLit(a[0])}, [${lits(a.slice(1))}])`;
    case "HINCRBY": return isInt(a[2]) !== null ? `hincrby(${pyLit(a[0])}, ${pyLit(a[1])}, ${isInt(a[2])})` : null;
    case "LPUSH":
    case "RPUSH":
    case "SADD":
    case "SREM":
      return `${name.toLowerCase()}(${lits(a)})`;
    case "LPOP":
    case "RPOP":
      return a.length === 1 ? `${name.toLowerCase()}(${pyLit(a[0])})` : a.length === 2 && isInt(a[1]) !== null ? `${name.toLowerCase()}(${pyLit(a[0])}, ${isInt(a[1])})` : null;
    case "LRANGE": return isInt(a[1]) !== null && isInt(a[2]) !== null ? `lrange(${pyLit(a[0])}, ${isInt(a[1])}, ${isInt(a[2])})` : null;
    case "LTRIM": return isInt(a[1]) !== null && isInt(a[2]) !== null ? `ltrim(${pyLit(a[0])}, ${isInt(a[1])}, ${isInt(a[2])})` : null;
    case "LINDEX": return isInt(a[1]) !== null ? `lindex(${pyLit(a[0])}, ${isInt(a[1])})` : null;
    case "LREM": return isInt(a[1]) !== null ? `lrem(${pyLit(a[0])}, ${isInt(a[1])}, ${pyLit(a[2])})` : null;
    case "SISMEMBER": return `sismember(${lits(a)})`;
    case "SUNION":
    case "SINTER":
    case "SDIFF":
      return `${name.toLowerCase()}([${lits(a)}])`;
    case "ZADD": {
      if (a.length < 3 || a.length % 2 === 0 || !a.slice(1).every((x, i) => (i % 2 === 0 ? isNum(x) : true))) return null;
      const pairs: string[] = [];
      for (let i = 1; i < a.length; i += 2) pairs.push(`${pyLit(a[i + 1])}: ${pyNum(a[i])}`);
      return `zadd(${pyLit(a[0])}, {${pairs.join(", ")}})`;
    }
    case "ZRANGE":
    case "ZREVRANGE": {
      if (a.length < 3 || isInt(a[1]) === null || isInt(a[2]) === null) return null;
      if (a.length === 3) return `${name.toLowerCase()}(${pyLit(a[0])}, ${isInt(a[1])}, ${isInt(a[2])})`;
      if (a.length === 4 && a[3].s.toUpperCase() === "WITHSCORES") return `${name.toLowerCase()}(${pyLit(a[0])}, ${isInt(a[1])}, ${isInt(a[2])}, withscores=True)`;
      return null;
    }
    case "ZREM": return `zrem(${lits(a)})`;
    case "ZSCORE":
    case "ZRANK":
    case "ZREVRANK":
      return `${name.toLowerCase()}(${lits(a)})`;
    case "ZINCRBY": return isNum(a[1]) ? `zincrby(${pyLit(a[0])}, ${pyNum(a[1])}, ${pyLit(a[2])})` : null;
    case "ZCOUNT": return `zcount(${lits(a)})`;
    case "PUBLISH": return `publish(${lits(a)})`;
    case "RENAME": return `rename(${lits(a)})`;
    case "FLUSHALL":
    case "FLUSHDB":
      return a.length === 0 ? `${name.toLowerCase()}()` : a.length === 1 && a[0].s === "ASYNC" ? `${name.toLowerCase()}(asynchronous=True)` : null;
    case "DBSIZE": return "dbsize()";
    case "PING": return a.length === 0 ? "ping()" : null;
    case "INFO": return a.length === 0 ? "info()" : a.length === 1 ? `info(${pyLit(a[0])})` : null;
    case "XADD": {
      const rest = a.slice(2);
      if (a.length < 4 || rest.length % 2 !== 0) return null;
      const fields = rest.filter((_, i) => i % 2 === 0).map((x) => x.s);
      if (new Set(fields).size !== fields.length) return null;
      const body = rest.reduce<string[]>((acc, x, i) => (i % 2 === 0 ? [...acc, `${pyString(x.s)}: ${pyLit(rest[i + 1])}`] : acc), []).join(", ");
      return a[1].s === "*" ? `xadd(${pyLit(a[0])}, {${body}})` : `xadd(${pyLit(a[0])}, {${body}}, id=${pyLit(a[1])})`;
    }
    default: return null;
  }
}

function pyGeneric(cmd: Cmd): string {
  return `execute_command(${[...cmd.words.map(pyString), ...cmd.args.map(pyLit)].join(", ")})`;
}

function pyStatement(cmd: Cmd, recv: string): string {
  const head = cmd.words[0];
  if (head === "SUBSCRIBE" || head === "PSUBSCRIBE") {
    const method = head === "SUBSCRIBE" ? "subscribe" : "psubscribe";
    return `pubsub = r.pubsub()\npubsub.${method}(${cmd.args.map(pyLit).join(", ")})\nfor message in pubsub.listen():\n    print(message)`;
  }
  return `${recv}.${pyFriendly(cmd) ?? pyGeneric(cmd)}`;
}

function renderPython(spec: RedisSpec, cmds: Cmd[]): string {
  const c = spec.connection ?? {};
  const mode = spec.mode ?? "sequential";
  const connect = `r = redis.Redis(host=${pyString(c.host ?? "localhost")}, port=${c.port ?? 6379}, db=${c.db ?? 0}${c.tls ? ", ssl=True" : ""}, decode_responses=True)`;
  const lines: string[] = ["import redis", "", connect, ""];
  if (mode === "sequential") {
    for (const cmd of cmds) {
      const statement = pyStatement(cmd, "r");
      lines.push(cmd.words[0] === "SUBSCRIBE" || cmd.words[0] === "PSUBSCRIBE" ? statement : `print(${statement})`);
    }
  } else {
    lines.push(`pipe = r.pipeline(transaction=${mode === "transaction" ? "True" : "False"})`);
    for (const cmd of cmds) lines.push(pyStatement(cmd, "pipe"));
    lines.push("print(pipe.execute())");
  }
  return `${lines.join("\n")}\n`;
}

/* ---- node-redis */

const jsStr = (a: CmdArg): string => jsString(a.s);
const jsInt = (a: CmdArg): string | null => (isInt(a) !== null ? String(isInt(a)) : null);

function nodeFriendly(cmd: Cmd): string | null {
  const a = cmd.args;
  const name = cmd.def.name;
  const one = (method: string, count = 1) => (a.length === count ? `${method}(${a.map(jsStr).join(", ")})` : null);
  const many = (method: string) => (a.length === 1 ? `${method}(${jsStr(a[0])})` : `${method}([${a.map(jsStr).join(", ")}])`);
  const keyThenMany = (method: string) => (a.length === 2 ? `${method}(${jsStr(a[0])}, ${jsStr(a[1])})` : `${method}(${jsStr(a[0])}, [${a.slice(1).map(jsStr).join(", ")}])`);
  switch (name) {
    case "GET": return one("get");
    case "TTL": return one("ttl");
    case "INCR": return one("incr");
    case "DECR": return one("decr");
    case "HGETALL": return one("hGetAll");
    case "SMEMBERS": return one("sMembers");
    case "SCARD": return one("sCard");
    case "LLEN": return one("lLen");
    case "KEYS": return one("keys");
    case "DEL": return many("del");
    case "EXISTS": return many("exists");
    case "SET": {
      if (a.length < 2) return null;
      const opts: string[] = [];
      for (let i = 2; i < a.length; i++) {
        const k = a[i].s.toUpperCase();
        if (["EX", "PX", "EXAT", "PXAT"].includes(k) && a[i + 1] && jsInt(a[i + 1])) opts.push(`${k}: ${jsInt(a[++i])}`);
        else if (["KEEPTTL", "NX", "XX", "GET"].includes(k)) opts.push(`${k}: true`);
        else return null;
      }
      return `set(${jsStr(a[0])}, ${jsStr(a[1])}${opts.length ? `, { ${opts.join(", ")} }` : ""})`;
    }
    case "EXPIRE": return a.length === 2 && jsInt(a[1]) ? `expire(${jsStr(a[0])}, ${jsInt(a[1])})` : null;
    case "INCRBY": return a.length === 2 && jsInt(a[1]) ? `incrBy(${jsStr(a[0])}, ${jsInt(a[1])})` : null;
    case "HSET": {
      if (a.length === 3) return `hSet(${jsStr(a[0])}, ${jsStr(a[1])}, ${jsStr(a[2])})`;
      if (a.length % 2 === 0) return null;
      const fields = a.slice(1).filter((_, i) => i % 2 === 0).map((x) => x.s);
      if (new Set(fields).size !== fields.length) return null;
      return `hSet(${jsStr(a[0])}, { ${a.slice(1).reduce<string[]>((acc, x, i) => (i % 2 === 0 ? [...acc, `${jsString(x.s)}: ${jsStr(a[i + 2])}`] : acc), []).join(", ")} })`;
    }
    case "HGET": return one("hGet", 2);
    case "HDEL": return keyThenMany("hDel");
    case "LPUSH": return keyThenMany("lPush");
    case "RPUSH": return keyThenMany("rPush");
    case "SADD": return keyThenMany("sAdd");
    case "SREM": return keyThenMany("sRem");
    case "SISMEMBER": return one("sIsMember", 2);
    case "LRANGE": return jsInt(a[1]) && jsInt(a[2]) ? `lRange(${jsStr(a[0])}, ${jsInt(a[1])}, ${jsInt(a[2])})` : null;
    case "ZADD": {
      if (a.length < 3 || a.length % 2 === 0 || !a.slice(1).every((x, i) => i % 2 !== 0 || isNum(x))) return null;
      const members: string[] = [];
      for (let i = 1; i < a.length; i += 2) members.push(`{ score: ${a[i].s}, value: ${jsStr(a[i + 1])} }`);
      return `zAdd(${jsStr(a[0])}, ${members.length === 1 ? members[0] : `[${members.join(", ")}]`})`;
    }
    case "PUBLISH": return one("publish", 2);
    default: return null;
  }
}

function nodeGeneric(cmd: Cmd): string[] {
  return [...cmd.words, ...cmd.args.map((a) => a.s)].map(jsString);
}

function renderNode(spec: RedisSpec, cmds: Cmd[]): string {
  const c = spec.connection ?? {};
  const mode = spec.mode ?? "sequential";
  const url = `${c.tls ? "rediss" : "redis"}://${c.host ?? "localhost"}:${c.port ?? 6379}${c.db ? `/${c.db}` : ""}`;
  const body: string[] = [];
  let subscribes = false;
  if (mode === "sequential") {
    for (const cmd of cmds) {
      const head = cmd.words[0];
      if (head === "SUBSCRIBE" || head === "PSUBSCRIBE") {
        subscribes = true;
        const method = head === "SUBSCRIBE" ? "subscribe" : "pSubscribe";
        const targets = cmd.args.map(jsStr);
        body.push("const subscriber = client.duplicate();", "await subscriber.connect();", `await subscriber.${method}(${targets.length === 1 ? targets[0] : `[${targets.join(", ")}]`}, (message, channel) => console.log(channel, message));`);
      } else {
        const friendly = nodeFriendly(cmd);
        body.push(`console.log(await client.${friendly ?? `sendCommand([${nodeGeneric(cmd).join(", ")}])`});`);
      }
    }
  } else {
    body.push("const results = await client", "  .multi()");
    for (const cmd of cmds) body.push(`  .addCommand([${nodeGeneric(cmd).join(", ")}])`);
    body.push(mode === "transaction" ? "  .exec();" : "  .execAsPipeline();", "console.log(results);");
  }
  const tail = subscribes ? "" : "\n} finally {\n  await client.quit();\n}";
  const inner = body.map((line) => `  ${line}`).join("\n");
  return `import { createClient } from "redis";\n\nconst client = createClient({ url: ${jsString(url)} });\nclient.on("error", (error) => console.error("Redis error", error));\n${subscribes ? "await client.connect();\n" : "try {\n  await client.connect();\n"}${subscribes ? body.join("\n") : inner}${tail}\n`;
}

/** `options` is accepted for symmetry with the other stores; Redis commands are never wrapped. */
export function compile(input: unknown, options?: CompileOptions): CompileResult {
  void options;
  const { spec, cmds, issues } = check(input);
  if (!spec || !cmds || hasErrors(issues)) return { ok: false, snippets: [], issues };
  const mode = spec.mode ?? "sequential";
  const db = spec.connection?.db;
  const cli = [...(db ? [`SELECT ${db}`] : []), ...(mode === "transaction" ? ["MULTI"] : []), ...cmds.map(cliLine), ...(mode === "transaction" ? ["EXEC"] : [])];
  const c = spec.connection ?? {};
  const extra: NosqlIssue[] = [];
  if (mode === "pipeline") extra.push(makeIssue("info", "mode", "redis-cli runs the lines one by one; the client-library snippets send them as one pipeline."));
  if (c.host && c.host !== "localhost") extra.push(makeIssue("info", "connection.host", `Connect redis-cli with: redis-cli -h ${c.host} -p ${c.port ?? 6379}${c.tls ? " --tls" : ""}`));
  const snippets: Snippet[] = [
    { language: "shell", label: "redis-cli", code: `${cli.join("\n")}\n` },
    { language: "python", label: "redis-py", code: renderPython(spec, cmds) },
    { language: "javascript", label: "node-redis", code: renderNode(spec, cmds) },
  ];
  return { ok: true, snippets, issues: [...issues, ...extra] };
}

/* -------------------------------------------------------------------- explain */

export function explain(input: unknown): string[] {
  const { spec, cmds, issues } = check(input);
  if (!spec || !cmds) return [];
  const mode = spec.mode ?? "sequential";
  const lines: string[] = [];
  lines.push(mode === "transaction" ? "Run these commands in one MULTI/EXEC transaction: they execute together, with no other client's command in between." : mode === "pipeline" ? "Send these commands in one pipeline (a single network round trip); other clients' commands may interleave." : "Run these commands one after another.");
  cmds.forEach((cmd, index) => {
    lines.push(`${index + 1}. ${cliLine(cmd)}: ${cmd.def.summary}${cmd.def.complexity ? ` Complexity: ${cmd.def.complexity}` : ""}`);
    for (const item of issues) if (item.path.startsWith(`ops[${index}]`) && item.severity !== "info") lines.push(`   ${item.severity === "error" ? "Error" : "Warning"}: ${item.message}${item.fix ? ` ${item.fix}` : ""}`);
  });
  return lines;
}

/* ------------------------------------------------------------------- examples */

export interface RedisExample {
  id: string;
  title: string;
  description: string;
  spec: Obj;
}

export const REDIS_EXAMPLES: RedisExample[] = [
  { id: "cache-ttl", title: "Cache a value for a minute", description: "SET with EX, then read it back and check the TTL.", spec: { ops: [{ command: "SET", args: ["user:1:name", "Ada", "EX", 60] }, { command: "GET", args: ["user:1:name"] }, { command: "TTL", args: ["user:1:name"] }] } },
  { id: "lock", title: "Take a lock only if free", description: "SET NX EX is the safe replacement for SETNX + EXPIRE.", spec: { ops: [{ command: "SET", args: ["lock:report", "worker-1", "NX", "EX", 30] }] } },
  { id: "counter", title: "Atomic counters", description: "INCR and INCRBY.", spec: { ops: [{ command: "INCR", args: ["page:views"] }, { command: "INCRBY", args: ["page:views", 10] }] } },
  { id: "hash-profile", title: "Store a user profile in a hash", description: "HSET with several fields, HGETALL to read.", spec: { ops: [{ command: "HSET", args: ["user:1", "name", "Ada", "city", "London", "age", 36] }, { command: "HGETALL", args: ["user:1"] }] } },
  { id: "queue", title: "A simple list queue", description: "RPUSH to enqueue, LPOP to dequeue, LRANGE a window.", spec: { ops: [{ command: "RPUSH", args: ["jobs", "a", "b", "c"] }, { command: "LPOP", args: ["jobs"] }, { command: "LRANGE", args: ["jobs", 0, 9] }] } },
  { id: "set-tags", title: "Tags as a set", description: "SADD, SISMEMBER and SMEMBERS.", spec: { ops: [{ command: "SADD", args: ["post:1:tags", "redis", "cache"] }, { command: "SISMEMBER", args: ["post:1:tags", "redis"] }, { command: "SMEMBERS", args: ["post:1:tags"] }] } },
  { id: "leaderboard", title: "Leaderboard with a sorted set", description: "ZADD scores, then the top 3 with scores.", spec: { ops: [{ command: "ZADD", args: ["leaders", 120, "ada", 95, "bob", 200, "cy"] }, { command: "ZRANGE", args: ["leaders", 0, 2, "WITHSCORES"] }] } },
  { id: "top-rev", title: "Top scores, highest first", description: "ZRANGE with REV (Redis 6.2+).", spec: { ops: [{ command: "ZRANGE", args: ["leaders", 0, 2, "REV", "WITHSCORES"] }] } },
  { id: "stream", title: "Append to a stream", description: "XADD with an automatic id, then XRANGE.", spec: { ops: [{ command: "XADD", args: ["events", "*", "type", "login", "user", "ada"] }, { command: "XRANGE", args: ["events", "-", "+", "COUNT", 10] }] } },
  { id: "transaction", title: "Transfer in one transaction", description: "mode transaction adds MULTI/EXEC for you.", spec: { mode: "transaction", ops: [{ command: "DECRBY", args: ["balance:a", 50] }, { command: "INCRBY", args: ["balance:b", 50] }] } },
  { id: "pipeline", title: "Pipeline many writes", description: "One round trip for several commands.", spec: { mode: "pipeline", connection: { host: "localhost", port: 6379, db: 2 }, ops: [{ command: "SET", args: ["a", 1] }, { command: "SET", args: ["b", 2] }, { command: "MGET", args: ["a", "b"] }] } },
  { id: "scan", title: "Find keys the safe way", description: "SCAN instead of KEYS.", spec: { ops: [{ command: "SCAN", args: [0, "MATCH", "user:*", "COUNT", 100] }] } },
  { id: "publish", title: "Publish a message", description: "Pub/Sub is fire-and-forget.", spec: { ops: [{ command: "PUBLISH", args: ["news", "hello"] }] } },
  { id: "subscribe", title: "Subscribe to a channel", description: "Long-running: keep it in its own spec.", spec: { ops: [{ command: "SUBSCRIBE", args: ["news"] }] } },
  { id: "keys-pitfall", title: "KEYS * (a classic mistake)", description: "Compiles, but warns: use SCAN.", spec: { ops: [{ command: "KEYS", args: ["*"] }] } },
  { id: "expire-hash", title: "Expire a key at a time", description: "EXPIREAT with a unix time.", spec: { ops: [{ command: "EXPIREAT", args: ["session:9", 1893456000] }] } },
];

/** Exposes the number of commands in the table for UI copy. */
export const REDIS_COMMAND_COUNT = REDIS_COMMANDS.length;
export const REDIS_COMMAND_NAMES = allCommandNames();
