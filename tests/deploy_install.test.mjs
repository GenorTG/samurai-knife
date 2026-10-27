// The systemd install (deploy/install.sh, deploy/bin/knife-update, knife-admin, the units and the polkit rule) is checked
// statically here; the full install was verified in a systemd Debian 12 container (docs/DEPLOY.md "Install script").
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const INSTALL = read("deploy/install.sh");
const UNITS = readdirSync(join(ROOT, "deploy/systemd")).map((name) => `deploy/systemd/${name}`);
const TEMPLATES = [...UNITS, "deploy/polkit/50-samurai-knife-deploy.rules", "deploy/bin/knife-admin"];

function unitLines(text, key) {
  return text.split("\n").filter((line) => line.startsWith(`${key}=`)).map((line) => line.slice(key.length + 1));
}

test("shell scripts parse", () => {
  for (const rel of ["deploy/install.sh", "deploy/bin/knife-update", "deploy/bin/knife-admin"]) {
    const result = spawnSync("bash", ["-n", join(ROOT, rel)], { encoding: "utf8" });
    assert.equal(result.status, 0, `${rel}: ${result.stderr}`);
  }
});

test("every @PLACEHOLDER@ in an installed file is one install.sh substitutes", () => {
  const substituted = new Set([...INSTALL.matchAll(/s\|@([A-Z_]+)@\|/g)].map((match) => match[1]));
  assert.ok(substituted.size >= 5, "the sub() list was not found");
  for (const rel of TEMPLATES) {
    for (const [, name] of read(rel).matchAll(/@([A-Z_]+)@/g)) {
      assert.ok(substituted.has(name), `${rel} uses @${name}@, which install.sh never replaces`);
    }
  }
});

test("install.sh installs every unit, the polkit rule and both tools", () => {
  for (const rel of [...UNITS.filter((rel) => !/knife-(firewall|docker-user)\.service$/.test(rel)), "deploy/polkit/50-samurai-knife-deploy.rules"]) {
    assert.ok(INSTALL.includes(`$SRC/${rel}`), `install.sh does not install ${rel}`);
  }
  assert.match(INSTALL, /deploy\/bin\/knife-update"/);
  assert.match(INSTALL, /deploy\/bin\/knife-admin"/);
});

test("live.env never overrides what the unit sets (EnvironmentFile wins over Environment=)", () => {
  const keys = new Set(INSTALL.match(/^UNIT_KEYS="([^"]+)"/m)[1].split(" "));
  const unit = read("deploy/systemd/samurai-knife.service");
  for (const assignment of unitLines(unit, "Environment")) {
    const key = assignment.split("=")[0];
    if (key.startsWith("KNIFE_") || key === "PATH" || key === "NODE_ENV") assert.ok(keys.has(key), `UNIT_KEYS lacks ${key}`);
  }
});

test("units that start the parser sandbox leave out the directives that break bubblewrap", () => {
  // Verified in systemd containers (Debian 12 / systemd 252, Arch / systemd 262, bubblewrap 0.8 and 0.13): these cover
  // parts of /proc with mounts, so the kernel refuses bwrap a fresh /proc, or answer openat2 with ENOSYS. Any of them
  // makes every sandbox start fail: public mode refuses to start (service) and every preflight fails (updater).
  const breaking = ["ProtectKernelTunables", "ProtectKernelLogs", "ProtectHostname", "RestrictSUIDSGID"];
  for (const rel of ["deploy/systemd/samurai-knife.service", "deploy/systemd/knife-update.service"]) {
    const unit = read(rel);
    for (const key of breaking) assert.deepEqual(unitLines(unit, key), [], `${rel} sets ${key}`);
    assert.deepEqual(unitLines(unit, "ProtectHome"), ["yes"], `${rel}: ProtectHome expected`);
  }
  const app = read("deploy/systemd/samurai-knife.service");
  assert.deepEqual(unitLines(app, "CapabilityBoundingSet"), [""], "the reasoning above needs an empty capability set");
});

test("the app runs unprivileged and the updater restarts it through polkit, not sudo", () => {
  const app = read("deploy/systemd/samurai-knife.service");
  assert.deepEqual(unitLines(app, "User"), ["knife"]);
  assert.deepEqual(unitLines(app, "NoNewPrivileges"), ["yes"]);
  assert.deepEqual(unitLines(app, "ProtectHome"), ["yes"]);
  assert.match(app, /^Environment=KNIFE_PYTHON=@APP_ROOT@\/current\/\.py\/venv\/bin\/python$/m);
  const updater = read("deploy/systemd/knife-update.service");
  assert.deepEqual(unitLines(updater, "User"), ["knife-deploy"]);
  assert.deepEqual(unitLines(updater, "NoNewPrivileges"), ["yes"]);
  const rule = read("deploy/polkit/50-samurai-knife-deploy.rules");
  assert.match(rule, /action\.lookup\("verb"\) == "restart"/);
  assert.match(rule, /action\.lookup\("unit"\) == "@SERVICE@"/);
  assert.match(rule, /subject\.user == "knife-deploy"/);
  assert.doesNotMatch(INSTALL, /sudoers/);
});

test("knife-update builds a venv per release and never deploys backwards", () => {
  const updater = read("deploy/bin/knife-update");
  assert.match(updater, /-m venv "\$dir\/\.py\/venv"/);
  assert.match(updater, /merge-base --is-ancestor "\$current" "\$target"/);
  assert.match(updater, /ln -s "\$CACHE_DIR" "\$dir\/\.next\/cache"/);
  assert.match(updater, /flock -n -o -E 75/);
});

test("the service is enabled at boot only by --start (never next to an old server before the data moved)", () => {
  const enables = INSTALL.split("\n").filter((line) => /systemctl enable\b.*\$SERVICE/.test(line));
  assert.equal(enables.length, 1, enables.join("\n"));
  const startBlock = INSTALL.slice(INSTALL.indexOf('if [[ -n "$START" ]]; then'));
  assert.ok(startBlock.includes(enables[0]), "the only `systemctl enable $SERVICE` must be inside the --start block");
});

test("knife-update never returns to the caller's directory (knife-deploy may not enter the operator's home)", () => {
  const updater = read("deploy/bin/knife-update");
  assert.doesNotMatch(updater, /\bcd -/);
  assert.match(updater, /^set -euo pipefail\n(#.*\n)*cd \/\n/m);
});

test("package names per package manager (checked against Debian 12, Fedora 44, Arch and openSUSE Tumbleweed)", () => {
  const fn = INSTALL.slice(INSTALL.indexOf("pkg_name() {"), INSTALL.indexOf("pkg_install() {"));
  const expected = {
    "apt-get": "git curl rsync util-linux bubblewrap tesseract-ocr tesseract-ocr-eng tesseract-ocr-pol tesseract-ocr-osd qpdf ghostscript polkitd python3-venv libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0",
    dnf: "git curl rsync util-linux bubblewrap tesseract tesseract-langpack-eng tesseract-langpack-pol tesseract-osd qpdf ghostscript polkit venv pango",
    pacman: "git curl rsync util-linux bubblewrap tesseract tesseract-data-eng tesseract-data-pol tesseract-data-osd qpdf ghostscript polkit venv pango",
    zypper: "git curl rsync util-linux bubblewrap tesseract-ocr tesseract-ocr-traineddata-eng tesseract-ocr-traineddata-pol tesseract-ocr-traineddata-osd qpdf ghostscript polkit venv libpango-1_0-0",
  };
  const logical = "git curl rsync util-linux bubblewrap tesseract tess-eng tess-pol tess-osd qpdf ghostscript polkit venv pango";
  for (const [pm, names] of Object.entries(expected)) {
    const script = `${fn}\nPM=${pm}; for n in ${logical}; do pkg_name "$n"; done | paste -sd' '`;
    const out = spawnSync("bash", ["-c", script], { encoding: "utf8" });
    assert.equal(out.stdout.trim(), names, pm);
  }
});

test("log files: the app writes only its two log folders, knife-update its own, the viewer reads both", () => {
  const app = read("deploy/systemd/samurai-knife.service");
  assert.deepEqual(unitLines(app, "Environment").filter((line) => line.startsWith("KNIFE_LOG_DIR=")), ["KNIFE_LOG_DIR=@APP_ROOT@/logs"]);
  assert.deepEqual(unitLines(app, "ReadOnlyPaths"), ["@APP_ROOT@"], "the release tree stays read-only");
  assert.deepEqual(unitLines(app, "ReadWritePaths"), ["@APP_ROOT@/logs/app @APP_ROOT@/logs/sidecars"], "never logs/update, never the root");
  // install.sh creates every ReadWritePaths entry (systemd refuses to start the unit when one is missing)
  assert.match(INSTALL, /^install -d -o root -g root -m 0751 "\$LOGS"$/m, "log root: root-owned, not listable");
  assert.match(INSTALL, /^install -d -o knife -g knife -m 0750 "\$LOGS\/app" "\$LOGS\/sidecars"$/m);
  assert.match(INSTALL, /^install -d -o knife-deploy -g knife -m 2750 "\$LOGS\/update"$/m, "update/: knife-deploy writes, knife (setgid group) only reads");
  assert.match(INSTALL, /^LOGS="\$APP_ROOT\/logs"/m);
  assert.ok(INSTALL.indexOf('install -d -o root -g root -m 0751 "$LOGS"') < INSTALL.indexOf("samurai-knife-sandbox-probe.service"), "dirs exist before the probe copy of the unit starts");
  // knife-update gets the folder and the retention (it cannot read legal.json) through update.conf
  assert.match(INSTALL, /^LOG_DIR=\$LOGS\/update$/m);
  assert.match(INSTALL, /^LOG_RETENTION_DAYS=\$log_days$/m);
  assert.match(INSTALL, /logRetentionDays/);
  const updater = read("deploy/bin/knife-update");
  assert.match(updater, /LOG_DIR="\$\(conf LOG_DIR\)"/);
  assert.match(updater, /LOG_DAYS="\$\(conf LOG_RETENTION_DAYS\)"/);
  assert.match(updater, /umask 027/, "update log files are 0640");
  assert.match(updater, /^prune_logs$/m, "retention runs on every updater run");
  assert.match(updater, /KNIFE_LOG_DIR="\$pre\/logs"/, "the preflight server logs into its temp dir, never into the release");
  const updaterUnit = read("deploy/systemd/knife-update.service");
  assert.deepEqual(unitLines(updaterUnit, "ReadWritePaths"), ["@APP_ROOT@"], "logs/update is inside the updater's writable tree");
});

test("sidecar helper unit: reads the app's staged content, writes only its runtime dir and the Craft content dir (install.sh creates it)", () => {
  const unit = read("deploy/systemd/knife-sidecar@.service");
  assert.deepEqual(unitLines(unit, "ProtectSystem"), ["strict"]);
  assert.deepEqual(unitLines(unit, "CapabilityBoundingSet"), ["CAP_DAC_READ_SEARCH"], "root must read the app's 0700 staging dir; nothing more");
  assert.deepEqual(unitLines(unit, "AmbientCapabilities"), [], "root needs no ambient set");
  assert.deepEqual(unitLines(unit, "ReadWritePaths"), ["/run/knife-sidecar -/etc/samurai-knife/sidecars/craft-content"], "the content verb swaps app folders there; nothing else under /etc");
  const helper = read("deploy/sidecar-helper/knife-sidecar-helper");
  assert.match(helper, /"BUNDLE_ROOT": "\/etc\/samurai-knife\/sidecars"/, "the unit's path is the helper's default content dir parent");
  assert.match(helper, /os\.path\.join\(conf\["BUNDLE_ROOT"\], f"\{sidecar_id\}-content"\)/);
  assert.match(INSTALL, /^  install -d -o root -g root -m 0755 "\$ETC\/sidecars" "\$ETC\/sidecars\/craft-content"$/m);
  assert.match(INSTALL, /^ETC=\/etc\/samurai-knife$/m);
});

test("the repo: --repo, the checkout's origin, the installed update.conf, then package.json (a re-run from current works)", () => {
  const start = INSTALL.indexOf('if [[ -z "$REPO_URL" ]]; then REPO_URL="$(git -C "$SRC"');
  const end = INSTALL.indexOf("\n", INSTALL.indexOf('problems+=("no --repo given'));
  assert.ok(start > 0 && end > start, "the repo resolution block was not found");
  const block = INSTALL.slice(start, end);
  const pkgUrl = JSON.parse(read("package.json")).repository?.url;
  assert.match(pkgUrl ?? "", /^https:\/\//, "package.json repository.url must be https (knife-deploy has no SSH keys)");
  const tmp = mkdtempSync(join(tmpdir(), "knife-install-repo-"));
  try {
    mkdirSync(join(tmp, "src"));
    mkdirSync(join(tmp, "etc"));
    const run = (extra = "") =>
      spawnSync("bash", ["-c", `set -euo pipefail; SRC=${tmp}/src; ETC=${tmp}/etc; APP_ROOT=${tmp}/app; REPO_URL=""; problems=(); ${extra}\n${block}\necho "url=$REPO_URL problems=\${#problems[@]}"`], { encoding: "utf8" });
    assert.match(run().stdout, /url= problems=1/, "nothing to go on must stay a problem");
    writeFileSync(join(tmp, "src", "package.json"), read("package.json"));
    assert.equal(run().stdout.trim(), `url=${pkgUrl} problems=0`, "package.json's repository.url is the default");
    writeFileSync(join(tmp, "etc", "update.conf"), "APP_ROOT=/opt/x\nREPO_URL=https://example.org/mirror.git\nREF=\n");
    assert.match(run().stdout, /url=https:\/\/example\.org\/mirror\.git problems=0/, "an installed remote (fork/mirror) beats the default");
    assert.match(run('REPO_URL="https://example.org/given.git"').stdout, /url=https:\/\/example\.org\/given\.git problems=0/, "--repo still wins");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("knife-update: a release that touches sidecar bundle sources logs which installed sidecars to check, never syncs", () => {
  const updater = read("deploy/bin/knife-update");
  // It only names the commands in a log line; no line runs sudo or the helper.
  assert.doesNotMatch(updater, /^\s*(?:sudo|knife-sidecar|\S*knife-sidecar-helper)\b/m, "knife-update must never run the root sync");
  assert.match(INSTALL, /^SIDECAR_BUNDLES=\$ETC\/sidecars$/m);
  assert.match(updater, /SIDECAR_BUNDLES="\$\(conf SIDECAR_BUNDLES\)"/);
  // Run the real function from the script against a throwaway repo and bundle dir.
  const body = updater.slice(updater.indexOf("sidecar_sync_hint() {"), updater.indexOf("\nsidecar_sync_hint\n") + 1);
  assert.ok(body.startsWith("sidecar_sync_hint() {"), "function not found");
  const tmp = mkdtempSync(join(tmpdir(), "knife-sync-hint-"));
  try {
    const git = (...args) => spawnSync("git", ["-C", join(tmp, "repo"), ...args], { encoding: "utf8" });
    mkdirSync(join(tmp, "repo", "src", "lib", "services"), { recursive: true });
    mkdirSync(join(tmp, "repo", "docs"), { recursive: true });
    spawnSync("git", ["init", "-q", join(tmp, "repo")]);
    const commit = (file, text) => {
      writeFileSync(join(tmp, "repo", file), text);
      git("add", "-A");
      git("-c", "user.email=t@example.org", "-c", "user.name=t", "commit", "-q", "-m", file);
      return git("rev-parse", "HEAD").stdout.trim();
    };
    const first = commit("docs/a.md", "1");
    const docsOnly = commit("docs/a.md", "2");
    const services = commit("src/lib/services/compose.ts", "x");
    for (const id of ["office", "craft"]) {
      mkdirSync(join(tmp, "bundles", id), { recursive: true });
      writeFileSync(join(tmp, "bundles", id, "compose.yaml"), "name: x\n");
    }
    mkdirSync(join(tmp, "bundles", "craft-content"));
    const run = (current, target) => spawnSync("bash", ["-c", `g() { git -C "$REPO" "$@"; }\nlog() { printf '%s\\n' "$*"; }\n${body}\nsidecar_sync_hint`], {
      encoding: "utf8",
      env: { ...process.env, REPO: join(tmp, "repo"), current, target, SIDECAR_BUNDLES: join(tmp, "bundles") },
    });
    assert.equal(run(first, docsOnly).stdout, "", "a release without sidecar changes logs nothing");
    assert.equal(run(services, services).stdout, "", "the same commit logs nothing");
    const out = run(docsOnly, services).stdout;
    assert.match(out, /sidecar bundle sources changed \(src\/lib\/services\/compose\.ts\)/);
    assert.match(out, /sudo knife-sidecar check craft; sudo knife-sidecar check office; then sudo knife-sidecar sync <id>/);
    assert.doesNotMatch(out, /craft-content/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
