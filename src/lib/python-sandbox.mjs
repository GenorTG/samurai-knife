// Parser sandbox for the Python lane (src/lib/python.ts): every script runs inside bubblewrap when it is on.
// Threat model (audit injection #5): a crafted upload exploits a C/C++ parser (qpdf, pdfium, tesseract, ghostscript) and
// gets code execution as the app user. Inside the sandbox that code has no network (own network namespace, loopback only),
// sees only read-only system files, the interpreter, the venv and the scripts, and can write only the job's own scratch
// dirs: no $KNIFE_DATA_DIR, no storage key, no other job's files, no /proc of the app (own pid namespace), no nested user
// namespaces. The rlimits (run_limited.py) and the process-group kill on abort/timeout stay as they are.
//
// Plain JavaScript with JSDoc types (tsconfig allowJs) and no dependencies, so scripts/serve.mjs can probe it before Next
// starts and refuse a public deploy without it (docs/DEPLOY.md "Startup checks"). Tests: tests/python_sandbox.test.mjs.
//
// KNIFE_PY_SANDBOX: `auto` (default) = bwrap in public mode, required (startup refuses when it does not work); off in
// private mode (the owner's toolbox keeps its behaviour; tools may live where the sandbox does not look). `bwrap` =
// required in any mode. `off` = no sandbox (public mode starts with a warning). KNIFE_BWRAP = the bwrap binary (default /usr/bin/bwrap). KNIFE_PY_SANDBOX_RO = extra
// read-only roots, colon-separated, for tools installed outside /usr (e.g. a Homebrew tesseract).
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readlinkSync, realpathSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** @typedef {"auto" | "bwrap" | "off"} SandboxSetting */
/** @typedef {{ ok: boolean, detail: string }} SandboxProbe */
/**
 * @typedef {object} SandboxPolicy
 * @property {"bwrap" | "off"} use
 * @property {string[]} errors   fatal at startup; at run time every job fails closed with the first one
 * @property {string[]} warnings
 */
/**
 * @typedef {object} SandboxLayout
 * @property {string} python        interpreter path as the app spawns it (inside the venv)
 * @property {string} scriptsDir    server/py/scripts
 * @property {string[]} extraRo     KNIFE_PY_SANDBOX_RO roots
 * @property {string[]} forbidden   paths no bind may expose (data dir, storage key, GitHub App file)
 */
/**
 * @typedef {object} JobBinds
 * @property {string} scratch       the job's own request dir (rw; HOME, TMPDIR = scratch/tmp)
 * @property {string[]} [readOnly]  job dirs the script reads (uploads)
 * @property {string[]} [writable]  job dirs the script writes (out_dir)
 */

export const DEFAULT_BWRAP = "/usr/bin/bwrap";
/** Size of the sandbox's own /tmp (tmpfs, memory-backed); real temp files go to the job's scratch/tmp on disk. */
export const SANDBOX_TMPFS_BYTES = 16 * 1024 * 1024;

/** System paths bound read-only when they exist (directories or files). Never /etc as a whole: it holds secrets. */
const SYSTEM_RO = [
  "/usr",
  "/etc/ld.so.cache",
  "/etc/ld.so.conf",
  "/etc/ld.so.conf.d",
  "/etc/alternatives",
  "/etc/fonts",
  "/etc/ghostscript",
  "/etc/ImageMagick-6",
  "/etc/localtime",
  "/etc/mime.types",
  "/etc/passwd",
  "/etc/group",
  "/etc/nsswitch.conf",
  "/var/cache/fontconfig",
];
/** Merged-/usr symlinks (or real dirs on an old layout). */
const TOP_LINKS = ["/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"];

/** @param {Record<string, string | undefined>} env @returns {SandboxSetting | null} null = invalid value */
export function sandboxSetting(env) {
  const value = (env.KNIFE_PY_SANDBOX ?? "").trim().toLowerCase();
  if (!value || value === "auto") return "auto";
  if (value === "bwrap" || value === "off") return value;
  return null;
}

/** @param {Record<string, string | undefined>} env */
export function bwrapBin(env) {
  return env.KNIFE_BWRAP?.trim() || DEFAULT_BWRAP;
}

/**
 * Pure decision: which sandbox a server uses, given its mode and whether the probe ran a script inside bwrap.
 * @param {Record<string, string | undefined>} env
 * @param {"private" | "public"} mode
 * @param {SandboxProbe} probe
 * @returns {SandboxPolicy}
 */
export function sandboxPolicy(env, mode, probe) {
  const setting = sandboxSetting(env);
  if (setting === null) {
    return { use: "off", errors: [`KNIFE_PY_SANDBOX=${env.KNIFE_PY_SANDBOX} is not auto, bwrap or off.`], warnings: [] };
  }
  if (setting === "off") {
    const warnings = mode === "public" ? ["KNIFE_PY_SANDBOX=off in public mode: uploaded PDFs are parsed WITHOUT the bubblewrap sandbox, with the app user's file and network access (docs/DEPLOY.md \"Parser sandbox\")."] : [];
    return { use: "off", errors: [], warnings };
  }
  if (!sandboxRequired(env, mode)) return { use: "off", errors: [], warnings: [] };
  if (probe.ok) return { use: "bwrap", errors: [], warnings: [] };
  const why = setting === "bwrap" ? "KNIFE_PY_SANDBOX=bwrap requires it" : "public mode requires it";
  return {
    use: "bwrap",
    errors: [`the Python parser sandbox does not work (${probe.detail}); ${why}. Fix bubblewrap (docs/DEPLOY.md "Parser sandbox") or set KNIFE_PY_SANDBOX=off to run parsers unsandboxed.`],
    warnings: [],
  };
}

/**
 * Whether this server runs its parsers sandboxed (and so must probe bwrap): `bwrap`, or `auto` in public mode.
 * @param {Record<string, string | undefined>} env @param {"private" | "public"} mode
 */
export function sandboxRequired(env, mode) {
  const setting = sandboxSetting(env);
  return setting === "bwrap" || (setting === "auto" && mode === "public");
}

/**
 * OCR/PDF tools found on PATH whose real file the sandbox cannot see (installed outside /usr and KNIFE_PY_SANDBOX_RO):
 * the script would report them as missing. Startup warns; it is a broken feature, not a hole.
 * @param {SandboxLayout} layout @param {Record<string, string | undefined>} env @param {string[]} tools
 */
export function toolsOutsideSandbox(layout, env, tools = ["tesseract", "gs", "qpdf"]) {
  let roots;
  try {
    roots = ["/usr", ...readOnlyRoots(layout)];
  } catch {
    return [];
  }
  const missing = [];
  for (const tool of tools) {
    for (const dir of (env.PATH ?? "").split(":").filter((entry) => path.isAbsolute(entry))) {
      const candidate = path.join(dir, tool);
      if (!existsSync(candidate)) continue;
      const visible = isWithin(path.resolve(candidate), "/bin") || isWithin(path.resolve(candidate), "/sbin") || roots.some((root) => isWithin(real(candidate), root) && isWithin(path.resolve(candidate), root));
      if (!visible) missing.push(`${tool} (${candidate} -> ${real(candidate)})`);
      break;
    }
  }
  return missing;
}

/** @param {string} p */
function isWithin(p, root) {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** @param {string} p */
function real(p) {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Refuses a bind that would expose a forbidden path: the root itself, an ancestor of a forbidden path, or a path inside one.
 * @param {string} bind @param {string[]} forbidden
 */
export function assertSafeBind(bind, forbidden) {
  if (!path.isAbsolute(bind)) throw new Error(`sandbox bind ${bind} is not absolute`);
  const resolved = real(bind);
  if (resolved === "/") throw new Error("sandbox bind of / refused");
  for (const blocked of forbidden) {
    const target = real(blocked);
    if (isWithin(target, resolved) || isWithin(resolved, target)) {
      throw new Error(`sandbox bind ${bind} would expose ${blocked}`);
    }
  }
}

/**
 * The interpreter's symlink chain: links outside the bound trees are recreated with --symlink, the final binary's
 * prefix (dirname(dirname(real))) is bound read-only. A venv's `bin/python` -> ~/.local/bin/python3.12 -> uv's cpython
 * works the same as a plain /usr/bin/python3.
 * @param {string} python
 * @returns {{ links: [string, string][], prefix: string }}
 */
export function interpreterChain(python) {
  /** @type {[string, string][]} */
  const links = [];
  let current = path.resolve(python);
  for (let hops = 0; hops < 16; hops += 1) {
    let info;
    try {
      info = lstatSync(current);
    } catch {
      break;
    }
    if (!info.isSymbolicLink()) break;
    const target = readlinkSync(current);
    links.push([target, current]);
    current = path.resolve(path.dirname(current), target);
  }
  return { links, prefix: path.dirname(path.dirname(real(current))) };
}

/** @param {Record<string, string | undefined>} env */
export function extraReadOnly(env) {
  return (env.KNIFE_PY_SANDBOX_RO ?? "").split(":").map((part) => part.trim()).filter(Boolean);
}

/**
 * The read-only trees every job sees (validated against `forbidden`).
 * @param {SandboxLayout} layout
 */
export function readOnlyRoots(layout) {
  const venv = path.dirname(path.dirname(path.resolve(layout.python)));
  const { prefix } = interpreterChain(layout.python);
  const roots = [venv, prefix, layout.scriptsDir, ...layout.extraRo];
  const unique = [...new Set(roots.map((root) => path.resolve(root)))].filter((root) => !isWithin(root, "/usr"));
  for (const root of unique) {
    if (!existsSync(root)) throw new Error(`sandbox read-only root ${root} does not exist`);
    assertSafeBind(root, layout.forbidden);
  }
  return unique;
}

/**
 * bwrap argv up to (not including) the command. Paths inside the sandbox equal the paths outside, so the request JSON
 * (file paths, out_dir) needs no rewriting.
 * @param {SandboxLayout} layout
 * @param {JobBinds} job
 * @param {Record<string, string>} childEnv  the script's whole environment (--clearenv first)
 */
export function bwrapArgs(layout, job, childEnv) {
  const args = [
    "--unshare-user",
    "--unshare-pid",
    "--unshare-net",
    "--unshare-ipc",
    "--disable-userns",
    "--die-with-parent",
    "--new-session",
    "--clearenv",
  ];
  for (const [key, value] of Object.entries(childEnv)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid env name ${key}`);
    args.push("--setenv", key, value);
  }
  for (const entry of SYSTEM_RO) if (existsSync(/*turbopackIgnore: true*/ entry)) args.push("--ro-bind", entry, entry);
  for (const entry of TOP_LINKS) {
    let info;
    try {
      info = lstatSync(entry);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) args.push("--symlink", readlinkSync(entry), entry);
    else if (info.isDirectory()) args.push("--ro-bind", entry, entry);
  }
  args.push("--dev", "/dev", "--proc", "/proc");
  args.push("--perms", "1777", "--size", String(SANDBOX_TMPFS_BYTES), "--tmpfs", "/tmp");
  const roots = readOnlyRoots(layout);
  for (const root of roots) args.push("--ro-bind", root, root);
  // Interpreter links that live outside every bound tree (e.g. ~/.local/bin/python3.12 -> uv's cpython).
  const bound = ["/usr", ...roots];
  for (const [target, link] of interpreterChain(layout.python).links) {
    if (!bound.some((root) => isWithin(link, root))) args.push("--symlink", target, link);
  }
  const jobRo = job.readOnly ?? [];
  const jobRw = [job.scratch, ...(job.writable ?? [])];
  for (const dir of [...jobRo, ...jobRw]) assertSafeBind(dir, layout.forbidden);
  for (const dir of jobRo) args.push("--ro-bind", dir, dir);
  for (const dir of jobRw) args.push("--bind", dir, dir);
  // The sandbox's own root (bwrap's tmpfs holding the mount points) becomes read-only: writable = the binds and /tmp.
  args.push("--remount-ro", "/", "--chdir", layout.scriptsDir);
  return args;
}

/**
 * Whitelist the parser's environment and remove PATH/library/data paths the sandbox cannot see. The inherited PATH often
 * contains the operator's home and tool manager directories; passing it would defeat the requested minimal clearenv.
 * @param {Record<string, string | undefined>} env
 * @param {SandboxLayout} layout
 */
export function sandboxChildEnv(env, layout) {
  const roots = ["/usr", ...readOnlyRoots(layout)].map((root) => real(root));
  const visible = (value) => {
    if (!value || !path.isAbsolute(value)) return false;
    const resolved = real(value);
    return roots.some((root) => isWithin(resolved, root));
  };
  const pathDirs = ["/usr/local/bin", "/usr/bin", "/bin"];
  for (const dir of (env.PATH ?? "").split(":").filter(visible)) pathDirs.push(dir);
  const result = {
    PATH: [...new Set(pathDirs)].join(":"),
    HOME: env.HOME ?? "/tmp",
    TMPDIR: env.TMPDIR ?? "/tmp",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONNOUSERSITE: "1",
  };
  if (env.NODE_ENV) result.NODE_ENV = env.NODE_ENV;
  if (env.OMP_THREAD_LIMIT) result.OMP_THREAD_LIMIT = env.OMP_THREAD_LIMIT;
  if (visible(env.TESSDATA_PREFIX)) result.TESSDATA_PREFIX = env.TESSDATA_PREFIX;
  if (env.LD_LIBRARY_PATH) {
    const dirs = env.LD_LIBRARY_PATH.split(":").filter(visible);
    if (dirs.length) result.LD_LIBRARY_PATH = dirs.join(":");
  }
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("KNIFE_RLIMIT_") && value) result[key] = value;
  }
  return result;
}

/** Paths a sandboxed script must never reach, from the server's environment. */
export function forbiddenPaths(/** @type {Record<string, string | undefined>} */ env) {
  const dataDir = env.KNIFE_DATA_DIR?.trim() || path.join(os.homedir(), ".local", "share", "samurai-knife");
  return [dataDir, env.KNIFE_STORAGE_KEY_FILE?.trim(), env.KNIFE_GITHUB_APP_FILE?.trim()].filter((entry) => typeof entry === "string" && entry.length > 0 && path.isAbsolute(entry));
}

/**
 * Runs `python -c "print('ok')"` inside the exact sandbox a job gets (same binds, namespaces, env rules).
 * @param {SandboxLayout} layout
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<SandboxProbe>}
 */
export function probeSandbox(layout, env) {
  const bin = bwrapBin(env);
  if (!path.isAbsolute(bin)) return Promise.resolve({ ok: false, detail: `KNIFE_BWRAP=${bin} is not an absolute path` });
  try {
    if (!statSync(/*turbopackIgnore: true*/ bin).isFile()) return Promise.resolve({ ok: false, detail: `${bin} is not a file` });
  } catch {
    return Promise.resolve({ ok: false, detail: `${bin} not found (install bubblewrap)` });
  }
  let scratch;
  let args;
  try {
    scratch = mkdtempSync(path.join(os.tmpdir(), "knife-probe-"));
    args = [...bwrapArgs(layout, { scratch }, { PATH: "/usr/bin:/bin", HOME: scratch, PYTHONNOUSERSITE: "1" }), "--", layout.python, "-I", "-c", "print('ok')"];
  } catch (error) {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    return Promise.resolve({ ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(/*turbopackIgnore: true*/ bin, args, { stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    const done = (/** @type {SandboxProbe} */ result) => {
      clearTimeout(timer);
      rmSync(scratch, { recursive: true, force: true });
      resolve(result);
    };
    child.on("error", (error) => done({ ok: false, detail: error.message }));
    child.on("close", (code) => {
      const text = out.trim().split("\n").slice(-2).join(" ").slice(0, 300);
      done(code === 0 && /^ok$/m.test(out) ? { ok: true, detail: "ok" } : { ok: false, detail: text || `bwrap exited with ${code}` });
    });
  });
}

/**
 * The interpreter the lane runs: KNIFE_PYTHON, else `$KNIFE_PY_HOME/venv/bin/python` (default ~/work/samurai-knife-py).
 * Assembled at run time on purpose (see src/lib/python.ts).
 * @param {Record<string, string | undefined>} env
 */
export function pythonBinFrom(env) {
  const fromEnv = env.KNIFE_PYTHON?.trim();
  if (fromEnv) return fromEnv;
  const pyHome = env.KNIFE_PY_HOME?.trim() || path.join(os.homedir(), "work", "samurai-knife-py");
  return path.join(pyHome, "venv", "bin", "python");
}

/**
 * The layout for a server started in `cwd` (the app root).
 * @param {Record<string, string | undefined>} env @param {string} cwd
 * @returns {SandboxLayout}
 */
export function sandboxLayout(env, cwd) {
  return {
    python: pythonBinFrom(env),
    scriptsDir: path.join(cwd, "server", "py", "scripts"),
    extraRo: extraReadOnly(env),
    forbidden: forbiddenPaths(env),
  };
}
