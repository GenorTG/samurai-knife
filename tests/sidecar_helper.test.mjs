// Sidecar backends (src/lib/services/backend.ts, helper-backend.ts) and the root helper (deploy/sidecar-helper/).
//   1. backend selection and the docker argv (unchanged behaviour of the default backend)
//   2. the manager over a FAKE helper socket: exact request lines, no `up` before root installed the bundle
//   3. the REAL helper (python) behind a socket-activation stand-in, with a fake docker: argv allow-list, injection
//      attempts, abort kills the docker process group, peer check
//   4. `sync`: the app's real rendered compose files pass the helper's validator (real `docker compose config`, skipped
//      when the compose plugin is missing), a tampered one is refused, hashes agree between Python and TypeScript
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/sidecar_helper.test.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;
const HELPER = join(ROOT, "deploy/sidecar-helper/knife-sidecar-helper");
const work = mkdtempSync(join(tmpdir(), "knife-helper-"));
const dataDir = join(work, "data");
process.env.KNIFE_DATA_DIR = dataDir;
process.env.KNIFE_HOST = "100.64.0.7";
process.env.KNIFE_PORT = "3210";
delete process.env.KNIFE_SIDECAR_PREFIX;
delete process.env.KNIFE_OFFICE_PUBLIC_URL;
test.after(() => rmSync(work, { recursive: true, force: true }));

const { backendKind, dockerArgv, sidecarBackend } = await import("../src/lib/services/backend.ts");
const { helperRequest, callHelper, bundleHash, resetHelperCache } = await import("../src/lib/services/helper-backend.ts");
const { findSidecar, SIDECARS } = await import("../src/lib/services/definitions.ts");
const manager = await import("../src/lib/services/manager.ts");
const state = await import("../src/lib/services/state.ts");
const { renderCompose, DEFAULT_PIDS_LIMIT } = await import("../src/lib/services/compose.ts");
const { sitesConfig } = await import("../src/lib/services/sites.ts");

const office = findSidecar("office");
const learn = findSidecar("learn-db");
const craft = findSidecar("craft");
const silent = { phase() {}, log() {} };

/* ------------------------------------------------------------------------------------------- 1. selection */

test("backend selection: docker by default, helper on request, a typo fails closed", () => {
  assert.equal(backendKind({}), "docker");
  assert.equal(backendKind({ KNIFE_SIDECAR_BACKEND: " Helper " }), "helper");
  assert.equal(backendKind({ KNIFE_SIDECAR_BACKEND: "docker" }), "docker");
  assert.throws(() => backendKind({ KNIFE_SIDECAR_BACKEND: "dockr" }), /docker or helper/);
  assert.equal(sidecarBackend().kind, "docker");
});

test("docker backend argv is exactly what the manager ran before backends existed", () => {
  const file = state.composeFile("office");
  const base = ["compose", "-p", "samurai-knife-office", "-f", file];
  assert.deepEqual(dockerArgv(office, { verb: "ps" }), [...base, "ps", "-a", "--format", "json"]);
  assert.deepEqual(dockerArgv(office, { verb: "pull" }), ["compose", "--progress", "json", "-p", "samurai-knife-office", "-f", file, "pull"]);
  assert.deepEqual(dockerArgv(office, { verb: "up" }), [...base, "up", "-d", "--remove-orphans"]);
  assert.deepEqual(dockerArgv(office, { verb: "down", volumes: true, removeImages: true }), [...base, "down", "--remove-orphans", "--volumes", "--rmi", "all"]);
  assert.deepEqual(dockerArgv(office, { verb: "logs" }), [...base, "logs", "--tail", "30", "documentserver"]);
  assert.deepEqual(dockerArgv(office, { verb: "prepare" }), [...base, "exec", "-T", "documentserver", "documentserver-generate-allfonts.sh"]);
  assert.deepEqual(dockerArgv(office, { verb: "image-id", image: "img:1" }), ["image", "inspect", "--format", "{{.Id}}", "img:1"]);
  assert.deepEqual(dockerArgv(office, { verb: "memory", container: "c1" }), ["stats", "--no-stream", "--format", "{{.MemUsage}}", "c1"]);
  assert.throws(() => dockerArgv(learn, { verb: "prepare" }), /no prepare step/);
});

test("helper request lines: verb + id + fixed flags only; ping-app is not offered", () => {
  assert.equal(helperRequest(office, { verb: "up" }), "up office");
  assert.equal(helperRequest(learn, { verb: "down", volumes: true, removeImages: false }), "down learn-db volumes");
  assert.equal(helperRequest(learn, { verb: "down", volumes: true, removeImages: true }), "down learn-db volumes rmi");
  assert.equal(helperRequest(office, { verb: "image-id", image: "evil; rm -rf /" }), "image-id office", "the image argument never reaches the helper");
  assert.equal(helperRequest(office, { verb: "memory", container: "$(id)" }), "memory office");
  assert.equal(helperRequest(office, { verb: "ping-app", url: "http://x" }), null);
  assert.throws(() => helperRequest({ id: "Office;id" }, { verb: "up" }), /invalid sidecar id/);
});

test("the helper's fixed table matches the sidecar definitions", () => {
  const source = readFileSync(HELPER, "utf8");
  for (const def of SIDECARS) {
    const block = new RegExp(`"${def.id}": \\{[^}]*"service": "${def.serviceName}"[^}]*"image_prefix": "([^"]+)"`).exec(source);
    assert.ok(block, `helper table has ${def.id} with service ${def.serviceName}`);
    assert.ok(def.image.startsWith(block[1]), `${def.image} matches the helper's image prefix ${block[1]}`);
    if (def.prepare) assert.ok(source.includes(JSON.stringify(def.prepare.command).replace(/,/g, ", ")), `prepare command of ${def.id}`);
  }
});

test("the helper REQUIRES each definition's hardening: same cap_add set, pids and memory caps", { skip: spawnSync("python3", ["-c", "1"]).status !== 0 && "python3 missing" }, () => {
  const dump = [
    "import importlib.machinery, importlib.util, json, sys",
    "loader = importlib.machinery.SourceFileLoader('h', sys.argv[1])",
    "spec = importlib.util.spec_from_loader('h', loader); h = importlib.util.module_from_spec(spec); loader.exec_module(h)",
    "print(json.dumps({k: {'cap_add': sorted(v['cap_add']), 'pids_max': v['pids_max'], 'mem_max': v['mem_max']} for k, v in h.SIDECARS.items()}))",
  ].join("\n");
  const result = spawnSync("python3", ["-I", "-c", dump, HELPER], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const table = JSON.parse(result.stdout);
  const scale = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
  assert.deepEqual(Object.keys(table).sort(), SIDECARS.map((def) => def.id).sort());
  for (const def of SIDECARS) {
    assert.deepEqual(table[def.id].cap_add, [...def.security.capAdd].sort(), `${def.id}: helper cap_add = definition security.capAdd`);
    assert.equal(table[def.id].pids_max, def.security.pidsLimit ?? DEFAULT_PIDS_LIMIT, `${def.id}: pids cap`);
    const mem = /^(\d+)([kmg])$/.exec(def.memLimit ?? "");
    assert.ok(mem, `${def.id} sets a memLimit (the helper requires one)`);
    assert.equal(table[def.id].mem_max, Number(mem[1]) * scale[mem[2]], `${def.id}: memory cap`);
  }
});

/* ------------------------------------------------------------------------------------------- 2. fake helper */

/** A fake helper on a unix socket: records request lines, answers from `script(line)` -> {out, err, code} | "hang". */
async function fakeHelper(script) {
  const path = join(work, `fake-${Math.random().toString(36).slice(2)}.sock`);
  const requests = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const line = buffer.split("\n")[0];
      requests.push(line);
      const answer = script(line);
      if (answer === "hang") {
        socket.write("o working\n");
        return;
      }
      if (answer === "drop") {
        socket.destroy();
        return;
      }
      for (const text of answer.out ?? []) socket.write(`o ${text}\n`);
      for (const text of answer.err ?? []) socket.write(`e ${text}\n`);
      socket.end(`x ${answer.code ?? 0}\n`);
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(path, resolve));
  return { path, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("callHelper: streams o/e lines, parses the exit code, reports a dropped connection and aborts", async () => {
  const fake = await fakeHelper((line) => (line === "hang office" ? "hang" : line === "drop office" ? "drop" : { out: ["a", "b"], err: ["warn"], code: 3 }));
  try {
    const lines = [];
    const result = await callHelper("ps office", { socketPath: fake.path, onLine: (text, stream) => lines.push(`${stream}:${text}`) });
    assert.equal(result.code, 3);
    assert.equal(result.stdout, "a\nb\n");
    assert.deepEqual(lines, ["stdout:a", "stdout:b", "stderr:warn"]);
    const dropped = await callHelper("drop office", { socketPath: fake.path });
    assert.equal(dropped.code, null);
    assert.match(dropped.stderr, /without a result/);
    const controller = new AbortController();
    const pending = callHelper("hang office", { socketPath: fake.path, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const aborted = await pending;
    assert.equal(aborted.code, null);
    assert.match(aborted.stderr, /aborted/);
    const missing = await callHelper("version", { socketPath: join(work, "nope.sock") });
    assert.equal(missing.code, null);
    assert.match(missing.stderr, /ENOENT/);
  } finally {
    await fake.close();
  }
});

/** A Postgres stand-in for the health probe: answers an SSLRequest with "N". */
async function fakePostgres() {
  const server = createServer((socket) => socket.once("data", () => socket.end("N")));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("manager over the helper backend: refuses to start until root installed the same bundle, then sends only verb+id", async () => {
  const pg = await fakePostgres();
  let installed = "absent";
  const fake = await fakeHelper((line) => {
    if (line === "version") return { out: [JSON.stringify({ engine: "29.0.0", compose: "2.36.0" })] };
    if (line === "hash learn-db") return { out: [installed] };
    if (line === "ps learn-db") return { out: [JSON.stringify({ Service: "postgres", State: "running", ID: "abc", Name: "samurai-knife-learn-db-postgres-1" })] };
    return { code: 0 };
  });
  process.env.KNIFE_SIDECAR_BACKEND = "helper";
  process.env.KNIFE_SIDECAR_HELPER_SOCKET = fake.path;
  resetHelperCache();
  try {
    state.ensureSecrets(learn);
    state.writeState({ id: "learn-db", image: learn.image, bindHost: "127.0.0.1", hostPort: pg.port, idleStopMinutes: 30, installedAt: "x", updatedAt: "x" });
    await assert.rejects(manager.start("learn-db", silent), (error) => {
      assert.equal(error.status, 409);
      assert.match(error.hint, /sudo knife-sidecar sync learn-db/);
      return true;
    });
    assert.ok(!fake.requests.some((line) => line.startsWith("up")), "no `up` while the bundle is not installed");
    installed = "0".repeat(64);
    await assert.rejects(manager.start("learn-db", silent), /differs from what this release renders/);
    installed = bundleHash(state.serviceDir("learn-db"));
    assert.match(installed, /^[0-9a-f]{64}$/);
    fake.requests.length = 0;
    await manager.start("learn-db", silent);
    assert.deepEqual(fake.requests, ["hash learn-db", "up learn-db"]);
    fake.requests.length = 0;
    const status = await manager.status("learn-db");
    assert.equal(status.runtime.ok, true);
    assert.equal(status.container.state, "running");
    assert.deepEqual(status.warnings, []);
    await manager.stop("learn-db", silent);
    await manager.remove("learn-db", { purge: true }, silent);
    assert.deepEqual(fake.requests.filter((line) => !line.startsWith("ps") && !line.startsWith("hash")), ["stop learn-db", "down learn-db volumes"]);
    for (const line of fake.requests) assert.match(line, /^[a-z-]+( learn-db( volumes| rmi)*)?$/);
  } finally {
    delete process.env.KNIFE_SIDECAR_BACKEND;
    delete process.env.KNIFE_SIDECAR_HELPER_SOCKET;
    resetHelperCache();
    await fake.close();
    await pg.close();
  }
});

test("helper backend: an unreachable socket is a 503 with the systemd hint, never a docker fallback", async () => {
  process.env.KNIFE_SIDECAR_BACKEND = "helper";
  process.env.KNIFE_SIDECAR_HELPER_SOCKET = join(work, "missing.sock");
  resetHelperCache();
  try {
    const info = await sidecarBackend().detect(true);
    assert.equal(info.ok, false);
    assert.match(info.hint, /knife-sidecar\.socket/);
    state.writeState({ id: "office", image: office.image, bindHost: "100.64.0.7", hostPort: 3299, idleStopMinutes: 30, installedAt: "x", updatedAt: "x" });
    await assert.rejects(manager.stop("office", silent), (error) => error.status === 503);
  } finally {
    delete process.env.KNIFE_SIDECAR_BACKEND;
    delete process.env.KNIFE_SIDECAR_HELPER_SOCKET;
    resetHelperCache();
  }
});

/* ------------------------------------------------------------------------------------------- 3. real helper */

const python = spawnSync("python3", ["-c", "import sys; print(sys.version_info >= (3, 9))"], { encoding: "utf8" });
const havePython = python.status === 0 && python.stdout.trim() === "True";

test("helper python unit tests (request parsing, compose validation)", { skip: !havePython && "python3 >= 3.9 missing" }, () => {
  const result = spawnSync("python3", ["-I", join(ROOT, "deploy/sidecar-helper/test_knife_sidecar_helper.py")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

/** Fake docker: logs argv (one JSON array per line), answers a few commands, `pull` hangs (records its pid). */
function writeFakeDocker(dir) {
  const path = join(dir, "fake-docker");
  writeFileSync(
    path,
    `#!/usr/bin/env python3
import json, os, sys, time
args = sys.argv[1:]
with open(${JSON.stringify(join(dir, "docker.log"))}, "a") as log:
    log.write(json.dumps(args) + "\\n")
joined = " ".join(args)
if args[:3] == ["compose", "version", "--short"]: print("2.36.0")
elif args[:1] == ["info"]: print("29.8.2")
elif "pull" in args:
    open(${JSON.stringify(join(dir, "pull.pid"))}, "w").write(str(os.getpid()))
    print("pulling", flush=True)
    time.sleep(60)
elif args[-2:] == ["config", "--images"]: print("postgis/postgis:16-3.4")
elif args[:2] == ["image", "inspect"]: print("sha256:feed")
elif "up" in args: print("Container started", file=sys.stderr)
elif "ps" in args: print(json.dumps({"Service": "postgres", "State": "running"}))
sys.exit(0)
`,
  );
  chmodSync(path, 0o755);
  return path;
}

/** Stand-in for systemd's Accept=yes: one helper process per connection, the socket as its stdin/stdout. */
async function realHelper(conf) {
  const path = join(work, `helper-${Math.random().toString(36).slice(2)}.sock`);
  const server = createServer({ pauseOnConnect: true }, (socket) => {
    const child = spawn("python3", ["-I", HELPER, "serve"], { stdio: [socket, socket, "pipe"], env: { PATH: process.env.PATH, KNIFE_SIDECAR_HELPER_CONF: conf } });
    child.stderr.on("data", () => {});
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(path, resolve));
  return { path, close: () => new Promise((resolve) => server.close(resolve)) };
}

function helperConf(dir, extra = {}) {
  const conf = join(dir, "helper.conf");
  const values = {
    CLIENT_USER: userInfo().username,
    BUNDLE_ROOT: join(dir, "etc"),
    STAGING_DIR: join(dir, "staging"),
    RUNTIME_DIR: join(dir, "run"),
    DOCKER: join(dir, "fake-docker"),
    ALLOW_BIND_HOSTS: "127.0.0.1,100.64.0.7",
    ...extra,
  };
  writeFileSync(conf, Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n"));
  return conf;
}

function installFakeBundle(dir, id) {
  const bundle = join(dir, "etc", id);
  mkdirSync(join(bundle, "assets", "plugin-abc123"), { recursive: true });
  writeFileSync(join(bundle, "compose.yaml"), "name: x\n");
  writeFileSync(join(bundle, "secrets.env"), "A=b\n");
  return bundle;
}

test("real helper: fixed argv per verb, injection attempts refused before docker runs", { skip: !havePython && "python3 missing" }, async () => {
  const dir = mkdtempSync(join(work, "real-"));
  writeFakeDocker(dir);
  const helper = await realHelper(helperConf(dir));
  const log = () => (existsSync(join(dir, "docker.log")) ? readFileSync(join(dir, "docker.log"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  try {
    const version = await callHelper("version", { socketPath: helper.path, timeoutMs: 20_000 });
    assert.equal(version.code, 0, version.stderr);
    assert.deepEqual(JSON.parse(version.stdout.trim()), { engine: "29.8.2", compose: "2.36.0" });

    const notInstalled = await callHelper("up learn-db", { socketPath: helper.path, timeoutMs: 20_000 });
    assert.equal(notInstalled.code, 69);
    assert.match(notInstalled.stderr, /knife-sidecar sync learn-db/);

    const bundle = installFakeBundle(dir, "learn-db");
    const hash = await callHelper("hash learn-db", { socketPath: helper.path, timeoutMs: 20_000 });
    assert.equal(hash.stdout.trim(), bundleHash(bundle), "python and typescript hash the bundle identically");

    const before = log().length;
    const up = await callHelper("up learn-db", { socketPath: helper.path, timeoutMs: 20_000 });
    assert.equal(up.code, 0, up.stderr);
    assert.match(up.stderr, /Container started/);
    const argv = log().slice(before)[0];
    assert.deepEqual(argv, ["compose", "--project-directory", bundle, "-p", "samurai-knife-learn-db", "-f", join(bundle, "compose.yaml"), "up", "-d", "--remove-orphans"]);

    const down = await callHelper("down learn-db volumes rmi", { socketPath: helper.path, timeoutMs: 20_000 });
    assert.equal(down.code, 0);
    assert.deepEqual(log().at(-1).slice(-5), ["down", "--remove-orphans", "--volumes", "--rmi", "all"]);

    const imageId = await callHelper("image-id learn-db", { socketPath: helper.path, timeoutMs: 20_000 });
    assert.equal(imageId.stdout.trim(), "sha256:feed");
    assert.deepEqual(log().at(-1), ["image", "inspect", "--format", "{{.Id}}", "postgis/postgis:16-3.4"]);

    const count = log().length;
    for (const line of ["up learn-db;id", "up ../learn-db", "exec learn-db", "up learn-db -d", "UP learn-db", "down learn-db --volumes", "up nginx", "up learn-db\u0000x", "x".repeat(400)]) {
      const result = await callHelper(line, { socketPath: helper.path, timeoutMs: 20_000 });
      assert.equal(result.code, 64, `${JSON.stringify(line.slice(0, 40))} -> ${result.code} ${result.stderr}`);
    }
    assert.equal(log().length, count, "no refused request reached docker");
  } finally {
    await helper.close();
  }
});

test("real helper: closing the connection kills the running docker command; the peer check refuses other users", { skip: !havePython && "python3 missing" }, async () => {
  const dir = mkdtempSync(join(work, "abort-"));
  writeFakeDocker(dir);
  installFakeBundle(dir, "learn-db");
  const helper = await realHelper(helperConf(dir));
  try {
    const controller = new AbortController();
    const pending = callHelper("pull learn-db", { socketPath: helper.path, signal: controller.signal, onLine: (text) => text === "pulling" && controller.abort() });
    await pending;
    const pid = Number(readFileSync(join(dir, "pull.pid"), "utf8"));
    const deadline = Date.now() + 10_000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, "the hanging docker pull was killed when the client went away");
  } finally {
    await helper.close();
  }
  const other = mkdtempSync(join(work, "peer-"));
  writeFakeDocker(other);
  const strict = await realHelper(helperConf(other, { CLIENT_USER: "root-only-no-such-user" }));
  try {
    const refused = await callHelper("version", { socketPath: strict.path, timeoutMs: 20_000 });
    assert.equal(refused.code, 77);
    assert.equal(existsSync(join(other, "docker.log")), false);
  } finally {
    await strict.close();
  }
});

/* ------------------------------------------------------------------------------------------- 4. sync */

const composeProbe = spawnSync("docker", ["compose", "version", "--short"], { encoding: "utf8" });
const haveCompose = havePython && composeProbe.status === 0;

test("sync: the app's rendered compose files pass the helper's validator; tampering is refused", { skip: !haveCompose && "docker compose plugin missing" }, () => {
  const dir = mkdtempSync(join(work, "sync-"));
  // Real `docker compose config` (offline parse only); the wrapper finds a per-user compose plugin under the test's HOME.
  const wrapper = join(dir, "docker-wrapper");
  writeFileSync(wrapper, `#!/bin/sh\nexport DOCKER_CONFIG=${JSON.stringify(join(homedir(), ".docker"))}\nexec docker "$@"\n`);
  chmodSync(wrapper, 0o755);
  const conf = helperConf(dir, { DOCKER: wrapper });
  const env = { PATH: process.env.PATH, KNIFE_SIDECAR_HELPER_CONF: conf };
  for (const def of [learn, office, craft]) {
    const staging = join(dir, "staging", def.id);
    mkdirSync(join(staging, "assets", "knife-bridge-0123abcd"), { recursive: true });
    writeFileSync(join(staging, "assets", "knife-bridge-0123abcd", "config.json"), "{}\n");
    const host = def.id === "office" ? "100.64.0.7" : "127.0.0.1";
    const extraEnv = def.requestFilter ? { NODE_CONFIG: JSON.stringify({ services: { CoAuthoring: { "request-filtering-agent": { allowIPAddressList: [] } } } }) } : undefined;
    // The ArtCraft nginx: read-only root, tmpfs, fixed entrypoint, healthcheck, its generated config named in `command`.
    writeFileSync(join(staging, "compose.yaml"), renderCompose(def, { bindHost: host, hostPort: 3290, extraEnv, command: sitesConfig(def)?.command }));
    writeFileSync(join(staging, "secrets.env"), def.secrets.map((secret) => `${secret.name}=${"ab".repeat(8)}`).join("\n") + "\n");
    const result = spawnSync("python3", ["-I", HELPER, "sync", def.id, "--yes"], { env, encoding: "utf8" });
    assert.equal(result.status, 0, `${def.id}: ${result.stdout}${result.stderr}`);
    const installed = join(dir, "etc", def.id);
    assert.equal(spawnSync("python3", ["-I", HELPER, "hash", def.id], { env, encoding: "utf8" }).stdout.trim(), bundleHash(staging), "installed copy = staged copy");
    assert.ok(existsSync(join(installed, "assets", "knife-bridge-0123abcd", "config.json")));
    const again = spawnSync("python3", ["-I", HELPER, "sync", def.id, "--yes"], { env, encoding: "utf8" });
    assert.match(again.stdout, /already installed/);
  }
  const staging = join(dir, "staging", "learn-db");
  const good = readFileSync(join(staging, "compose.yaml"), "utf8");
  const tampered = [
    [good.replace("restart: no\n", "restart: no\n    privileged: true\n"), /service keys not allowed/],
    [good.replace("restart: no\n", "restart: no\n    network_mode: host\n"), /refused|not allowed/],
    [good.replace("- pgdata:/var/lib/postgresql/data", "- /:/host"), /bind mount/],
    [good.replace("127.0.0.1:3290:5432", "3290:5432"), /every address|allowed/],
    [good.replace("image: postgis/postgis:16-3.4", "image: evil/x:1"), /image must start/],
    [good.replace("restart: no\n", "restart: no\n    command: [\"sh\", \"-c\", \"echo $HOME\"]\n"), /`\$`/],
    // Host audit M2: a bundle WITHOUT the hardening is refused, not tolerated.
    [good.replace(/ {4}cap_drop:\n {6}- ALL\n/, ""), /cap_drop must be exactly \[ALL\]/],
    [good.replace(/ {4}security_opt:\n {6}- no-new-privileges:true\n/, ""), /no-new-privileges/],
    [good.replace(/ {4}pids_limit: \d+\n/, ""), /pids_limit must be set/],
    [good.replace(/ {4}mem_limit: \S+\n/, ""), /mem_limit must be set/],
    [good.replace(/ {6}- SETUID\n/, ""), /exactly the definition's set/],
  ];
  for (const [text, expected] of tampered) {
    assert.notEqual(text, good);
    writeFileSync(join(staging, "compose.yaml"), text);
    const result = spawnSync("python3", ["-I", HELPER, "sync", "learn-db", "--yes"], { env, encoding: "utf8" });
    assert.notEqual(result.status, 0, text);
    assert.match(result.stderr, expected);
  }
  writeFileSync(join(staging, "compose.yaml"), good);
  writeFileSync(join(staging, "secrets.env"), "POSTGRES_PASSWORD=$(id)\n");
  assert.match(spawnSync("python3", ["-I", HELPER, "sync", "learn-db", "--yes"], { env, encoding: "utf8" }).stderr, /secrets\.env must hold/);
});
