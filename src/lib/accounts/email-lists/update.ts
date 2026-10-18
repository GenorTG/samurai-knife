import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFile } from "@/lib/accounts/store";
import { disposableListProblem, emailPolicyDir, parseDomainList } from "@/lib/accounts/email-policy";

/**
 * Weekly refresh of the disposable-domain list (`npm run email-lists -- update`, docs/DEPLOY.md "Email lists"). Threat
 * model: the download is untrusted input that decides who can sign up. It comes over HTTPS from one fixed repository
 * (CC0), is size-capped, optionally pinned to a commit and a sha256, and must validate (`disposableListProblem`: plausible
 * size, no junk, never a big webmail domain, still the well-known disposable ones, no sudden shrink) before it atomically
 * replaces `$KNIFE_DATA_DIR/email-policy/disposable.txt`. A failed update keeps the previous list; the server never
 * downloads anything at request time.
 */

export const DISPOSABLE_SOURCE = {
  name: "disposable-email-domains",
  license: "CC0-1.0",
  url: (ref: string) => `https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/${ref}/disposable_email_blocklist.conf`,
};

const MAX_BYTES = 10 * 1024 * 1024;

export interface UpdateOptions {
  ref?: string;
  sha256?: string;
  force?: boolean;
  dryRun?: boolean;
  /** Injected for tests; default: global fetch with a timeout and a byte cap. */
  fetchText?: (url: string) => Promise<string>;
}

export type UpdateResult =
  | { ok: true; written: boolean; domains: number; previous: number; sha256: string; url: string }
  | { ok: false; error: string };

async function defaultFetch(url: string): Promise<string> {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error(`more than ${MAX_BYTES} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function currentCount(path: string): number {
  try {
    return parseDomainList(readFileSync(path, "utf8")).domains.size;
  } catch {
    return 0;
  }
}

export async function updateDisposableList(options: UpdateOptions = {}): Promise<UpdateResult> {
  const ref = options.ref?.trim() || "main";
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(ref) || ref.includes("..")) return { ok: false, error: `invalid ref "${ref}"` };
  const pin = options.sha256?.trim().toLowerCase();
  if (pin && !/^[0-9a-f]{64}$/.test(pin)) return { ok: false, error: "--sha256 needs 64 hex characters" };
  const url = DISPOSABLE_SOURCE.url(ref);
  let text: string;
  try {
    text = await (options.fetchText ?? defaultFetch)(url);
  } catch (error) {
    return { ok: false, error: `download failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (Buffer.byteLength(text) > MAX_BYTES) return { ok: false, error: "download too large" };
  const sha256 = createHash("sha256").update(text).digest("hex");
  if (pin && pin !== sha256) return { ok: false, error: `sha256 mismatch: got ${sha256}` };
  const dir = emailPolicyDir();
  const target = join(dir, "disposable.txt");
  const previous = currentCount(target);
  const list = parseDomainList(text);
  const problem = disposableListProblem(list, options.force ? 0 : previous);
  if (problem) return { ok: false, error: `refused: ${problem}` };
  if (!options.dryRun) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writePrivateFile(target, `${[...list.domains].sort().join("\n")}\n`);
    const meta = { source: DISPOSABLE_SOURCE.name, license: DISPOSABLE_SOURCE.license, url, sha256, domains: list.domains.size, fetchedAt: new Date().toISOString() };
    writePrivateFile(join(dir, "disposable.meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  }
  return { ok: true, written: !options.dryRun, domains: list.domains.size, previous, sha256, url };
}
