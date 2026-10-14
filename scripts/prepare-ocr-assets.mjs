import { promises as fs } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(projectRoot, "public", "ocr");

function packageRoot(entry) {
  return path.dirname(require.resolve(entry));
}

async function copyAsset(source, target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
}

async function main() {
  const tesseractRoot = path.dirname(packageRoot("tesseract.js"));
  const coreRoot = packageRoot("tesseract.js-core");
  const englishRoot = packageRoot("@tesseract.js-data/eng");
  const polishRoot = packageRoot("@tesseract.js-data/pol");

  await copyAsset(path.join(tesseractRoot, "dist", "worker.min.js"), path.join(outputRoot, "worker.min.js"));

  const coreFiles = await fs.readdir(coreRoot);
  for (const filename of coreFiles) {
    if (filename.startsWith("tesseract-core-") && (filename.endsWith(".wasm.js") || filename.endsWith(".wasm"))) {
      await copyAsset(path.join(coreRoot, filename), path.join(outputRoot, "core", filename));
    }
  }

  for (const [language, root] of [["eng", englishRoot], ["pol", polishRoot]]) {
    const filename = `${language}.traineddata.gz`;
    await copyAsset(
      path.join(root, "4.0.0_best_int", filename),
      path.join(outputRoot, "lang", filename),
    );
  }

  console.log("Prepared local Tesseract worker, WASM cores, and English/Polish language data.");
}

await main();
