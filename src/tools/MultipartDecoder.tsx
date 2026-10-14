"use client";
import { useMemo, useState } from "react";
import { Field, Notice, Panel, Stat, TextArea, TextInput } from "@/components/ui";
import { decodeMultipart } from "@/lib/multipart";
export default function MultipartDecoder() {
  const [boundary, setBoundary] = useState("----KnifeBoundary"), [input, setInput] = useState("------KnifeBoundary\r\nContent-Disposition: form-data; name=\"title\"\r\n\r\nLocal file\r\n------KnifeBoundary\r\nContent-Type: text/plain\r\nContent-Disposition: form-data; name=\"note\"\r\n\r\nhello world\r\n------KnifeBoundary--");
  const result = useMemo(() => decodeMultipart(boundary, input), [boundary, input]);
  return <Panel title="MIME multipart decoder"><div className="space-y-3"><Field label="Boundary (without the leading --)"><TextInput value={boundary} onChange={(e) => setBoundary(e.target.value)} /></Field><Field label="Pasted multipart body"><TextArea rows={12} spellCheck={false} value={input} onChange={(e) => setInput(e.target.value)} /></Field>
    {result.error ? <Notice tone="error">{result.error}</Notice> : <><Stat label="Parts" value={result.parts.length} />{result.parts.map((part, index) => <section key={index} className="space-y-2 rounded-lg border border-line p-3"><h3 className="text-sm font-medium">Part {index + 1}</h3><Field label="Headers"><TextArea rows={3} readOnly value={part.headers} /></Field><Field label="Text body"><TextArea rows={4} readOnly value={part.body} /></Field></section>)}</>}
    <p className="text-xs text-faint">Text-only decoder for pasted multipart bodies. Binary parts can be corrupted by text encoding and are not supported.</p></div></Panel>;
}
