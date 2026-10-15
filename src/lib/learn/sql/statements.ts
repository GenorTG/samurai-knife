/**
 * Learner SQL, before it reaches the database: split into statements (Postgres lexical rules: '' strings, E'' escapes,
 * $tag$ dollar quotes, "identifiers", -- and nested block comments) and decide per statement whether the course runner
 * accepts it. Pure, no I/O (tests/learn_sql.test.mjs).
 *
 * This is the friendly first line, not the security boundary: the learner role's privileges are (docs/LEARN.md). Its job
 * is to keep every run inside the ONE transaction the runner opens and always rolls back, so a COMMIT can never make a
 * change stick, and to explain why a statement is refused.
 */

export interface SqlStatement {
  /** Statement text without the trailing semicolon (comments kept). */
  text: string;
  /** Offset of `text` in the original input (for error positions). */
  start: number;
  /** Upper-case words outside strings, comments and quoted identifiers, in order. */
  words: string[];
}

export type StatementKind = "read" | "write" | "ddl" | "tx" | "explain" | "set";

export type StatementVerdict =
  | { ok: true; kind: StatementKind; /** A plain query whose rows can be fetched through a cursor (row cap). */ cursor: boolean }
  | { ok: false; reason: string };

/** Splits on top-level semicolons; empty statements (only whitespace/comments) are dropped. */
export function splitStatements(sql: string): SqlStatement[] {
  const out: SqlStatement[] = [];
  let start = 0;
  let words: string[] = [];
  let i = 0;
  const n = sql.length;
  const push = (end: number) => {
    const raw = sql.slice(start, end);
    if (words.length > 0) {
      const lead = raw.length - raw.trimStart().length;
      out.push({ text: raw.trim(), start: start + lead, words });
    }
    words = [];
  };
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          i += 2;
        } else i += 1;
      }
      continue;
    }
    if (c === "'") {
      // E'...' (escape string): the E was read as a word just before; backslashes escape there.
      const escape = /[eE]$/.test(sql.slice(Math.max(0, i - 1), i)) && !/[A-Za-z0-9_]/.test(sql[i - 2] ?? " ");
      if (escape && words.length && words[words.length - 1] === "E") words.pop();
      i += 1;
      while (i < n) {
        if (escape && sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          break;
        }
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === '"') {
      i += 1;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          break;
        }
        i += 1;
      }
      i += 1;
      // A quoted identifier still counts as "something" in the statement.
      words.push('"');
      continue;
    }
    if (c === "$") {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? " ")) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        i = close < 0 ? n : close + tag[0].length;
        words.push("$");
        continue;
      }
    }
    if (c === ";") {
      push(i);
      start = i + 1;
      i += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j])) j += 1;
      words.push(sql.slice(i, j).toUpperCase());
      i = j;
      continue;
    }
    if (!/\s/.test(c)) words.push(c);
    i += 1;
  }
  push(n);
  return out;
}

const TX_HINT = "Every run here is already one transaction that is rolled back at the end, so nothing you change is kept. Practise with SAVEPOINT name / ROLLBACK TO SAVEPOINT name instead.";

const REFUSED: Record<string, string> = {
  BEGIN: TX_HINT,
  START: TX_HINT,
  COMMIT: TX_HINT,
  END: TX_HINT,
  ABORT: TX_HINT,
  PREPARE: "PREPARE / PREPARE TRANSACTION are not available in the course runner.",
  EXECUTE: "EXECUTE (prepared statements) is not available in the course runner.",
  DEALLOCATE: "DEALLOCATE is not available in the course runner.",
  COPY: "COPY reads or writes files; use SELECT / INSERT instead.",
  DO: "Anonymous code blocks (DO) are not part of the course.",
  CALL: "Procedures (CALL) are not part of the course.",
  GRANT: "Privileges are fixed for the course role.",
  REVOKE: "Privileges are fixed for the course role.",
  ALTER: "ALTER changes the course tables, which are read-only here. Create a TEMP table copy to experiment.",
  TRUNCATE: "TRUNCATE is not allowed; DELETE inside the run (rolled back) shows the same idea.",
  VACUUM: "VACUUM cannot run inside a transaction.",
  CLUSTER: "CLUSTER is not part of the course.",
  REINDEX: "REINDEX is not part of the course.",
  LOCK: "Explicit table locks are not part of the course.",
  LISTEN: "LISTEN/NOTIFY are not part of the course.",
  NOTIFY: "LISTEN/NOTIFY are not part of the course.",
  UNLISTEN: "LISTEN/NOTIFY are not part of the course.",
  DISCARD: "DISCARD is not available in the course runner.",
  RESET: "RESET is not available; SET LOCAL settings end with the run anyway.",
  LOAD: "LOAD is not available.",
  SECURITY: "Not available in the course runner.",
  REFRESH: "Materialized views are not part of the course data.",
  COMMENT: "COMMENT changes the course tables, which are read-only here.",
  IMPORT: "Not available in the course runner.",
  CHECKPOINT: "Not available in the course runner.",
  REASSIGN: "Not available in the course runner.",
  SECURITY_LABEL: "Not available in the course runner.",
};

/** Is this statement accepted, and how is it run? */
export function classifyStatement(statement: SqlStatement): StatementVerdict {
  const [first = "", second = "", third = ""] = statement.words;
  if (first === "ROLLBACK") {
    if (second === "TO") return { ok: true, kind: "tx", cursor: false };
    return { ok: false, reason: TX_HINT };
  }
  if (first === "SAVEPOINT" || first === "RELEASE") return { ok: true, kind: "tx", cursor: false };
  if (first === "SET") {
    if (second === "LOCAL") return { ok: true, kind: "set", cursor: false };
    if (second === "TRANSACTION" || second === "SESSION") return { ok: false, reason: "Use SET LOCAL name = value: it lasts until the end of this run." };
    return { ok: false, reason: "Use SET LOCAL name = value (for example SET LOCAL enable_seqscan = off): it lasts until the end of this run." };
  }
  if (first in REFUSED) return { ok: false, reason: `${first} is not allowed here. ${REFUSED[first]}` };
  switch (first) {
    case "SELECT":
    case "VALUES":
    case "TABLE":
      // SELECT ... INTO creates a table (not allowed in a cursor); run it directly so Postgres explains.
      return { ok: true, kind: "read", cursor: !statement.words.includes("INTO") };
    case "WITH": {
      const writes = statement.words.some((w) => w === "INSERT" || w === "UPDATE" || w === "DELETE" || w === "MERGE");
      return { ok: true, kind: writes ? "write" : "read", cursor: !writes && !statement.words.includes("INTO") };
    }
    case "(":
      return { ok: true, kind: "read", cursor: true };
    case "SHOW":
      return { ok: true, kind: "read", cursor: false };
    case "EXPLAIN":
      return { ok: true, kind: "explain", cursor: false };
    case "INSERT":
    case "UPDATE":
    case "DELETE":
    case "MERGE":
      return { ok: true, kind: "write", cursor: false };
    case "ANALYZE":
      return { ok: true, kind: "ddl", cursor: false };
    case "CREATE": {
      const temp = second === "TEMP" || second === "TEMPORARY" || ((second === "LOCAL" || second === "GLOBAL") && (third === "TEMP" || third === "TEMPORARY"));
      if (temp || second === "INDEX" || (second === "UNIQUE" && third === "INDEX")) return { ok: true, kind: "ddl", cursor: false };
      return { ok: false, reason: "Only CREATE TEMP TABLE and CREATE INDEX are available here (the course schemas are read-only; a TEMP table is your scratch area for this run)." };
    }
    case "DROP":
      if (second === "TABLE" || second === "INDEX") return { ok: true, kind: "ddl", cursor: false };
      return { ok: false, reason: "Only DROP TABLE / DROP INDEX on your own TEMP objects are available here." };
    default:
      return { ok: false, reason: `${first || "This statement"} is not something the course runner accepts. Start with SELECT, WITH, EXPLAIN, INSERT, UPDATE or DELETE.` };
  }
}

/** Text with comments and string/identifier contents blanked out (same length), for `mustUse` checks. */
export function codeOnly(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  const blank = (from: number, to: number) => {
    out += sql.slice(from, to).replace(/[^\n]/g, " ");
  };
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    const from = i;
    if (c === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i += 1;
      blank(from, i);
      continue;
    }
    if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          i += 2;
        } else i += 1;
      }
      blank(from, i);
      continue;
    }
    if (c === "'") {
      i += 1;
      while (i < n && !(sql[i] === "'" && sql[i + 1] !== "'")) i += sql[i] === "'" ? 2 : 1;
      i += 1;
      out += "'";
      blank(from + 1, Math.min(i, n) - 1);
      if (i <= n) out += "'";
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** 1-based line and column of a 1-based character position (Postgres error `position`). */
export function lineColumn(sql: string, position: number): { line: number; column: number } {
  const before = sql.slice(0, Math.max(0, position - 1));
  const lines = before.split("\n");
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}
