"use client";
import { useMemo, useState } from "react";
import { Field, Notice, Panel, Select, TextArea } from "@/components/ui";
const SAMPLE = `:root {\n  --space: 8px;\n  --space-lg: calc(var(--space) * 2);\n  --brand: #7658e8;\n  --card-gap: var(--space-lg);\n}`;
function definitions(css: string): Map<string, string> { const map = new Map<string, string>(); for (const match of css.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)/g)) map.set(match[1], match[2].trim()); return map; }
function resolve(value: string, tokens: Map<string, string>, stack: string[] = []): { value: string; missing: string[]; cycles: string[] } {
  const missing = new Set<string>(), cycles = new Set<string>();
  let output = "", cursor = 0;
  const start = /var\(\s*(--[\w-]+)\s*/g;
  for (let match = start.exec(value); match; match = start.exec(value)) {
    // Find the matching close paren, so fallbacks may contain nested calls such as calc(...).
    let depth = 1, end = start.lastIndex, comma = -1;
    for (; end < value.length && depth > 0; end++) {
      const ch = value[end];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === "," && depth === 1 && comma < 0) comma = end;
    }
    if (depth > 0) continue;
    const name = match[1], fallback = comma < 0 ? undefined : value.slice(comma + 1, end - 1).trim();
    let replacement: string;
    if (stack.includes(name)) { cycles.add([...stack, name].join(" → ")); replacement = fallback || "<cycle>"; }
    else {
      const token = tokens.get(name);
      if (token === undefined) {
        if (fallback === undefined) { missing.add(name); replacement = `<missing:${name}>`; }
        else { const nested = resolve(fallback, tokens, stack); nested.missing.forEach((item) => missing.add(item)); nested.cycles.forEach((item) => cycles.add(item)); replacement = nested.value; }
      } else { const nested = resolve(token, tokens, [...stack, name]); nested.missing.forEach((item) => missing.add(item)); nested.cycles.forEach((item) => cycles.add(item)); replacement = nested.value; }
    }
    output += value.slice(cursor, match.index) + replacement;
    cursor = end; start.lastIndex = end;
  }
  return { value: output + value.slice(cursor), missing: [...missing], cycles: [...cycles] };
}
export default function CssVariableResolver() {
  const [css, setCss] = useState(SAMPLE), [name, setName] = useState("--card-gap");
  const tokens = useMemo(() => definitions(css), [css]); const active = tokens.has(name) ? name : [...tokens.keys()][0] ?? ""; const result = useMemo(() => { const value = tokens.get(active); return value === undefined ? null : resolve(value, tokens, [active]); }, [active, tokens]);
  return <Panel title="CSS custom-property resolver"><div className="space-y-3"><Field label="CSS custom-property declarations"><TextArea rows={10} spellCheck={false} value={css} onChange={(e) => setCss(e.target.value)} /></Field><Field label="Token to resolve"><Select value={active} onChange={(e) => setName(e.target.value)}>{[...tokens.keys()].map((key) => <option key={key}>{key}</option>)}</Select></Field>{result ? <><Field label="Resolved value"><TextArea rows={3} readOnly value={result.value} /></Field>{result.missing.length > 0 && <Notice tone="error">Undefined token(s): {result.missing.join(", ")}</Notice>}{result.cycles.length > 0 && <Notice tone="error">Cycle(s): {result.cycles.join("; ")}</Notice>}{!result.missing.length && !result.cycles.length && <Notice tone="good">All referenced custom properties resolved.</Notice>}</> : <Notice>Select a token declared in the CSS sample.</Notice>}<p className="text-xs text-faint">Resolves simple nested var() references with optional text fallbacks. calc() remains intact. This is a focused parser, not a full CSS cascade/inheritance engine.</p></div></Panel>;
}
