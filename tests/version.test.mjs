// Build version (src/lib/version.ts, the Finetune Studio scheme): VERSION = MAJOR.MINOR.PATCH.BUILD, package.json carries
// MAJOR.MINOR.PATCH, the pre-commit hook bumps BUILD inside the commit it runs for (not the next one), KNIFE_NO_BUMP=1
// and VERSION-only commits do not bump.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/version.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;
const { appVersion, VERSION_PATTERN } = await import("../src/lib/version.ts");

test("VERSION is MAJOR.MINOR.PATCH.BUILD, package.json carries MAJOR.MINOR.PATCH, appVersion() reads it", () => {
  const version = readFileSync(join(ROOT, "VERSION"), "utf8").trim();
  assert.match(version, VERSION_PATTERN);
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.version, version.split(".").slice(0, 3).join("."), "bump package.json together with MAJOR/MINOR/PATCH");
  const cwd = process.cwd();
  try {
    process.chdir(ROOT);
    assert.equal(appVersion(), version);
  } finally {
    process.chdir(cwd);
  }
});

function git(repo, args, env = {}) {
  return execFileSync("git", args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", ...env }, encoding: "utf8" });
}

test("the pre-commit hook bumps BUILD in the commit itself; KNIFE_NO_BUMP and VERSION-only commits do not bump", () => {
  const hook = join(ROOT, "scripts/git-hooks/pre-commit");
  assert.ok(statSync(hook).mode & 0o100, "hook is executable");
  execFileSync("bash", ["-n", hook]);
  const repo = mkdtempSync(join(tmpdir(), "knife-hook-"));
  try {
    git(repo, ["init", "-q"]);
    mkdirSync(join(repo, "scripts/git-hooks"), { recursive: true });
    copyFileSync(hook, join(repo, "scripts/git-hooks/pre-commit"));
    git(repo, ["config", "core.hooksPath", "scripts/git-hooks"]);
    writeFileSync(join(repo, "VERSION"), "0.1.0.0\n");
    writeFileSync(join(repo, "a.txt"), "1\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "one"]);
    assert.equal(git(repo, ["show", "HEAD:VERSION"]).trim(), "0.1.0.1", "the committed tree has the bumped version");
    writeFileSync(join(repo, "a.txt"), "2\n");
    git(repo, ["commit", "-qam", "two"]);
    assert.equal(git(repo, ["show", "HEAD:VERSION"]).trim(), "0.1.0.2");
    writeFileSync(join(repo, "a.txt"), "3\n");
    git(repo, ["commit", "-qam", "three"], { KNIFE_NO_BUMP: "1" });
    assert.equal(git(repo, ["show", "HEAD:VERSION"]).trim(), "0.1.0.2", "KNIFE_NO_BUMP=1 skips");
    writeFileSync(join(repo, "VERSION"), "0.2.0.0\n");
    git(repo, ["commit", "-qam", "minor"]);
    assert.equal(git(repo, ["show", "HEAD:VERSION"]).trim(), "0.2.0.0", "a VERSION-only commit is not bumped");
    assert.equal(git(repo, ["status", "--porcelain"]).trim(), "", "nothing left uncommitted");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
