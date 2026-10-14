// Markdown preview stats: an image is not also a link.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/markdown_counts.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { countLinksAndImages } from "../src/lib/markdown-counts.ts";

const CASES = [
  ["empty", "", 0, 0],
  ["plain text", "no links here", 0, 0],
  ["link only", "see [a](b)", 1, 0],
  ["image only", "![i](j)", 0, 1],
  ["both (the walkthrough input)", "# T\nOne two [a](b) ![i](j)", 1, 1],
  ["image with a link inside it: link wrapping an image", "[![i](j)](k)", 1, 1],
  ["linked image next to a plain link", "[![i](j)](k) and [x](y)", 2, 1],
  ["two images, one link", "![a](1) ![b](2) [c](3)", 1, 2],
  ["image with empty alt and a title", '![](a.png "t") [l](u)', 1, 1],
  ["reference-style links and images are left as they are", "[a][1] ![b][2]\n\n[1]: http://x\n[2]: http://y", 0, 0],
  ["several links on several lines", "[a](1)\n[b](2)\n[c](3)", 3, 0],
];

for (const [name, markdown, links, images] of CASES) {
  test(`links/images: ${name}`, () => {
    assert.deepEqual(countLinksAndImages(markdown), { links, images });
  });
}
