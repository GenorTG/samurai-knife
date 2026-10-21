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

test("units that start the parser sandbox keep /proc/sys/user writable under ProtectKernelTunables", () => {
  // bwrap --disable-userns writes user.max_user_namespaces inside its own user namespace: with /proc/sys read-only every
  // sandbox start fails, public mode refuses to start (service) and every preflight fails (updater).
  for (const rel of ["deploy/systemd/samurai-knife.service", "deploy/systemd/knife-update.service"]) {
    const unit = read(rel);
    assert.ok(unitLines(unit, "ProtectKernelTunables").includes("yes"), `${rel}: ProtectKernelTunables expected`);
    assert.ok(unitLines(unit, "ReadWritePaths").includes("/proc/sys/user"), `${rel}: ReadWritePaths=/proc/sys/user missing`);
  }
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
