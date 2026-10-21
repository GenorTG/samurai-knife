import { composeProject, type SidecarDefinition } from "./definitions";
import { detectRuntime, run, type RunOptions, type RunResult, type RuntimeInfo } from "./runtime";
import { composeFile, serviceDir } from "./state";
import { helperBackend } from "./helper-backend";

/**
 * How the sidecar manager reaches the container runtime. One interface, two backends, chosen by KNIFE_SIDECAR_BACKEND:
 *
 *   docker (default)  the app runs `docker|podman compose` itself on the compose file it rendered in its data dir. Needs
 *                     the app user in the docker group, which is root-equivalent: fine for the owner's private toolbox.
 *   helper            the app has no docker access. It asks the root-owned knife-sidecar helper (socket-activated, unix
 *                     socket KNIFE_SIDECAR_HELPER_SOCKET) for a fixed verb on a fixed sidecar id; the helper runs compose
 *                     on a root-owned copy of the bundle that the owner installed with `sudo knife-sidecar sync <id>`
 *                     after validation (deploy/sidecar-helper/). A compromised app can then start/stop the two sidecars,
 *                     not create a privileged container. Contract: docs/DEPLOY.md "Sidecars without the docker group".
 *
 * Actions are typed values, never argv: the helper backend can only express what the helper's allow-list accepts.
 */

export type BackendKind = "docker" | "helper";

export type BackendAction =
  | { verb: "ps" }
  | { verb: "pull" }
  | { verb: "up" }
  | { verb: "stop" }
  | { verb: "down"; volumes: boolean; removeImages: boolean }
  | { verb: "logs" }
  | { verb: "prepare" }
  /** Docker: inspect `image`. Helper: the image of the installed bundle (the argument is ignored). */
  | { verb: "image-id"; image: string }
  /** Docker: `stats` of `container`. Helper: the bundle's running service container. */
  | { verb: "memory"; container: string }
  /** Docker only: GET the app's ping URL from inside the container. */
  | { verb: "ping-app"; url: string }
  /**
   * A `sites` sidecar's static content (sites.ts content dir). Helper: root copies it into its own content dir (no
   * sync needed). Docker: nothing to do, the container mounts the data-dir content dir directly.
   */
  | { verb: "content" };

/** Installed-bundle check (helper only): the root copy matches what this release renders, or the owner must sync. */
export type BundleCheck = { ok: true } | { ok: false; reason: "absent" | "differs" | "unavailable"; message: string; hint: string };

export interface SidecarBackend {
  readonly kind: BackendKind;
  detect(fresh?: boolean): Promise<RuntimeInfo>;
  exec(def: SidecarDefinition, action: BackendAction, options?: RunOptions): Promise<RunResult>;
  /** Whether `ping-app` is supported (the helper never execs arbitrary commands in a container). */
  readonly canPingApp: boolean;
  /** Compares the staged bundle (data dir) with what the runtime will actually run. Always ok for docker. */
  checkBundle(def: SidecarDefinition): Promise<BundleCheck>;
}

/* ------------------------------------------------------------------------------------------------- docker */

/** argv after `docker|podman` for an action: exactly what the manager ran before backends existed. */
export function dockerArgv(def: SidecarDefinition, action: BackendAction): string[] {
  const base = ["compose", "-p", composeProject(def.id), "-f", composeFile(def.id)];
  switch (action.verb) {
    case "ps":
      return [...base, "ps", "-a", "--format", "json"];
    case "pull":
      // `--progress` is a global compose flag (before the subcommand).
      return ["compose", "--progress", "json", ...base.slice(1), "pull"];
    case "up":
      return [...base, "up", "-d", "--remove-orphans"];
    case "stop":
      return [...base, "stop"];
    case "down":
      return [...base, "down", "--remove-orphans", ...(action.volumes ? ["--volumes"] : []), ...(action.removeImages ? ["--rmi", "all"] : [])];
    case "logs":
      return [...base, "logs", "--tail", "30", def.serviceName];
    case "prepare":
      if (!def.prepare) throw new Error(`${def.id} has no prepare step`);
      return [...base, "exec", "-T", def.serviceName, ...def.prepare.command];
    case "image-id":
      return ["image", "inspect", "--format", "{{.Id}}", action.image];
    case "memory":
      return ["stats", "--no-stream", "--format", "{{.MemUsage}}", action.container];
    case "content":
      throw new Error("content is not a compose step");
    case "ping-app": {
      const target = `${action.url}/api/services/ping`;
      return [...base, "exec", "-T", def.serviceName, "sh", "-c", `curl -s -m 5 "${target}" || wget -q -T 5 -O - "${target}"`];
    }
  }
}

export const dockerBackend: SidecarBackend = {
  kind: "docker",
  canPingApp: true,
  detect: (fresh) => detectRuntime(fresh),
  async exec(def, action, options = {}) {
    if (action.verb === "content") return { code: 0, stdout: "", stderr: "" };
    const info = await detectRuntime();
    if (!info.ok) return { code: null, stdout: "", stderr: info.message };
    const composeStep = action.verb !== "image-id" && action.verb !== "memory";
    return run(info.kind, dockerArgv(def, action), composeStep ? { cwd: serviceDir(def.id), ...options } : options);
  },
  checkBundle: async () => ({ ok: true }),
};

/* ------------------------------------------------------------------------------------------------- selection */

export function backendKind(env: NodeJS.ProcessEnv = process.env): BackendKind {
  const value = env.KNIFE_SIDECAR_BACKEND?.trim().toLowerCase();
  if (!value || value === "docker") return "docker";
  if (value === "helper") return "helper";
  // Fail closed: a typo must not silently fall back to the root-equivalent docker path on a hardened host.
  throw new Error(`KNIFE_SIDECAR_BACKEND must be docker or helper, not "${env.KNIFE_SIDECAR_BACKEND}"`);
}

export function sidecarBackend(): SidecarBackend {
  return backendKind() === "docker" ? dockerBackend : helperBackend;
}
