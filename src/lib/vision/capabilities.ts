import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod/v4";
import type { ProviderTestResult } from "@/lib/accounts/provider";
import { ensureDataDir, writePrivateFile } from "@/lib/accounts/store";

/**
 * What the vision probe learned about a model (docs/ACCOUNTS.md "Vision detection"): one shared, non-personal file
 * `model-capabilities.json` in the data dir, keyed by the provider address (host + path, never a key, query or user) and
 * the model id. It holds no account data: only "this endpoint's model X accepted / refused an image" with when it was
 * checked. Only a definite answer is kept (30 days); errors and unclear answers are never cached, so the next check
 * tries again.
 */

export const CAPABILITY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_CAPABILITY_ENTRIES = 5_000;
const FILE = "model-capabilities.json";

const entrySchema = z.object({
  vision: z.boolean(),
  checkedAt: z.string(),
  expiresAt: z.string(),
});
const fileSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), entrySchema),
});

export type CapabilityEntry = z.infer<typeof entrySchema>;
type CapabilityFile = z.infer<typeof fileSchema>;

/**
 * The cache key: lower-case host (with port) + path of the base URL, then the model id. null for an address that is
 * not a plain http(s) URL (credentials, query and fragment are refused, so nothing secret can end up in a key).
 */
export function capabilityKey(baseUrl: string, model: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const id = model.trim();
  if (!id || id.length > 200 || /[\u0000-\u001f]/.test(id)) return null;
  return `${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}|${id}`;
}

function filePath(): string {
  return join(ensureDataDir(), FILE);
}

let cache: { identity: string; data: CapabilityFile } | null = null;

function emptyFile(): CapabilityFile {
  return { version: 1, entries: {} };
}

function readFile(): CapabilityFile {
  const path = filePath();
  let identity: string;
  try {
    const stat = statSync(path);
    identity = `${path}:${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return emptyFile();
  }
  if (cache?.identity === identity) return structuredClone(cache.data);
  let data = emptyFile();
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")) as unknown);
    if (parsed.success) data = parsed.data;
  } catch {
    // A broken file is the same as no file: the next definite answer rewrites it.
  }
  cache = { identity, data };
  return structuredClone(data);
}

/** The learned answer for this endpoint and model, or null (never checked, expired, or not a valid address). */
export function learnedVision(baseUrl: string, model: string, now = Date.now()): CapabilityEntry | null {
  const key = capabilityKey(baseUrl, model);
  if (!key) return null;
  const entry = readFile().entries[key];
  if (!entry || Date.parse(entry.expiresAt) <= now) return null;
  return entry;
}

/** Keep a definite answer (expired entries are pruned and the oldest dropped beyond the cap). */
export function rememberVision(baseUrl: string, model: string, vision: boolean, now = Date.now()): CapabilityEntry | null {
  const key = capabilityKey(baseUrl, model);
  if (!key) return null;
  const data = readFile();
  const entry: CapabilityEntry = { vision, checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + CAPABILITY_TTL_MS).toISOString() };
  data.entries[key] = entry;
  const live = Object.entries(data.entries).filter(([, value]) => Date.parse(value.expiresAt) > now);
  live.sort((a, b) => Date.parse(b[1].checkedAt) - Date.parse(a[1].checkedAt));
  data.entries = Object.fromEntries(live.slice(0, MAX_CAPABILITY_ENTRIES));
  writePrivateFile(filePath(), `${JSON.stringify(data, null, 2)}\n`);
  return entry;
}

/**
 * A model list with the learned answers filled in: the provider's advertised value first, else the probe's (marked
 * `detected`), else unknown. Models the provider lists without details still get an entry when something was learned.
 */
export function mergeLearnedVision<T extends { id: string; vision: boolean | null; visionSource: "advertised" | "detected" | null; visionCheckedAt?: string }>(
  baseUrl: string,
  details: readonly T[],
  now = Date.now(),
): T[] {
  return details.map((entry) => {
    if (entry.vision !== null) return entry;
    const learned = learnedVision(baseUrl, entry.id, now);
    return learned ? { ...entry, vision: learned.vision, visionSource: "detected" as const, visionCheckedAt: learned.checkedAt } : entry;
  });
}

/** A provider test / model list answer with the learned vision answers merged in. */
export function withLearnedVision(baseUrl: string, result: ProviderTestResult): ProviderTestResult {
  return result.modelDetails ? { ...result, modelDetails: mergeLearnedVision(baseUrl, result.modelDetails) } : result;
}

/** Tests only: forget the read cache (the file is the truth). */
export function resetCapabilityCache(): void {
  cache = null;
}
