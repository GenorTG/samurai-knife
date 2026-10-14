"use client";
import { useState } from "react";
import { Button, Field, Notice, Panel, Stat, TextArea } from "@/components/ui";
import { auditHeadings } from "@/lib/html-audit";
export default function HeadingAudit() {
  const [source, setSource] = useState("<main>\n  <h1>Page title</h1>\n  <h2>Overview</h2>\n  <h4>Details</h4>\n</main>"), [items, setItems] = useState<{ level: number; text: string }[]>([]), [issues, setIssues] = useState<string[]>([]), [error, setError] = useState("");
  const audit = () => { try { const result = auditHeadings(source); setItems(result.headings); setIssues(result.issues); setError(""); } catch { setError("Could not parse this HTML fragment."); } };
  return <Panel title="HTML heading hierarchy auditor"><div className="space-y-3"><Field label="HTML fragment (not executed)"><TextArea rows={10} value={source} onChange={(e) => setSource(e.target.value)} /></Field><Button variant="primary" onClick={audit}>Audit headings</Button>{error && <Notice tone="error">{error}</Notice>}{items.length > 0 && <><Stat label="Headings" value={items.length} /><ol className="space-y-1">{items.map((item, index) => <li key={index} className="rounded border border-line px-3 py-2 text-sm" style={{ marginLeft: `${(item.level - 1) * 12}px` }}><span className="mr-2 font-mono text-faint">H{item.level}</span>{item.text}</li>)}</ol></>}{issues.length > 0 && <Notice tone="error"><span className="block whitespace-pre-wrap">{issues.join("\n")}</span></Notice>}{!error && !issues.length && items.length > 0 && <Notice tone="good">No skipped levels or duplicate H1 headings detected.</Notice>}<p className="text-xs text-faint">Checks order, skipped levels, and multiple H1s in pasted markup. It cannot determine whether the heading text is meaningful.</p></div></Panel>;
}
