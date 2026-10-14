"use client";

import { useMemo, useState } from "react";
import { CopyButton, Field, Notice, Panel, TextArea } from "@/components/ui";

const DIRECTIVES = ["default-src", "script-src", "style-src", "img-src", "font-src", "connect-src", "media-src", "object-src", "frame-src", "frame-ancestors", "base-uri", "form-action"];
const VALUELESS = ["sandbox", "upgrade-insecure-requests", "block-all-mixed-content"];
const STARTER = `default-src 'self'\nscript-src 'self'\nstyle-src 'self'\nimg-src 'self' data:\nobject-src 'none'\nbase-uri 'self'\nframe-ancestors 'none'`;
export default function CspBuilder() {
  const [text, setText] = useState(STARTER);
  const [reportOnly, setReportOnly] = useState(false);
  const result = useMemo(() => {
    const seen = new Set<string>();
    const errors: string[] = [];
    const lines = text.split(/\r?\n/).map((line, index) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return "";
      const [rawName, ...tokens] = trimmed.split(/\s+/);
      const name = rawName.toLowerCase(); // directive names are case-insensitive
      if (!/^[a-z][a-z0-9-]*$/.test(name)) errors.push(`Line ${index + 1}: invalid directive name.`);
      if (tokens.some((token) => /[;,]/.test(token))) errors.push(`Line ${index + 1}: ${name} contains ";" or ","; put each directive on its own line.`);
      const bare = tokens.filter((token) => /^(self|none|unsafe-inline|unsafe-eval|strict-dynamic|unsafe-hashes|report-sample|wasm-unsafe-eval)$/i.test(token));
      if (bare.length) errors.push(`Line ${index + 1}: ${bare.join(", ")} must be quoted, e.g. '${bare[0].toLowerCase()}'.`);
      if (seen.has(name)) errors.push(`Line ${index + 1}: duplicate ${name} directive.`);
      seen.add(name);
      if (!DIRECTIVES.includes(name) && !/^[a-z][a-z0-9-]*$/.test(name)) return "";
      if (!tokens.length && !VALUELESS.includes(name)) errors.push(`Line ${index + 1}: ${name} has no source values.`);
      return [name, ...tokens].join(" ");
    }).filter(Boolean);
    return { errors, policy: lines.join("; ") };
  }, [text]);
  // Copy is disabled while there are errors: copying only the valid directives would silently ship a weaker policy than the one typed, and copying everything ships a broken one.
  const headerName = reportOnly ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy";
  return <Panel title="Content Security Policy builder" right={<CopyButton text={`${headerName}: ${result.policy}`} label="Copy header" disabled={result.errors.length > 0} />}>
    <div className="space-y-3"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={reportOnly} onChange={(e) => setReportOnly(e.target.checked)} /> Generate report-only header</label>
      <Field label="One directive per line" hint="Example: img-src 'self' data: https://images.example"><TextArea rows={13} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} /></Field>
      {result.errors.length ? <Notice tone="error"><span className="block whitespace-pre-wrap">{result.errors.join("\n")}</span><span className="mt-1 block">Copy header is disabled until these are fixed.</span></Notice> : <Notice tone="good">Policy syntax is assembled. Source policy still needs review against your application.</Notice>}
      <Field label={headerName}><TextArea rows={3} readOnly value={`${headerName}: ${result.policy}`} /></Field>
      <p className="text-xs text-faint">This builds a header string; it does not assess whether a policy is safe or complete. Test report-only first and avoid adding broad sources such as * or unsafe-inline without understanding their effect.</p>
    </div>
  </Panel>;
}
