"use client";

import { useCallback, useSyncExternalStore } from "react";
import { ACCOUNT_KNOWN_EVENT, knownAccount, loadAccount } from "@/lib/client-account";
import { SQL_DIALECTS, sqlSchemaSchema, type SqlDialect, type SqlSchema } from "./types";

/**
 * Client-only store for "the current schema" and the chosen dialect, shared by every SQL lab tab and read by the
 * assistant from the page text. Server snapshots are always empty, so nothing stored can leak into SSR output.
 * Kept per account (`<key>.<account id>`, cleared on logout: src/lib/client-account.ts); until the account is known the
 * store reads as empty and keeps writes in this tab only.
 */

const SCHEMA_KEY = "sk.sql.schema.v1";
const DIALECT_KEY = "sk.sql.dialect.v1";
const CHANGE_EVENT = "sk:sql-store";

/** The account's own key, or null while the account is not known yet (or signed out). */
function scoped(key: string): string | null {
  const account = knownAccount();
  if (account === undefined) void loadAccount();
  return account ? `${key}.${account.id}` : null;
}

export interface StoredSchema {
  schema: SqlSchema;
  /** Where it came from (shown to the user): "pasted DDL (postgres)", "sample: shop"… */
  source: string;
}

const cache = new Map<string, { raw: string | null; value: unknown }>();

const memory = new Map<string, string | null>();

function read<T>(base: string, parse: (raw: string) => T | null): T | null {
  if (typeof window === "undefined") return null;
  const key = scoped(base);
  let raw: string | null = null;
  if (key === null) {
    raw = memory.get(base) ?? null;
  } else {
    try {
      raw = window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  const cacheKey = key ?? `memory:${base}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.raw === raw) return hit.value as T | null;
  let value: T | null = null;
  if (raw) {
    try {
      value = parse(raw);
    } catch {
      value = null;
    }
  }
  cache.set(cacheKey, { raw, value });
  return value;
}

function write(base: string, raw: string | null): void {
  const key = scoped(base);
  if (key === null) {
    memory.set(base, raw);
  } else {
    try {
      if (raw === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, raw);
    } catch {
      // Storage blocked or full: the in-memory cache entry below still serves this tab.
      cache.set(key, { raw, value: undefined });
    }
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener(ACCOUNT_KNOWN_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener(ACCOUNT_KNOWN_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

function parseStoredSchema(raw: string): StoredSchema | null {
  const data = JSON.parse(raw) as { schema?: unknown; source?: unknown };
  const schema = sqlSchemaSchema.safeParse(data.schema);
  if (!schema.success) return null;
  return { schema: schema.data, source: typeof data.source === "string" ? data.source : "saved" };
}

const DIALECT_IDS: string[] = SQL_DIALECTS.map((d) => d.id);

export function readStoredSchema(): StoredSchema | null {
  return read(SCHEMA_KEY, parseStoredSchema);
}

export function saveSchema(schema: SqlSchema, source: string): void {
  write(SCHEMA_KEY, JSON.stringify({ schema, source }));
}

export function clearSchema(): void {
  write(SCHEMA_KEY, null);
}

export function useStoredSchema(): StoredSchema | null {
  return useSyncExternalStore(subscribe, readStoredSchema, () => null);
}

export function readStoredDialect(fallback: SqlDialect): SqlDialect {
  const stored = read(DIALECT_KEY, (raw) => (DIALECT_IDS.includes(raw) ? raw : null));
  return (stored as SqlDialect | null) ?? fallback;
}

/** Persisted dialect choice. `fallback` is what SSR and first-time visitors see. */
export function useStoredDialect(fallback: SqlDialect = "postgres"): [SqlDialect, (dialect: SqlDialect) => void] {
  const dialect = useSyncExternalStore(
    subscribe,
    () => readStoredDialect(fallback),
    () => fallback,
  );
  const set = useCallback((next: SqlDialect) => write(DIALECT_KEY, next), []);
  return [dialect, set];
}

/** Compact one-line-per-table text used on the page and in assistant prompts. */
export function describeSchema(schema: SqlSchema): string {
  return schema.tables
    .map((table) => {
      const cols = table.columns.map((c) => `${c.name}${c.type ? ` ${c.type}` : ""}${c.primaryKey ? " PK" : ""}`);
      return `${table.name}(${cols.join(", ")})`;
    })
    .join("\n");
}
