"use client";
import { useState, type ChangeEvent } from "react";
import { Button, Field, Notice, Panel, Select } from "@/components/ui";
import { canvasBlob, loadLocalBitmap } from "@/lib/image-canvas";
import { downloadBlob } from "@/lib/format";
import { useT } from "@/lib/i18n/react";
export default function ImageScrubber() {
  const { t } = useT();
  const [file, setFile] = useState<File | null>(null), [format, setFormat] = useState("image/png"), [status, setStatus] = useState("");
  const onFile = (e: ChangeEvent<HTMLInputElement>) => { setFile(e.target.files?.[0] ?? null); setStatus(""); };
  const scrub = async () => { if (!file) return; let bitmap: ImageBitmap | undefined; try { bitmap = await loadLocalBitmap(file); const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.getContext("2d")?.drawImage(bitmap, 0, 0); const blob = await canvasBlob(canvas, format, 0.92); const ext = format === "image/jpeg" ? "jpg" : format === "image/webp" ? "webp" : "png"; downloadBlob(blob, `${file.name.replace(/\.[^.]+$/, "")}-clean.${ext}`); setStatus(t("Saved {toUpperCase} without embedded source metadata.", { toUpperCase: ext.toUpperCase() })); } catch (error) { setStatus(error instanceof Error ? error.message : t("Could not process image.")); } finally { bitmap?.close(); } };
  return <Panel title={t("Image metadata scrubber")}><div className="space-y-3"><Field label={t("Local image file")}><input className="sk-input w-full px-3 py-2 text-sm" type="file" accept="image/*" onChange={onFile} /></Field><Field label={t("Clean output format")}><Select value={format} onChange={(e) => setFormat(e.target.value)}><option value="image/png">{t("PNG (lossless)")}</option><option value="image/jpeg">JPEG</option><option value="image/webp">{t("WebP")}</option></Select></Field><Button variant="primary" disabled={!file} onClick={() => void scrub()}>{t("Re-encode and download")}</Button>{status && <Notice>{status}</Notice>}<p className="text-xs text-faint">{t("Re-draws pixels into a fresh browser canvas, omitting EXIF/IPTC/XMP metadata and the original filename. Processing stays local; image dimensions are capped at 20 megapixels.")}</p></div></Panel>;
}
