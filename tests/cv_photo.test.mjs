// CV photo store (src/lib/cv/photo-store.ts) and the layout rules (src/lib/cv/render/layout.ts).
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/cv_photo.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "knife-cv-photo-"));
process.env.KNIFE_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const { CvPhotoError, decodeJpegDataUrl, deletePhoto, MAX_PHOTO_BYTES, photoMeta, readPhoto, savePhoto } = await import("../src/lib/cv/photo-store.ts");
const { CV_LAYOUTS, CV_LAYOUT_INFO, showsPhoto } = await import("../src/lib/cv/render/layout.ts");

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
const dataUrl = (bytes, mime = "image/jpeg") => `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;

test("decodeJpegDataUrl accepts a JPEG data URL and refuses anything else", () => {
  assert.deepEqual(decodeJpegDataUrl(dataUrl(JPEG)), JPEG);
  for (const bad of [dataUrl(JPEG, "image/png"), dataUrl(Buffer.from("<svg/>")), "https://example.test/x.jpg", "data:image/jpeg;base64,!!!"]) {
    assert.throws(() => decodeJpegDataUrl(bad), CvPhotoError, bad.slice(0, 30));
  }
  const huge = Buffer.concat([JPEG, Buffer.alloc(MAX_PHOTO_BYTES)]);
  assert.throws(() => decodeJpegDataUrl(dataUrl(huge)), /limit/);
});

test("save, read, meta and delete per account; the file is private", () => {
  assert.equal(photoMeta("alice"), null);
  assert.equal(readPhoto("alice"), null);
  const meta = savePhoto("alice", JPEG);
  assert.equal(meta.bytes, JPEG.length);
  assert.match(meta.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(readPhoto("alice"), JPEG);
  const file = join(dataDir, "cv", "alice.photo.jpg");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.notDeepEqual(readFileSync(file).subarray(0, 2), JPEG.subarray(0, 2), "sealed at rest");
  assert.equal(photoMeta("bob"), null, "accounts do not share a photo");
  assert.equal(deletePhoto("alice"), true);
  assert.equal(deletePhoto("alice"), false);
  assert.equal(existsSync(file), false);
  assert.throws(() => photoMeta("../etc"), CvPhotoError);
});

test("layouts: ATS never prints a photo; the others only when wanted and stored", () => {
  assert.deepEqual([...CV_LAYOUTS], ["ats", "modern", "sidebar", "elegant"]);
  assert.equal(CV_LAYOUT_INFO.ats.photo, false);
  assert.equal(showsPhoto("ats", true, true), false);
  for (const layout of ["modern", "sidebar", "elegant"]) {
    assert.equal(showsPhoto(layout, true, true), true, layout);
    assert.equal(showsPhoto(layout, false, true), false, layout);
    assert.equal(showsPhoto(layout, true, false), false, layout);
  }
});
