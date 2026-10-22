/** Small helpers shared by node implementations. */
import { NodeError } from "../engine/node-api";
import type { Item, JsonObject } from "../types";

const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** `a.b[0].c` -> ["a", "b", "0", "c"]. */
export function pathParts(path: string): string[] {
  return path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function getPath(source: unknown, path: string, dotNotation = true): unknown {
  if (!dotNotation) return source && typeof source === "object" ? (source as JsonObject)[path] : undefined;
  let current: unknown = source;
  for (const part of pathParts(path)) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function setPath(target: JsonObject, path: string, value: unknown, dotNotation = true): void {
  const parts = dotNotation ? pathParts(path) : [path];
  if (!parts.length) return;
  if (parts.some((part) => UNSAFE_KEYS.has(part))) throw new NodeError(`The field name "${path}" is not allowed.`);
  let current: Record<string, unknown> = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    const next = current[part];
    if (next === null || typeof next !== "object") {
      current[part] = /^\d+$/.test(parts[index + 1]) ? [] : {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

export function deletePath(target: JsonObject, path: string): void {
  const parts = pathParts(path);
  let current: unknown = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (!current || typeof current !== "object") return;
    current = (current as Record<string, unknown>)[parts[index]];
  }
  if (current && typeof current === "object") delete (current as Record<string, unknown>)[parts[parts.length - 1]];
}

/** "a, b ,c" -> ["a", "b", "c"]; lists pass through. */
export function fieldList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((v) => v.trim()).filter(Boolean);
  if (typeof value !== "string") return [];
  return value.split(",").map((v) => v.trim()).filter(Boolean);
}

/** A JSON parameter: an object/array as is, or text parsed as JSON. */
export function jsonParam(value: unknown, label: string): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new NodeError(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function isPlainObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((key) => deepEqual((a as JsonObject)[key], (b as JsonObject)[key]));
}

/** Stable text form of a value for keys (dedupe, grouping). */
export function stableKey(value: unknown): string {
  if (value === undefined) return "u";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${stableKey((value as JsonObject)[key])}`).join(",")}}`;
}

export function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

/** Key/value rows ([{ name, value }]) into an object. */
export function keyValues(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(value)) return out;
  for (const row of value) {
    if (!isPlainObject(row)) continue;
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (!name) continue;
    const entry = row.value;
    out[name] = entry === undefined || entry === null ? "" : typeof entry === "object" ? JSON.stringify(entry) : String(entry);
  }
  return out;
}

export function withJson(item: Item, json: JsonObject, index: number): Item {
  return { json, ...(item.binary ? { binary: item.binary } : {}), pairedItem: index };
}

export function binaryOf(item: Item, property: string, nodeName: string) {
  const ref = item.binary?.[property];
  if (!ref) throw new NodeError(`The item has no file in "${property}".`, { description: `Node "${nodeName}" reads the file field "${property}"; check the field name in the previous node's output.` });
  return ref;
}

export function extensionFor(mimeType: string): string {
  const map: Record<string, string> = {
    "application/json": "json",
    "text/csv": "csv",
    "text/plain": "txt",
    "text/html": "html",
    "application/pdf": "pdf",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "application/xml": "xml",
    "text/xml": "xml",
    "application/zip": "zip",
    "application/gzip": "gz",
    "text/calendar": "ics",
  };
  return map[mimeType.split(";")[0].trim().toLowerCase()] ?? "bin";
}
