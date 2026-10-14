"use client";

import { useCallback, useState } from "react";
import { Button, CopyButton, Dropzone, Field, Notice, Panel, Select, Stat, StatGrid } from "@/components/ui";
import { formatBytes, readAsDataURL } from "@/lib/format";

type Mode = "data-uri" | "base64" | "css" | "html" | "markdown";

const MODES: { value: Mode; label: string }[] = [
  { value: "data-uri", label: "data:image/…;base64,…" },
  { value: "base64", label: "raw base64 only" },
  { value: "css", label: "CSS background-image" },
  { value: "html", label: "HTML <img>" },
  { value: "markdown", label: "Markdown image" },
];

const SIZE_WARN = 250_000;

export default function ImageDataUri() {
  const [file, setFile] = useState<File | null>(null);
  const [dataUri, setDataUri] = useState("");
  const [mode, setMode] = useState<Mode>("data-uri");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (incoming: File) => {
    if (!incoming.type.startsWith("image/")) {
      setError("That is not an image file.");
      return;
    }
    setError(null);
    setFile(incoming);
    try {
      setDataUri(await readAsDataURL(incoming));
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Could not read that file.");
    }
  }, []);

  const output = (() => {
    if (!dataUri || !file) return "";
    switch (mode) {
      case "base64":
        return dataUri.slice(dataUri.indexOf(",") + 1);
      case "css":
        return `background-image: url("${dataUri}");`;
      case "html":
        return `<img src="${dataUri}" alt="${file.name}" />`;
      case "markdown":
        return `![${file.name.replace(/\.[^.]+$/, "")}](${dataUri})`;
      default:
        return dataUri;
    }
  })();

  const oversized = (file?.size ?? 0) > SIZE_WARN;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
      <div className="space-y-4">
        {!file ? (
          <Dropzone accept="image/*" hint="Small PNG, JPEG, SVG, GIF" onFiles={(files) => void load(files[0])} />
        ) : (
          <>
            <Panel
              title="Source"
              right={
                <Button size="sm" variant="ghost" onClick={() => { setFile(null); setDataUri(""); }}>
                  Clear
                </Button>
              }
            >
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={dataUri || undefined} alt="" className="size-14 shrink-0 rounded-lg border border-line bg-raised object-contain p-1" />
                  <div className="min-w-0 text-sm">
                    <p className="truncate text-ink">{file.name}</p>
                    <p className="mt-0.5 font-mono text-xs text-faint">
                      {file.type || "image"} · {formatBytes(file.size)}
                    </p>
                  </div>
                </div>
                {oversized ? (
                  <Notice tone="error">
                    {formatBytes(file.size)} is a lot of base64. Data URIs this big bloat CSS and
                    kill page performance — host the file instead.
                  </Notice>
                ) : null}
              </div>
            </Panel>

            <Panel title="Wrap as">
              <Field label="Output shape">
                <Select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
                  {MODES.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </Panel>
          </>
        )}
      </div>

      <Panel
        title="Output"
        right={
          <div className="flex gap-1.5">
            <CopyButton text={output} />
            {output ? (
              <Button
                size="sm"
                variant="subtle"
                onClick={() => {
                  const blob = new Blob([output], { type: "text/plain;charset=utf-8" });
                  const url = URL.createObjectURL(blob);
                  const link = document.createElement("a");
                  link.href = url;
                  link.download = `${file?.name.replace(/\.[^.]+$/, "") ?? "image"}.txt`;
                  link.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                }}
              >
                Save .txt
              </Button>
            ) : null}
          </div>
        }
      >
        {error ? <Notice tone="error">{error}</Notice> : null}
        {output ? (
          <div className="space-y-3">
            <StatGrid>
              <Stat label="Characters" value={output.length.toLocaleString("en-US")} />
              <Stat label="Encoded" value={formatBytes(output.length)} />
              <Stat label="Overhead" value={`${Math.round((output.length / Math.max(file?.size ?? 1, 1) - 1) * 100)}%`} />
            </StatGrid>
            <pre className="sk-input max-h-[52vh] overflow-auto px-3 py-2.5 font-mono text-[12px] leading-relaxed break-all whitespace-pre-wrap">
              {output}
            </pre>
          </div>
        ) : (
          <div className="grid h-64 place-items-center text-sm text-faint">
            Drop an image and the string appears here.
          </div>
        )}
      </Panel>
    </div>
  );
}
