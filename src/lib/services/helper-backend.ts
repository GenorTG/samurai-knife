import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import type { BackendAction, BundleCheck, SidecarBackend } from "./backend";
import type { SidecarDefinition } from "./definitions";
import type { RunOptions, RunResult, RuntimeInfo } from "./runtime";
import { SECRETS_FILE, ASSETS_DIR } from "./compose";
import { composeFile, serviceDir } from "./state";
import { msgf } from "@/lib/i18n/msg";

/**
 * Client of the root-owned knife-sidecar helper (deploy/sidecar-helper/knife-sidecar-helper), the sidecar backend for
 * hosts where the app user has no docker access (KNIFE_SIDECAR_BACKEND=helper).
 *
 * Threat model: the app may be compromised; the helper is the boundary. This client only ever sends one line
 * `<verb> <id> [flags]` built from typed actions and the definition's id (never user text), the helper re-validates it
 * against its own allow-list, and the compose bundle docker runs is root's validated copy, not the data-dir file.
 * Wire format: docs/DEPLOY.md "Sidecars without the docker group".
 */

export const DEFAULT_HELPER_SOCKET = "/run/knife-sidecar.sock";
const MAX_KEEP = 200_000;

export function helperSocket(env: NodeJS.ProcessEnv = process.env): string {
  return env.KNIFE_SIDECAR_HELPER_SOCKET?.trim() || DEFAULT_HELPER_SOCKET;
}

const TOKEN = /^[a-z][a-z0-9-]{0,31}$/;

/** The request line for an action, or null when the helper does not offer it. */
export function helperRequest(def: Pick<SidecarDefinition, "id">, action: BackendAction): string | null {
  if (!TOKEN.test(def.id)) throw new Error(`invalid sidecar id ${def.id}`);
  switch (action.verb) {
    case "down":
      return ["down", def.id, ...(action.volumes ? ["volumes"] : []), ...(action.removeImages ? ["rmi"] : [])].join(" ");
    case "ping-app":
      return null;
    default:
      return `${action.verb} ${def.id}`;
  }
}

/**
 * One request on a fresh connection; resolves like runtime.run(): `code` is the helper's `x` line (null when the
 * connection failed, timed out, was aborted or closed without one).
 */
export function callHelper(line: string, options: RunOptions & { socketPath?: string } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const out = { stdout: "", stderr: "" };
    let code: number | null = null;
    let buffer = "";
    let settled = false;
    const socket = connect(options.socketPath ?? helperSocket());
    const finish = (extra?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (extra) out.stderr += (out.stderr ? "\n" : "") + extra;
      socket.destroy();
      resolve({ code, ...out });
    };
    const onAbort = () => finish("aborted");
    const timer = options.timeoutMs ? setTimeout(() => finish(`helper timed out after ${options.timeoutMs} ms`), options.timeoutMs) : null;
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const take = (raw: string) => {
      const kind = raw.slice(0, 2);
      const text = raw.slice(2);
      if (kind === "x ") {
        const parsed = Number.parseInt(text, 10);
        code = Number.isInteger(parsed) ? parsed : null;
        finish();
      } else if (kind === "o " || kind === "e ") {
        const stream = kind === "o " ? "stdout" : "stderr";
        out[stream] = (out[stream] + text + "\n").slice(-MAX_KEEP);
        if (text.trim()) options.onLine?.(text, stream);
      }
    };
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${line}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) {
        take(raw);
        if (settled) return;
      }
      if (buffer.length > 64 * 1024) buffer = buffer.slice(-64 * 1024);
    });
    socket.on("error", (error: NodeJS.ErrnoException) => finish(`sidecar helper: ${error.code ?? error.message}`));
    socket.on("close", () => finish(code === null ? "sidecar helper closed the connection without a result" : undefined));
    if (options.signal?.aborted) onAbort();
  });
}

/**
 * sha256 over compose.yaml, secrets.env and the asset folder names (each carries its content hash). Must match
 * bundle_hash_of() in the helper: equal hashes mean root's installed copy is exactly what this release renders.
 */
export function bundleHash(dir: string): string | null {
  const compose = join(dir, "compose.yaml");
  const secrets = join(dir, SECRETS_FILE);
  if (!existsSync(compose) || !existsSync(secrets)) return null;
  const hash = createHash("sha256").update("knife-sidecar-bundle-v1\0");
  hash.update(readFileSync(compose)).update("\0");
  hash.update(readFileSync(secrets)).update("\0");
  const assets = join(dir, ASSETS_DIR);
  let folders: string[] = [];
  if (existsSync(assets) && lstatSync(assets).isDirectory()) {
    folders = readdirSync(assets, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  }
  hash.update(folders.join("\n"));
  return hash.digest("hex");
}

const SYNC_HINT = (id: string) =>
  msgf(
    "On the host, as root: sudo knife-sidecar check {id} shows what differs, then sudo knife-sidecar sync {id} validates the bundle this app staged in its data dir and installs it (docs/DEPLOY.md \"Sidecars without the docker group\"). If the sync refuses something this release added (a new mount), re-run deploy/install.sh first: it installs the matching helper.",
    { id },
  );

let cached: { at: number; info: RuntimeInfo } | null = null;

async function detect(fresh = false): Promise<RuntimeInfo> {
  if (!fresh && cached && Date.now() - cached.at < 60_000) return cached.info;
  const socketPath = helperSocket();
  const result = await callHelper("version", { timeoutMs: 30_000, socketPath });
  let info: RuntimeInfo;
  if (result.code === 0) {
    let parsed: { engine?: unknown; compose?: unknown } = {};
    try {
      parsed = JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}") as typeof parsed;
    } catch {
      /* reported below */
    }
    info = { ok: true, kind: "docker", engineVersion: String(parsed.engine ?? "?"), composeVersion: String(parsed.compose ?? "?") };
  } else if (result.code === null) {
    info = {
      ok: false,
      reason: "daemon",
      message: `The sidecar helper is not reachable at ${socketPath} (${result.stderr.trim().split("\n").pop() ?? "no answer"}).`,
      hint: "On the host, as root: systemctl enable --now knife-sidecar.socket (docs/DEPLOY.md \"Sidecars without the docker group\").",
    };
  } else {
    info = {
      ok: false,
      reason: "daemon",
      message: `The sidecar helper cannot reach docker: ${result.stderr.trim().split("\n").slice(-2).join(" ")}`,
      hint: "On the host: systemctl status docker; the helper needs docker and the docker compose plugin installed for root.",
    };
  }
  cached = { at: Date.now(), info };
  return info;
}

export const helperBackend: SidecarBackend = {
  kind: "helper",
  canPingApp: false,
  detect,
  async exec(def, action, options = {}) {
    const line = helperRequest(def, action);
    if (!line) return { code: null, stdout: "", stderr: `${action.verb} is not offered by the sidecar helper` };
    return callHelper(line, options);
  },
  async checkBundle(def): Promise<BundleCheck> {
    // serviceDir/composeFile create and validate the staging dir; the hash covers what writeCompose staged there.
    composeFile(def.id);
    const staged = bundleHash(serviceDir(def.id));
    const result = await callHelper(`hash ${def.id}`, { timeoutMs: 15_000 });
    if (result.code !== 0) {
      return { ok: false, reason: "unavailable", message: msgf("The sidecar helper did not answer: {detail}", { detail: result.stderr.trim().split("\n").pop() ?? "" }), hint: SYNC_HINT(def.id) };
    }
    const installed = result.stdout.trim().split("\n").pop() ?? "";
    if (installed === "absent") {
      return { ok: false, reason: "absent", message: msgf("Sync needed: {name} has no root-installed compose bundle on this host yet.", { name: def.name }), hint: SYNC_HINT(def.id) };
    }
    if (!staged || installed !== staged) {
      return {
        ok: false,
        reason: "differs",
        message: msgf("Sync needed: the host's installed bundle for {name} differs from what this release renders (image, port, editor plugin, generated config or secret changed).", { name: def.name }),
        hint: SYNC_HINT(def.id),
      };
    }
    return { ok: true };
  },
};

/** Tests only: forget the cached detection. */
export function resetHelperCache(): void {
  cached = null;
}
