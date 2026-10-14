/**
 * sRGB <-> OKLCH (Björn Ottosson's Oklab, https://bottosson.github.io/posts/oklab/). Pure; channels are 0-255 integers on output.
 * Both directions use the canonical matrices: the inverse once had a wrong G and B row (white came out #fffec9), found
 * 2026-10-10 by comparing the page with an independent Oklab inverse in a browser walkthrough.
 */
export type Rgb = { r: number; g: number; b: number; a: number };

export function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
}

function oklabFromLinear(r: number, g: number, b: number): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040792471 * s,
    1.9779984543 * l - 2.4285922265 * m + 0.4505937011 * s,
    0.0259040371 * l + 0.7827712382 * m - 0.8086757084 * s,
  ];
}

export function rgbToOklch(color: Rgb): [number, number, number] {
  const [L, a, b] = oklabFromLinear(
    srgbToLinear(color.r),
    srgbToLinear(color.g),
    srgbToLinear(color.b),
  );
  const chroma = Math.hypot(a, b);
  const hue = (Math.atan2(b, a) * 180) / Math.PI;
  return [L, chroma, (hue + 360) % 360];
}

export function oklchToRgb(L: number, chroma: number, hueDeg: number): Rgb {
  const h = (hueDeg * Math.PI) / 180;
  const a = chroma * Math.cos(h);
  const b = chroma * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  return {
    r: linearToSrgb((l_ ** 3) * 4.0767416621 - (m_ ** 3) * 3.3077115913 + (s_ ** 3) * 0.2309699292),
    g: linearToSrgb(-(l_ ** 3) * 1.2684380046 + (m_ ** 3) * 2.6097574011 - (s_ ** 3) * 0.3413193965),
    b: linearToSrgb(-(l_ ** 3) * 0.0041960863 - (m_ ** 3) * 0.7034186147 + (s_ ** 3) * 1.7076147010),
    a: 1,
  };
}
