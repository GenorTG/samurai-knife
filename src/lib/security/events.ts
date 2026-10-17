import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "@/lib/accounts/store";

/**
 * Security event log (minimal local version for the accounts lane; the abuse-detector lane owns the full module and
 * keeps this name and signature). Appends one JSON line per event to `$KNIFE_DATA_DIR/security/events.jsonl` (0600)
 * through a bounded in-memory buffer: never blocks or fails a request, drops events when the buffer is full.
 */

export type SecurityEventKind =
  | "login_lockout"
  | "pow_fail"
  | "rate_block"
  | "hash_busy"
  | "pending_full"
  | "oauth_flow_full"
  | (string & {});

export interface SecurityEvent {
  kind: SecurityEventKind;
  ipPrefix?: string;
  account?: string;
  path?: string;
  status?: number;
  count?: number;
  detail?: string;
}

const MAX_BUFFER = 1_000;
const buffer: string[] = [];
let flushing = false;

async function flush(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    const dir = join(dataDir(), "security");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    while (buffer.length > 0) {
      const lines = buffer.splice(0, buffer.length).join("");
      await appendFile(join(dir, "events.jsonl"), lines, { mode: 0o600 });
    }
  } catch (error) {
    console.warn(`[security] could not write events: ${error instanceof Error ? error.message : String(error)}`);
    buffer.length = 0;
  } finally {
    flushing = false;
  }
}

export function recordSecurityEvent(event: SecurityEvent): void {
  if (buffer.length >= MAX_BUFFER) return;
  buffer.push(`${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
  void flush();
}
