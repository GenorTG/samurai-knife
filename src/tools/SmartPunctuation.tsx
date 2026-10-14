"use client";

import { useMemo, useState } from "react";
import { Field, Panel, Select, TextArea } from "@/components/ui";

function normalize(text: string, mode: "typographic" | "plain"): string {
  if (mode === "plain") return text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, "-");
  return text.replace(/([\p{L}\p{N}])'(?=\p{L})/gu, "$1’").replace(/(^|[\s([{])"(?=\S)/g, "$1“").replace(/"(?=[\s.,!?;:)}\]]|$)/g, "”")
    .replace(/(^|[\s([{])'(?=\S)/g, "$1‘").replace(/'(?=[\s.,!?;:)}\]]|$)/g, "’")
    .replace(/(^|\s)--(?=\s|$)/g, "$1—").replace(/(?<![\d-])(\d{1,4})-(\d{1,4})(?![\d-])/g, "$1–$2");
}
export default function SmartPunctuation() {
  const [text, setText] = useState('"Hello," she said. It\'s a well-known example -- with quotes.');
  const [mode, setMode] = useState<"typographic" | "plain">("typographic");
  const output = useMemo(() => normalize(text, mode), [mode, text]);
  return <Panel title="Smart punctuation normalizer">
    <div className="space-y-3"><Field label="Transform"><Select className="max-w-64" value={mode} onChange={(e) => setMode(e.target.value as "typographic" | "plain")}><option value="typographic">Straight → typographic</option><option value="plain">Typographic → straight</option></Select></Field>
      <div className="grid gap-3 lg:grid-cols-2"><Field label="Input"><TextArea rows={12} value={text} onChange={(e) => setText(e.target.value)} /></Field><Field label="Output"><TextArea rows={12} readOnly value={output} /></Field></div>
      <p className="text-xs text-faint">Typographic conversion uses nearby whitespace and punctuation to guess opening versus closing quotes. Review code, measurements, and apostrophes before use.</p>
    </div>
  </Panel>;
}
