// Parser sandbox (src/lib/python-sandbox.mjs, src/lib/python.ts; audit injection #5).
//   1. policy: public mode requires it, a typo fails closed, `off` warns in public mode
//   2. argv: namespaces, read-only system binds, job dirs only, no bind can expose the data dir or the storage key
//   3. REAL runs through runPythonScript (skipped when bubblewrap cannot run here): an attack script cannot read another
//      job's file, the data dir or the storage key, cannot write outside its scratch dir, has no network (not even the
//      host's loopback), sees only its own processes; an abort kills what it started even in a new session
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/python_sandbox.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const REPO = new URL("..", import.meta.url).pathname;
const sandbox = await import("../src/lib/python-sandbox.mjs");

/* ------------------------------------------------------------------------------------------- 1. policy */

test("policy: auto = required in public mode, off in private; bwrap = required; off warns in public; typo fails closed", () => {
  const works = { ok: true, detail: "ok" };
  const broken = { ok: false, detail: "bwrap: setting up uid map: Permission denied" };
  const policy = (value, mode, probe) => sandbox.sandboxPolicy(value === undefined ? {} : { KNIFE_PY_SANDBOX: value }, mode, probe);

  assert.deepEqual(policy(undefined, "public", works), { use: "bwrap", errors: [], warnings: [] });
  assert.equal(policy(undefined, "public", broken).errors.length, 1, "public mode refuses to start without a working sandbox");
  assert.match(policy(undefined, "public", broken).errors[0], /public mode requires it/);
  assert.deepEqual(policy("auto", "private", works), { use: "off", errors: [], warnings: [] }, "private mode keeps its behaviour unless asked");
  assert.deepEqual(policy(undefined, "private", broken), { use: "off", errors: [], warnings: [] });
  assert.equal(policy("bwrap", "private", works).use, "bwrap");
  assert.equal(sandbox.sandboxRequired({}, "public"), true);
  assert.equal(sandbox.sandboxRequired({}, "private"), false);
  assert.equal(sandbox.sandboxRequired({ KNIFE_PY_SANDBOX: "bwrap" }, "private"), true);
  assert.equal(sandbox.sandboxRequired({ KNIFE_PY_SANDBOX: "off" }, "public"), false);
  assert.equal(policy("bwrap", "private", broken).errors.length, 1, "explicit bwrap is required in private mode too");
  assert.deepEqual(policy("off", "private", broken), { use: "off", errors: [], warnings: [] });
  const publicOff = policy("off", "public", works);
  assert.equal(publicOff.use, "off");
  assert.match(publicOff.warnings[0], /WITHOUT the bubblewrap sandbox/);
  for (const typo of ["bwarp", "on", "true", "1"]) assert.equal(policy(typo, "private", works).errors.length, 1, typo);
  assert.equal(sandbox.sandboxSetting({ KNIFE_PY_SANDBOX: " BWRAP " }), "bwrap");
});

/* ------------------------------------------------------------------------------------------- 2. argv */

const work = mkdtempSync(join(tmpdir(), "knife-sbx-test-"));
// process exit, not test.after: a top-level after hook here runs before the later tests.
process.on("exit", () => rmSync(work, { recursive: true, force: true }));

function layout(extra = {}) {
  return {
    python: "/usr/bin/python3",
    scriptsDir: join(REPO, "server/py/scripts"),
    extraRo: [],
    forbidden: [join(work, "data"), join(work, "keys/storage.key")],
    ...extra,
  };
}

test("sandbox env: removes host home/tool paths and retains only paths visible read-only", () => {
  const env = sandbox.sandboxChildEnv({
    PATH: "/home/user/.local/bin:/usr/bin:/opt/tools/bin",
    HOME: "/tmp/job",
    TMPDIR: "/tmp/job/tmp",
    TESSDATA_PREFIX: "/usr/share/tesseract-ocr/5/tessdata",
    KNIFE_RLIMIT_CPU_SEC: "65",
    KNIFE_SMTP_PASS: "secret",
  }, layout());
  assert.equal(env.PATH, "/usr/local/bin:/usr/bin:/bin");
  assert.equal(env.TESSDATA_PREFIX, "/usr/share/tesseract-ocr/5/tessdata");
  assert.equal(env.KNIFE_RLIMIT_CPU_SEC, "65");
  assert.equal(env.KNIFE_SMTP_PASS, undefined);
  assert.doesNotMatch(env.PATH, /home|opt\/tools/);

  const toolRoot = join(work, "external-tools");
  mkdirSync(join(toolRoot, "bin"), { recursive: true });
  const withExtraRoot = sandbox.sandboxChildEnv({ PATH: `/usr/bin:${toolRoot}/bin`, HOME: "/tmp/job", TMPDIR: "/tmp/job/tmp" }, layout({ extraRo: [toolRoot] }));
  assert.ok(withExtraRoot.PATH.includes(`${toolRoot}/bin`), "only an explicitly bound tool root extends PATH");
});

test("argv: own user/pid/net/ipc namespaces, no nested userns, clean env, read-only system, only the job's dirs", () => {
  const scratch = join(work, "job");
  const out = join(work, "out");
  const uploads = join(work, "uploads");
  const args = sandbox.bwrapArgs(layout(), { scratch, readOnly: [uploads], writable: [out] }, { PATH: "/usr/bin", HOME: scratch });
  for (const flag of ["--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--disable-userns", "--die-with-parent", "--new-session", "--clearenv"]) {
    assert.ok(args.includes(flag), flag);
  }
  assert.ok(!args.includes("--share-net") && !args.includes("--unshare-all"));
  const pairs = (flag) => args.flatMap((arg, i) => (arg === flag ? [args[i + 1]] : []));
  assert.ok(pairs("--ro-bind").includes("/usr"));
  assert.ok(pairs("--ro-bind").includes(join(REPO, "server/py/scripts")), "scripts are read-only");
  assert.ok(pairs("--ro-bind").includes(uploads), "uploads are read-only");
  assert.deepEqual(pairs("--bind"), [scratch, out], "the only writable binds are the job's dirs");
  assert.ok(!pairs("--ro-bind").includes("/etc"), "never /etc as a whole");
  const allowed = (p) => p === "/usr" || p.startsWith("/etc/") || p === "/var/cache/fontconfig" || p === uploads || p === join(REPO, "server/py/scripts");
  assert.deepEqual(pairs("--ro-bind").filter((p) => !allowed(p)), [], "read-only binds: /usr, named /etc files, the scripts, the uploads");
  assert.equal(args[args.indexOf("--chdir") + 1], join(REPO, "server/py/scripts"));
  const envPairs = args.flatMap((arg, i) => (arg === "--setenv" ? [`${args[i + 1]}=${args[i + 2]}`] : []));
  assert.deepEqual(envPairs, ["PATH=/usr/bin", `HOME=${scratch}`]);
  assert.throws(() => sandbox.bwrapArgs(layout(), { scratch }, { "BAD NAME": "x" }), /invalid env name/);
});

test("argv: no bind may expose the data dir or the storage key (root, ancestor or inside)", () => {
  mkdirSync(join(work, "data", "cv"), { recursive: true });
  mkdirSync(join(work, "keys"), { recursive: true });
  writeFileSync(join(work, "keys/storage.key"), "0".repeat(64));
  const scratch = join(work, "job");
  for (const bad of ["/", work, join(work, "data"), join(work, "data", "cv"), join(work, "keys")]) {
    assert.throws(() => sandbox.bwrapArgs(layout(), { scratch, writable: [bad] }, {}), /refused|would expose/, `writable ${bad}`);
    assert.throws(() => sandbox.bwrapArgs(layout({ extraRo: [bad] }), { scratch }, {}), /refused|would expose/, `extra ro ${bad}`);
  }
  assert.throws(() => sandbox.bwrapArgs(layout({ extraRo: ["relative/path"] }), { scratch }, {}), /not absolute|does not exist/);
  assert.throws(() => sandbox.bwrapArgs(layout({ extraRo: [join(work, "missing")] }), { scratch }, {}), /does not exist/);
  // The default data dir and the configured key/GitHub files are what the server forbids.
  const forbidden = sandbox.forbiddenPaths({ KNIFE_DATA_DIR: "/srv/knife-data", KNIFE_STORAGE_KEY_FILE: "/etc/knife/storage.key", KNIFE_GITHUB_APP_FILE: "relative.json" });
  assert.deepEqual(forbidden, ["/srv/knife-data", "/etc/knife/storage.key"]);
});

test("argv: an interpreter reached through symlinks outside every bound tree is recreated link by link", () => {
  const venv = join(work, "venv");
  const prefix = join(work, "cpython");
  mkdirSync(join(venv, "bin"), { recursive: true });
  mkdirSync(join(prefix, "bin"), { recursive: true });
  mkdirSync(join(work, "localbin"), { recursive: true });
  copyFileSync("/bin/true", join(prefix, "bin/python3.12"));
  spawnSync("ln", ["-sf", join(prefix, "bin/python3.12"), join(work, "localbin/python3.12")]);
  spawnSync("ln", ["-sf", join(work, "localbin/python3.12"), join(venv, "bin/python3.12")]);
  spawnSync("ln", ["-sf", "python3.12", join(venv, "bin/python")]);
  const args = sandbox.bwrapArgs(layout({ python: join(venv, "bin/python") }), { scratch: join(work, "job") }, {});
  const ro = args.flatMap((arg, i) => (arg === "--ro-bind" ? [args[i + 1]] : []));
  assert.ok(ro.includes(venv) && ro.includes(prefix), "venv and the interpreter prefix are bound");
  const links = args.flatMap((arg, i) => (arg === "--symlink" ? [`${args[i + 2]}->${args[i + 1]}`] : []));
  assert.ok(links.includes(`${join(work, "localbin/python3.12")}->${join(prefix, "bin/python3.12")}`), "the out-of-tree hop is recreated");
  assert.ok(!links.some((link) => link.startsWith(venv)), "links inside the bound venv come with the bind");
});

test("startup warning: a tool on PATH whose real file the sandbox cannot see", () => {
  const brew = join(work, "brew");
  mkdirSync(join(brew, "Cellar/tesseract/bin"), { recursive: true });
  mkdirSync(join(brew, "bin"), { recursive: true });
  copyFileSync("/bin/true", join(brew, "Cellar/tesseract/bin/tesseract"));
  spawnSync("ln", ["-sf", join(brew, "Cellar/tesseract/bin/tesseract"), join(brew, "bin/tesseract")]);
  const env = { PATH: `${join(brew, "bin")}:/usr/bin:/bin` };
  assert.match(sandbox.toolsOutsideSandbox(layout(), env, ["tesseract"]).join(), /tesseract/);
  assert.deepEqual(sandbox.toolsOutsideSandbox(layout({ extraRo: [brew] }), env, ["tesseract"]), [], "KNIFE_PY_SANDBOX_RO makes it visible");
  assert.deepEqual(sandbox.toolsOutsideSandbox(layout(), { PATH: "/usr/bin:/bin" }, ["sh"]), []);
});

/* ------------------------------------------------------------------------------------------- 3. real runs */

const appRoot = mkdtempSync(join(tmpdir(), "knife-sbx-app-"));
process.on("exit", () => rmSync(appRoot, { recursive: true, force: true }));
const scripts = join(appRoot, "server/py/scripts");
mkdirSync(scripts, { recursive: true });
copyFileSync(join(REPO, "server/py/scripts/run_limited.py"), join(scripts, "run_limited.py"));
const dataDir = join(appRoot, "data");
mkdirSync(join(dataDir, "cv"), { recursive: true });
writeFileSync(join(dataDir, "cv/genor.json"), "SEALED-ACCOUNT-DATA");
const keyFile = join(appRoot, "keys/storage.key");
mkdirSync(join(appRoot, "keys"));
writeFileSync(keyFile, "f".repeat(64));
const otherJob = mkdtempSync(join(tmpdir(), "knife-other-job-"));
process.on("exit", () => rmSync(otherJob, { recursive: true, force: true }));
writeFileSync(join(otherJob, "upload.pdf"), "ANOTHER-USERS-UPLOAD");

// The attack: everything a parser exploit would try first. Prints what it reached.
writeFileSync(
  join(scripts, "attack.py"),
  String.raw`import json, os, socket, sys
req = json.load(open(sys.argv[1]))
seen = {}
def attempt(name, fn):
    try:
        seen[name] = ("REACHED", str(fn())[:80])
    except Exception as exc:
        seen[name] = ("blocked", type(exc).__name__)
attempt("other_job", lambda: open(req["other"]).read())
attempt("data_dir", lambda: open(req["data"]).read())
attempt("data_listing", lambda: os.listdir(req["data_dir"]))
attempt("storage_key", lambda: open(req["key"]).read())
attempt("host_loopback", lambda: socket.create_connection(("127.0.0.1", req["port"]), timeout=2))
attempt("internet", lambda: socket.create_connection(("1.1.1.1", 53), timeout=2))
attempt("dns", lambda: socket.getaddrinfo("example.org", 80))
attempt("write_scripts", lambda: open(os.path.join(os.path.dirname(__file__), "planted.py"), "w").write("x"))
attempt("write_tmp_root", lambda: open("/tmp/../planted", "w").write("x"))
attempt("app_proc", lambda: open("/proc/%d/environ" % req["app_pid"], "rb").read())
attempt("etc_shadow", lambda: open("/etc/shadow").read())
seen["pids"] = sorted(int(p) for p in os.listdir("/proc") if p.isdigit())
seen["env"] = sorted(os.environ)
with open(os.path.join(os.environ["TMPDIR"], "t.txt"), "w") as handle:
    handle.write("scratch ok")
with open(os.path.join(req["out_dir"], "result.txt"), "w") as handle:
    handle.write("out ok")
json.dump({"ok": True, "data": seen}, open(sys.argv[2], "w"))
`,
);
writeFileSync(
  join(scripts, "linger.py"),
  String.raw`import json, subprocess, sys, time
req = json.load(open(sys.argv[1]))
# A child in its OWN session: outside the sandbox it would escape a process-group kill.
subprocess.Popen(["sleep", req["token"]], start_new_session=True)
time.sleep(60)
`,
);

const env = {
  KNIFE_DATA_DIR: dataDir,
  KNIFE_STORAGE_KEY_FILE: keyFile,
  KNIFE_PYTHON: "/usr/bin/python3",
  KNIFE_PY_SANDBOX: "bwrap",
  KNIFE_AUTH_MODE: "private",
  KNIFE_SMTP_PASS: "smtp-secret-value",
};
const probe = await sandbox.probeSandbox(sandbox.sandboxLayout(env, appRoot), env);
const skip = !existsSync("/usr/bin/python3") ? "python3 missing" : !probe.ok ? `bubblewrap cannot run here: ${probe.detail}` : false;

/** Imports python.ts with this file's app root as the cwd (PY_SCRIPTS_DIR is fixed at import). */
async function lane() {
  Object.assign(process.env, env);
  process.chdir(appRoot);
  const python = await import("../src/lib/python.ts");
  python.resetPythonSandbox();
  return python;
}

test("sandboxed run: no other job's file, no data dir, no storage key, no network, no host processes; own dirs work", { skip }, async () => {
  const python = await lane();
  const server = createServer((socket) => socket.end("hello")).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const out = await python.makeScratchDir("knife-sbx-out-");
  try {
    const result = await python.runPythonScript("attack.py", {
      other: join(otherJob, "upload.pdf"),
      data: join(dataDir, "cv/genor.json"),
      data_dir: dataDir,
      key: keyFile,
      port: server.address().port,
      app_pid: process.pid,
      out_dir: out,
    }, { binds: { writable: [out] }, timeoutMs: 30_000 });
    assert.equal(result.ok, true, `${result.error} ${result.logs.join("\n")}`);
    const seen = result.data;
    for (const name of ["other_job", "data_dir", "data_listing", "storage_key", "host_loopback", "internet", "dns", "write_scripts", "write_tmp_root", "app_proc", "etc_shadow"]) {
      assert.equal(seen[name][0], "blocked", `${name}: ${seen[name].join(" ")}`);
    }
    assert.ok(seen.pids.length <= 4 && !seen.pids.includes(process.pid), `own pid namespace: ${seen.pids}`);
    assert.ok(!seen.env.includes("KNIFE_SMTP_PASS") && !seen.env.includes("KNIFE_DATA_DIR"), seen.env.join(","));
    assert.equal(readFileSync(join(out, "result.txt"), "utf8"), "out ok", "the declared out_dir is writable");
    assert.ok(!existsSync(join(scripts, "planted.py")));
  } finally {
    server.close();
    await python.disposeDir(out);
  }
});

test("sandboxed run: an abort kills everything the script started, even a child in its own session", { skip }, async () => {
  const python = await lane();
  const token = `${4000 + Math.floor(Math.random() * 1000)}.${process.pid}`;
  const controller = new AbortController();
  const pending = python.runPythonScript("linger.py", { token }, { signal: controller.signal, timeoutMs: 60_000 });
  const sleeping = () =>
    readdirSync("/proc").filter((pid) => /^\d+$/.test(pid)).some((pid) => {
      try {
        return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim() === `sleep ${token}`;
      } catch {
        return false;
      }
    });
  const deadline = Date.now() + 15_000;
  while (!sleeping() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(sleeping(), "the sandboxed child started");
  controller.abort();
  const result = await pending;
  assert.equal(result.cancelled, true);
  const gone = Date.now() + 5_000;
  while (sleeping() && Date.now() < gone) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(sleeping(), false, "the pid namespace went down with bwrap");
});

test("a required sandbox that does not work fails every job closed (never runs unsandboxed)", { skip: !existsSync("/usr/bin/python3") && "python3 missing" }, async () => {
  const python = await lane();
  process.env.KNIFE_BWRAP = join(appRoot, "no-such-bwrap");
  try {
    python.resetPythonSandbox();
    const result = await python.runPythonScript("attack.py", {}, { timeoutMs: 10_000 });
    assert.equal(result.ok, false);
    assert.match(result.error, /sandbox is unavailable/);
  } finally {
    delete process.env.KNIFE_BWRAP;
    python.resetPythonSandbox();
  }
});

test("job dirs must be the job's own scratch dirs directly under the temp dir", { skip }, async () => {
  const python = await lane();
  const result = await python.runPythonScript("attack.py", {}, { binds: { writable: [dataDir] }, timeoutMs: 10_000 });
  assert.equal(result.ok, false);
  assert.match(result.error, /not a scratch dir/);
});
