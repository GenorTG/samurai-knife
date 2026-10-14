/** Image resize/re-encode. Pure: runs inside image-resize.worker.ts (OffscreenCanvas + createImageBitmap), never on the page's main thread. */

export type ResizeFormat = "image/png" | "image/jpeg" | "image/webp";

export interface ResizeInput {
  file: Blob;
  width: number;
  height: number;
  fit: "contain" | "cover";
  format: ResizeFormat;
  quality: number;
  /** Fill behind transparency; JPEG/WebP output is always flattened onto it. */
  background: string;
}

export type ResizeTasks = { resize: { payload: ResizeInput; result: Blob } };

export async function resizeImage({ file, width, height, fit, format, quality, background }: ResizeInput): Promise<Blob> {
  if (typeof OffscreenCanvas === "undefined") throw new Error("This browser cannot resize images in the background (no OffscreenCanvas).");
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is unavailable in this browser.");
    // JPEG has no alpha, so lossy output always needs a flat backdrop.
    if (format !== "image/png") {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);
    }
    const scale = fit === "cover" ? Math.max(width / bitmap.width, height / bitmap.height) : Math.min(width / bitmap.width, height / bitmap.height);
    const drawW = bitmap.width * scale;
    const drawH = bitmap.height * scale;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, (width - drawW) / 2, (height - drawH) / 2, drawW, drawH);
    return await canvas.convertToBlob({ type: format, quality });
  } finally {
    bitmap.close();
  }
}
