"use client";
import { useState, type ChangeEvent } from "react";
import { Field, Notice, Panel } from "@/components/ui";
const LIMIT = 1024 * 1024;
function render(bytes: Uint8Array): string { const lines: string[] = []; for (let offset = 0; offset < bytes.length; offset += 16) { const chunk = bytes.slice(offset, offset + 16); const hex = [...chunk].map((b) => b.toString(16).padStart(2, "0")).join(" ").padEnd(47, " "); const ascii = [...chunk].map((b) => b >= 32 && b <= 126 ? String.fromCharCode(b) : ".").join(""); lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex}  |${ascii}|`); } return lines.join("\n"); }
export default function HexViewer() {
  const [name, setName] = useState("No file selected"), [output, setOutput] = useState("Choose a local file up to 1 MiB to inspect its bytes."), [error, setError] = useState("");
  const onFile = async (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (!file) return; setName(file.name); if (file.size > LIMIT) { setOutput(""); setError("File exceeds the 1 MiB inspection limit."); return; } try { setOutput(render(new Uint8Array(await file.arrayBuffer()))); setError(""); } catch { setError("Could not read that file."); } };
  return <Panel title="Binary and hex viewer"><div className="space-y-3"><Field label="Local file (never uploaded)"><input type="file" className="sk-input w-full px-3 py-2 text-sm" onChange={onFile} /></Field><p className="text-xs text-faint">{name}</p>{error && <Notice tone="error">{error}</Notice>}<pre className="max-h-[32rem] overflow-auto rounded-lg border border-line bg-raised p-3 font-mono text-xs leading-relaxed">{output}</pre><p className="text-xs text-faint">Displays the first at most 1 MiB with byte offsets and printable ASCII.</p></div></Panel>;
}
