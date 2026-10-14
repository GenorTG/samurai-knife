export const MAX_IMAGE_PIXELS = 20_000_000;

export async function loadLocalBitmap(file: File): Promise<ImageBitmap> {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  if (bitmap.width * bitmap.height > MAX_IMAGE_PIXELS) {
    bitmap.close();
    throw new Error("Image exceeds the 20-megapixel processing limit.");
  }
  return bitmap;
}

export function canvasBlob(canvas: HTMLCanvasElement, type = "image/png", quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("The browser could not encode this image.")), type, quality));
}
