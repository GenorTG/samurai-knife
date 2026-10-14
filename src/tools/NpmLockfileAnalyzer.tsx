"use client";
import { useMemo, useState } from "react";
import { CopyButton, Field, Notice, Panel, Stat, StatGrid, TextArea } from "@/components/ui";
const SAMPLE = JSON.stringify({ name: "example", lockfileVersion: 3, packages: { "": { name: "example" }, "node_modules/react": { version: "19.0.0" }, "node_modules/a/node_modules/react": { version: "18.3.1" }, "node_modules/typescript": { version: "5.7.2", dev: true } } }, null, 2);
export default function NpmLockfileAnalyzer() {
  const [input, setInput] = useState(SAMPLE);
  const result = useMemo(() => { try {
    const data: unknown = JSON.parse(input);
    if (!data || typeof data !== "object") throw new Error("Lockfile must be a JSON object.");
    const root = data as { lockfileVersion?: number; packages?: Record<string, { name?: string; version?: string; dev?: boolean; optional?: boolean }> };
    if (![2, 3].includes(root.lockfileVersion ?? 0) || !root.packages) throw new Error("Expected package-lock.json version 2 or 3 with a packages map.");
    const packages = Object.entries(root.packages).filter(([path]) => path !== "").map(([path, item]) => ({ path, name: item.name ?? path.split("node_modules/").at(-1) ?? path, version: item.version ?? "(no version)", dev: Boolean(item.dev), optional: Boolean(item.optional) }));
    const versions = new Map<string, Set<string>>(); packages.forEach((item) => { const set = versions.get(item.name) ?? new Set<string>(); set.add(item.version); versions.set(item.name, set); });
    const duplicated = [...versions].filter(([, values]) => values.size > 1).map(([name, values]) => `${name}: ${[...values].sort().join(", ")}`);
    return { packages, duplicated, version: root.lockfileVersion, error: "" };
  } catch (e) { return { packages: [], duplicated: [], version: 0, error: e instanceof Error ? e.message : "Invalid lockfile." }; } }, [input]);
  return <Panel title="npm lockfile analyzer" right={<CopyButton text={result.duplicated.join("\n")} label="Copy duplicate versions" />}><div className="space-y-3"><Field label="package-lock.json"><TextArea rows={13} spellCheck={false} value={input} onChange={(e) => setInput(e.target.value)} /></Field>
    {result.error ? <Notice tone="error">{result.error}</Notice> : <><StatGrid><Stat label="Lockfile version" value={result.version} /><Stat label="Installed packages" value={result.packages.length} /><Stat label="Names with multiple versions" value={result.duplicated.length} /></StatGrid><Field label="Duplicate package versions"><TextArea rows={7} readOnly value={result.duplicated.join("\n") || "No duplicate package versions."} /></Field><div className="max-h-64 overflow-auto rounded-lg border border-line"><table className="w-full text-left text-sm"><tbody>{result.packages.slice(0, 500).map((item) => <tr className="border-t border-line first:border-0" key={item.path}><td className="px-3 py-1.5 font-mono">{item.name}</td><td className="px-3 py-1.5">{item.version}</td><td className="px-3 py-1.5 text-faint">{item.dev ? "dev" : "prod"}{item.optional ? ", optional" : ""}</td></tr>)}</tbody></table></div>{result.packages.length > 500 ? <p className="text-xs text-faint">Showing the first 500 of {result.packages.length} packages.</p> : null}</>}
    <p className="text-xs text-faint">Understands npm package-lock v2/v3 package maps. Duplicate versions are observations, not automatic upgrade recommendations.</p></div></Panel>;
}
