/**
 * Browser-only square crop for the CV photo. The picked file never leaves the browser as is: it is decoded, cropped,
 * scaled to `PHOTO_SIZE` and re-encoded as JPEG (which also drops EXIF, GPS included) before upload.
 */

export const PHOTO_SIZE = 800;
const MAX_UPLOAD_BYTES = 1_400_000; // server limit is 1.5 MB of JPEG; leave room

/** zoom >= 1 (1 = the largest square that fits); cx/cy = crop centre as a fraction of the image width/height. */
export interface Crop {
  zoom: number;
  cx: number;
  cy: number;
}

export const DEFAULT_CROP: Crop = { zoom: 1, cx: 0.5, cy: 0.4 };

export interface Picture {
  source: CanvasImageSource;
  width: number;
  height: number;
}

/** Decode a picked file. Rejects with a readable message for formats the browser cannot decode (HEIC on most). */
export async function decodePicture(file: File): Promise<Picture> {
  if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|gif|avif|bmp)$/i.test(file.name)) throw new Error(`${file.name} is not an image.`);
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { source: bitmap, width: bitmap.width, height: bitmap.height };
  } catch {
    throw new Error(`This browser cannot read ${file.name}. Use a JPEG, PNG or WebP.`);
  }
}

/** The source rectangle of a crop, clamped inside the picture. */
export function cropRect(p: { width: number; height: number }, crop: Crop): { sx: number; sy: number; side: number } {
  const zoom = Math.min(Math.max(crop.zoom, 1), 6);
  const side = Math.min(p.width, p.height) / zoom;
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max);
  return { sx: clamp(crop.cx * p.width - side / 2, p.width - side), sy: clamp(crop.cy * p.height - side / 2, p.height - side), side };
}

export function drawCrop(canvas: HTMLCanvasElement, p: Picture, crop: Crop, size: number): void {
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available in this browser.");
  const { sx, sy, side } = cropRect(p, crop);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(p.source, sx, sy, side, side, 0, 0, size, size);
}

/** Crop + scale + JPEG; lowers the quality until the result fits the upload limit. */
export function encodePhoto(p: Picture, crop: Crop): string {
  const canvas = document.createElement("canvas");
  const size = Math.min(PHOTO_SIZE, Math.round(cropRect(p, crop).side)) || PHOTO_SIZE;
  drawCrop(canvas, p, crop, Math.max(size, 200));
  for (const quality of [0.9, 0.82, 0.72, 0.6]) {
    const url = canvas.toDataURL("image/jpeg", quality);
    if ((url.length * 3) / 4 <= MAX_UPLOAD_BYTES) return url;
  }
  throw new Error("The photo is still too large after compression.");
}
