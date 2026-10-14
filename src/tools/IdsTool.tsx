"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { sha1 } from "@noble/hashes/legacy.js";
import { sha256, sha384, sha512 } from "@noble/hashes/sha2.js";
import { Button, CopyButton, Dropzone, Field, Notice, NumberField, Panel, Select, Stat, StatGrid, TextArea, TextInput } from "@/components/ui";
import { FileHasher } from "@/lib/hash-client";
import { HASH_NAMES, type HashName } from "@/lib/hash-run";
import { isAbortError } from "@/lib/workers/errors";
import { copyText, formatBytes } from "@/lib/format";
import { createUuidV4 } from "@/lib/random-uuid";

const ALPHABETS = {
  base36: "0123456789abcdefghijklmnopqrstuvwxyz",
  base62: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
  crockford: "0123456789ABCDEFGHJKMNPQRSTVWXYZ",
  hex: "0123456789abcdef",
} as const;

type AlphabetKey = keyof typeof ALPHABETS;

function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytes;
}

function uuidv7(): string {
  const bytes = randomBytes(16);
  const ms = BigInt(Math.floor(Date.now()));
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 9562 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function randomId(length: number, alphabet: AlphabetKey): string {
  const chars = ALPHABETS[alphabet];
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += chars[bytes[i] % chars.length];
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}


// Pure-JS digests: crypto.subtle is undefined on insecure (plain-http tailnet) origins. Text is hashed here (tiny); files stream through hash.worker.ts.
const HASH_FNS = { "SHA-1": sha1, "SHA-256": sha256, "SHA-384": sha384, "SHA-512": sha512 } as const;

export default function IdsTool() {
  const [count, setCount] = useState(5);
  const [length, setLength] = useState(21);
  const [alphabet, setAlphabet] = useState<AlphabetKey>("base62");
  const [ids, setIds] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  const generate = useCallback(
    (kind: "uuid4" | "uuid7" | "random") => {
      const n = Math.min(Math.max(count, 1), 500);
      const next = Array.from({ length: n }, () =>
        kind === "uuid4"
          ? createUuidV4()
          : kind === "uuid7"
            ? uuidv7()
            : randomId(Math.min(Math.max(length, 4), 64), alphabet),
      );
      setIds(next);
    },
    [alphabet, count, length],
  );

  /* ------------------------------------------------------------- hashing */

  const [payload, setPayload] = useState("");
  const [algorithm, setAlgorithm] = useState<HashName>("SHA-256");
  const [digest, setDigest] = useState("");
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fileBytes, setFileBytes] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const hasherRef = useRef<FileHasher | null>(null);
  const [progress, setProgress] = useState<{ bytes: number; total: number; name: string } | null>(null);

  const hashText = useCallback(
    async (text: string, algo: HashName) => {
      setError(null);
      setFileName("");
      setFileBytes(0);
      setDigest(toHex(HASH_FNS[algo](new TextEncoder().encode(text))));
    },
    [],
  );

  const hashFile = useCallback(async (file: File, algo: HashName) => {
    setError(null);
    setBusy(true);
    setPayload("");
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      // Files stream through the worker (constant memory); the cap stays as the documented limit.
      if (file.size > 512 * 1024 * 1024) {
        throw new Error("File hashing is capped at 512 MB in the browser.");
      }
      hasherRef.current ??= new FileHasher();
      setProgress({ bytes: 0, total: file.size, name: file.name });
      const hex = await hasherRef.current.hash(file, algo, {
        signal: controller.signal,
        onProgress: (p) => setProgress({ bytes: p.bytes, total: p.total, name: file.name }),
      });
      setFileName(file.name);
      setFileBytes(file.size);
      setDigest(hex);
    } catch (exc) {
      if (isAbortError(exc)) {
        if (abortRef.current === controller) {
          setError(`Hashing ${file.name} was cancelled.`);
          setDigest("");
        }
        return;
      }
      setError(exc instanceof Error ? exc.message : "Hash failed.");
      setDigest("");
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setBusy(false);
        setProgress(null);
      }
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (payload) void hashText(payload, algorithm).catch((exc: unknown) => {
        setError(exc instanceof Error ? exc.message : "Hash failed.");
        setDigest("");
      });
    }, 120);
    return () => clearTimeout(timer);
  }, [algorithm, hashText, payload]);

  useEffect(() => () => {
    abortRef.current?.abort();
    hasherRef.current?.dispose();
  }, []);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel
        title="Identifiers"
        right={
          <div className="flex gap-1.5">
            <CopyButton text={ids.join("\n")} />
            <Button size="sm" variant="ghost" onClick={() => setIds([])}>Clear</Button>
          </div>
        }
      >
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="How many" className="w-24">
              <NumberField type="text" min={1} max={500} integer value={count} onValueChange={setCount} />
            </Field>
            <Field label="Length" className="w-24">
              <NumberField type="text" min={4} max={64} integer value={length} onValueChange={setLength} />
            </Field>
            <Field label="Alphabet" className="w-36">
              <Select value={alphabet} onChange={(e) => setAlphabet(e.target.value as AlphabetKey)}>
                <option value="base62">Base62</option>
                <option value="base36">Base36</option>
                <option value="crockford">Crockford</option>
                <option value="hex">Hex</option>
              </Select>
            </Field>
          </div>

          <div className="flex flex-wrap gap-1.5">
            <Button variant="primary" onClick={() => generate("uuid4")}>UUID v4</Button>
            <Button variant="subtle" onClick={() => generate("uuid7")}>UUID v7</Button>
            <Button variant="subtle" onClick={() => generate("random")}>Random ID</Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={ids.length === 0}
              onClick={async () => {
                if (await copyText(ids.join("\n"))) {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1400);
                }
              }}
            >
              {copied ? "Copied" : "Copy all"}
            </Button>
          </div>

          <p className="text-xs text-faint">
            v4 = random, v7 = time-ordered (better for indexes). All from{" "}
            <span className="font-mono">crypto.getRandomValues</span>.
          </p>

          {ids.length > 0 ? (
            <>
              <StatGrid>
                <Stat label="Generated" value={ids.length} />
                <Stat label="Each" value={`${ids[0].length} chars`} />
                <Stat label="Unique" value={new Set(ids).size} />
              </StatGrid>
              <TextArea
                readOnly
                rows={12}
                value={ids.join("\n")}
                onFocus={(e) => e.currentTarget.select()}
              />
            </>
          ) : (
            <div className="grid h-40 place-items-center text-sm text-faint">
              Nothing generated yet.
            </div>
          )}
        </div>
      </Panel>

      <Panel
        title="Hashes"
        right={
          <div className="flex gap-1.5">
            <CopyButton text={digest} />
            <Button size="sm" variant="ghost" onClick={() => { setDigest(""); setPayload(""); setFileName(""); }}>
              Clear
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <Field label="Algorithm">
            <Select value={algorithm} onChange={(e) => setAlgorithm(e.target.value as HashName)}>
              {HASH_NAMES.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Text">
            <TextArea
              rows={5}
              spellCheck={false}
              value={payload}
              onChange={(e) => {
                setPayload(e.target.value);
                // Emptying the box must not leave the digest of text that is gone (the effect only hashes non-empty text).
                if (!e.target.value) { setDigest(""); setFileName(""); setFileBytes(0); }
              }}
              placeholder="Type or paste text — digest updates as you type…"
            />
          </Field>

          <Dropzone
            accept="*/*"
            hint="Any file up to 512 MB — read in the browser, never uploaded"
            disabled={busy}
            onFiles={(files) => void hashFile(files[0], algorithm)}
          />

          <div role="status" aria-live="polite" data-agent-region="hash-status">
            {progress ? (
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
                <span>
                  Hashing {progress.name}: {formatBytes(progress.bytes)} of {formatBytes(progress.total)} ({progress.total ? Math.floor((progress.bytes / progress.total) * 100) : 100}%)
                </span>
                <Button size="sm" variant="danger" onClick={() => abortRef.current?.abort()}>Cancel hashing</Button>
              </div>
            ) : null}
          </div>

          {error ? <Notice tone="error">{error}</Notice> : null}

          {digest ? (
            <div className="space-y-2">
              <StatGrid>
                <Stat label="Algorithm" value={algorithm} />
                <Stat label="Hex chars" value={digest.length} />
                <Stat
                  label="Source"
                  value={fileName ? `${fileName} · ${formatBytes(fileBytes)}` : `${payload.length} chars`}
                />
              </StatGrid>
              <TextInput readOnly value={digest} onFocus={(e) => e.currentTarget.select()} className="font-mono text-[12px]" />
            </div>
          ) : (
            <div className="grid h-20 place-items-center text-sm text-faint">
              {busy ? "Hashing…" : "No digest yet."}
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}
