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
  const scrub = async () => { if (!file) return; let bitmap: ImageBitmap | undefined; try { bitmap = await loadLocalBitmap(file); const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.getContext("2d")?.drawImage(bitmap, 0, 0); const blob = await canvasBlob(canvas, format, 0.92); const ext = format === "image/jpeg" ? "jpg" : format === "image/webp" ? "webp" : "png"; downloadBlob(blob, `${file.name.replace(/\.[^.]+$/, "")}-clean.${ext}`); setStatus(t("Saved {toUpperCase} without the hidden data.", { toUpperCase: ext.toUpperCase() })); } catch (error) { setStatus(error instanceof Error ? error.message : t("Could not process image.")); } finally { bitmap?.close(); } };
  return <Panel title={t("Remove hidden data from a photo")}><div className="space-y-3"><Field label={t("Your image")}><input className="sk-input w-full px-3 py-2 text-sm" type="file" accept="image/*" onChange={onFile} /></Field><Field label={t("File type of the clean copy")}><Select value={format} onChange={(e) => setFormat(e.target.value)}><option value="image/png">{t("PNG (no quality loss)")}</option><option value="image/jpeg">JPEG</option><option value="image/webp">{t("WebP")}</option></Select></Field><Button variant="primary" disabled={!file} onClick={() => void scrub()}>{t("Clean and download")}</Button>{status && <Notice>{status}</Notice>}<p className="text-xs text-faint">{t("Makes a fresh copy of the picture without hidden data such as location and camera details (EXIF, IPTC, XMP) and without the original file name. Everything stays on your device. Images up to 20 megapixels.")}</p></div></Panel>;
}
