"use client";
import { useState } from "react";
import { Button, Field, Notice, Panel, Stat, StatGrid, TextArea } from "@/components/ui";
import { auditLinks } from "@/lib/html-audit";
export default function LinkTextAudit() {
  const [source, setSource] = useState(`<main><a href="/docs">Read more</a><a href="/about"><img src="about.png" alt="About the team"></a><a href="/empty"></a></main>`), [links, setLinks] = useState<{ index: number; href: string; name: string; issue: string }[]>([]), [error, setError] = useState("");
  const audit = () => { try { setLinks(auditLinks(source)); setError(""); } catch { setError("Could not parse this HTML fragment."); } };
  return <Panel title="Accessible link-text finder"><div className="space-y-3"><Field label="HTML fragment (not executed)"><TextArea rows={10} value={source} onChange={(e) => setSource(e.target.value)} /></Field><Button variant="primary" onClick={audit}>Find link issues</Button>{error && <Notice tone="error">{error}</Notice>}{links.length > 0 && <><StatGrid><Stat label="Links" value={links.length} /><Stat label="Potential issues" value={links.filter((link) => link.issue).length} /></StatGrid><div className="space-y-2">{links.map((link) => <div key={link.index} className="rounded-lg border border-line p-3"><div className="font-mono text-xs text-faint">{link.href}</div><div className="text-sm">{link.name}</div>{link.issue && <div className="mt-1 text-xs text-danger">{link.issue}</div>}</div>)}</div></> }<p className="text-xs text-faint">Flags empty and generic labels; considers aria labels, referenced labels, visible text, and image alt text. Review context to decide whether link purpose is clear.</p></div></Panel>;
}
