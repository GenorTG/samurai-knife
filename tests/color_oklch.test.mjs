// sRGB <-> OKLCH (src/lib/color-oklch.ts). Bug found 2026-10-10 in a browser walkthrough: `oklch(1 0 0)` came out #fffec9, grey was
// olive, because the inverse matrix had a wrong G and B row. Oracles that do not share the code under test:
//   1. CSS Color 4 / Ottosson reference values (white, black, mid grey, the sRGB primaries),
//   2. a round trip over a colour grid,
//   3. a reference inverse built here by NUMERICALLY inverting the (correct) forward matrices, never from the hard-coded inverse.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/color_oklch.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { linearToSrgb, oklchToRgb, rgbToOklch, srgbToLinear } from "../src/lib/color-oklch.ts";

const rgb = (r, g, b) => ({ r, g, b, a: 1 });
const close = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`);

test("achromatic colours stay achromatic (the bug tinted white yellow and grey olive)", () => {
  assert.deepEqual(oklchToRgb(1, 0, 0), rgb(255, 255, 255));
  assert.deepEqual(oklchToRgb(0, 0, 0), rgb(0, 0, 0));
  assert.deepEqual(oklchToRgb(0.5, 0, 0), rgb(99, 99, 99)); // L 0.5 -> linear 0.125 -> sRGB 0.388 -> 99
  for (const hue of [0, 90, 180, 270, 359]) {
    const grey = oklchToRgb(0.7, 0, hue);
    assert.ok(grey.r === grey.g && grey.g === grey.b, `chroma 0 at hue ${hue}: ${JSON.stringify(grey)}`);
  }
});

test("the sRGB primaries match the CSS Color 4 OKLCH reference values", () => {
  const cases = [
    [[0.62796, 0.25768, 29.234], [255, 0, 0]],
    [[0.86644, 0.29483, 142.495], [0, 255, 0]],
    [[0.45201, 0.31321, 264.052], [0, 0, 255]],
    [[0.96798, 0.21101, 109.769], [255, 255, 0]],
    [[0.90540, 0.15455, 194.769], [0, 255, 255]],
    [[0.70167, 0.32249, 328.363], [255, 0, 255]],
  ];
  for (const [[l, c, h], [r, g, b]] of cases) {
    const got = oklchToRgb(l, c, h);
    close(got.r, r, 1, `oklch(${l} ${c} ${h}) R`);
    close(got.g, g, 1, `oklch(${l} ${c} ${h}) G`);
    close(got.b, b, 1, `oklch(${l} ${c} ${h}) B`);
  }
});

test("rgb -> oklch -> rgb round trips within one level over a colour grid", () => {
  const steps = [0, 32, 64, 96, 128, 160, 192, 224, 255];
  let checked = 0;
  for (const r of steps) for (const g of steps) for (const b of steps) {
    const [L, c, h] = rgbToOklch(rgb(r, g, b));
    const back = oklchToRgb(L, c, h);
    close(back.r, r, 1, `(${r},${g},${b}) R`);
    close(back.g, g, 1, `(${r},${g},${b}) G`);
    close(back.b, b, 1, `(${r},${g},${b}) B`);
    checked += 1;
  }
  assert.equal(checked, 729);
});

// -- reference inverse: invert the forward matrices numerically (3x3 adjugate), independent of any inverse constants in the app
const M1 = [[0.4122214708, 0.5363325363, 0.0514459929], [0.2119034982, 0.6806995451, 0.1073969566], [0.0883024619, 0.2817188376, 0.6299787005]]; // linear rgb -> lms
const M2 = [[0.2104542553, 0.7936177850, -0.0040720468], [1.9779984951, -2.4285922050, 0.4505937099], [0.0259040371, 0.7827717662, -0.8086757660]]; // lms' -> lab
function inverse(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}
const apply = (m, v) => m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
const M1inv = inverse(M1);
const M2inv = inverse(M2);
function referenceOklchToRgb(L, chroma, hueDeg) {
  const h = (hueDeg * Math.PI) / 180;
  const lms = apply(M2inv, [L, chroma * Math.cos(h), chroma * Math.sin(h)]).map((v) => v ** 3);
  const linear = apply(M1inv, lms);
  const encode = (c) => Math.round(Math.min(1, Math.max(0, c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)) * 255);
  return linear.map(encode);
}

test("agrees with a numerically inverted reference on 500 pseudo-random OKLCH colours (in and out of gamut)", () => {
  let seed = 20261010;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  let worst = 0;
  for (let n = 0; n < 500; n++) {
    const L = random();
    const c = random() * 0.3;
    const h = random() * 360;
    const got = oklchToRgb(L, c, h);
    const want = referenceOklchToRgb(L, c, h);
    worst = Math.max(worst, Math.abs(got.r - want[0]), Math.abs(got.g - want[1]), Math.abs(got.b - want[2]));
  }
  // the app's inverse constants are 10 digits, the reference is exact to double precision: allow a single level at most
  assert.ok(worst <= 1, `worst channel difference ${worst}`);
});

test("transfer function pieces: known sRGB values", () => {
  close(srgbToLinear(255), 1, 1e-12, "white");
  close(srgbToLinear(0), 0, 1e-12, "black");
  close(srgbToLinear(128), 0.2158605, 1e-6, "128");
  assert.equal(linearToSrgb(1), 255);
  assert.equal(linearToSrgb(0), 0);
  assert.equal(linearToSrgb(0.2158605), 128);
  assert.equal(linearToSrgb(2), 255, "out of range clamps");
  assert.equal(linearToSrgb(-1), 0, "negative clamps");
});
