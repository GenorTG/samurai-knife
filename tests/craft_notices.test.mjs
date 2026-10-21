// Craft apps licences & notices (src/lib/craft/notices.ts): the paths a NOTICE names, the release's own licence files,
// the repository fetch at the release tag (fake fetch), caching per version and retry after a failed fetch.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/craft_notices.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "knife-craft-notices-"));
process.env.KNIFE_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const { ARTCRAFT_APPS } = await import("../src/lib/services/definitions.ts");
const { siteFolder } = await import("../src/lib/services/sites.ts");
const notices = await import("../src/lib/craft/notices.ts");

const PHOTOCRAFT_NOTICE = `PhotoCraft
Copyright (c) 2026 ArtCraft Team and the PhotoCraft contributors.
The per-file list (author, source, license) is in ATTRIBUTION.md.

Inter font (assets/fonts/Inter-*.ttf) — SIL Open Font License 1.1. See assets/fonts/OFL-Inter.txt.
SCOWL English word list (assets/dict/en_US-scowl-50.txt.gz) — SCOWL license. See assets/dict/LICENSE-SCOWL.txt.
Lucide icons (assets/icons/*.svg, except slice-knife.svg) — ISC. See assets/icons/LICENSE-lucide.txt.
libfacedetection (crates/algo/data/libfacedetection.bin) — BSD-3-Clause. See crates/algo/data/LICENSE-libfacedetection.txt.
Builds made with craft-fonts also embed the fonts listed in
https://github.com/storytold/craft-fonts/blob/main/ATTRIBUTION.md. Their licence texts ship as OFL-<family>.txt.
Never followed: ../../etc/passwd.txt, /etc/shadow.txt, a/./b.txt
`;

test("noticePaths: the licence files a NOTICE names, nothing outside the repository", () => {
  assert.deepEqual(notices.noticePaths(PHOTOCRAFT_NOTICE), [
    "ATTRIBUTION.md",
    "assets/fonts/OFL-Inter.txt",
    "assets/dict/LICENSE-SCOWL.txt",
    "assets/icons/LICENSE-lucide.txt",
    "crates/algo/data/LICENSE-libfacedetection.txt",
  ]);
});

test("releaseNoticeFiles: only regular licence files at the top of the release, no .gz twins or symlinks", () => {
  const dir = join(dataDir, "release");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "LICENSE-MIT"), "MIT text");
  writeFileSync(join(dir, "LICENSE-MIT.gz"), "gz");
  writeFileSync(join(dir, "OFL-Inter.txt"), "OFL");
  writeFileSync(join(dir, "index.html"), "<html>");
  symlinkSync("/etc/hostname", join(dir, "NOTICE"));
  const files = notices.releaseNoticeFiles(dir);
  assert.deepEqual(files.map((file) => file.name), ["LICENSE-MIT", "OFL-Inter.txt"]);
  assert.ok(files.every((file) => file.source === "release"));
});

function fakeGithub(files, calls) {
  return async (url, init) => {
    calls.push(url);
    assert.equal(init.redirect, "error", "raw file fetches never follow redirects");
    const path = new URL(url).pathname;
    const body = files[path];
    if (body === "<500>") return new Response("busy", { status: 503 });
    return body === undefined ? new Response("no", { status: 404 }) : new Response(body, { status: 200 });
  };
}

test("appNotices: release licences + repository NOTICE and its files at the release tag, cached once complete", async () => {
  const app = ARTCRAFT_APPS.find((candidate) => candidate.id === "photocraft");
  const site = join(dataDir, "services", "craft", "assets", siteFolder(app), app.id);
  mkdirSync(site, { recursive: true });
  writeFileSync(join(site, "LICENSE-MIT"), "MIT License\n\nCopyright (c) 2026 ArtCraft Team and the PhotoCraft contributors\n");
  writeFileSync(join(site, "LICENSE-APACHE"), "Apache License 2.0");
  const base = `/storytold/photocraft/v${app.version}/`;
  const calls = [];
  const files = {
    [`${base}NOTICE`]: PHOTOCRAFT_NOTICE,
    [`${base}ATTRIBUTION.md`]: "per-file list",
    [`${base}assets/fonts/OFL-Inter.txt`]: "OFL 1.1",
    [`${base}assets/icons/LICENSE-lucide.txt`]: "ISC",
    [`${base}crates/algo/data/LICENSE-libfacedetection.txt`]: "<500>",
  };
  const first = await notices.appNotices("photocraft", undefined, fakeGithub(files, calls));
  assert.equal(first.version, app.version);
  assert.equal(first.copyright, "Copyright (c) 2026 ArtCraft Team and the PhotoCraft contributors");
  assert.deepEqual(first.files.map((file) => `${file.source}:${file.name}`), [
    "release:LICENSE-APACHE",
    "release:LICENSE-MIT",
    "repository:NOTICE",
    "repository:ATTRIBUTION.md",
    "repository:assets/fonts/OFL-Inter.txt",
    "repository:assets/icons/LICENSE-lucide.txt",
  ]);
  assert.deepEqual(first.missing, ["crates/algo/data/LICENSE-libfacedetection.txt"], "a 5xx is retried later");
  assert.deepEqual(first.absent, ["assets/dict/LICENSE-SCOWL.txt"], "a 404 is final (named but not in the repo)");
  assert.ok(calls.every((url) => url.startsWith(`https://raw.githubusercontent.com${base}`)), calls.join("\n"));

  // Incomplete (5xx) -> fetched again next time; complete (only 404s left) -> served from the cache without a request.
  files[`${base}crates/algo/data/LICENSE-libfacedetection.txt`] = "BSD-3";
  const second = await notices.appNotices("photocraft", undefined, fakeGithub(files, calls));
  assert.deepEqual(second.missing, []);
  const before = calls.length;
  const third = await notices.appNotices("photocraft", undefined, fakeGithub(files, calls));
  assert.equal(calls.length, before, "a complete set is cached per version");
  assert.equal(third.files.length, 7);
});

test("appNotices refuses unknown apps and odd versions", async () => {
  await assert.rejects(notices.appNotices("../etc"), notices.NoticeError);
  await assert.rejects(notices.appNotices("photocraft", "1.0.0/../../x"), notices.NoticeError);
});
