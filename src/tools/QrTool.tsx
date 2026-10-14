"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, CopyButton, Field, Notice, Panel, Select, Stat, StatGrid, TextInput } from "@/components/ui";
import { cx, downloadBlob } from "@/lib/format";
import QRCode from "qrcode";

/**
 * QR code generator. SVG for the screen (scales, prints, pastes into docs),
 * PNG for anything that wants a raster. Both are produced locally — the text
 * never leaves the tab.
 */

const LEVELS = ["L", "M", "Q", "H"] as const;

const MIN_SIZE = 64;
const MAX_SIZE = 2048;

function svgToDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

async function dataUriToBlob(dataUri: string): Promise<Blob> {
  const comma = dataUri.indexOf(",");
  if (comma === -1) throw new Error("Malformed data URI.");
  const head = dataUri.slice(0, comma);
  const body = dataUri.slice(comma + 1);
  const match = /^data:([^;]*);base64$/i.exec(head);
  if (!match) throw new Error("Only base64 data URIs can be downloaded.");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: match[1] });
}

export default function QrTool() {
  const [text, setText] = useState("https://github.com/GenorTG/samurai-knife");
  const [sizeText, setSizeText] = useState("512");
  const [marginText, setMarginText] = useState("2");
  const size = Number(sizeText) || MIN_SIZE;
  const margin = Number(marginText) || 0;
  const [level, setLevel] = useState<"L" | "M" | "Q" | "H">("M");
  const [svg, setSvg] = useState("");
  const [pngUri, setPngUri] = useState("");
  const [error, setError] = useState<string | null>(null);

  const options = useMemo(
    () => ({
      width: Math.min(Math.max(size, MIN_SIZE), MAX_SIZE),
      margin: Math.min(Math.max(margin, 0), 16),
      errorCorrectionLevel: level,
    }),
    [size, margin, level],
  );

  const generate = useCallback(async () => {
    if (!text || text.length > 2048) {
      setSvg("");
      setPngUri("");
      setError(null);
      return;
    }
    try {
      const vector = await QRCode.toString(text, { ...options, type: "svg" });
      const raster = await QRCode.toDataURL(
        text,
        { ...options, type: "image/png", color: { dark: "#000000ff", light: "#ffffffff" } },
      );
      setSvg(vector);
      setPngUri(raster);
      setError(null);
    } catch (exc) {
      setSvg("");
      setPngUri("");
      setError(exc instanceof Error ? exc.message : "The QR library rejected this text.");
    }
  }, [options, text]);

  useEffect(() => {
    const timer = setTimeout(generate, 160);
    return () => clearTimeout(timer);
  }, [generate]);

  const tooLong = text.length > 2048;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
      <Panel title="Content">
        <div className="space-y-3">
          <Field label="Text or URL">
            <TextInput
              value={text}
              spellCheck={false}
              onChange={(e) => setText(e.target.value)}
              placeholder="https://…"
              className="font-mono"
            />
          </Field>

          <div className="flex flex-wrap gap-2">
            <Field label="Size" className="w-20">
              <TextInput
                inputMode="numeric"
                value={sizeText}
                onChange={(e) => setSizeText(e.target.value.replace(/\D/g, "").slice(0, 4))}
                onBlur={() => setSizeText(String(Math.min(MAX_SIZE, Math.max(MIN_SIZE, size))))}
              />
            </Field>
            <Field label="Quiet zone" className="w-24">
              <TextInput
                inputMode="numeric"
                value={marginText}
                onChange={(e) => setMarginText(e.target.value.replace(/\D/g, "").slice(0, 2))}
                onBlur={() => setMarginText(String(Math.min(16, Math.max(0, margin))))}
              />
            </Field>
            <Field label="Error correction" className="max-w-64 min-w-48 flex-1">
              <Select value={level} onChange={(e) => setLevel(e.target.value as typeof level)}>
                {LEVELS.map((value) => (
                  <option key={value} value={value}>
                    {value} — {value === "L" ? "7%" : value === "M" ? "15%" : value === "Q" ? "25%" : "30%"} recoverable
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {tooLong ? (
            <Notice tone="error">
              {text.length} characters is past what a QR code can hold at this error level. Shorten it, or drop the level to L.
            </Notice>
          ) : null}
          {error ? <Notice tone="error">{error}</Notice> : null}
        </div>
      </Panel>

      <Panel
        title="Preview"
        right={
          <span className="font-mono text-[11px] text-faint">
            {svg ? `${options.width}px · ${level}` : "idle"}
          </span>
        }
      >
        <div className="space-y-3">
          {svg ? (
            <div
              className={cx(
                "rounded-tool overflow-hidden bg-[#ecebe7] p-3",
                "grid place-items-center",
              )}
            >
              {/* The SVG comes from the library: rects only, no user text. */}
              <div
                className="max-w-full [&_svg]:block [&_svg]:h-auto [&_svg]:max-w-full"
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            </div>
          ) : (
            <div className="grid h-48 place-items-center text-sm text-faint">
              Type something above — the code renders here.
            </div>
          )}

          <div className="flex flex-wrap gap-1.5">
            <CopyButton text={svgToDataUri(svg)} label="Copy SVG URI" />
            <Button
              size="sm"
              variant="subtle"
              disabled={!pngUri}
              onClick={async () => {
                try {
                  downloadBlob(await dataUriToBlob(pngUri), `qr-${options.width}.png`);
                } catch {
                  /* A bad data URI is already surfaced by `error`. */
                }
              }}
            >
              Download PNG
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setText(""); setSvg(""); setPngUri(""); }}>
              Clear
            </Button>
          </div>

          <StatGrid>
            <Stat label="Characters" value={text.length} />
            <Stat label="SVG bytes" value={svg.length} />
            <Stat label="PNG size" value={`${Math.round(pngUri.length * 0.75)} B`} />
          </StatGrid>
        </div>
      </Panel>
    </div>
  );
}
