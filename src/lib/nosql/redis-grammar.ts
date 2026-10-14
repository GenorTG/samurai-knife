/**
 * Redis command table lookup, syntax strings and an argument-grammar matcher.
 *
 * The table (`redis-commands.data.ts`, 388 core commands + sub-commands) is GENERATED from the official command
 * metadata https://github.com/redis/docs/blob/main/data/commands.json (what https://redis.io/docs/latest/commands/ renders):
 * arity, complexity, ACL categories and the argument tree (tokens, optional, oneof, block, multiple).
 * Redis arity rule (https://redis.io/docs/latest/commands/command/): N >= 0 means exactly N words including the command
 * name, -N means at least N. Command names, tokens and sub-commands are case-insensitive.
 */
import { REDIS_COMMAND_DATA } from "./redis-commands.data";
import type { RedisArgDef, RedisCommandDef } from "./redis-types";
import { levenshtein } from "./common";

export type { RedisArgDef, RedisCommandDef };

const BY_NAME = new Map<string, RedisCommandDef>(REDIS_COMMAND_DATA.map((c) => [c.name, c]));
const CONTAINERS = new Set(REDIS_COMMAND_DATA.filter((c) => c.name.includes(" ")).map((c) => c.name.split(" ")[0]));

export const REDIS_COMMANDS: readonly RedisCommandDef[] = REDIS_COMMAND_DATA;

export function isContainer(word: string): boolean {
  return CONTAINERS.has(word.toUpperCase());
}

export function subcommandsOf(word: string): string[] {
  return REDIS_COMMAND_DATA.filter((c) => c.name.startsWith(`${word.toUpperCase()} `)).map((c) => c.name.split(" ")[1]);
}

export function allCommandNames(): string[] {
  return [...new Set(REDIS_COMMAND_DATA.map((c) => c.name.split(" ")[0]))];
}

export interface Resolved {
  def: RedisCommandDef;
  /** number of leading words used by the command name (2 for `CLIENT SETNAME`) */
  words: number;
}

export type Resolution = { ok: true; value: Resolved } | { ok: false; unknown: "command" | "subcommand"; candidates: string[]; word: string };

/** Looks a command up by its first word (and second word for container commands). */
export function resolveCommand(first: string, second?: string): Resolution {
  const head = first.toUpperCase();
  if (CONTAINERS.has(head)) {
    const sub = second?.toUpperCase();
    const def = sub ? BY_NAME.get(`${head} ${sub}`) : undefined;
    if (def) return { ok: true, value: { def, words: 2 } };
    return { ok: false, unknown: "subcommand", candidates: subcommandsOf(head), word: second ?? "" };
  }
  const def = BY_NAME.get(head);
  if (def) return { ok: true, value: { def, words: 1 } };
  return { ok: false, unknown: "command", candidates: allCommandNames(), word: first };
}

/* --------------------------------------------------------------------- syntax */

function argSyntax(arg: RedisArgDef): string {
  let core: string;
  switch (arg.t) {
    case "pure-token":
      core = arg.k ?? arg.n;
      break;
    case "oneof":
      core = (arg.a ?? []).map(argSyntax).join(" | ");
      if (arg.k) core = `${arg.k} ${(arg.a ?? []).length > 1 ? `<${core}>` : core}`;
      break;
    case "block":
      core = `${arg.k ? `${arg.k} ` : ""}${(arg.a ?? []).map(argSyntax).join(" ")}`;
      break;
    default:
      core = `${arg.k ? `${arg.k} ` : ""}${arg.n}`;
  }
  if (arg.m) core = arg.mt ? `${core} [${core} ...]` : `${core} [${arg.t === "block" ? core : arg.n} ...]`;
  return arg.o ? `[${core}]` : core;
}

export function syntaxOf(def: RedisCommandDef): string {
  return [def.name, ...def.args.map(argSyntax)].join(" ");
}

/* ------------------------------------------------------------------- matching */

const INT = /^[-+]?\d+$/;
const DOUBLE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$|^[-+]?inf(?:inity)?$/i;

interface Failure {
  pos: number;
  spec: RedisArgDef;
  reason: "missing" | "type";
  token?: string;
}

export interface MatchContext {
  tokens: string[];
  /** furthest failure seen; used to explain what was missing or malformed */
  failure?: Failure;
  /** while > 0 (probing optional arguments) plain mismatches are not reported */
  quiet: number;
  /** positions of tokens that matched a literal keyword (so the caller can print canonical upper-case spelling) */
  keywordAt: Set<number>;
}

function note(ctx: MatchContext, pos: number, spec: RedisArgDef, reason: Failure["reason"], token?: string, force = false): void {
  if (ctx.quiet && !force) return;
  if (!ctx.failure || pos >= ctx.failure.pos) ctx.failure = { pos, spec, reason, token };
}

function matchValue(spec: RedisArgDef, pos: number, ctx: MatchContext, afterToken: boolean): number | null {
  const tok = ctx.tokens[pos];
  if (tok === undefined) return note(ctx, pos, spec, "missing", undefined, afterToken), null;
  if ((spec.t === "integer" || spec.t === "unix-time") && !INT.test(tok)) return note(ctx, pos, spec, "type", tok, afterToken), null;
  if (spec.t === "double" && !DOUBLE.test(tok)) return note(ctx, pos, spec, "type", tok, afterToken), null;
  return pos + 1;
}

function matchOne(spec: RedisArgDef, pos: number, ctx: MatchContext): number | null {
  let at = pos;
  if (spec.k) {
    if (ctx.tokens[at]?.toUpperCase() !== spec.k.toUpperCase()) return note(ctx, at, spec, "missing"), null;
    ctx.keywordAt.add(at);
    at += 1;
    if (spec.t === "pure-token") return at;
  }
  switch (spec.t) {
    case "pure-token":
      return note(ctx, at, spec, "missing"), null;
    case "oneof": {
      for (const alt of spec.a ?? []) {
        const saved = new Set(ctx.keywordAt);
        const next = matchOne(alt, at, ctx);
        if (next !== null) return next;
        ctx.keywordAt = saved;
      }
      return null;
    }
    case "block":
      return matchSeq(spec.a ?? [], at, ctx);
    default:
      return matchValue(spec, at, ctx, !!spec.k);
  }
}

/** Keywords that introduce any of the specs (looking inside oneof/block), upper-cased. */
function leadKeywords(specs: RedisArgDef[]): Set<string> {
  const out = new Set<string>();
  const walk = (list: RedisArgDef[]) => {
    for (const spec of list) {
      if (spec.k) out.add(spec.k.toUpperCase());
      else if (spec.t === "oneof" && spec.a) walk(spec.a);
    }
  };
  walk(specs);
  return out;
}

/** Greedily consumes as many repetitions of `spec` as match; returns every end position reached (shortest first). */
function repetitions(spec: RedisArgDef, pos: number, ctx: MatchContext, stop: Set<string>, first: number): number[] {
  const ends = [first];
  let at = first;
  for (;;) {
    const token = ctx.tokens[at];
    if (token === undefined || (!spec.k && stop.has(token.toUpperCase()))) break;
    const next = matchOne(spec, at, ctx);
    if (next === null || next === at) break;
    ends.push(next);
    at = next;
  }
  return ends;
}

/**
 * Matches `specs` from `pos`. Optional arguments may appear in any order (Redis parses options in a loop, e.g.
 * `SET k v EX 10 NX`), so they are collected and probed before each required argument and at the end. Repeated
 * arguments backtrack so grammars such as `BLPOP key [key ...] timeout` work.
 */
function matchSeq(specs: RedisArgDef[], pos: number, ctx: MatchContext): number | null {
  const run = (index: number, at: number, pending: RedisArgDef[]): number | null => {
    // probe pending optionals in any order until none matches
    let cursor = at;
    let left = pending;
    ctx.quiet += 1;
    for (let progressed = true; progressed; ) {
      progressed = false;
      for (let i = 0; i < left.length; i++) {
        const spec = left[i];
        const first = matchOne(spec, cursor, ctx);
        if (first === null || first === cursor) continue;
        let end = first;
        if (spec.m) {
          const ends = repetitions(spec, cursor, ctx, leadKeywords(left.filter((x) => x !== spec)), first);
          end = ends[ends.length - 1];
        }
        cursor = end;
        left = spec.m ? left : left.filter((_, j) => j !== i);
        progressed = true;
        break;
      }
    }
    ctx.quiet -= 1;
    if (index >= specs.length) return cursor;
    const spec = specs[index];
    if (spec.o) return run(index + 1, cursor, [...left, spec]);
    const first = matchOne(spec, cursor, ctx);
    if (first === null) return null;
    if (!spec.m) return run(index + 1, first, left);
    const ends = repetitions(spec, cursor, ctx, leadKeywords([...specs.slice(index + 1), ...left]), first);
    for (let i = ends.length - 1; i >= 0; i--) {
      const result = run(index + 1, ends[i], left);
      if (result !== null && (i === ends.length - 1 || result > ends[i])) return result;
    }
    return null;
  };
  return run(0, pos, []);
}

export interface MatchResult {
  ok: boolean;
  /** index of the first token that is not understood (when ok is false because of leftovers) */
  stoppedAt: number;
  failure?: Failure;
  keywordAt: Set<number>;
}

/** Matches `args` (after the command words) against the command's argument tree. */
export function matchArgs(def: RedisCommandDef, args: string[]): MatchResult {
  const ctx: MatchContext = { tokens: args, keywordAt: new Set(), quiet: 0 };
  const end = matchSeq(def.args, 0, ctx);
  if (end === null) return { ok: false, stoppedAt: ctx.failure?.pos ?? 0, failure: ctx.failure, keywordAt: ctx.keywordAt };
  if (end < args.length) return { ok: false, stoppedAt: end, failure: ctx.failure, keywordAt: ctx.keywordAt };
  return { ok: true, stoppedAt: end, keywordAt: ctx.keywordAt };
}

/** Every literal keyword used anywhere in the command's grammar (for did-you-mean on option spelling). */
export function keywordsOf(def: RedisCommandDef): string[] {
  const out = new Set<string>();
  const walk = (args: RedisArgDef[]) => {
    for (const arg of args) {
      if (arg.k) out.add(arg.k);
      if (arg.a) walk(arg.a);
    }
  };
  walk(def.args);
  return [...out];
}

export function describeSpec(spec: RedisArgDef): string {
  if (spec.t === "oneof") return `one of ${(spec.a ?? []).map((a) => a.k ?? a.n).join(" | ")}`;
  return `${spec.k ? `${spec.k} ` : ""}${spec.n}${spec.t === "integer" || spec.t === "unix-time" ? " (integer)" : spec.t === "double" ? " (number)" : ""}`;
}

/** Closest keyword by edit distance, or undefined. */
export function nearestKeyword(token: string, keywords: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const keyword of keywords) {
    const distance = levenshtein(token.toUpperCase(), keyword.toUpperCase());
    if (distance < bestDistance) {
      best = keyword;
      bestDistance = distance;
    }
  }
  return best !== undefined && bestDistance <= Math.max(1, Math.floor(token.length / 3)) ? best : undefined;
}

/* ----------------------------------------------------------------- redis-cli */

/**
 * Port of Redis' sdssplitargs (https://github.com/redis/redis/blob/unstable/src/sds.c): how redis-cli splits a line.
 * Double quotes understand \\ \" \n \r \t \b \a \xHH; single quotes only \'. Returns null for unbalanced quotes.
 */
export function splitCommandLine(line: string): string[] | null {
  const out: string[] = [];
  let i = 0;
  const hex = (c: string) => /[0-9a-fA-F]/.test(c);
  for (;;) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) return out;
    let current = "";
    let inDq = false;
    let inSq = false;
    for (;;) {
      const c = line[i];
      if (inDq) {
        if (c === undefined) return null;
        if (c === "\\" && line[i + 1] === "x" && hex(line[i + 2] ?? "") && hex(line[i + 3] ?? "")) {
          current += String.fromCharCode(parseInt(line.slice(i + 2, i + 4), 16));
          i += 3;
        } else if (c === "\\" && i + 1 < line.length) {
          i += 1;
          const e = line[i];
          current += e === "n" ? "\n" : e === "r" ? "\r" : e === "t" ? "\t" : e === "b" ? "\b" : e === "a" ? "\x07" : e;
        } else if (c === '"') {
          if (i + 1 < line.length && !/\s/.test(line[i + 1])) return null;
          i += 1;
          break;
        } else current += c;
      } else if (inSq) {
        if (c === undefined) return null;
        if (c === "\\" && line[i + 1] === "'") {
          i += 1;
          current += "'";
        } else if (c === "'") {
          if (i + 1 < line.length && !/\s/.test(line[i + 1])) return null;
          i += 1;
          break;
        } else current += c;
      } else {
        if (c === undefined || /\s/.test(c)) break;
        if (c === '"') inDq = true;
        else if (c === "'") inSq = true;
        else current += c;
      }
      i += 1;
    }
    out.push(current);
  }
}

/* -------------------------------------------------------------------- pitfalls */

export interface Pitfall {
  severity: "warning" | "info";
  message: string;
  fix?: string;
}

/** Hand-written advice (the table has complexity, not judgement). Sources: command pages on https://redis.io/docs/latest/commands/ . */
export const PITFALLS: Record<string, Pitfall> = {
  KEYS: { severity: "warning", message: "KEYS walks every key in the database and blocks the server while it runs (O(N)).", fix: "Use SCAN with MATCH and COUNT in production." },
  FLUSHALL: { severity: "warning", message: "FLUSHALL deletes every key in EVERY database.", fix: "Use FLUSHDB for one database, or add ASYNC to avoid blocking." },
  FLUSHDB: { severity: "warning", message: "FLUSHDB deletes every key in the current database.", fix: "Add ASYNC to avoid blocking the server." },
  SMEMBERS: { severity: "warning", message: "SMEMBERS returns the whole set at once (O(N)) and can block on large sets.", fix: "Use SSCAN to page through big sets." },
  HGETALL: { severity: "info", message: "HGETALL returns every field of the hash (O(N)).", fix: "Use HSCAN for very large hashes, or HMGET for specific fields." },
  HKEYS: { severity: "info", message: "HKEYS returns every field name (O(N)); use HSCAN for big hashes." },
  HVALS: { severity: "info", message: "HVALS returns every value (O(N)); use HSCAN for big hashes." },
  LRANGE: { severity: "info", message: "LRANGE with a huge range (e.g. 0 -1) returns the whole list (O(S+N)).", fix: "Fetch pages with small start/stop windows." },
  DEL: { severity: "info", message: "DEL on a large collection frees memory synchronously and can block.", fix: "Use UNLINK to free it in the background." },
  SORT: { severity: "warning", message: "SORT is O(N+M*log(M)) and blocks the server; BY/GET patterns add extra lookups.", fix: "Keep sorted data in a sorted set instead." },
  MONITOR: { severity: "warning", message: "MONITOR streams every command the server executes and slows it down; use it only briefly while debugging." },
  DEBUG: { severity: "warning", message: "DEBUG is for Redis developers and some sub-commands crash or freeze the server." },
  SAVE: { severity: "warning", message: "SAVE blocks the server while it writes the RDB snapshot.", fix: "Use BGSAVE." },
  SHUTDOWN: { severity: "warning", message: "SHUTDOWN stops the Redis server." },
  "CONFIG SET": { severity: "warning", message: "CONFIG SET changes the running server's configuration; it is lost on restart unless you CONFIG REWRITE." },
  REPLICAOF: { severity: "warning", message: "REPLICAOF changes this server into a replica and discards its dataset when it syncs." },
  SLAVEOF: { severity: "warning", message: "SLAVEOF is deprecated and changes this server into a replica." },
  EVAL: { severity: "info", message: "A Lua script blocks the server for its whole run: keep it short. List every key in KEYS (numkeys), do not build key names inside the script." },
  EVALSHA: { severity: "info", message: "EVALSHA needs the script to be loaded already (SCRIPT LOAD); otherwise it fails with NOSCRIPT." },
  BLPOP: { severity: "info", message: "Blocking command: the connection waits until data arrives or the timeout (0 = forever) passes.", fix: "Use a dedicated connection, and never inside MULTI/pipelines." },
  BRPOP: { severity: "info", message: "Blocking command: the connection waits until data arrives or the timeout (0 = forever) passes.", fix: "Use a dedicated connection, and never inside MULTI/pipelines." },
  BLMOVE: { severity: "info", message: "Blocking command: it waits until a source element exists or the timeout passes.", fix: "Use a dedicated connection." },
  BRPOPLPUSH: { severity: "warning", message: "BRPOPLPUSH is deprecated and blocks the connection.", fix: "Use BLMOVE." },
  BZPOPMIN: { severity: "info", message: "Blocking command: it waits until a member exists or the timeout passes.", fix: "Use a dedicated connection." },
  BZPOPMAX: { severity: "info", message: "Blocking command: it waits until a member exists or the timeout passes.", fix: "Use a dedicated connection." },
  XREAD: { severity: "info", message: "XREAD with BLOCK waits for new entries and ties up the connection (BLOCK 0 = forever).", fix: "Use a dedicated connection for blocking reads." },
  XREADGROUP: { severity: "info", message: "XREADGROUP with BLOCK waits for new entries and ties up the connection.", fix: "Use a dedicated connection; XACK every processed entry." },
  SUBSCRIBE: { severity: "warning", message: "After SUBSCRIBE the connection only receives messages (plus a few control commands).", fix: "Use a separate connection for subscribing and put it in its own spec." },
  PSUBSCRIBE: { severity: "warning", message: "After PSUBSCRIBE the connection only receives messages.", fix: "Use a separate connection and its own spec." },
  PUBLISH: { severity: "info", message: "Pub/Sub is fire-and-forget: subscribers that are offline miss the message and nothing is persisted.", fix: "Use Streams (XADD/XREADGROUP) when messages must not be lost." },
  SET: { severity: "info", message: "SET overwrites any existing value and clears its TTL (unless KEEPTTL).", fix: "Add NX to only create, XX to only update." },
  SETNX: { severity: "warning", message: "SETNX is deprecated.", fix: "Use SET key value NX (add EX for a lock timeout)." },
  GETSET: { severity: "warning", message: "GETSET is deprecated.", fix: "Use SET key value GET." },
  SETEX: { severity: "info", message: "SETEX is deprecated in favour of SET key value EX seconds." },
  RENAME: { severity: "info", message: "RENAME overwrites the destination key if it exists.", fix: "Use RENAMENX to avoid overwriting." },
  SELECT: { severity: "info", message: "SELECT is not available on Redis Cluster (only database 0 exists) and does not change other connections." },
  INCR: { severity: "info", message: "INCR fails if the value is not an integer string, and it keeps any existing TTL." },
  EXPIRE: { severity: "info", message: "A later SET on the same key removes the TTL (unless KEEPTTL).", fix: "Set the TTL in the same SET (EX seconds)." },
  WATCH: { severity: "info", message: "WATCH only has an effect on the transaction that follows on the same connection (optimistic locking).", fix: "Use the client library's transaction helper that retries on conflict." },
  MULTI: { severity: "warning", message: "Do not write MULTI/EXEC by hand in a client library: it needs one connection and a transaction object.", fix: 'Set "mode": "transaction" and list only the commands.' },
  EXEC: { severity: "warning", message: "Do not write MULTI/EXEC by hand in a client library.", fix: 'Set "mode": "transaction" and list only the commands.' },
  DISCARD: { severity: "warning", message: "DISCARD only makes sense inside a hand-written MULTI block.", fix: 'Use "mode": "transaction".' },
  SCAN: { severity: "info", message: "SCAN returns a cursor: repeat with the returned cursor until it is 0. It may return duplicates.", fix: "Use scan_iter / scanIterator in client libraries." },
  SSCAN: { severity: "info", message: "SSCAN returns a cursor: repeat until it is 0; elements may repeat." },
  HSCAN: { severity: "info", message: "HSCAN returns a cursor: repeat until it is 0; fields may repeat." },
  ZSCAN: { severity: "info", message: "ZSCAN returns a cursor: repeat until it is 0; members may repeat." },
  "CLIENT KILL": { severity: "warning", message: "CLIENT KILL disconnects other clients." },
  "ACL SETUSER": { severity: "warning", message: "ACL SETUSER changes who can run which commands; a mistake can lock clients out." },
  "ACL DELUSER": { severity: "warning", message: "ACL DELUSER removes users and disconnects them." },
  FAILOVER: { severity: "warning", message: "FAILOVER switches this master to a replica." },
  CONFIG: { severity: "info", message: "CONFIG needs a sub-command such as GET or SET." },
};

/** True when the documented complexity grows with data size (anything other than O(1) or O(log(N))). */
export function isLinearComplexity(complexity: string): boolean {
  const c = complexity.trim();
  return c.startsWith("O(") && !/^O\(1\)\.?$/.test(c) && !/^O\(log\(N\)\)\.?$/.test(c);
}
