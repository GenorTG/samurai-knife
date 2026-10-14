"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CopyButton, Dropzone, Field, KeyValues, Notice, OutputBlock, Panel, Stat, StatGrid, TextInput } from "@/components/ui";
import { oklchToRgb, rgbToOklch, srgbToLinear, linearToSrgb, type Rgb } from "@/lib/color-oklch";
import { cx, clamp } from "@/lib/format";
import { readAsDataURL } from "@/lib/format";

/**
 * Colour workbench. Parses hex / rgb() / hsl() / oklch(), converts between
 * them, checks WCAG contrast against the knife's own background and ink, and
 * builds a tint ramp in *linear* light (mixing in sRGB space gives muddy
 * midtones, which is exactly what people complain about).
 */

const THEME_BG: Rgb = { r: 0x0a, g: 0x0a, b: 0x09, a: 1 };
const THEME_INK: Rgb = { r: 0xec, g: 0xeb, b: 0xe7, a: 1 };




function relativeLuminance(color: Rgb): number {
  return (
    0.2126 * srgbToLinear(color.r) +
    0.7152 * srgbToLinear(color.g) +
    0.0722 * srgbToLinear(color.b)
  );
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function hexToRgb(input: string): Rgb | null {
  const value = input.replace(/^#/, "");
  const hex = value.length === 3 || value.length === 4
    ? value.split("").map((c) => c + c).join("")
    : value;
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(hex)) return null;
  const chunk = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16);
  return { r: chunk(0), g: chunk(2), b: chunk(4), a: hex.length === 8 ? chunk(6) / 255 : 1 };
}

function rgbToHex(color: Rgb): string {
  const part = (n: number) => Math.round(n).toString(16).padStart(2, "0");
  const base = `#${part(color.r)}${part(color.g)}${part(color.b)}`;
  return color.a < 1 ? `${base}${part(Math.round(color.a * 255))}` : base;
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    hue < 60 ? [c, x, 0]
      : hue < 120 ? [x, c, 0]
        : hue < 180 ? [0, c, x]
          : hue < 240 ? [0, x, c]
            : hue < 300 ? [x, 0, c]
              : [c, 0, x];
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
    a: 1,
  };
}

function hslLabel(color: Rgb): string {
  const [h, s, l] = rgbToHsl(color);
  return `hsl(${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;
}

function oklchLabel(color: Rgb): string {
  const [L, chroma, hue] = rgbToOklch(color);
  return `oklch(${L.toFixed(3)} ${chroma.toFixed(3)} ${Math.round(hue)})`;
}

function rgbToHsl(color: Rgb): [number, number, number] {
  const r = color.r / 255;
  const g = color.g / 255;
  const b = color.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r ? ((g - b) / d + (g < b ? 6 : 0))
      : max === g ? (b - r) / d + 2
        : (r - g) / d + 4;
  return [h * 60, s, l];
}




function parseNumber(arg: string, percentScale: number): number {
  return arg.endsWith("%") ? (Number(arg.slice(0, -1)) / 100) * percentScale : Number(arg);
}

function parseColor(input: string): Rgb | null {
  const value = input.trim().replace(/\s+/g, " ");
  if (!value) return null;
  if (/^#/.test(value)) return hexToRgb(value);

  const fn = /^([a-z]+)\(([^)]*)\)$/i.exec(value);
  if (!fn) return null;
  const name = fn[1].toLowerCase();
  const args = fn[2].split(/[\s,/]+/).filter(Boolean);
  const alphaOf = (index: number): number => (args.length > index ? clamp(parseNumber(args[index], 1), 0, 1) : 1);
  let color: Rgb | null = null;

  if (name === "rgb" || name === "rgba") {
    if (args.length < 3) return null;
    const [r, g, b] = args.slice(0, 3).map((arg) => clamp(parseNumber(arg, 255), 0, 255));
    color = { r: Math.round(r), g: Math.round(g), b: Math.round(b), a: alphaOf(3) };
  } else if (name === "hsl" || name === "hsla") {
    if (args.length < 3) return null;
    const h = Number(args[0].replace(/deg$/, ""));
    const s = clamp(Number(args[1].replace(/%$/, "")) / 100, 0, 1);
    const l = clamp(Number(args[2].replace(/%$/, "")) / 100, 0, 1);
    color = { ...hslToRgb(h, s, l), a: alphaOf(3) };
  } else if (name === "oklch") {
    if (args.length < 3) return null;
    const L = parseNumber(args[0], 1);
    const chroma = args[1] === "none" ? 0 : parseNumber(args[1], 0.4);
    const hue = args[2] === "none" ? 0 : Number(args[2].replace(/deg$/, ""));
    color = { ...oklchToRgb(L, chroma, hue), a: alphaOf(3) };
  }

  if (!color || ![color.r, color.g, color.b, color.a].every(Number.isFinite)) return null;
  return color;
}

function mixLinear(a: Rgb, b: Rgb, t: number): Rgb {
  const blend = (ca: number, cb: number) => {
    const la = srgbToLinear(ca);
    const lb = srgbToLinear(cb);
    return linearToSrgb(la + (lb - la) * t);
  };
  return { r: blend(a.r, b.r), g: blend(a.g, b.g), b: blend(a.b, b.b), a: a.a };
}

async function paletteFromDataUri(dataUri: string): Promise<string[]> {
  const image = new Image();
  image.src = dataUri;
  try {
    await image.decode();
  } catch {
    return [];
  }
  const scale = 128 / Math.max(image.width || 1, image.height || 1);
  const width = Math.max(1, Math.round((image.width || 1) * Math.min(scale, 1)));
  const height = Math.max(1, Math.round((image.height || 1) * Math.min(scale, 1)));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return [];
  context.drawImage(image, 0, 0, width, height);
  const data = context.getImageData(0, 0, width, height).data;

  const buckets = new Map<string, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const key = `${data[i] >> 4}-${data[i + 1] >> 4}-${data[i + 2] >> 4}`;
    const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bucket.n += 1;
    bucket.r += data[i];
    bucket.g += data[i + 1];
    bucket.b += data[i + 2];
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, 8)
    .map((x) => rgbToHex({ r: x.r / x.n, g: x.g / x.n, b: x.b / x.n, a: 1 }));
}

export default function ColorTool() {
  const [input, setInput] = useState("#c9a227");
  const [palette, setPalette] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = useMemo(() => parseColor(input), [input]);

  const loadFile = useCallback(async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      setPalette(await paletteFromDataUri(await readAsDataURL(file)));
    } catch {
      setError("Could not read that image.");
      setPalette([]);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!input.trim()) {
        setError(null);
        return;
      }
      if (!parsed) setError(`"${input.trim()}" is not hex, rgb(), hsl() or oklch().`);
      else setError(null);
    }, 140);
    return () => clearTimeout(timer);
  }, [input, parsed]);

  const ramp = useMemo(() => {
    if (!parsed) return [];
    const white = { r: 255, g: 255, b: 255, a: 1 };
    const black = { r: 0, g: 0, b: 0, a: 1 };
    const steps: Rgb[] = [];
    for (let i = 4; i >= 1; i -= 1) steps.push(mixLinear(parsed, white, i / 5));
    steps.push(parsed);
    for (let i = 1; i <= 4; i += 1) steps.push(mixLinear(parsed, black, i / 5));
    return steps;
  }, [parsed]);

  const contrast = useMemo(() => {
    if (!parsed) return null;
    const onBg = contrastRatio(parsed, THEME_BG);
    const onInk = contrastRatio(parsed, THEME_INK);
    const grade = (ratio: number) =>
      ratio >= 7 ? "AAA" : ratio >= 4.5 ? "AA" : ratio >= 3 ? "AA large" : "fails";
    return { onBg, onInk, bgGrade: grade(onBg), inkGrade: grade(onInk) };
  }, [parsed]);

  const cssBlock = useMemo(() => {
    if (!parsed) return "";
    const lines = ramp.map((step, index) => `  --knife-${String(index + 1).padStart(2, "0")}: ${rgbToHex(step)};`);
    return `:root {\n${lines.join("\n")}\n}`;
  }, [parsed, ramp]);

  const swatch = parsed ? rgbToHex(parsed) : "";

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
      <Panel title="Colour">
        <div className="space-y-3">
          <Field label="Any format the browser understands">
            <TextInput
              value={input}
              spellCheck={false}
              onChange={(e) => setInput(e.target.value)}
              placeholder="#c9a227 · rgb(201 162 39) · hsl(43 62% 51%) · oklch(0.72 0.11 85)"
              className="font-mono"
            />
          </Field>

          {error ? <Notice tone="error">{error}</Notice> : null}

          {parsed ? (
            <div className="space-y-3">
              <div
                className={cx("rounded-tool border border-line h-16", "bg-[color]")}
                style={{ background: swatch }}
              />
              <KeyValues
                rows={[
                  ["HEX", swatch],
                  ["RGB", `rgb(${parsed.r} ${parsed.g} ${parsed.b})`],
                  ["HSL", hslLabel(parsed)],
                  ["OKLCH", oklchLabel(parsed)],
                  ["Alpha", parsed.a < 1 ? String(parsed.a.toFixed(2)) : "opaque"],
                ]}
              />
            </div>
          ) : null}
        </div>
      </Panel>

      <Panel title="Contrast against this app">
        {contrast ? (
          <div className="space-y-3">
            <StatGrid>
              <Stat label="On the dark bg" value={`${contrast.onBg.toFixed(2)} : 1 · ${contrast.bgGrade}`} />
              <Stat label="On the ink colour" value={`${contrast.onInk.toFixed(2)} : 1 · ${contrast.inkGrade}`} />
            </StatGrid>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-tool border border-line bg-[#0a0a09] p-3 text-[13px]" style={{ color: swatch || undefined }}>
                this text on the app background
              </div>
              <div className="rounded-tool border border-line bg-[#ecebe7] p-3 text-[13px]" style={{ color: swatch || undefined }}>
                this text on the app ink
              </div>
            </div>
            <p className="text-xs text-faint">
              WCAG 2.1: AA needs 4.5:1, large text 3:1, AAA 7:1.
            </p>
          </div>
        ) : (
          <p className="text-sm text-faint">Parse a colour above to check it.</p>
        )}
      </Panel>

      <Panel
        title="Tint ramp"
        right={
          <div className="flex gap-1.5">
            <CopyButton text={cssBlock} label="Copy CSS" />
          </div>
        }
      >
        <div className="space-y-3">
          <div className="grid grid-cols-9 gap-1">
            {ramp.map((step, index) => (
              <div
                key={index}
                className={cx("rounded-md border border-line h-8", "bg-[color]")}
                style={{ background: rgbToHex(step) }}
                title={rgbToHex(step)}
              />
            ))}
          </div>
          <OutputBlock value={cssBlock} rows={10} empty="Parse a colour above." />
          <p className="text-xs text-faint">
            Mixed in linear light, so the midtones stay clean.
          </p>
        </div>
      </Panel>

      <Panel
        title="Palette from an image"
        right={
          <span className="font-mono text-[11px] text-faint">
            {palette.length ? `${palette.length} swatches` : "idle"}
          </span>
        }
      >
        <div className="space-y-3">
          <Dropzone
            accept="image/*"
            hint="Read in the browser and sampled at ≤128 px — never uploaded"
            disabled={busy}
            onFiles={(files) => void loadFile(files[0])}
          />
          {palette.length ? (
            <div className="grid grid-cols-4 gap-2">
              {palette.map((hex) => (
                <div key={hex} className="space-y-1">
                  <div
                    className={cx("rounded-md border border-line h-10", "bg-[color]")}
                    style={{ background: hex }}
                  />
                  <TextInput readOnly value={hex} onFocus={(e) => e.currentTarget.select()} className="font-mono text-[12px]" />
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-faint">
              {busy ? "Sampling…" : "Drop an image — the dominant colours come out as copyable hex."}
            </p>
          )}
        </div>
      </Panel>
    </div>
  );
}
