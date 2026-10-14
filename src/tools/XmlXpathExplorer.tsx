"use client";
import { useState } from "react";
import { Button, CopyButton, Field, Notice, Panel, Select, TextArea } from "@/components/ui";
const SAMPLE = `<?xml version="1.0"?>\n<catalog><book id="b1"><title>Local tools</title><price>12.5</price></book></catalog>`;
function prettyXml(source: string): string {
  const xml = new DOMParser().parseFromString(source, "application/xml");
  if (xml.querySelector("parsererror")) throw new Error("XML is malformed.");
  const render = (node: Node, depth: number): string => {
    const pad = "  ".repeat(depth);
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").trim();
    if (node.nodeType === Node.COMMENT_NODE) return `${pad}<!--${node.textContent ?? ""}-->`;
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as Element;
    const attrs = [...el.attributes].map((a) => ` ${a.name}="${a.value.replace(/"/g, "&quot;")}"`).join("");
    const children = [...el.childNodes].filter((child) => child.nodeType !== Node.TEXT_NODE || child.textContent?.trim());
    if (!children.length) return `${pad}<${el.tagName}${attrs}/>`;
    if (children.length === 1 && children[0].nodeType === Node.TEXT_NODE) return `${pad}<${el.tagName}${attrs}>${children[0].textContent?.trim()}</${el.tagName}>`;
    return `${pad}<${el.tagName}${attrs}>\n${children.map((child) => render(child, depth + 1)).filter(Boolean).join("\n")}\n${pad}</${el.tagName}>`;
  };
  return [...xml.childNodes].map((node) => render(node, 0)).filter(Boolean).join("\n");
}
export default function XmlXpathExplorer() {
  const [source, setSource] = useState(SAMPLE), [query, setQuery] = useState("//book/title/text()"), [mode, setMode] = useState<"query" | "format">("query"), [output, setOutput] = useState(""), [error, setError] = useState("");
  const run = () => {
    try {
      if (mode === "format") { setOutput(prettyXml(source)); setError(""); return; }
      const xml = new DOMParser().parseFromString(source, "application/xml");
      if (xml.querySelector("parsererror")) throw new Error("XML is malformed; check tags and entities.");
      const value = xml.evaluate(query, xml, null, XPathResult.ANY_TYPE, null);
      if (value.resultType === XPathResult.STRING_TYPE) { setOutput(value.stringValue); setError(""); return; }
      if (value.resultType === XPathResult.NUMBER_TYPE) { setOutput(String(value.numberValue)); setError(""); return; }
      if (value.resultType === XPathResult.BOOLEAN_TYPE) { setOutput(String(value.booleanValue)); setError(""); return; }
      const nodes: string[] = []; let node = value.iterateNext();
      while (node && nodes.length < 500) { nodes.push(node.nodeType === Node.TEXT_NODE ? node.nodeValue ?? "" : new XMLSerializer().serializeToString(node)); node = value.iterateNext(); }
      setOutput(nodes.length ? nodes.join("\n") : "No matching nodes."); setError("");
    } catch (e) { setOutput(""); setError(e instanceof Error ? e.message : "Could not evaluate XPath."); }
  };
  return <Panel title="XML formatter & XPath explorer" right={<CopyButton text={output} label="Copy result" />}><div className="space-y-3">
    <Field label="Operation"><Select className="max-w-64" value={mode} onChange={(e) => setMode(e.target.value as "query" | "format")}><option value="query">Run XPath</option><option value="format">Pretty-format XML</option></Select></Field>
    {mode === "query" && <Field label="XPath expression"><TextArea rows={2} value={query} onChange={(e) => setQuery(e.target.value)} /></Field>}
    <Field label="XML document"><TextArea rows={12} spellCheck={false} value={source} onChange={(e) => setSource(e.target.value)} /></Field>
    <Button variant="primary" onClick={run}>{mode === "query" ? "Run XPath" : "Format XML"}</Button>
    {error ? <Notice tone="error">{error}</Notice> : output && <Field label={mode === "query" ? "XPath result" : "Formatted XML"}><TextArea rows={7} readOnly value={output} /></Field>}
    <p className="text-xs text-faint">Uses browser XML parsing and XPath 1.0. XML stays local; formatting is a readability pass for markup, not a canonicalizer.</p>
  </div></Panel>;
}
