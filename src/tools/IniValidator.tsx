"use client";

import { useMemo, useState } from "react";
import { CopyButton, Field, Notice, Panel, Stat, StatGrid, TextArea } from "@/components/ui";

export default function IniValidator() {
  const [input, setInput] = useState("; App settings\n[server]\nhost = localhost\nport=3210\n\n[features]\npdf = true");
  const result = useMemo(() => {
    const sections = new Set<string>([""]);
    const keys = new Set<string>();
    const errors: string[] = [];
    let section = "";
    const normalized: string[] = [];
    input.split(/\r?\n/).forEach((raw, index) => {
      const line = raw.trim();
      if (!line || line.startsWith(";") || line.startsWith("#")) { normalized.push(raw.trimEnd()); return; }
      const header = line.match(/^\[([^\]]+)\]$/);
      if (header) {
        section = header[1].trim();
        if (!section) errors.push(`Line ${index + 1}: section name cannot be empty.`);
        if (sections.has(section)) errors.push(`Line ${index + 1}: duplicate section [${section}].`);
        sections.add(section);
        normalized.push(`[${section}]`);
        return;
      }
      if (line.startsWith("[") || line.includes("]")) errors.push(`Line ${index + 1}: malformed section header.`);
      const equals = line.indexOf("=");
      if (equals < 1) { errors.push(`Line ${index + 1}: expected key = value.`); normalized.push(raw.trimEnd()); return; }
      const key = line.slice(0, equals).trim();
      const value = line.slice(equals + 1).trim();
      if (!/^[^\s=]+$/.test(key)) errors.push(`Line ${index + 1}: key must be non-empty and cannot contain spaces or =.`);
      const identity = `${section}\u0000${key}`;
      if (keys.has(identity)) errors.push(`Line ${index + 1}: duplicate key "${key}" in section [${section}].`);
      keys.add(identity);
      normalized.push(`${key} = ${value}`);
    });
    return { errors, output: normalized.join("\n"), sectionCount: sections.size - 1, keyCount: keys.size };
  }, [input]);
  return <Panel title="INI validator & formatter" right={<CopyButton text={result.output} label="Copy normalized INI" />}>
    <div className="space-y-3"><Field label="INI content"><TextArea rows={13} spellCheck={false} value={input} onChange={(e) => setInput(e.target.value)} /></Field>
      <StatGrid><Stat label="Sections" value={result.sectionCount} /><Stat label="Keys" value={result.keyCount} /><Stat label="Issues" value={result.errors.length} /></StatGrid>
      {result.errors.length ? <Notice tone="error"><span className="block whitespace-pre-wrap">{result.errors.join("\n")}</span></Notice> : <Notice tone="good">No duplicate keys or malformed entries found.</Notice>}
      <Field label="Normalized output"><TextArea rows={9} readOnly value={result.output} /></Field>
      <p className="text-xs text-faint">Validates a practical INI subset: section headers, key/value lines, blank lines, and ;/# comments. Values are preserved as text; dialect-specific escaping is not interpreted.</p>
    </div>
  </Panel>;
}
