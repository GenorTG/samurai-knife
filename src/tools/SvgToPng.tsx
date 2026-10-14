"use client";
import { useState } from "react";
import { Button, Field, Notice, NumberField, Panel, TextArea } from "@/components/ui";
import { canvasBlob } from "@/lib/image-canvas";
import { downloadBlob } from "@/lib/format";
import { sanitizeSvgMarkup } from "@/lib/svg";
export default function SvgToPng() {
  const [source, setSource] = useState(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 60"><rect width="160" height="60" rx="12" fill="#7658e8"/><text x="16" y="38" fill="white" font-size="20">Vector</text></svg>`), [width, setWidth] = useState(640), [height, setHeight] = useState(240), [status, setStatus] = useState("");
  const exportPng = async () => { let url = ""; try { const clean = sanitizeSvgMarkup(source); url = URL.createObjectURL(new Blob([clean], { type: "image/svg+xml" })); const image = new Image(); image.src = url; await image.decode(); const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height; const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Canvas is unavailable."); ctx.drawImage(image, 0, 0, width, height); downloadBlob(await canvasBlob(canvas), "vector.png"); setStatus(`Exported ${width} × ${height} PNG from sanitized SVG.`); } catch (e) { setStatus(e instanceof Error ? e.message : "Could not render SVG."); } finally { if (url) URL.revokeObjectURL(url); } };
  return <Panel title="SVG to PNG exporter"><div className="space-y-3"><Field label="SVG markup"><TextArea rows={11} spellCheck={false} value={source} onChange={(e) => setSource(e.target.value)} /></Field><div className="grid gap-3 sm:grid-cols-2"><Field label="Output width (px)"><NumberField min={1} max={4096} integer value={width} onValueChange={setWidth} /></Field><Field label="Output height (px)"><NumberField min={1} max={4096} integer value={height} onValueChange={setHeight} /></Field></div><Button variant="primary" onClick={() => void exportPng()}>Rasterize and download</Button>{status && <Notice>{status}</Notice>}<p className="text-xs text-faint">Sanitizes to the supported SVG allowlist before rasterizing. Unsupported SVG features are stripped; output is limited to 4096 × 4096 pixels.</p></div></Panel>;
}
