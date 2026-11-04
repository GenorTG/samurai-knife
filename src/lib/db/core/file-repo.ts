import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Account } from "@/lib/accounts/store";
import { accountsFileIn, ensureDataDir, withAccountsLock, writePrivateFile } from "@/lib/accounts/store";
import {
  CoreConflictError,
  isMcpKeyRecord,
  isSessionRecord,
  type CommitResult,
  type CoreBatch,
  type CoreLoad,
  type CoreRepo,
  type McpKeyRecord,
  type SessionRecord,
} from "@/lib/db/core/types";

/**
 * File implementation of CoreRepo over today's formats in one data directory: accounts.json (v1 or v2, provider secrets
 * sealed), sessions.json, mcp-keys.json. Used by the contract tests, `db:import` (source) and the verify mode's mirror;
 * the server in file mode keeps using its own synchronous file code (store.ts, session.ts, mcp-keys.ts), which writes the
 * same files. Versions are content hashes of the stored record, so `expect` works like a row version.
 */

interface AccountsFile {
  version?: number;
  defaultAccountId: string;
  accounts: unknown[];
}

const accountId = (doc: unknown): string => (typeof doc === "object" && doc !== null && typeof (doc as { id?: unknown }).id === "string" ? (doc as { id: string }).id : "");

export function fileVersion(doc: unknown): string {
  return createHash("sha256").update(JSON.stringify(doc)).digest("hex").slice(0, 16);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export class FileCoreRepo implements CoreRepo {
  readonly kind = "files" as const;

  private readonly dir: string;

  constructor(dir: string = ensureDataDir()) {
    this.dir = dir;
  }

  private accountsFile(): AccountsFile | null {
    const path = accountsFileIn(this.dir);
    if (!existsSync(path)) return null;
    const raw = readJson(path);
    if (typeof raw !== "object" || raw === null || !Array.isArray((raw as AccountsFile).accounts) || typeof (raw as AccountsFile).defaultAccountId !== "string") {
      throw new Error(`${path} has an unexpected shape`);
    }
    return raw as AccountsFile;
  }

  private list<T>(name: string, field: "sessions" | "keys", accept: (value: unknown) => value is T): T[] {
    const path = join(this.dir, name);
    if (!existsSync(path)) return [];
    try {
      const raw = readJson(path) as Record<string, unknown>;
      return Array.isArray(raw[field]) ? (raw[field] as unknown[]).filter(accept) : [];
    } catch {
      return []; // the server treats a damaged file the same way (fail closed: no session / key works)
    }
  }

  async load(): Promise<CoreLoad> {
    return this.loadSync();
  }

  loadSync(): CoreLoad {
    const file = this.accountsFile();
    return {
      defaultAccountId: file ? file.defaultAccountId : null,
      legacyV1: file !== null && typeof file.version !== "number",
      accounts: (file?.accounts ?? []).map((doc) => ({ doc, version: fileVersion(doc) })),
      sessions: this.list("sessions.json", "sessions", isSessionRecord),
      keys: this.list("mcp-keys.json", "keys", isMcpKeyRecord),
    };
  }

  async commit(batch: CoreBatch): Promise<CommitResult> {
    return withAccountsLock(this.dir, () => {
      const file = this.accountsFile();
      const accounts = new Map<string, unknown>((file?.accounts ?? []).map((doc) => [accountId(doc), doc]));
      const versions: Record<string, string> = {};
      for (const { doc, expect } of batch.accounts?.upsert ?? []) {
        const current = accounts.get(doc.id);
        if (expect === null ? current !== undefined : current === undefined || fileVersion(current) !== expect) {
          throw new CoreConflictError(`account ${doc.id} changed in accounts.json (expected version ${expect ?? "none"})`);
        }
      }
      for (const { id, expect } of batch.accounts?.delete ?? []) {
        const current = accounts.get(id);
        if (current === undefined || fileVersion(current) !== expect) throw new CoreConflictError(`account ${id} changed in accounts.json (expected version ${expect})`);
      }
      const removed = new Set((batch.accounts?.delete ?? []).map(({ id }) => id));
      for (const { doc } of batch.accounts?.upsert ?? []) {
        accounts.set(doc.id, doc);
        versions[doc.id] = fileVersion(doc);
      }
      for (const id of removed) accounts.delete(id);
      const defaultAccountId = batch.defaultAccountId ?? file?.defaultAccountId ?? [...accounts.keys()][0] ?? "";
      const docs = [...accounts.values()] as Account[];
      if (batch.accounts || batch.defaultAccountId !== undefined || !file) {
        writePrivateFile(accountsFileIn(this.dir), `${JSON.stringify({ version: 2, defaultAccountId, accounts: docs }, null, 2)}\n`);
      }
      // Same cascade as the database: rows of a deleted account go with it.
      const apply = <T>(rows: T[], change: { upsert?: T[]; delete?: string[] } | undefined, idOf: (row: T) => string, ownerOf: (row: T) => string): T[] => {
        const byId = new Map(rows.map((row) => [idOf(row), row]));
        for (const row of change?.upsert ?? []) byId.set(idOf(row), row);
        for (const id of change?.delete ?? []) byId.delete(id);
        return [...byId.values()].filter((row) => !removed.has(ownerOf(row)));
      };
      if (batch.sessions || removed.size) {
        const sessions = apply<SessionRecord>(this.list("sessions.json", "sessions", isSessionRecord), batch.sessions, (s) => s.hash, (s) => s.accountId);
        writePrivateFile(join(this.dir, "sessions.json"), `${JSON.stringify({ version: 1, sessions })}\n`);
      }
      if (batch.keys || removed.size) {
        const keys = apply<McpKeyRecord>(this.list("mcp-keys.json", "keys", isMcpKeyRecord), batch.keys, (k) => k.id, (k) => k.accountId);
        writePrivateFile(join(this.dir, "mcp-keys.json"), `${JSON.stringify({ version: 1, keys })}\n`);
      }
      return { versions };
    });
  }

  /** Verify-mode mirror: rewrites sessions.json and mcp-keys.json from the database state (accounts: mirrorAccountsFile). */
  mirror(sessions: readonly SessionRecord[], keys: readonly McpKeyRecord[]): void {
    writePrivateFile(join(this.dir, "sessions.json"), `${JSON.stringify({ version: 1, sessions })}\n`);
    writePrivateFile(join(this.dir, "mcp-keys.json"), `${JSON.stringify({ version: 1, keys })}\n`);
  }

  async close(): Promise<void> {}
}
