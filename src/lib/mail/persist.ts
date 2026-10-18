import { createHmac, createSecretKey, type KeyObject } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { authMac } from "@/lib/accounts/auth-secret";
import { ensureDataDir } from "@/lib/accounts/store";

/**
 * Persistence for the mail layer's counters (day budgets, suppression list) in `$KNIFE_DATA_DIR/mail/` (0700, files
 * 0600). Threat model: a restart must not hand an attacker a fresh day of mail budget or let dead mailboxes be mailed
 * again, and the files must not be a list of addresses: every mailbox/domain is stored only as `mailKeyHash` (HMAC with
 * a key derived from auth.key for the purpose "mail", not recomputable from a guess). Loads are asynchronous and
 * size-capped, saves are asynchronous (temp file + rename, debounced, at most one in flight) plus a last synchronous
 * save on exit; a damaged file starts empty (counters only, never a security decision that fails open for long).
 */

export const MAIL_HASH = /^[A-Za-z0-9_-]{22}$/;

let hashKey: { master: Buffer; key: KeyObject } | null = null;

/** Keyed hash of a canonical mailbox or domain for the files on disk. */
export function mailKeyHash(value: string): string {
  const master = authMac("mail", "mail-keys/v1");
  if (!hashKey || !hashKey.master.equals(master)) hashKey = { master, key: createSecretKey(master) };
  return createHmac("sha256", hashKey.key).update(value).digest("base64url").slice(0, 22);
}

export function mailStatePath(name: string): string {
  return join(ensureDataDir(), "mail", name);
}

export interface PersistedFileOptions {
  path: string;
  /** Refuse to load a bigger file (it is then replaced on the next save). */
  maxBytes: number;
  serialize(now: number): string;
  /** Called once with the parsed JSON of the previous process's file. */
  restore(data: unknown, now: number): void;
  /** Debounce between a change and its save. */
  saveDelayMs?: number;
}

const LIVE = Symbol.for("samurai-knife.mail-persist.live.v1");
const g = globalThis as unknown as Record<symbol, Set<PersistedFile> | undefined>;

function live(): Set<PersistedFile> {
  let set = g[LIVE];
  if (!(set instanceof Set)) {
    set = new Set();
    g[LIVE] = set;
    process.once("exit", () => {
      for (const file of g[LIVE] ?? []) file.saveSync();
    });
  }
  return set;
}

/** One JSON file: `ready()` loads it once, `changed()` schedules a save. */
export class PersistedFile {
  private loading: Promise<void> | null = null;
  private dirty = false;
  private saving: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly options: PersistedFileOptions;

  constructor(options: PersistedFileOptions) {
    this.options = options;
    live().add(this);
  }

  get path(): string {
    return this.options.path;
  }

  ready(): Promise<void> {
    this.loading ??= this.load();
    return this.loading;
  }

  private async load(): Promise<void> {
    try {
      const info = await stat(this.options.path);
      if (info.size > this.options.maxBytes) return;
      this.options.restore(JSON.parse(await readFile(this.options.path, "utf8")), Date.now());
    } catch {
      // No file yet, or a damaged one: start empty; the next save rewrites it.
    }
  }

  changed(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save();
    }, this.options.saveDelayMs ?? 2_000);
    this.timer.unref?.();
  }

  /** Writes now if something changed (waits for a save in flight first). */
  async save(): Promise<void> {
    while (this.saving) await this.saving;
    if (!this.dirty) return;
    await this.ready();
    this.dirty = false;
    const temp = `${this.options.path}.${process.pid}.tmp`;
    this.saving = (async () => {
      try {
        await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 });
        await writeFile(temp, this.options.serialize(Date.now()), { mode: 0o600 });
        await rename(temp, this.options.path);
      } catch (error) {
        this.dirty = true;
        console.error(`[mail] saving ${this.options.path.split("/").pop()} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    try {
      await this.saving;
    } finally {
      this.saving = null;
    }
  }

  saveSync(): void {
    if (!this.dirty) return;
    try {
      mkdirSync(dirname(this.options.path), { recursive: true, mode: 0o700 });
      const temp = `${this.options.path}.${process.pid}.tmp`;
      writeFileSync(temp, this.options.serialize(Date.now()), { mode: 0o600 });
      renameSync(temp, this.options.path);
      this.dirty = false;
    } catch {
      // exiting anyway
    }
  }

  /** Stops the timer and forgets the file (tests, a new data dir). Pending changes are written first. */
  async dispose(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.save();
    live().delete(this);
  }
}
