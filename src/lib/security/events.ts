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
  kind?: SecurityEventKind;
  type?: string;
  ipPrefix?: string;
  ip?: string;
  account?: string;
  accountId?: string;
  path?: string;
  status?: number;
  count?: number;
  detail?: string | Record<string, string | number | boolean>;
}

const MAX_BUFFER = 1_000;
const MAX_RECENT = 500;
const buffer: string[] = [];
const recent: Array<SecurityEvent & { ts: string }> = [];
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
  const recorded = { ts: new Date().toISOString(), ...event };
  recent.push(recorded);
  if (recent.length > MAX_RECENT) recent.splice(0, recent.length - MAX_RECENT);
  if (buffer.length >= MAX_BUFFER) return;
  buffer.push(`${JSON.stringify(recorded)}\n`);
  void flush();
}

export function recentSecurityEvents(): readonly (SecurityEvent & { ts: string })[] {
  return recent;
}
