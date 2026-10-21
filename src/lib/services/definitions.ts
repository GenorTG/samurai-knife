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
  /**
   * Static web apps served by an nginx container (sites.ts): each app's pinned release zip is downloaded, checked against
   * its sha256, unpacked into `$KNIFE_DATA_DIR/services/<id>/assets/<app>-<version>-<sha prefix>/<app>/` and served under
   * `/<app>/`; the generated nginx.conf sits next to them in `conf-<hash>/`. That directory is mounted read-only at
   * `target`. Exclusive with `assets` (both use the assets folder).
   */
  sites?: { target: string; label: string; apps: readonly SidecarSite[] };
  /** Container options beyond the defaults (a read-only root filesystem with tmpfs scratch, a fixed entrypoint, a healthcheck). */
  container?: {
    readOnly?: boolean;
    tmpfs?: string[];
    entrypoint?: string[];
    healthcheck?: { test: string[]; intervalSec: number; timeoutSec: number; retries: number };
  };
}

/**
 * One static web app of a `sites` sidecar. Facts from the app's own hosting notes (packaging/web/README.md of its repo):
 * `immutable` = regexes on the path below `/<id>` (`^/...` anchors at that point, others match anywhere) whose names carry a
 * content hash and may be cached for a year (everything else revalidates); `sandbox` = the iframe sandbox tokens the app needs.
 */
export interface SidecarSite {
  id: string;
  name: string;
  /** What it is, in a few words ("photo editor"). */
  kind: string;
  version: string;
  url: string;
  sha256: string;
  /** Size of the zip, for download progress. */
  bytes: number;
  license: string;
  repo: string;
  immutable: string[];
  sandbox: string[];
  /** The iframe's `allow` (Permissions Policy features delegated to the frame), from the README's embedding example. */
  allow: string[];
  /** wgpu apps: WebGPU in a secure context, else WebGL2 (`?webgl` forces it). False: WebGL2 only. */
  webgpu: boolean;
  /** One-line caveat shown with the app. */
  note?: string;
}

// ArtCraft (https://github.com/storytold): MIT OR Apache-2.0, pure Rust, static WebAssembly web builds. Versions and
// sha256 verified 2026-10-21 against the GitHub release assets (the API's asset digest and a local sha256sum agree).
const ARTCRAFT_SANDBOX = ["allow-scripts", "allow-same-origin", "allow-downloads", "allow-popups"];
const ARTCRAFT_ALLOW = ["fullscreen", "clipboard-read", "clipboard-write"];
const HASHED_GLUE = String.raw`-[0-9a-f]{16}(?:_bg\.wasm|\.js)$`;
const artcraft = (id: string, name: string, kind: string, version: string, sha256: string, bytes: number, rest: Partial<SidecarSite> = {}): SidecarSite => ({
  id,
  name,
  kind,
  version,
  url: `https://github.com/storytold/${id}/releases/download/v${version}/${id}-web-${version}.zip`,
  sha256,
  bytes,
  license: "MIT OR Apache-2.0",
  repo: `https://github.com/storytold/${id}`,
  immutable: [HASHED_GLUE],
  sandbox: ARTCRAFT_SANDBOX,
  allow: ARTCRAFT_ALLOW,
  webgpu: true,
  ...rest,
});

export const ARTCRAFT_APPS: readonly SidecarSite[] = [
  // The app's wasm ships gzipped in parts (app/*.part-*, served byte for byte); app/photocraft-web.js and app/parts.txt
  // keep their names and revalidate.
  artcraft("photocraft", "PhotoCraft", "image editor", "0.11.1", "f954c8096eeb5ab7ab20cd73445420097a4afde46f3d79547b3c9fe4f03d735f", 11567210, {
    immutable: [String.raw`\.part-[a-z]+$`, String.raw`photocraft-web-boot-[0-9a-f]{16}(?:_bg\.wasm|\.js)$`],
  }),
  artcraft("vectorcraft", "VectorCraft", "vector illustration", "0.14.0", "6f28a8bcee1c5ad6c37c6a0c44058793a40ea4443085866d5f78afb16aba075e", 27734185, {
    immutable: [HASHED_GLUE, String.raw`^/fonts/[0-9a-f]{16}/`],
  }),
  // index.html loads the glue and wasm with `?v=<build hash>`.
  artcraft("filmcraft", "FilmCraft", "video editor", "0.10.0", "47618cc373ff1306be17cfd539a33a5a5af490d3bb6722a6bc1436fcd6bf87a0", 13429216, {
    immutable: [String.raw`\.(?:wasm|js)$`],
  }),
  // Same file names in every release: nothing is immutable. Library in OPFS (IndexedDB fallback), render workers.
  artcraft("lightcraft", "LightCraft", "photo library and raw developer", "0.10.0", "6f787f9cd28c0092672e06077c7b7f5b1c9c72f709c570b317fef99a1c0cd794", 22381646, {
    immutable: [],
    sandbox: [...ARTCRAFT_SANDBOX, "allow-modals"],
    webgpu: false,
    note: "Experimental: the library lives in this browser's storage for the Craft apps address; keep your originals elsewhere and use File > Back Up Library.",
  }),
  artcraft("effectcraft", "EffectCraft", "motion graphics and effects", "0.13.0", "70eeb35b1bc6e19be98e37570cba962afce9dc65f2099d23989fca9c45a656dc", 19328128, {
    immutable: [],
    note: "The largest app (about 63 MB of WebAssembly, 17 MB to download): the first start takes a while.",
  }),
  artcraft("designcraft", "DesignCraft", "page layout", "0.10.0", "88358c3f4bc169001bb7b4f8022a4a148ecae7534c17f2d8867c1bfaeab618a4", 19242619),
  artcraft("pdfcraft", "PdfCraft", "PDF workbench", "0.10.1", "58a3e92a7bb61ed62d09376c96e71d65d0104495e629594fe52678d7579e68b9", 14507703),
  // The web build has no file system ("native file dialogs aren't wired up yet"), so its README asks for no
  // allow-downloads; live sessions (ws:// to a desktop host) are blocked by the craft CSP's connect-src.
  artcraft("figcraft", "FigCraft", "interface design", "0.8.0", "75fd4821e0ef8793c82bc56d530764f8244a137e55745f49a745838028c9bb51", 9794330, {
    sandbox: ["allow-scripts", "allow-same-origin", "allow-popups"],
    note: "The web build starts with one new document and has no files: work you want to keep needs the desktop app.",
  }),
  artcraft("wordcraft", "WordCraft", "word processor", "0.9.0", "710d2f4dd95ac6234a043d15d8e82232d20330199dbdbc94159324eeb02631c1", 16450184),
  // WebAudio only (no SharedArrayBuffer, no recording, so no microphone); `autoplay` lets the first click start sound.
  artcraft("soundcraft", "SoundCraft", "audio workstation", "0.10.0", "834949ad6ef7df7c45fd28632b6eb94768c52134581b3778275a10a5451a6206", 5947630, {
    sandbox: ["allow-scripts", "allow-same-origin"],
    allow: ["fullscreen", "autoplay", "clipboard-read", "clipboard-write"],
    note: "The web build opens a synthesised demo session (no recording, no files); click once into the app before you expect sound.",
  }),
  // Not the newest: the 0.8.0 and 0.9.0 web builds panic at startup ("no pids on this platform", std::process on
  // wasm32; https://github.com/storytold/deckcraft/issues/959, open on 2026-10-21). 0.7.0 starts; same hosting notes.
  artcraft("deckcraft", "DeckCraft", "presentations", "0.7.0", "4ab91994048c096fa356b7246c31098474d978ecd572e5b252dd825a287d1c40", 9385879, {
    note: "Starts with the sample deck every time and keeps no preferences: save your presentation before you close the tab.",
  }),
  artcraft("cadcraft", "CADCraft", "CAD", "0.10.0", "d86268e964ca91402439f4518d25057463db988d0145a48d3c65213957a1ced2", 8670115),
  artcraft("gridcraft", "GridCraft", "spreadsheet", "0.9.0", "f2327c09f176258143f7a5a78e4b40ae439be52e7cceca50fca1176dddcd11d8", 7128155),
];

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
  {
    id: "craft",
    name: "Craft apps (PhotoCraft, VectorCraft, FilmCraft, LightCraft, EffectCraft, DesignCraft, PdfCraft, FigCraft, WordCraft, SoundCraft, DeckCraft, CADCraft, GridCraft)",
    shortName: "Craft apps",
    description:
      "Thirteen open-source creative and office apps by the ArtCraft team and contributors (image, vector, video, photo library, motion graphics, page layout, PDF, interface design, word processor, audio workstation, presentations, CAD, spreadsheet) that run entirely in your browser as WebAssembly. A small nginx container on this machine serves their files on an address of its own; files you open never leave your browser, Save and Export are downloads. This site serves their official, unmodified web builds and is not affiliated with or endorsed by the ArtCraft team.",
    // nginx's unprivileged image (uid 101, port 8080), pinned by digest (the multi-arch index of 1.31.7-alpine, 2026-10-19).
    image: "nginxinc/nginx-unprivileged:1.31.7-alpine@sha256:b5047b9b76845eac124358373c6852377c52e4b05834a47647e955dd91cb8f1e",
    serviceName: "nginx",
    containerPort: 8080,
    health: { kind: "http", path: "/healthz", body: /^ok\s*$/ },
    callsBack: false,
    // Not used by the container: the key of the tickets that let a browser through the app's ArtCraft proxy
    // (KNIFE_CRAFT_PUBLIC_URL, scripts/craft-proxy.mjs).
    secrets: [{ name: "TICKET_SECRET", bytes: 32 }],
    env: {},
    volumes: [],
    startTimeoutSec: 60,
    requirements: { ramGb: 0.25, diskGb: 0.8 },
    license: "MIT OR Apache-2.0 (apps), BSD-2-Clause (nginx)",
    homepage: "https://github.com/storytold",
    usedBy: ["artcraft"],
    idleStopMinutes: 30,
    memLimit: "256m",
    cpus: "1",
    // Verified on 1.31.7-alpine with every capability dropped: nginx runs as uid 101, binds 8080, writes only its tmpfs.
    security: { capAdd: [], pidsLimit: 64 },
    sites: { target: "/srv/craft", label: "Craft apps", apps: ARTCRAFT_APPS },
    container: {
      readOnly: true,
      tmpfs: ["/tmp:size=64m,mode=1777"],
      entrypoint: ["nginx"],
      healthcheck: { test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"], intervalSec: 30, timeoutSec: 5, retries: 3 },
    },
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
