import { msgf } from "@/lib/i18n/msg";
import { PDFDocument } from "pdf-lib";

/**
 * Browser-only: turn picked images (scans, phone photos, screenshots) into a PDF, one page per image, so the PDF editor
 * can show, annotate, export and OCR them. Each image is decoded with its EXIF orientation applied and re-encoded
 * (JPEG stays JPEG, everything else becomes PNG), then placed on a page sized at 96 dpi and shrunk to fit A4 (portrait or
 * landscape, following the image). `nativeWidths` keeps the pixel width per page: OCR renders at that resolution instead
 * of the page size, so a 300 dpi scan is read at 300 dpi.
 */

export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif";
const IMAGE_NAME = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;
const A4: [number, number] = [595.28, 841.89];

export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") ? file.type !== "image/svg+xml" : IMAGE_NAME.test(file.name);
}

export interface ImagesPdf {
  bytes: Uint8Array;
  /** Pixel width of the image on each page, in page order. */
  nativeWidths: number[];
}

/** Page size in points: 96 dpi, shrunk (never enlarged) to fit A4 in the image's orientation. */
export function pageSizeFor(width: number, height: number): [number, number] {
  const w = width * 0.75;
  const h = height * 0.75;
  const [maxW, maxH] = width > height ? [A4[1], A4[0]] : A4;
  const fit = Math.min(1, maxW / w, maxH / h);
  return [w * fit, h * fit];
}

async function encode(file: File): Promise<{ bytes: Uint8Array; jpeg: boolean; width: number; height: number }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(msgf("This browser cannot read {name}. Use PNG, JPEG or WebP.", { name: file.name }));
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D is unavailable in this browser.");
    const jpeg = file.type === "image/jpeg" || /\.jpe?g$/i.test(file.name);
    if (jpeg) {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, jpeg ? "image/jpeg" : "image/png", 0.95));
    canvas.width = 0;
    canvas.height = 0;
    if (!blob) throw new Error(msgf("Could not convert {name}.", { name: file.name }));
    return { bytes: new Uint8Array(await blob.arrayBuffer()), jpeg, width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

export async function imagesToPdf(files: File[], onProgress?: (done: number, total: number) => void): Promise<ImagesPdf> {
  const pdf = await PDFDocument.create();
  const nativeWidths: number[] = [];
  for (const [index, file] of files.entries()) {
    onProgress?.(index, files.length);
    const image = await encode(file);
    const embedded = image.jpeg ? await pdf.embedJpg(image.bytes) : await pdf.embedPng(image.bytes);
    const [width, height] = pageSizeFor(image.width, image.height);
    pdf.addPage([width, height]).drawImage(embedded, { x: 0, y: 0, width, height });
    nativeWidths.push(image.width);
  }
  onProgress?.(files.length, files.length);
  pdf.setProducer("Smart Knife");
  pdf.setCreator("Smart Knife PDF editor (images to PDF)");
  return { bytes: await pdf.save(), nativeWidths };
}
