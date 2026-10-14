/**
 * Instant (in-browser, dialect-free) SQL formatter: keyword line breaks, casing and comma layout. It is a tokenizer, not a parser:
 * the server-side formatter is the dialect-aware one. Pure, unit-tested.
 */
const BREAKS = new Set(["SELECT", "FROM", "WHERE", "HAVING", "LIMIT", "OFFSET", "UNION", "RETURNING", "VALUES", "SET", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "FULL", "CROSS", "NATURAL", "ON", "GROUP", "ORDER"]);
const JOIN_MODIFIERS = new Set(["LEFT", "RIGHT", "INNER", "OUTER", "FULL", "CROSS", "NATURAL"]);
/** Keywords that are only re-cased (never moved to their own line). */
const CASE_ONLY = new Set(["BY", "AS", "AND", "OR", "NOT", "IN", "IS", "NULL", "LIKE", "ILIKE", "BETWEEN", "EXISTS", "DISTINCT", "ASC", "DESC", "INTO", "INSERT", "UPDATE", "DELETE", "ALL", "CASE", "WHEN", "THEN", "ELSE", "END", "USING", "WITH", "DEFAULT"]);
export function formatSql(sql: string, upper: boolean): string {
  const tokens = sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\/|\b\w+\b|\s+|./g) ?? [];
  const significant = tokens.filter((t) => !/^\s+$/.test(t));
  const out: string[] = []; let pendingSpace = false; let depth = 0; let sigIndex = -1; let prevWord = "";
  const cased = (token: string) => (upper ? token.toUpperCase() : token.toLowerCase());
  for (const token of tokens) {
    if (/^\s+$/.test(token)) { pendingSpace = true; continue; }
    sigIndex += 1;
    const word = token.toUpperCase();
    const isFunctionCall = (word === "LEFT" || word === "RIGHT") && significant[sigIndex + 1] === "(";
    if (BREAKS.has(word) && !isFunctionCall) {
      const joinContinuation = (word === "JOIN" || JOIN_MODIFIERS.has(word)) && JOIN_MODIFIERS.has(prevWord);
      if (!joinContinuation && out.length && !out.join("").endsWith("\n")) out.push("\n");
      if (joinContinuation) out.push(" ");
      out.push(cased(token)); pendingSpace = true; prevWord = word; continue;
    }
    prevWord = word;
    if (token === "(") depth += 1;
    if (token === ")") depth = Math.max(0, depth - 1);
    if (token === ",") { out.push(depth > 0 ? ", " : ",\n  "); pendingSpace = false; continue; }
    if (token === ";") { out.push(";\n\n"); pendingSpace = false; continue; }
    const text = CASE_ONLY.has(word) || isFunctionCall ? cased(token) : token;
    if (pendingSpace && out.length && !/[\s]$/.test(out.at(-1) ?? "") && token !== ")" && token !== ".") out.push(" ");
    out.push(text); pendingSpace = false;
    // A `--` comment runs to the end of its line: whatever follows must start on a new one, or it would end up inside the comment.
    if (token.startsWith("--")) out.push("\n");
  }
  return out.join("").trim().replace(/[ \t]+\n/g, "\n");
}
