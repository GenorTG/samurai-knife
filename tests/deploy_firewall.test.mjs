// Deployment firewall policy is rendered/tested without loading a host ruleset; Docker policy uses --dry-run only.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;
const FIREWALL = join(ROOT, "deploy/sbin/knife-firewall");
const DOCKER_USER = join(ROOT, "deploy/sbin/knife-docker-user");
const scratch = mkdtempSync(join(tmpdir(), "knife-firewall-test-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

function confFile(name, content) {
  const file = join(scratch, name);
  writeFileSync(file, content, { mode: 0o600 });
  return file;
}

test("nft firewall renderer: default drop; only proxy and declared callback networks reach app port", { skip: process.getuid?.() === 0 }, () => {
  const conf = confFile("firewall.conf", [
    "LAN_IF=lo",
    "LAN_CIDR4=192.0.2.0/24",
    "LAN_CIDR6=",
    "TAILSCALE_IF=",
    "TAILSCALE_TCP=",
    "TAILSCALE_UDP=",
    "LAN_TCP=",
    "LAN_UDP=",
    "INTERNET_TCP=",
    "INTERNET_UDP=",
    "PROXY_IP4=192.0.2.10",
    "PROXY_TCP=3210",
    "SIDECAR_TCP=3210",
    "DOCKER_IFS=br-*",
    "DOCKER_TCP=",
    "DOCKER_UDP=",
    "LOG_DROPS=yes",
  ].join("\n"));
  const result = spawnSync("python3", [FIREWALL, "render"], {
    env: { ...process.env, KNIFE_FIREWALL_CONF: conf },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /table inet knife_host/);
  assert.match(result.stdout, /type filter hook input priority filter; policy drop/);
  assert.match(result.stdout, /ip saddr 192\.0\.2\.10 tcp dport \{ 3210 \} accept/);
  assert.match(result.stdout, /ip saddr @sidecar_nets tcp dport \{ 3210 \} accept/);
  assert.doesNotMatch(result.stdout, /^\s*flush ruleset/m);
});

test("Docker forwarding script validates config and dry-run does not invoke iptables", { skip: process.getuid?.() === 0 }, () => {
  execFileSync("bash", ["-n", DOCKER_USER]);
  const conf = confFile("docker-user.conf", [
    "SIDECAR_PROJECT_PREFIX=knife-firewall-unit-no-network",
    'SIDECAR_EGRESS="office=internet learn-db=none"',
    "SIDECAR_CALLBACK_IDS=office",
    "SIDECAR_DNS4=",
  ].join("\n"));
  const result = spawnSync("bash", [DOCKER_USER, "apply", "--dry-run"], {
    env: { ...process.env, KNIFE_DOCKER_USER_CONF: conf },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /iptables -w -N KNIFE-SIDECAR/);
  assert.match(result.stdout, /iptables -w -I DOCKER-USER 1 -j KNIFE-SIDECAR/);

  writeFileSync(conf, "SIDECAR_EGRESS=office=anything\n", { mode: 0o600 });
  const invalid = spawnSync("bash", [DOCKER_USER, "apply", "--dry-run"], {
    env: { ...process.env, KNIFE_DOCKER_USER_CONF: conf },
    encoding: "utf8",
  });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /SIDECAR_EGRESS entry invalid/);
});

test("deploy units never pull in the stock nftables.service (its /etc/nftables.conf flushes Docker's rules)", () => {
  const dir = join(ROOT, "deploy/systemd");
  for (const name of readdirSync(dir)) {
    const unit = readFileSync(join(dir, name), "utf8");
    assert.doesNotMatch(unit, /^\s*(Wants|Requires|Requisite|BindsTo|PartOf|Upholds)=.*\bnftables\.service\b/m, name);
  }
});
