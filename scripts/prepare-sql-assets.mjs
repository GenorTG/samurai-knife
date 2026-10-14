import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(projectRoot, "public", "sql");

// sql.js (SQLite compiled to WebAssembly) runs in the browser tab: the loader script and the wasm are
// served same-origin from /sql/ so no CDN is involved and files never leave the page.
const distRoot = path.join(projectRoot, "node_modules", "sql.js", "dist");

await fs.mkdir(outputRoot, { recursive: true });
for (const filename of ["sql-wasm-browser.js", "sql-wasm-browser.wasm"]) {
  await fs.copyFile(path.join(distRoot, filename), path.join(outputRoot, filename));
}
console.log("Prepared local sql.js loader and SQLite WASM.");
