"use client";
import { useState, type ChangeEvent } from "react";
import { Button, Field, Notice, Panel } from "@/components/ui";
import { canvasBlob, loadLocalBitmap } from "@/lib/image-canvas";
import { downloadBlob } from "@/lib/format";
const SIZES = [16, 32, 48, 180, 512];
export default function FaviconPackager() {
  const [file, setFile] = useState<File | null>(null), [icons, setIcons] = useState<{ size: number; blob: Blob }[]>([]), [error, setError] = useState("");
  const generate = async () => { if (!file) return; let bitmap: ImageBitmap | undefined; try { bitmap = await loadLocalBitmap(file); const blobs = await Promise.all(SIZES.map(async (size) => { const canvas = document.createElement("canvas"); canvas.width = size; canvas.height = size; canvas.getContext("2d")?.drawImage(bitmap!, 0, 0, size, size); return { size, blob: await canvasBlob(canvas) }; })); setIcons(blobs); setError(""); } catch (e) { setError(e instanceof Error ? e.message : "Could not create icons."); } finally { bitmap?.close(); } };
  return <Panel title="Favicon and app-icon packager"><div className="space-y-3"><Field label="Source image (square artwork recommended)"><input className="sk-input w-full px-3 py-2 text-sm" type="file" accept="image/*" onChange={(e: ChangeEvent<HTMLInputElement>) => { setFile(e.target.files?.[0] ?? null); setIcons([]); }} /></Field><Button variant="primary" disabled={!file} onClick={() => void generate()}>Generate PNG icons</Button>{error && <Notice tone="error">{error}</Notice>}{icons.map(({ size, blob }) => <div key={size} className="flex items-center justify-between gap-3 rounded-lg border border-line p-3"><span className="font-mono text-sm">{size} × {size} PNG</span><Button size="sm" onClick={() => downloadBlob(blob, `icon-${size}.png`)}>Download</Button></div>)}<p className="text-xs text-faint">Creates separate PNGs at 16, 32, 48, 180, and 512 px by resizing to a square. It does not generate a multi-size .ico or an HTML manifest.</p></div></Panel>;
}
