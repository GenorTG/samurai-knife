"use client";

import { useState } from "react";
import { Button, Dropzone, Field, Notice, Panel, Select, Stat, StatGrid } from "@/components/ui";
import { downloadBlob, formatBytes } from "@/lib/format";

type Algorithm = "gzip" | "deflate";
type Operation = "compress" | "decompress";

const MAX_FILE_BYTES = 512 * 1024 * 1024;

function outputName(name: string, operation: Operation, algorithm: Algorithm): string {
  if (operation === "compress") return `${name}.${algorithm === "gzip" ? "gz" : "deflate"}`;
  if (name.toLowerCase().endsWith(".gz")) return name.slice(0, -3) || "decompressed";
  if (name.toLowerCase().endsWith(".deflate")) return name.slice(0, -8) || "decompressed";
  return `${name}.decompressed`;
}

async function transform(file: File, operation: Operation, algorithm: Algorithm): Promise<Blob> {
  if (typeof CompressionStream === "undefined" || typeof DecompressionStream === "undefined") {
    throw new Error("This browser does not support the native Compression Streams API.");
  }
  const stream = operation === "compress"
    ? file.stream().pipeThrough(new CompressionStream(algorithm))
    : file.stream().pipeThrough(new DecompressionStream(algorithm));
  const reader = stream.getReader();
  const chunks: BlobPart[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_FILE_BYTES) {
        await reader.cancel();
        throw new Error("Expanded output exceeds the 512 MB safety limit.");
      }
      chunks.push(new Uint8Array(value));
    }
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks, { type: "application/octet-stream" });
}

export default function FileCompressor() {
  const [file, setFile] = useState<File | null>(null);
  const [operation, setOperation] = useState<Operation>("compress");
  const [algorithm, setAlgorithm] = useState<Algorithm>("gzip");
  const [result, setResult] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const process = async () => {
    if (!file) return;
    setResult(null);
    setError(null);
    if (file.size > MAX_FILE_BYTES) {
      setError("Files are capped at 512 MB to keep browser memory bounded.");
      return;
    }
    setBusy(true);
    try {
      setResult(await transform(file, operation, algorithm));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not process this stream. Check the file and algorithm.");
    } finally {
      setBusy(false);
    }
  };

  const resultName = file ? outputName(file.name, operation, algorithm) : "output";
  const savings = file && result ? ((1 - result.size / file.size) * 100) : null;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Local file">
        <div className="space-y-3">
          <Dropzone hint="Choose any file — it never leaves this tab" onFiles={(files) => { setFile(files[0]); setResult(null); setError(null); }} />
          {file ? <StatGrid><Stat label="File" value={file.name} /><Stat label="Size" value={formatBytes(file.size)} /></StatGrid> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Operation">
              <Select value={operation} onChange={(event) => { setOperation(event.target.value as Operation); setResult(null); }}>
                <option value="compress">Compress</option><option value="decompress">Decompress</option>
              </Select>
            </Field>
            <Field label="Stream format">
              <Select value={algorithm} onChange={(event) => { setAlgorithm(event.target.value as Algorithm); setResult(null); }}>
                <option value="gzip">gzip (.gz)</option><option value="deflate">Deflate (.deflate)</option>
              </Select>
            </Field>
          </div>
          <Button variant="primary" disabled={!file || busy} onClick={() => void process()}>{busy ? "Processing…" : operation === "compress" ? "Compress file" : "Decompress file"}</Button>
          {error ? <Notice tone="error">{error}</Notice> : null}
        </div>
      </Panel>
      <Panel title="Result">
        {result && file ? (
          <div className="space-y-3">
            <StatGrid><Stat label="Output" value={resultName} /><Stat label="Size" value={formatBytes(result.size)} /></StatGrid>
            <Notice tone={operation === "compress" && savings !== null && savings > 0 ? "good" : "info"}>
              {operation === "compress" ? `Size changed by ${savings?.toFixed(1)}% (${savings !== null && savings >= 0 ? "smaller" : "larger"}).` : "Decompression completed. The original file type is inferred from its filename only."}
            </Notice>
            <Button variant="primary" onClick={() => downloadBlob(result, resultName)}>Download {resultName}</Button>
          </div>
        ) : <p className="py-12 text-center text-sm text-faint">Choose a file and run the operation.</p>}
      </Panel>
      <p className="text-xs text-faint lg:col-span-2">gzip and zlib-wrapped deflate are stream formats, not ZIP archives. Processing is local and capped at 512 MB; already-compressed files may get larger.</p>
    </div>
  );
}
