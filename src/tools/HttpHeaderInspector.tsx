"use client";

import { useMemo, useState } from "react";
import { Field, Notice, Panel, Stat, StatGrid, TextArea } from "@/components/ui";

const RECOMMENDED = ["strict-transport-security", "content-security-policy", "x-content-type-options", "referrer-policy"];
export default function HttpHeaderInspector() {
  const [input, setInput] = useState("HTTP/1.1 200 OK\ncontent-type: text/html; charset=utf-8\ncache-control: no-store\nx-content-type-options: nosniff\nset-cookie: session=redacted; Secure; HttpOnly; SameSite=Lax");
  const parsed = useMemo(() => {
    const lines = input.split(/\r?\n/).filter((line) => line.trim());
    const status = lines[0]?.match(/^HTTP\/\S+\s+(\d{3})\s*(.*)$/);
    const headers = new Map<string, string[]>();
    const malformed: string[] = [];
    for (const line of status ? lines.slice(1) : lines) {
      const colon = line.indexOf(":");
      if (colon < 1) { malformed.push(line); continue; }
      const key = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      headers.set(key, [...(headers.get(key) ?? []), value]);
    }
    return { status: status ? `${status[1]} ${status[2]}`.trim() : "Not supplied", headers: [...headers], malformed };
  }, [input]);
  const duplicateCount = parsed.headers.filter(([, values]) => values.length > 1).length;
  const missing = RECOMMENDED.filter((key) => !parsed.headers.some(([name]) => name === key));
  return <Panel title="HTTP response header inspector">
    <div className="space-y-3"><Field label="Paste status line and headers (or headers only)"><TextArea rows={9} spellCheck={false} value={input} onChange={(e) => setInput(e.target.value)} /></Field>
      <StatGrid><Stat label="Status" value={parsed.status} /><Stat label="Header names" value={parsed.headers.length} /><Stat label="Duplicates" value={duplicateCount} /></StatGrid>
      {missing.length ? <Notice>Not present (review whether needed): {missing.join(", ")}</Notice> : <Notice tone="good">All four commonly reviewed security headers are present.</Notice>}
      <div className="overflow-x-auto rounded-lg border border-line"><table className="w-full text-left text-sm"><tbody>{parsed.headers.map(([name, values]) => <tr key={name} className="border-t border-line first:border-0"><th className="whitespace-nowrap px-3 py-2 font-mono text-faint">{name}</th><td className="px-3 py-2 font-mono break-all">{values.join(" · ")}</td></tr>)}</tbody></table></div>
      {!!parsed.malformed.length && <Notice tone="error">Could not parse: {parsed.malformed.join("; ")}</Notice>}
      <p className="text-xs text-faint">This checks only pasted text; it does not fetch a URL or determine whether each header is appropriate for your site.</p>
    </div>
  </Panel>;
}
