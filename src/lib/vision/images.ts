import { randomBytes } from "node:crypto";

/**
 * Images the vision tools hand between calls (a screenshot -> the assistant's next model round, knife_vision_describe),
 * kept in the server's MEMORY only: never written to the data dir, gone after `TTL_MS`, a restart, or when newer images
 * push them out. Bounded per account (`MAX_PER_ACCOUNT`) and server-wide (`MAX_TOTAL_BYTES`). An id is only ever looked
 * up with the account it was stored for, so another account's id answers "unknown image". Ids are `vis_` + 20 hex.
 */

export interface StoredImage {
  id: string;
  accountId: string;
  mime: "image/png" | "image/jpeg";
  bytes: Buffer;
  width: number;
  height: number;
  /** What the picture shows (a screenshot's final URL); third-party controlled, keep it inside envelopes. */
  source: string;
  createdAt: number;
}

export const IMAGE_ID = /^vis_[0-9a-f]{20}$/;
export const TTL_MS = 30 * 60_000;
export const MAX_PER_ACCOUNT = 8;
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

const KEY = Symbol.for("samurai-knife.vision-images.v1");

function store(): Map<string, StoredImage> {
  const g = globalThis as unknown as Record<symbol, Map<string, StoredImage> | undefined>;
  return (g[KEY] ??= new Map());
}

function sweep(now: number): void {
  const map = store();
  for (const [id, image] of map) if (now - image.createdAt > TTL_MS) map.delete(id);
  let total = 0;
  for (const image of map.values()) total += image.bytes.byteLength;
  // Oldest first (insertion order) until the server-wide cap holds.
  for (const [id, image] of map) {
    if (total <= MAX_TOTAL_BYTES) break;
    total -= image.bytes.byteLength;
    map.delete(id);
  }
}

export function putImage(input: Omit<StoredImage, "id" | "createdAt">, now = Date.now()): StoredImage {
  const map = store();
  const image: StoredImage = { ...input, id: `vis_${randomBytes(10).toString("hex")}`, createdAt: now };
  map.set(image.id, image);
  const own = [...map.values()].filter((candidate) => candidate.accountId === input.accountId);
  for (const old of own.slice(0, Math.max(0, own.length - MAX_PER_ACCOUNT))) map.delete(old.id);
  sweep(now);
  return image;
}

export function getImage(accountId: string, id: string, now = Date.now()): StoredImage | null {
  if (!IMAGE_ID.test(id)) return null;
  const image = store().get(id);
  if (!image || image.accountId !== accountId) return null;
  if (now - image.createdAt > TTL_MS) {
    store().delete(id);
    return null;
  }
  return image;
}

/** Tests only. */
export function clearImages(): void {
  store().clear();
}
