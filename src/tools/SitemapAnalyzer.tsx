"use client";
import { useState } from "react";
import { Button, CopyButton, Field, Notice, Panel, Stat, StatGrid, TextArea } from "@/components/ui";
const SAMPLE = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/</loc><lastmod>2026-01-01</lastmod></url><url><loc>https://example.com/docs</loc></url></urlset>`;
export default function SitemapAnalyzer() {
  const [input, setInput] = useState(SAMPLE), [entries, setEntries] = useState<{ loc: string; lastmod: string; valid: boolean; dateValid: boolean }[]>([]), [root, setRoot] = useState(""), [duplicateCount, setDuplicateCount] = useState(0), [error, setError] = useState("");
  const analyze = () => { try {
    const doc = new DOMParser().parseFromString(input, "application/xml"); if (doc.querySelector("parsererror")) throw new Error("Malformed XML.");
    const root = doc.documentElement.localName; if (root !== "urlset" && root !== "sitemapindex") throw new Error("Root must be urlset or sitemapindex.");
    const entries = [...doc.getElementsByTagNameNS("*", root === "urlset" ? "url" : "sitemap")].map((entry) => {
      const get = (name: string) => [...entry.children].find((child) => child.localName === name)?.textContent?.trim() ?? "";
      const loc = get("loc"), lastmod = get("lastmod"); let valid = false; try { const u = new URL(loc); valid = /^https?:$/.test(u.protocol) && Boolean(u.hostname); } catch { /* invalid URL */ }
      return { loc, lastmod, valid, dateValid: !lastmod || (/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(lastmod) && !Number.isNaN(Date.parse(lastmod.slice(0, 10))) && new Date(`${lastmod.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === lastmod.slice(0, 10)) };
    });
    const locs = entries.map((item) => item.loc); const duplicateCount = locs.length - new Set(locs).size;
    setRoot(root); setEntries(entries); setDuplicateCount(duplicateCount); setError("");
  } catch (e) { setRoot(""); setEntries([]); setDuplicateCount(0); setError(e instanceof Error ? e.message : "Could not parse sitemap."); } };
  const output = entries.map((entry) => `${entry.loc}\t${entry.lastmod}`).join("\n");
  return <Panel title="Sitemap XML analyzer" right={<CopyButton text={output} label="Copy URLs" />}><div className="space-y-3"><Field label="Paste sitemap or sitemap index XML"><TextArea rows={9} spellCheck={false} value={input} onChange={(e) => setInput(e.target.value)} /></Field><Button variant="primary" onClick={analyze}>Analyze sitemap</Button>
    {error ? <Notice tone="error">{error}</Notice> : root && entries.length === 0 ? <Notice>Valid {root} root, but it contains no entries.</Notice> : entries.length > 0 && <><StatGrid><Stat label="Type" value={root} /><Stat label="Entries" value={entries.length} /><Stat label="Duplicate locations" value={duplicateCount} /></StatGrid>{entries.some((e) => !e.valid || !e.dateValid) && <Notice tone="error">Some locations or last-modified dates are invalid.</Notice>}<div className="max-h-64 overflow-auto rounded-lg border border-line"><table className="w-full text-left text-sm"><tbody>{entries.map((entry, i) => <tr key={i} className="border-t border-line first:border-0"><td className="px-3 py-2 font-mono break-all">{entry.loc || "(missing loc)"}</td><td className="px-3 py-2">{entry.lastmod}</td><td className="px-3 py-2">{entry.valid && entry.dateValid ? "OK" : "Review"}</td></tr>)}</tbody></table></div></>}
    <p className="text-xs text-faint">Inspects pasted XML only; it does not fetch URLs, recursively read sitemap indexes, or validate every sitemap protocol limit.</p></div></Panel>;
}
