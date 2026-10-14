import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ensureDataDir, writePrivateFile } from "@/lib/accounts/store";

/**
 * Server-only: the CV photo, one JPEG per account at `$KNIFE_DATA_DIR/cv/<account id>.photo.jpg` (mode 600).
 * Kept outside the CV JSON on purpose: the JSON is polled, snapshotted 40 times and handed to the model, a photo is none
 * of those. The browser crops and re-encodes before upload (which also drops EXIF/GPS), so the server only accepts a
 * real JPEG of bounded size.
 */

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_PHOTO_BYTES = 1_500_000;

export class CvPhotoError extends Error {}

export interface CvPhotoMeta {
  bytes: number;
  /** ISO time of the last upload; the UI uses it to bust the image cache. */
  updatedAt: string;
}

function photoPath(accountId: string): string {
  if (!SAFE_ID.test(accountId)) throw new CvPhotoError("invalid account id");
  const base = join(ensureDataDir(), "cv");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  return join(base, `${accountId}.photo.jpg`);
}

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** `data:image/jpeg;base64,...` -> bytes; throws a readable CvPhotoError otherwise. */
export function decodeJpegDataUrl(dataUrl: string): Buffer {
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+=*)$/.exec(dataUrl.trim());
  if (!match) throw new CvPhotoError("photo: expected a base64 JPEG data URL (data:image/jpeg;base64,…).");
  const bytes = Buffer.from(match[1], "base64");
  if (!isJpeg(bytes)) throw new CvPhotoError("photo: the data is not a JPEG image.");
  if (bytes.length > MAX_PHOTO_BYTES) throw new CvPhotoError(`photo: ${bytes.length} bytes, the limit is ${MAX_PHOTO_BYTES}.`);
  return bytes;
}

export function photoMeta(accountId: string): CvPhotoMeta | null {
  const file = photoPath(accountId);
  if (!existsSync(file)) return null;
  const stat = statSync(file);
  return { bytes: stat.size, updatedAt: stat.mtime.toISOString() };
}

export function readPhoto(accountId: string): Buffer | null {
  const file = photoPath(accountId);
  return existsSync(file) ? readFileSync(file) : null;
}

/** Absolute path of the stored photo, or null; for the DOCX export, which copies it into its scratch dir. */
export function photoFile(accountId: string): string | null {
  const file = photoPath(accountId);
  return existsSync(file) ? file : null;
}

export function savePhoto(accountId: string, bytes: Uint8Array): CvPhotoMeta {
  writePrivateFile(photoPath(accountId), bytes);
  const meta = photoMeta(accountId);
  if (!meta) throw new CvPhotoError("photo: could not be stored.");
  return meta;
}

/** False when there was no photo. */
export function deletePhoto(accountId: string): boolean {
  const file = photoPath(accountId);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}
