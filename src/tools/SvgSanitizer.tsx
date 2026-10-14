"use client";
import { useState } from "react";
import { Button, CopyButton, Field, Notice, Panel, TextArea } from "@/components/ui";
import { downloadText } from "@/lib/format";
import { sanitizeSvgMarkup } from "@/lib/svg";
const SAMPLE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><script>alert(1)</script><rect width="120" height="40" fill="#7658e8"/><text x="10" y="26" fill="white">Safe preview</text></svg>`;
export default function SvgSanitizer() {
  const [source, setSource] = useState(SAMPLE), [clean, setClean] = useState(""), [error, setError] = useState("");
  const sanitize = () => { try { setClean(sanitizeSvgMarkup(source)); setError(""); } catch (e) { setError(e instanceof Error ? e.message : "Invalid SVG."); setClean(""); } };
  const preview = clean ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(clean)}` : "";
  return <Panel title="SVG sanitizer and previewer" right={<CopyButton text={clean} label="Copy cleaned SVG" />}><div className="space-y-3"><Field label="SVG markup"><TextArea rows={12} spellCheck={false} value={source} onChange={(e) => setSource(e.target.value)} /></Field><Button variant="primary" onClick={sanitize}>Sanitize and preview</Button>{error ? <Notice tone="error">{error}</Notice> : clean && <><Notice tone="good">Scripts, event handlers, external links, unsupported elements, and unsafe style references are removed.</Notice><Field label="Cleaned SVG"><TextArea rows={6} readOnly spellCheck={false} value={clean} /></Field><div role="img" aria-label="Sanitized SVG preview" className="grid min-h-40 place-items-center rounded-lg border border-line bg-raised bg-contain bg-center bg-no-repeat p-4" style={{ backgroundImage: `url("${preview}")` }} /><Button onClick={() => downloadText(clean, "sanitized.svg", "image/svg+xml")}>Download SVG</Button></>}
    <p className="text-xs text-faint">Uses an explicit element/attribute allowlist. Complex SVG features may be removed; inspect the cleaned markup and preview before use.</p></div></Panel>;
}
