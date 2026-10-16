import { existsSync, statSync } from "node:fs";
import { plainSize, readAccountFile } from "@/lib/storage/sealed";
import { removeAccountPath, writeAccountFile } from "@/lib/storage/quota";
import { accountScope, ensurePrivateDir, StorageScopeError } from "@/lib/storage/scope";

/**
 * Server-only: the CV photo, one JPEG per account at `$KNIFE_DATA_DIR/cv/<account id>.photo.jpg` (mode 600).
 * Kept outside the CV JSON on purpose: the JSON is polled, snapshotted 40 times and handed to the model, a photo is none
 * of those. The browser crops and re-encodes before upload (which also drops EXIF/GPS), so the server only accepts a
 * real JPEG of bounded size.
 */

export const MAX_PHOTO_BYTES = 1_500_000;

export class CvPhotoError extends Error {}

export interface CvPhotoMeta {
  bytes: number;
  /** ISO time of the last upload; the UI uses it to bust the image cache. */
  updatedAt: string;
}

function photoPath(accountId: string): string {
  try {
    const { cv } = accountScope(accountId);
    ensurePrivateDir(cv.dir);
    return cv.photo;
  } catch (error) {
    if (error instanceof StorageScopeError) throw new CvPhotoError("invalid account id");
    throw error;
  }
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
  return { bytes: plainSize(file, stat.size), updatedAt: stat.mtime.toISOString() };
}

export function readPhoto(accountId: string): Buffer | null {
  const file = photoPath(accountId);
  return existsSync(file) ? readAccountFile(accountId, file) : null;
}

/** Counts toward the storage quota (QuotaExceededError when it would not fit). */
export function savePhoto(accountId: string, bytes: Uint8Array): CvPhotoMeta {
  writeAccountFile(accountId, photoPath(accountId), bytes);
  const meta = photoMeta(accountId);
  if (!meta) throw new CvPhotoError("photo: could not be stored.");
  return meta;
}

/** False when there was no photo. */
export function deletePhoto(accountId: string): boolean {
  const file = photoPath(accountId);
  if (!existsSync(file)) return false;
  removeAccountPath(accountId, file);
  return true;
}
