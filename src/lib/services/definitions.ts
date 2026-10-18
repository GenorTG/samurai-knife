/**
 * Sidecar service definitions: optional docker compose services the app installs, starts and stops on demand.
 * Metadata only (no I/O), so the browser can import it for labels. Adding a sidecar = one entry here plus the tool that
 * uses it; docs/SIDECARS.md has the contract.
 */

export interface SidecarVolume {
  /** Compose volume name (the engine prefixes it with the project name). */
  name: string;
  /** Mount point inside the container. */
  target: string;
}

/**
 * How the app decides the service is ready. `http`: GET `path` answers 200 (and `body` matches). `postgres`: a Postgres
 * SSLRequest on the published port gets the server's one-byte answer ("S"/"N"); a plain TCP connect is not enough
 * because docker's port proxy accepts connections before the container listens.
 */
export type SidecarHealth = { kind: "http"; path: string; body?: RegExp } | { kind: "postgres" };

/**
 * Container privileges (docs/SIDECARS.md "Hardening"). Every sidecar runs with ALL capabilities dropped,
 * `no-new-privileges` and a pids cap; `capAdd` lists only what the image was verified to need (a real container under a
 * test prefix: starts, gets healthy, does its job). Defaults live in compose.ts (`DEFAULT_PIDS_LIMIT`).
 */
export interface SidecarSecurity {
  /** Capabilities given back after `cap_drop: [ALL]` (names without `CAP_`). */
  capAdd: string[];
  /** Compose `pids_limit`; unset = compose.ts DEFAULT_PIDS_LIMIT. */
  pidsLimit?: number;
}

export interface SidecarDefinition {
  id: string;
  name: string;
  /** Short noun for buttons ("Install <shortName>"). */
  shortName: string;
  description: string;
  /** Pinned image reference; `update` re-pulls it and recreates the container when the digest changed. */
  image: string;
  /** Compose service name inside the generated project. */
  serviceName: string;
  /** Port the container listens on; published on KNIFE_HOST:<chosen port>. */
  containerPort: number;
  health: SidecarHealth;
  /**
   * The container calls back into the app (document downloads, save callbacks): after a start the manager checks from
   * inside the container that the app URL answers. False for services the app only calls (a database).
   */
  callsBack: boolean;
  /** Generated once at install (random hex), written to secrets.env (mode 600), passed with env_file. */
  secrets: { name: string; bytes: number }[];
  /** Plain environment for the container. */
  env: Record<string, string>;
  volumes: SidecarVolume[];
  /** Upper bound for "started -> healthy". */
  startTimeoutSec: number;
  /** What the host needs, shown on the install card. */
  requirements: { ramGb: number; diskGb: number };
  license: string;
  homepage: string;
  /** Registry slugs of the tools that need this sidecar. */
  usedBy: string[];
  /** Default idle stop; 0 = never stop on idle. */
  idleStopMinutes: number;
  /** Optional container memory cap (compose `mem_limit`, e.g. "4g"). */
  memLimit?: string;
  /** Optional CPU cap (compose `cpus`, e.g. "2"). */
  cpus?: string;
  /** Capabilities and process cap; required so a new sidecar has to state what it needs. */
  security: SidecarSecurity;
  /**
   * Where the port is published. `app-host` (default): KNIFE_HOST, for sidecars the browser loads (the editor).
   * `loopback`: 127.0.0.1 only, for sidecars only this app talks to (a database): never reachable from the LAN/tailnet.
   */
  publish?: "app-host" | "loopback";
  /**
   * The container fetches URLs a user types (the Document Server's "insert image from URL", compare/merge sources)
   * behind a request filter: the manager renders its config explicitly (private and metadata addresses refused, allow
   * list = KNIFE_SIDECAR_ALLOW_IPS only). Signed URLs (document download, save callback) are trusted by the server and
   * are not filtered.
   */
  requestFilter?: "onlyoffice";
  /**
   * One-time preparation inside each NEW container (after it is healthy, before the op reports done); recorded per
   * container id, so stop/start skips it and only a recreated container (install, update, port change) runs it again.
   */
  prepare?: { command: string[]; label: string; timeoutSec: number };
  /**
   * Files shipped with the app and mounted read-only into the container (assets.ts): every sub-folder of `source`
   * (repo-relative) is copied to `$KNIFE_DATA_DIR/services/<id>/assets/<folder>-<content hash>/` on install, start, update
   * and lazy start, and that directory is mounted at `target`. The hash in the folder name changes every URL when the
   * files change, so a server that caches them forever (the Document Server sends `immutable`) still serves the new ones.
   */
  assets?: { source: string; target: string; label: string };
}

export const SIDECARS: readonly SidecarDefinition[] = [
  {
    id: "office",
    name: "Office editor (Euro-Office Document Server)",
    shortName: "office editor",
    description:
      "Edit Word, Excel and PowerPoint files (also ODT, ODS, ODP) in the browser. Euro-Office is the AGPL fork of the ONLYOFFICE Document Server; it runs as one container on this machine and reads/writes documents only through this app.",
    // `latest` and `v9.3.5` share the same digest on 2026-10-13 (ghcr.io registry API). The docs show `:9.3.1` without the
    // `v`, but the published release tags carry it.
    image: "ghcr.io/euro-office/documentserver:v9.3.5",
    serviceName: "documentserver",
    containerPort: 80,
    health: { kind: "http", path: "/healthcheck", body: /^\s*true\s*$/ },
    callsBack: true,
    // SECURE_LINK_SECRET signs the cache links (/cache/files/<key>/...); without it the image generates one per data volume.
    secrets: [{ name: "JWT_SECRET", bytes: 32 }, { name: "SECURE_LINK_SECRET", bytes: 24 }],
    env: {
      JWT_ENABLED: "true",
      JWT_HEADER: "Authorization",
      // The request filter stays on: no private, loopback or metadata address for any URL a user makes the editor fetch
      // (an image "from URL", a compared document). The signed document/callback URLs to the app are trusted, not filtered.
      ALLOW_PRIVATE_IP_ADDRESS: "false",
      ALLOW_META_IP_ADDRESS: "false",
      EXAMPLE_ENABLED: "false",
      ADMINPANEL_ENABLED: "false",
      WOPI_ENABLED: "false",
      // Font cache generation on every start cost ~25-30 s of each cold start (measured 39 s -> 9-16 s without it). The
      // cache is written into the container filesystem, so it is generated once per container instead (`prepare`).
      GENERATE_FONTS: "false",
    },
    volumes: [
      { name: "data", target: "/var/lib/euro-office/documentserver" },
      { name: "private", target: "/var/www/euro-office/Data" },
    ],
    startTimeoutSec: 240,
    requirements: { ramGb: 4, diskGb: 5 },
    license: "AGPL-3.0",
    homepage: "https://github.com/Euro-Office/DocumentServer",
    usedBy: ["office"],
    idleStopMinutes: 30,
    // Measured 1.1-1.5 GiB in use; conversions of big files peak higher.
    memLimit: "3g",
    cpus: "2",
    // Verified on v9.3.5 with every other capability dropped (start, /healthcheck, font prepare, stop, restart): the
    // entrypoint chowns and chmods its dirs as root (CHOWN, FOWNER, DAC_OVERRIDE), supervisord/gosu switch to ds,
    // postgres, rabbitmq, redis, www-data (SETUID, SETGID) and supervisord signals the ds processes on stop and restart
    // (KILL; without it "PermissionError" and a hard kill). Port 80 binds without NET_BIND_SERVICE (docker sets
    // ip_unprivileged_port_start=0). ~150 tasks when idle; conversions add x2t processes.
    security: { capAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "KILL", "SETGID", "SETUID"], pidsLimit: 1024 },
    requestFilter: "onlyoffice",
    // Without it a new container answers /healthcheck but the editor never finishes loading (no AllFonts.js).
    prepare: { command: ["documentserver-generate-allfonts.sh"], label: "Generating the font cache (once per new container)", timeoutSec: 300 },
    // The assistant's live-editing plugin (docs/SIDECARS.md "Live editing plugin"): the Document Server lists every folder
    // with a config.json under sdkjs-plugins in its /plugins.json, and the editor loads them.
    assets: { source: "sidecars/office/plugins", target: "/var/www/euro-office/documentserver/sdkjs-plugins", label: "editor plugins" },
  },
  {
    id: "learn-db",
    name: "Course database (PostgreSQL + PostGIS)",
    shortName: "course database",
    description:
      "A private PostgreSQL 16 server with PostGIS 3.4 for the Database course. The app fills it with a small generated practice dataset and runs your lesson queries as a low-privilege learner role inside a transaction that is always rolled back, so nothing you run is kept.",
    // Official PostGIS image (Debian, PostgreSQL 16 + PostGIS 3.4), pinned by tag.
    image: "postgis/postgis:16-3.4",
    serviceName: "postgres",
    containerPort: 5432,
    health: { kind: "postgres" },
    callsBack: false,
    // POSTGRES_PASSWORD is the superuser (seeding only); LEARNER_PASSWORD is set on the learner role by the seed. Both
    // stay server-side (src/lib/learn/sql/db.ts).
    secrets: [
      { name: "POSTGRES_PASSWORD", bytes: 24 },
      { name: "LEARNER_PASSWORD", bytes: 24 },
    ],
    env: {
      POSTGRES_USER: "postgres",
      POSTGRES_DB: "learn",
    },
    volumes: [{ name: "pgdata", target: "/var/lib/postgresql/data" }],
    startTimeoutSec: 120,
    requirements: { ramGb: 0.5, diskGb: 1 },
    license: "PostgreSQL License + GPL-2.0 (PostGIS)",
    homepage: "https://hub.docker.com/r/postgis/postgis",
    usedBy: ["db-course"],
    idleStopMinutes: 30,
    memLimit: "1g",
    cpus: "1",
    // Verified on 16-3.4 (fresh volume: initdb + PostGIS; restart on an existing volume): the entrypoint chowns/chmods the
    // data and socket dirs as root and gosu switches to postgres. FOWNER without DAC_OVERRIDE fails (root cannot enter
    // the 0700 data dir it no longer owns).
    security: { capAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"], pidsLimit: 256 },
    // Only this app connects (the browser never does): Postgres is published on loopback, not on KNIFE_HOST.
    publish: "loopback",
  },
];

export function findSidecar(id: string): SidecarDefinition | undefined {
  return SIDECARS.find((service) => service.id === id);
}

export const SIDECAR_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Compose project name; also the prefix of every container, network and volume it owns. KNIFE_SIDECAR_PREFIX (default
 * `samurai-knife`) lets a scratch/e2e server run its own project next to the live one instead of taking it over.
 */
export function composeProject(id: string): string {
  const prefix = process.env.KNIFE_SIDECAR_PREFIX?.trim();
  return `${prefix && /^[a-z0-9][a-z0-9_-]{0,40}$/.test(prefix) ? prefix : "samurai-knife"}-${id}`;
}
