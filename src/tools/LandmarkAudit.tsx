"use client";
import { useState } from "react";
import { Button, Field, Notice, Panel, Stat, TextArea } from "@/components/ui";
import { auditLandmarks } from "@/lib/html-audit";
export default function LandmarkAudit() {
  const [source, setSource] = useState("<header>Site name</header><nav aria-label=\"Primary\"></nav><main><article>Content</article></main><footer>Legal</footer>"), [counts, setCounts] = useState<{ role: string; count: number }[]>([]), [issues, setIssues] = useState<string[]>([]), [error, setError] = useState("");
  const audit = () => { try { const result = auditLandmarks(source); setCounts(result.counts); setIssues(result.issues); setError(""); } catch { setError("Could not parse this HTML fragment."); } };
  return <Panel title="Screen-reader landmark checker"><div className="space-y-3"><Field label="HTML fragment (not executed)"><TextArea rows={9} value={source} onChange={(e) => setSource(e.target.value)} /></Field><Button variant="primary" onClick={audit}>Check landmarks</Button>{error && <Notice tone="error">{error}</Notice>}{counts.length > 0 && <><div className="grid gap-2 sm:grid-cols-3">{counts.map((item) => <Stat key={item.role} label={item.role} value={item.count} />)}</div>{issues.length ? <Notice tone="error">{issues.join(" ")}</Notice> : <Notice tone="good">Exactly one main landmark found.</Notice>}</>}<p className="text-xs text-faint">Counts common semantic elements and explicit landmark roles. Nested headers/footers and page composition can affect landmark semantics; review the full document context.</p></div></Panel>;
}
