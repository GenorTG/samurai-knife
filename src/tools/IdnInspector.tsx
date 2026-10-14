"use client";
import { useMemo, useState } from "react";
import { CopyButton, Field, Notice, Panel, TextInput } from "@/components/ui";
function decodeLabel(label: string): string {
  if (!label.toLowerCase().startsWith("xn--")) return label;
  const input = label.slice(4), delimiter = input.lastIndexOf("-");
  const output = delimiter >= 0 ? [...input.slice(0, delimiter)].map((ch) => ch.codePointAt(0) ?? 0) : [];
  let n = 128, i = 0, bias = 72, cursor = delimiter >= 0 ? delimiter + 1 : 0;
  const digit = (ch: string) => { const code = ch.toLowerCase().charCodeAt(0); return code >= 97 && code <= 122 ? code - 97 : code >= 48 && code <= 57 ? code - 22 : 36; };
  const adapt = (delta0: number, points: number, first: boolean) => { let delta = first ? Math.floor(delta0 / 700) : delta0 >> 1; delta += Math.floor(delta / points); let k = 0; while (delta > 455) { delta = Math.floor(delta / 35); k += 36; } return k + Math.floor(36 * delta / (delta + 38)); };
  while (cursor < input.length) { const old = i; let weight = 1; for (let k = 36;; k += 36) { if (cursor >= input.length) throw new Error("Invalid Punycode label."); const d = digit(input[cursor++]); if (d >= 36) throw new Error("Invalid Punycode digit."); i += d * weight; const threshold = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias; if (d < threshold) break; weight *= 36 - threshold; }
    const points = output.length + 1; bias = adapt(i - old, points, old === 0); n += Math.floor(i / points); i %= points; output.splice(i, 0, n); i += 1;
  }
  return String.fromCodePoint(...output);
}
export default function IdnInspector() {
  const [input, setInput] = useState("münich.example");
  const result = useMemo(() => { try { const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input.trim()) ? input : `http://${input}`); const ascii = parsed.hostname.toLowerCase(); if (/[%\s]/.test(ascii)) throw new Error("Invalid hostname character."); const unicode = ascii.split(".").map(decodeLabel).join("."); return { ascii, unicode, error: "" }; } catch (e) { return { ascii: "", unicode: "", error: e instanceof Error ? e.message : "Invalid hostname." }; } }, [input]);
  return <Panel title="Punycode and IDN inspector" right={<CopyButton text={result.ascii} label="Copy ASCII hostname" />}><div className="space-y-3"><Field label="Hostname or URL"><TextInput value={input} onChange={(e) => setInput(e.target.value)} placeholder="bücher.example" /></Field>
    {result.error ? <Notice tone="error">Enter a valid hostname or URL.</Notice> : <><Field label="ASCII / Punycode hostname"><TextInput readOnly value={result.ascii} /></Field><Field label="Unicode display form"><TextInput readOnly value={result.unicode} /></Field></>}
    <p className="text-xs text-faint">Uses browser URL hostname normalization and decodes Punycode labels. Unicode lookalikes can be visually deceptive; inspect code points and certificate/origin details before trusting a domain.</p></div></Panel>;
}
