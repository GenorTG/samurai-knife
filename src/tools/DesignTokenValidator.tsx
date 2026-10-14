"use client";
import { useMemo, useState } from "react";
import { CopyButton, Field, Notice, Panel, Stat, StatGrid, TextArea } from "@/components/ui";
const SAMPLE = `:root {\n  --color-brand: #7658e8;\n  --space-md: 1rem;\n  --space-lg: var(--space-md);\n  --radius: 8px;\n}`;
export default function DesignTokenValidator() {
  const [input, setInput] = useState(SAMPLE);
  const result = useMemo(() => {
    const definitions = new Map<string, number>(), references: { name: string; line: number }[] = [], issues: string[] = [];
    // Statement-based scan: works for multi-line and compact CSS, ignores /* comments */ and selectors.
    const text = input.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
    let line = 1, statementLine = 1, statement = "";
    const flush = (terminator: string) => {
      const clean = statement.trim(); statement = "";
      if (!clean || terminator === "{") return;
      const declaration = clean.match(/^(--[\w-]+)\s*:\s*([\s\S]*)$/);
      if (declaration) { const [, name, value] = declaration; if (!value.trim()) issues.push(`Line ${statementLine}: ${name} has an empty value.`); if (definitions.has(name)) issues.push(`Line ${statementLine}: duplicate token ${name} (first on line ${definitions.get(name)}).`); else definitions.set(name, statementLine); }
      else if (clean.includes(":")) issues.push(`Line ${statementLine}: declaration is not a --custom-property token.`);
    };
    for (const ch of text) {
      if (ch === ";" || ch === "{" || ch === "}") { flush(ch); }
      else { if (!statement.trim() && ch !== "\n" && ch !== " " && ch !== "\t" && ch !== "\r") statementLine = line; statement += ch; }
      if (ch === "\n") line++;
    }
    flush(";");
    text.split(/\r?\n/).forEach((row, index) => { for (const match of row.matchAll(/var\(\s*(--[\w-]+)/g)) references.push({ name: match[1], line: index + 1 }); });
    references.forEach((ref) => { if (!definitions.has(ref.name)) issues.push(`Line ${ref.line}: reference to undefined ${ref.name}.`); });
    return { definitions, references, issues };
  }, [input]);
  const output = [...result.definitions.keys()].join("\n");
  return <Panel title="CSS design-token validator" right={<CopyButton text={output} label="Copy token names" />}><div className="space-y-3"><Field label="CSS custom-property declarations"><TextArea rows={12} spellCheck={false} value={input} onChange={(e) => setInput(e.target.value)} /></Field>
    <StatGrid><Stat label="Defined tokens" value={result.definitions.size} /><Stat label="var() references" value={result.references.length} /><Stat label="Issues" value={result.issues.length} /></StatGrid>
    {result.issues.length ? <Notice tone="error"><span className="block whitespace-pre-wrap">{result.issues.join("\n")}</span></Notice> : <Notice tone="good">No duplicate declarations or unresolved var() references found.</Notice>}
    <p className="text-xs text-faint">Checks pasted custom-property declarations, duplicates, empty values, and variable references. Not a full CSS parser; nested rules and comments should be reviewed manually.</p></div></Panel>;
}
