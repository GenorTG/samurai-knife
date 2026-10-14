import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { ASSETS_DIR } from "./compose";
import type { SidecarDefinition } from "./definitions";
import { serviceDir } from "./state";

/**
 * A definition's `assets` (files shipped in the repo, e.g. the office editor plugin) -> `<serviceDir>/assets/`, which
 * compose mounts read-only into the container. Each source sub-folder becomes `<folder>-<hash>` (hash of every relative
 * path + content), so changed files get new URLs; folders that are no longer current are removed. Dirs 755 / files 644:
 * the container reads them as its own user. Idempotent and cheap (a few small files), so every start/ensure calls it.
 */

export interface AssetSync {
  dir: string;
  folders: string[];
  /** Something was copied or removed. */
  changed: boolean;
}

function listFiles(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(root, full));
    else if (entry.isFile()) out.push(relative(root, full));
  }
  return out;
}

export function folderHash(source: string): string {
  const hash = createHash("sha256");
  for (const file of listFiles(source)) {
    hash.update(file.split("\\").join("/"));
    hash.update("\0");
    hash.update(readFileSync(join(source, file)));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

/** Absolute source dir of a definition's assets (relative paths are relative to the app checkout = the server's cwd). */
export function assetSource(def: SidecarDefinition): string | null {
  if (!def.assets) return null;
  if (isAbsolute(def.assets.source)) return def.assets.source;
  return join(process.cwd(), ...def.assets.source.split("/"));
}

/** The folder names the current sources map to (`<name>-<hash>`), without copying anything. */
export function expectedFolders(def: SidecarDefinition): string[] {
  const source = assetSource(def);
  if (!source || !existsSync(source)) return [];
  return readdirSync(source, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => `${entry.name}-${folderHash(join(source, entry.name))}`)
    .sort();
}

export function syncAssets(def: SidecarDefinition): AssetSync | null {
  const source = assetSource(def);
  if (!source) return null;
  const dir = join(serviceDir(def.id), ASSETS_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  chmodSync(dir, 0o755);
  if (!existsSync(source)) throw new Error(`sidecar assets missing: ${source}`);
  let changed = false;
  const wanted = new Set<string>();
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const from = join(source, entry.name);
    const name = `${entry.name}-${folderHash(from)}`;
    wanted.add(name);
    const target = join(dir, name);
    if (existsSync(target)) continue;
    // Copy into a temp name, then rename: the server never lists a half-written plugin.
    const temp = join(dir, `.tmp-${name}-${process.pid}`);
    rmSync(temp, { recursive: true, force: true });
    for (const file of listFiles(from)) {
      const dest = join(temp, file);
      mkdirSync(join(dest, ".."), { recursive: true, mode: 0o755 });
      copyFileSync(join(from, file), dest);
      chmodSync(dest, 0o644);
    }
    mkdirSync(temp, { recursive: true, mode: 0o755 });
    for (const sub of [temp, ...listDirs(temp)]) chmodSync(sub, 0o755);
    try {
      renameSync(temp, target);
      changed = true;
    } catch (error) {
      // The CLI and the server synced at the same moment: theirs won, the content is identical.
      rmSync(temp, { recursive: true, force: true });
      if (!existsSync(target)) throw error;
    }
  }
  for (const entry of readdirSync(dir)) {
    if (wanted.has(entry)) continue;
    const full = join(dir, entry);
    if (entry.startsWith(".tmp-") && Date.now() - statSync(full).mtimeMs < 60_000) continue; // another process is copying
    rmSync(full, { recursive: true, force: true });
    changed = true;
  }
  return { dir, folders: [...wanted].sort(), changed };
}

function listDirs(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = join(root, entry.name);
    out.push(full, ...listDirs(full));
  }
  return out;
}
