// The systemd install (deploy/install.sh, deploy/bin/knife-update, knife-admin, the units and the polkit rule) is checked
// statically here; the full install was verified in a systemd Debian 12 container (docs/DEPLOY.md "Install script").
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
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
    "apt-get": "git curl rsync util-linux bubblewrap tesseract-ocr tesseract-ocr-eng tesseract-ocr-pol tesseract-ocr-osd qpdf ghostscript polkitd python3-venv",
    dnf: "git curl rsync util-linux bubblewrap tesseract tesseract-langpack-eng tesseract-langpack-pol tesseract-osd qpdf ghostscript polkit venv",
    pacman: "git curl rsync util-linux bubblewrap tesseract tesseract-data-eng tesseract-data-pol tesseract-data-osd qpdf ghostscript polkit venv",
    zypper: "git curl rsync util-linux bubblewrap tesseract-ocr tesseract-ocr-traineddata-eng tesseract-ocr-traineddata-pol tesseract-ocr-traineddata-osd qpdf ghostscript polkit venv",
  };
  const logical = "git curl rsync util-linux bubblewrap tesseract tess-eng tess-pol tess-osd qpdf ghostscript polkit venv";
  for (const [pm, names] of Object.entries(expected)) {
    const script = `${fn}\nPM=${pm}; for n in ${logical}; do pkg_name "$n"; done | paste -sd' '`;
    const out = spawnSync("bash", ["-c", script], { encoding: "utf8" });
    assert.equal(out.stdout.trim(), names, pm);
  }
});
