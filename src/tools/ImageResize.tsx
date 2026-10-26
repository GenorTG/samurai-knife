"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, CopyButton, Dropzone, Field, Notice, NumberField, Panel, Select, Stat, StatGrid, TextInput, WorkStatus } from "@/components/ui";
import { clamp, cx, downloadBlob, formatBytes } from "@/lib/format";
import { resizeInWorker } from "@/lib/image-resize-client";
import { isAbortError } from "@/lib/workers/errors";
import { useT } from "@/lib/i18n/react";
import { msg } from "@/lib/i18n/msg";

type Format = "image/png" | "image/jpeg" | "image/webp";

const FORMATS: { value: Format; label: string; ext: string }[] = [
  { value: "image/png", label: "PNG", ext: "png" },
  { value: "image/jpeg", label: "JPEG", ext: "jpg" },
  { value: "image/webp", label: "WebP", ext: "webp" },
];

const PRESETS = [
  { label: msg("Original"), w: 0, h: 0 },
  { label: "1200 w", w: 1200, h: 0 },
  { label: "1920 w", w: 1920, h: 0 },
  { label: "800 × 600", w: 800, h: 600 },
  { label: "512 × 512", w: 512, h: 512 },
];

interface Source {
  name: string;
  bytes: number;
  width: number;
  height: number;
  type: string;
  url: string;
  file: File;
}

export default function ImageResize() {
  const { t } = useT();
  const [source, setSource] = useState<Source | null>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [lockRatio, setLockRatio] = useState(true);
  const [format, setFormat] = useState<Format>("image/png");
  const [quality, setQuality] = useState(0.9);
  const [background, setBackground] = useState("#ffffff");
  const [fillMode, setFillMode] = useState<"contain" | "cover">("contain");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ blob: Blob; url: string } | null>(null);
  const ratioRef = useRef(1);
  const cancelRef = useRef<AbortController | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(0);
  const [cancelled, setCancelled] = useState(false);

  const loadFile = useCallback(async (file: File) => {
    if (!file.type.startsWith("image/")) {
      setError(t("That is not an image file."));
      return;
    }
    setError(null);
    setResult(null);
    try {
      // Dimensions come from a (background-decoded) bitmap; the preview/source URL is a blob URL, not a megabytes-long data URL.
      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      } catch {
        throw new Error(t("Could not decode that image."));
      }
      const next: Source = {
        name: file.name,
        bytes: file.size,
        width: bitmap.width,
        height: bitmap.height,
        type: file.type || "image",
        url: URL.createObjectURL(file),
        file,
      };
      bitmap.close();
      ratioRef.current = next.width / next.height;
      setSource(next);
      setWidth(next.width);
      setHeight(next.height);
      // Keep the source format when the browser can encode it.
      setFormat((current) =>
        file.type === "image/jpeg" ? "image/jpeg" : file.type === "image/webp" ? "image/webp" : current,
      );
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : t("Could not read that image."));
    }
  }, [t]);

  const setWidthSafely = (value: number) => {
    const w = clamp(Math.round(value) || 0, 1, 8192);
    setWidth(w);
    if (lockRatio && source) {
      setHeight(clamp(Math.round(w / ratioRef.current) || 1, 1, 8192));
    }
  };

  const setHeightSafely = (value: number) => {
    const h = clamp(Math.round(value) || 0, 1, 8192);
    setHeight(h);
    if (lockRatio && source) {
      setWidth(clamp(Math.round(h * ratioRef.current) || 1, 1, 8192));
    }
  };

  useEffect(() => {
    ratioRef.current = source ? source.width / source.height : 1;
  }, [source]);

  // Decode, resize and re-encode run in a worker (a 24 MP source used to freeze the tab for a third of a second or more).
  const render = useCallback(
    async (signal: AbortSignal) => {
      if (!source || width < 1 || height < 1) return;
      setBusy(true);
      setError(null);
      setCancelled(false);
      const started = performance.now();
      setStartedAt(started);
      setNow(started);
      try {
        const blob = await resizeInWorker({ file: source.file, width, height, fit: fillMode, format, quality, background }, signal);
        if (signal.aborted) return;
        setResult((previous) => {
          if (previous) URL.revokeObjectURL(previous.url);
          return { blob, url: URL.createObjectURL(blob) };
        });
        setBusy(false);
      } catch (exc) {
        if (isAbortError(exc)) {
          // superseded by a newer render (it owns `busy`) or cancelled by the user (cancel() clears it)
          return;
        }
        setError(exc instanceof Error ? exc.message : t("Resize failed."));
        setBusy(false);
      }
    },
    [t, background, fillMode, format, height, quality, source, width],
  );

  useEffect(() => {
    if (!source) return;
    const controller = new AbortController();
    cancelRef.current = controller;
    const timer = setTimeout(() => void render(controller.signal), 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [render, source]);

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setNow(performance.now()), 250);
    return () => clearInterval(timer);
  }, [busy]);

  // Blob URLs live as long as their image: free the source one when it is replaced or the tool closes.
  useEffect(() => () => { if (source) URL.revokeObjectURL(source.url); }, [source]);

  const cancel = () => {
    cancelRef.current?.abort();
    setBusy(false);
    setCancelled(true);
  };

  const outName = useMemo(() => {
    if (!source) return "image";
    const ext = FORMATS.find((f) => f.value === format)?.ext ?? "png";
    return `${source.name.replace(/\.[^.]+$/, "")}-${width}x${height}.${ext}`;
  }, [format, height, source, width]);

  const savings = result && source ? ((1 - result.blob.size / source.bytes) * 100) : 0;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="space-y-4">
        {!source ? (
          <Dropzone
            accept="image/*"
            hint={t("PNG, JPEG, WebP, GIF, SVG — decoded locally")}
            onFiles={(files) => void loadFile(files[0])}
          />
        ) : (
          <>
            <Panel
              title={t("Source")}
              right={
                <Button size="sm" variant="ghost" onClick={() => { setSource(null); setResult(null); setError(null); }}>
                  {t("Clear")}
                </Button>
              }
            >
              <div className="flex items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={source.url}
                  alt=""
                  className="size-12 shrink-0 rounded-lg border border-line object-cover"
                />
                <div className="min-w-0 text-sm">
                  <p className="truncate text-ink">{source.name}</p>
                  <p className="mt-0.5 font-mono text-xs text-faint">
                    {source.width}×{source.height} · {formatBytes(source.bytes)} · {source.type}
                  </p>
                </div>
              </div>
            </Panel>

            <Panel title={t("Output size")}>
              <div className="space-y-3">
                <div className="flex flex-wrap gap-1.5">
                  {PRESETS.map((preset) => (
                    <Button
                      key={preset.label}
                      size="sm"
                      variant={
                        width === (preset.w || source.width) &&
                        height === (preset.h || source.height)
                          ? "primary"
                          : "subtle"
                      }
                      onClick={() => {
                        if (preset.w === 0 && preset.h === 0) {
                          setWidth(source.width);
                          setHeight(source.height);
                          return;
                        }
                        if (preset.h === 0) setWidthSafely(preset.w);
                        else {
                          setWidth(preset.w);
                          setHeight(preset.h);
                        }
                      }}
                    >
                      {t(preset.label)}
                    </Button>
                  ))}
                </div>

                <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
                  <Field label={t("Width")}>
                    <NumberField type="text" min={1} max={8192} integer value={width} onValueChange={setWidthSafely} />
                  </Field>
                  <button
                    autoComplete="off"
                    type="button"
                    onClick={() => setLockRatio((v) => !v)}
                    title={t("Lock aspect ratio")}
                    className={cx(
                      "mb-1 rounded-lg border px-3 py-2 text-sm transition-colors",
                      lockRatio
                        ? "border-accent/40 bg-accent/10 text-accent-soft"
                        : "border-line bg-surface text-faint hover:text-ink",
                    )}
                  >
                    {lockRatio ? "🔗" : "⛓️‍💥"}
                  </button>
                  <Field label={t("Height")}>
                    <NumberField type="text" min={1} max={8192} integer value={height} onValueChange={setHeightSafely} />
                  </Field>
                </div>

                <Field label={t("Fit")} hint={t("Cover crops to fill the box; contain leaves margins.")}>
                  <Select value={fillMode} onChange={(e) => setFillMode(e.target.value as "contain" | "cover")}>
                    <option value="contain">{t("Contain — fit inside, no crop")}</option>
                    <option value="cover">{t("Cover — fill the box, crop edges")}</option>
                  </Select>
                </Field>
              </div>
            </Panel>

            <Panel title={t("Encoding")}>
              <div className="space-y-3">
                <Field label={t("Format")}>
                  <Select value={format} onChange={(e) => setFormat(e.target.value as Format)}>
                    {FORMATS.map((f) => (
                      <option key={f.value} value={f.value}>
                        {t(f.label)}
                      </option>
                    ))}
                  </Select>
                </Field>
                {format !== "image/png" ? (
                  <>
                    <Field label={t("Quality — {value}", { value: Math.round(quality * 100) })}>
                      <input
                        type="range"
                        min={10}
                        max={100}
                        value={Math.round(quality * 100)}
                        onChange={(e) => setQuality(Number(e.target.value) / 100)}
                        className="w-full accent-[var(--color-accent)]"
                      />
                    </Field>
                    <Field label={t("Flatten onto")} hint={t("Transparency is filled with this colour.")}>
                      <div className="flex gap-2">
                        <input
                          type="color"
                          value={background}
                          onChange={(e) => setBackground(e.target.value)}
                          className="sk-input size-11 p-1"
                          aria-label={t("Background colour")}
                        />
                        <TextInput value={background} onChange={(e) => setBackground(e.target.value)} />
                      </div>
                    </Field>
                  </>
                ) : (
                  <Notice>{t("PNG keeps transparency and stays lossless.")}</Notice>
                )}
              </div>
            </Panel>
          </>
        )}
      </div>

      <div className="space-y-4">
        <Panel
          title={t("Result")}
          right={
            result ? (
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => result && downloadBlob(result.blob, outName)}
                >
                  {t("Download")}
                </Button>
              </div>
            ) : null
          }
        >
          <WorkStatus running={busy} elapsedMs={Math.max(0, now - startedAt)} label={t("Resizing image")} cancelLabel={t("Cancel resizing")} onCancel={cancel} />
          {cancelled && !busy ? <Notice>{t("Resizing cancelled. Change a setting to resize again.")}</Notice> : null}
          {error ? (
            <Notice tone="error">{error}</Notice>
          ) : !source ? (
            <div className="grid h-64 place-items-center text-sm text-faint">
              {t("Pick an image to start.")}
            </div>
          ) : busy ? (
            <div className="grid h-64 place-items-center text-sm text-faint">{t("Rendering…")}</div>
          ) : result ? (
            <div className="space-y-3">
              <div className="grid max-h-[46vh] place-items-center overflow-auto rounded-lg border border-line bg-raised/40 p-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={result.url} alt={t("Resized result")} className="max-w-full object-contain" />
              </div>
              <StatGrid>
                <Stat label={t("Dimensions")} value={`${width}×${height}`} />
                <Stat label={t("Size")} value={formatBytes(result.blob.size)} />
                <Stat
                  label={t("vs source")}
                  value={
                    source
                      ? `${savings > 0 ? "−" : "+"}${Math.abs(savings).toFixed(0)}%`
                      : "—"
                  }
                />
              </StatGrid>
              <CopyButton text={outName} label={t("Copy filename")} />
            </div>
          ) : (
            <div className="grid h-64 place-items-center text-sm text-faint">{t("Rendering…")}</div>
          )}
        </Panel>
      </div>
    </div>
  );
}
