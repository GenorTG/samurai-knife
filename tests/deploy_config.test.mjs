// Fail-closed deployment config (scripts/deploy-config.mjs, run by scripts/serve.mjs; src/lib/accounts/mode.ts): public
// mode without a trusted proxy or a public URL, a too-wide proxy rule, a public URL with an empty mode, a private install
// bound to or allowing a public host all refuse to start (exit 2) with a clear message; an explicitly private install
// that uses KNIFE_PUBLIC_URL for the GitHub App still starts (E5).
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/deploy_config.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const { deployProblems, hostScope } = await import("../scripts/deploy-config.mjs");
const mode = await import("../src/lib/accounts/mode.ts");
const { guardMode } = await import("../src/lib/security/guard.mjs");

const PUBLIC_OK = { KNIFE_AUTH_MODE: "public", KNIFE_PUBLIC_URL: "https://knife.example.org", KNIFE_TRUSTED_PROXIES: "127.0.0.1,::1" };

test("public mode: a complete config passes; each missing or unsafe piece is an error", () => {
  assert.deepEqual(deployProblems(PUBLIC_OK, "public"), { errors: [], warnings: [] });
  const errors = (env) => deployProblems({ ...PUBLIC_OK, ...env }, "public").errors.join(" | ");
  assert.match(errors({ KNIFE_TRUSTED_PROXIES: "" }), /needs KNIFE_TRUSTED_PROXIES/);
  assert.match(errors({ KNIFE_PUBLIC_URL: "" }), /needs KNIFE_PUBLIC_URL/);
  assert.match(errors({ KNIFE_PUBLIC_URL: "not a url" }), /not a URL/);
  assert.match(errors({ KNIFE_PUBLIC_URL: "http://knife.example.org" }), /must be https/);
  assert.equal(errors({ KNIFE_PUBLIC_URL: "http://127.0.0.1:3400" }), "", "plain http on loopback (test servers)");
  assert.equal(errors({ KNIFE_PUBLIC_URL: "http://100.64.1.2:3400" }), "", "plain http on a Tailscale address (sidecar tests)");
  assert.match(errors({ KNIFE_TRUSTED_PROXIES: "0.0.0.0/0" }), /wider than \/16/);
  assert.match(errors({ KNIFE_TRUSTED_PROXIES: "10.0.0.0/8" }), /wider than \/16/);
  assert.match(errors({ KNIFE_TRUSTED_PROXIES: "::/0" }), /wider than \/48/);
  assert.match(errors({ KNIFE_TRUSTED_PROXIES: "proxy.local" }), /not an IP address or CIDR/);
  assert.match(errors({ KNIFE_ABUSE_GUARD: "off" }), /not allowed in public mode/);
  const wide = deployProblems({ ...PUBLIC_OK, KNIFE_TRUSTED_PROXIES: "172.18.0.0/16" }, "public");
  assert.deepEqual(wide.errors, []);
  assert.match(wide.warnings.join(" "), /trusts a whole network/);
});

test("private mode: a public URL with an EMPTY mode is refused (lost KNIFE_AUTH_MODE), and so is any public bind or allowed host", () => {
  assert.deepEqual(deployProblems({ KNIFE_HOST: "100.100.1.2", KNIFE_ALLOWED_HOSTS: "mybox,192.168.1.20,mybox.tailnet-x.ts.net,localhost" }, "private").errors, []);
  assert.match(deployProblems({ KNIFE_PUBLIC_URL: "https://knife.example.org" }, "private").errors.join(), /KNIFE_AUTH_MODE is not/);
  // E5: GitHub App setup in a private install needs KNIFE_PUBLIC_URL (docs/GITHUB.md): explicit private starts, with a warning.
  const github = deployProblems({ KNIFE_AUTH_MODE: "private", KNIFE_HOST: "100.100.1.2", KNIFE_PUBLIC_URL: "https://knife.example.org" }, "private");
  assert.deepEqual(github.errors, []);
  assert.match(github.warnings.join(), /private mode with KNIFE_PUBLIC_URL \(knife\.example\.org\)/);
  assert.match(deployProblems({ KNIFE_HOST: "203.0.113.5" }, "private").errors.join(), /KNIFE_HOST contains "203.0.113.5"/);
  assert.match(deployProblems({ KNIFE_ALLOWED_HOSTS: "knife.example.org" }, "private").errors.join(), /KNIFE_ALLOWED_HOSTS contains "knife.example.org"/);
  assert.match(deployProblems({ KNIFE_MCP_ALLOWED_HOSTS: "2001:db8::1" }, "private").errors.join(), /KNIFE_MCP_ALLOWED_HOSTS/);
  assert.equal(hostScope("[::1]"), "private");
  assert.equal(hostScope("box.home.arpa"), "private");
  assert.equal(hostScope("example.com"), "public");
});

test("the app agrees: an unset mode with KNIFE_PUBLIC_URL is public (never the passwordless default account)", () => {
  assert.equal(mode.authMode({}), "private");
  assert.equal(mode.authMode({ KNIFE_PUBLIC_URL: "https://knife.example.org" }), "public");
  assert.equal(mode.authMode({ KNIFE_AUTH_MODE: "private", KNIFE_PUBLIC_URL: "https://x" }), "private");
  assert.equal(mode.authMode({ KNIFE_AUTH_MODE: "publik" }), "public");
  for (const env of [{}, { KNIFE_PUBLIC_URL: "https://x" }, { KNIFE_AUTH_MODE: "private" }, { KNIFE_AUTH_MODE: "public" }]) {
    assert.equal(guardMode(env), mode.authMode(env), JSON.stringify(env));
  }
});

test("serve.mjs exits 2 with the message before starting Next", () => {
  // A copy of serve.mjs and what it imports, in a temp dir without .env.local or a build: a run that passes the checks
  // stops at "no production build" and never starts a server, whatever this checkout has built.
  const cwd = mkdtempSync(join(tmpdir(), "knife-serve-"));
  for (const rel of ["scripts/serve.mjs", "scripts/deploy-config.mjs", "src/lib/net/client-ip.mjs", "src/lib/python-sandbox.mjs"]) {
    mkdirSync(join(cwd, dirname(rel)), { recursive: true });
    copyFileSync(join(import.meta.dirname, "..", rel), join(cwd, rel));
  }
  try {
    const run = (env) => spawnSync(process.execPath, [join(cwd, "scripts", "serve.mjs"), "start"], {
      cwd,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, KNIFE_DATA_DIR: cwd, KNIFE_PORT: "9", ...env },
      encoding: "utf8",
      timeout: 20_000,
    });
    const noProxy = run({ KNIFE_AUTH_MODE: "public", KNIFE_PUBLIC_URL: "https://knife.example.org" });
    assert.equal(noProxy.status, 2);
    assert.match(noProxy.stderr, /refusing to start: public mode needs KNIFE_TRUSTED_PROXIES/);
    const lostMode = run({ KNIFE_PUBLIC_URL: "https://knife.example.org" });
    assert.equal(lostMode.status, 2);
    assert.match(lostMode.stderr, /KNIFE_AUTH_MODE is not/);
    const privateGithub = run({ KNIFE_AUTH_MODE: "private", KNIFE_PUBLIC_URL: "https://knife.example.org" });
    assert.equal(privateGithub.status, 2, "gets past the checks; stops only because this temp dir has no build");
    assert.match(privateGithub.stderr, /no production build/);
    assert.doesNotMatch(privateGithub.stderr, /refusing to start/);
    const publicBind = run({ KNIFE_HOST: "203.0.113.5" });
    assert.equal(publicBind.status, 2);
    assert.match(publicBind.stderr, /KNIFE_HOST contains/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
