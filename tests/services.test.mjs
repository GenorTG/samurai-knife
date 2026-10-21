// Sidecar services (src/lib/services) and the office library glue (src/lib/office): compose rendering, secrets, state,
// lock, pull progress, URLs, HS256 JWT, document templates/text, the document store and the save callback.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/services.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const dataDir = mkdtempSync(join(tmpdir(), "knife-services-"));
process.env.KNIFE_DATA_DIR = dataDir;
process.env.KNIFE_HOST = "100.64.0.7";
process.env.KNIFE_PORT = "3210";
delete process.env.KNIFE_SIDECAR_APP_URL;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const { findSidecar, composeProject, SIDECARS } = await import("../src/lib/services/definitions.ts");
const { renderCompose, renderSecrets, parseSecrets, portMapping, ComposeError, onlyofficeFilterEnv, securityOptions, DEFAULT_PIDS_LIMIT } = await import("../src/lib/services/compose.ts");
const { PullTracker } = await import("../src/lib/services/pull-progress.ts");
const state = await import("../src/lib/services/state.ts");
const urls = await import("../src/lib/services/urls.ts");
const { parsePs, bindHostFor, filterAllowIps, allowIpsCheck, hostAddresses, composeHashOf, configure } = await import("../src/lib/services/manager.ts");
const { autostartDue, RETRY_MS } = await import("../src/lib/services/autostart.ts");
const { readAccountText } = await import("../src/lib/storage/sealed.ts");
const { signJwt, verifyJwt, JwtError, bearerToken } = await import("../src/lib/jwt-hs256.ts");
const { buildDocument, OFFICE_FORMATS } = await import("../src/lib/office/templates.ts");
const { readZip, writeZip } = await import("../src/lib/office/zip.ts");
const { extractText } = await import("../src/lib/office/text.ts");
const store = await import("../src/lib/office/store.ts");
const editor = await import("../src/lib/office/editor.ts");
const { handleCallback } = await import("../src/lib/office/callback.ts");

const office = findSidecar("office");

/* ------------------------------------------------------------------------------------------- compose */

test("office hardening: request filter on with exactly the app's IP allowed, secure-link secret, memory and CPU caps", () => {
  const svc = parse(renderCompose(office, { bindHost: "100.64.0.7", hostPort: 3211, extraEnv: { NODE_CONFIG: "{}" } })).services.documentserver;
  assert.equal(svc.environment.ALLOW_PRIVATE_IP_ADDRESS, "false");
  assert.equal(svc.environment.ALLOW_META_IP_ADDRESS, "false");
  assert.equal(svc.environment.NODE_CONFIG, "{}", "extra env lands after the definition's");
  assert.equal(svc.mem_limit, "3g");
  assert.equal(svc.cpus, "2");
  assert.ok(office.secrets.some((secret) => secret.name === "SECURE_LINK_SECRET"));
  const base = { id: "office", image: office.image, bindHost: "100.64.0.7", hostPort: 3211, idleStopMinutes: 30, installedAt: "x", updatedAt: "x" };
  assert.deepEqual(filterAllowIps(), [], "the app's own address is not opened to user URLs");
  process.env.KNIFE_SIDECAR_ALLOW_IPS = "192.0.2.10, junk";
  try {
    assert.deepEqual(filterAllowIps(), ["192.0.2.10"]);
    assert.notEqual(composeHashOf(office, base), (delete process.env.KNIFE_SIDECAR_ALLOW_IPS, composeHashOf(office, base)), "a changed allow list recreates the container");
  } finally {
    delete process.env.KNIFE_SIDECAR_ALLOW_IPS;
  }
  const filter = JSON.parse(parse(renderCompose(office, { bindHost: "100.64.0.7", hostPort: 3211, extraEnv: onlyofficeFilterEnv(["100.64.0.7", "100.64.0.7"]) })).services.documentserver.environment.NODE_CONFIG);
  assert.deepEqual(filter.services.CoAuthoring["request-filtering-agent"], { allowPrivateIPAddress: false, allowMetaIPAddress: false, allowIPAddressList: ["100.64.0.7"] });
});

test("allow list (audit injection #6): this machine's own addresses are refused, other IPs pass", () => {
  const own = new Set(["100.64.0.7", "172.17.0.1", "192.168.1.20", "fd7a:115c:a1e0::7"]);
  const check = (list) => allowIpsCheck({ KNIFE_SIDECAR_ALLOW_IPS: list }, own);
  assert.deepEqual(check("100.64.0.7"), { allowed: [], refused: ["100.64.0.7"] }, "the app host's Tailscale IP");
  assert.deepEqual(check("172.17.0.1,192.168.1.20"), { allowed: [], refused: ["172.17.0.1", "192.168.1.20"] }, "docker gateway and LAN address");
  assert.deepEqual(check("::ffff:100.64.0.7 FD7A:115C:A1E0::7"), { allowed: [], refused: ["::ffff:100.64.0.7", "FD7A:115C:A1E0::7"] }, "mapped and upper-case forms");
  assert.deepEqual(check("127.0.0.1, ::1, 127.1.2.3, 0.0.0.0"), { allowed: [], refused: ["127.0.0.1", "::1", "127.1.2.3", "0.0.0.0"] }, "loopback reaches the container's own internal services");
  assert.deepEqual(check("192.0.2.10, 10.9.8.7, junk"), { allowed: ["192.0.2.10", "10.9.8.7"], refused: [] });
  // The real host list: every interface address (here: loopback at least) and KNIFE_HOST literals.
  const real = hostAddresses({ KNIFE_HOST: "100.64.0.99" });
  assert.ok(real.has("127.0.0.1") && real.has("100.64.0.99"));
  assert.deepEqual(allowIpsCheck({ KNIFE_SIDECAR_ALLOW_IPS: "100.64.0.99", KNIFE_HOST: "100.64.0.99" }).refused, ["100.64.0.99"]);
});

test("container hardening (host audit M2): every sidecar drops ALL capabilities, adds only its verified set, no-new-privileges, pids cap", () => {
  const learn = findSidecar("learn-db");
  const svcOf = (def, bindHost) => Object.values(parse(renderCompose(def, { bindHost, hostPort: 3211 })).services)[0];
  const ds = svcOf(office, "100.64.0.7");
  assert.deepEqual(ds.cap_drop, ["ALL"]);
  // Verified on a real container (docs/SIDECARS.md "Hardening"): one cap fewer and the image does not start or stop cleanly.
  assert.deepEqual(ds.cap_add, ["CHOWN", "DAC_OVERRIDE", "FOWNER", "KILL", "SETGID", "SETUID"]);
  assert.deepEqual(ds.security_opt, ["no-new-privileges:true"]);
  assert.equal(ds.pids_limit, 1024);
  const pg = svcOf(learn, "127.0.0.1");
  assert.deepEqual(pg.cap_drop, ["ALL"]);
  assert.deepEqual(pg.cap_add, ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"]);
  assert.deepEqual(pg.security_opt, ["no-new-privileges:true"]);
  assert.equal(pg.pids_limit, 256);
  for (const def of SIDECARS) {
    const svc = svcOf(def, "127.0.0.1");
    assert.deepEqual([svc.cap_drop, svc.security_opt], [["ALL"], ["no-new-privileges:true"]], def.id);
    assert.ok(!(svc.cap_add ?? []).some((cap) => ["SYS_ADMIN", "NET_ADMIN", "SYS_PTRACE", "NET_RAW", "ALL"].includes(cap)), `${def.id}: no broad capability`);
    assert.equal(svc.privileged, undefined, def.id);
  }
  // Defaults and refusals: no capAdd = no cap_add key, the default pids cap, malformed names refused.
  const bare = { ...learn, id: "bare", security: { capAdd: [] } };
  const svc = svcOf(bare, "127.0.0.1");
  assert.equal(svc.cap_add, undefined);
  assert.equal(svc.pids_limit, DEFAULT_PIDS_LIMIT);
  assert.deepEqual(securityOptions({ ...learn, security: { capAdd: ["cap_chown", "CHOWN"] } }).cap_add, ["CHOWN"], "normalised and de-duplicated");
  for (const capAdd of [["ALL"], ["CHOWN; rm -rf /"], [""], ["chown\nprivileged: true"]]) {
    assert.throws(() => securityOptions({ ...learn, security: { capAdd } }), ComposeError, JSON.stringify(capAdd));
  }
  assert.throws(() => securityOptions({ ...learn, security: { capAdd: [], pidsLimit: 0 } }), ComposeError);
});

test("learn-db is published on loopback only (the app is its only client) and CPU-capped", () => {
  const learn = findSidecar("learn-db");
  assert.equal(bindHostFor(learn), "127.0.0.1");
  assert.equal(bindHostFor(office), "100.64.0.7");
  assert.equal(parse(renderCompose(learn, { bindHost: bindHostFor(learn), hostPort: 3212 })).services.postgres.cpus, "1");
});

test("compose: one service, published on the given address only, labelled, secrets via env_file", () => {
  const doc = parse(renderCompose(office, { bindHost: "100.64.0.7", hostPort: 3211 }));
  assert.equal(doc.name, "samurai-knife-office");
  assert.equal(composeProject("office"), "samurai-knife-office");
  const svc = doc.services.documentserver;
  assert.equal(svc.image, "ghcr.io/euro-office/documentserver:v9.3.5");
  assert.deepEqual(svc.ports, ["100.64.0.7:3211:80"]);
  assert.deepEqual(svc.env_file, ["secrets.env"]);
  assert.equal(svc.environment.JWT_ENABLED, "true");
  assert.equal(svc.environment.JWT_SECRET, undefined, "the secret never lands in compose.yaml");
  assert.equal(svc.restart, "no");
  assert.equal(svc.labels["dev.samurai-knife.service"], "office");
  assert.deepEqual(svc.extra_hosts, ["host.docker.internal:host-gateway"]);
  assert.deepEqual(Object.keys(doc.volumes).sort(), ["data", "private"]);
  assert.ok(svc.volumes.every((v) => !v.startsWith("/")), "named volumes, no bind mounts");
});

test("compose: the course database (learn-db) is published on the given address only, data in a named volume", async () => {
  const learn = findSidecar("learn-db");
  assert.equal(learn.health.kind, "postgres");
  assert.equal(learn.callsBack, false, "the database never calls the app back");
  const doc = parse(renderCompose(learn, { bindHost: "100.64.0.7", hostPort: 3212 }));
  assert.equal(doc.name, "samurai-knife-learn-db");
  const svc = doc.services.postgres;
  assert.match(svc.image, /^postgis\/postgis:16-3\.4$/, "pinned tag");
  assert.deepEqual(svc.ports, ["100.64.0.7:3212:5432"]);
  assert.deepEqual(svc.env_file, ["secrets.env"]);
  assert.equal(svc.environment.POSTGRES_PASSWORD, undefined, "passwords only in secrets.env");
  assert.equal(svc.environment.POSTGRES_DB, "learn");
  assert.deepEqual(svc.volumes, ["pgdata:/var/lib/postgresql/data"]);
  assert.equal(svc.mem_limit, "1g");
  const secrets = state.ensureSecrets(learn);
  assert.match(secrets.POSTGRES_PASSWORD, /^[0-9a-f]{48}$/);
  assert.match(secrets.LEARNER_PASSWORD, /^[0-9a-f]{48}$/);
  assert.notEqual(secrets.POSTGRES_PASSWORD, secrets.LEARNER_PASSWORD);
  // The office definition keeps its HTTP health check.
  assert.deepEqual({ kind: office.health.kind, path: office.health.path }, { kind: "http", path: "/healthcheck" });
});

test("postgres health probe: answers to an SSLRequest count, a silent or closing port does not", async () => {
  const { probeHealth } = await import("../src/lib/services/manager.ts");
  const net = await import("node:net");
  const learn = findSidecar("learn-db");
  const serve = (handler) => new Promise((resolve) => {
    const server = net.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
  const probe = (server) => probeHealth(learn, { bindHost: "127.0.0.1", hostPort: server.address().port }, 500);
  const pg = await serve((socket) => socket.once("data", (chunk) => {
    assert.deepEqual([...chunk], [0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f], "SSLRequest bytes");
    socket.end("N");
  }));
  const closing = await serve((socket) => socket.destroy()); // what docker's port proxy does before the container listens
  const silent = await serve(() => {});
  try {
    assert.equal(await probe(pg), true);
    assert.equal(await probe(closing), false);
    assert.equal(await probe(silent), false);
  } finally {
    for (const server of [pg, closing, silent]) server.close();
  }
  assert.equal(await probeHealth(learn, { bindHost: "127.0.0.1", hostPort: 1 }, 500), false, "nothing listening");
});

test("compose: refuses wildcard/empty bind addresses and bad ports; brackets IPv6", () => {
  for (const host of ["0.0.0.0", "::", "[::]", "", "*", "0"]) {
    assert.throws(() => renderCompose(office, { bindHost: host, hostPort: 3211 }), ComposeError, host);
  }
  assert.throws(() => renderCompose(office, { bindHost: "127.0.0.1", hostPort: 0 }), ComposeError);
  assert.equal(portMapping("fd7a:115c::1", 3211, 80), "[fd7a:115c::1]:3211:80");
  assert.equal(portMapping("127.0.0.1", 3211, 80), "127.0.0.1:3211:80");
});

test("secrets file round trip; unsafe keys/values are refused", () => {
  const text = renderSecrets({ JWT_SECRET: "ab12", OTHER_KEY: "x-y_z" });
  assert.deepEqual(parseSecrets(text), { JWT_SECRET: "ab12", OTHER_KEY: "x-y_z" });
  assert.throws(() => renderSecrets({ JWT_SECRET: "a b" }), ComposeError);
  assert.throws(() => renderSecrets({ "bad key": "x" }), ComposeError);
  assert.throws(() => renderSecrets({ JWT_SECRET: "a\nINJECT=1" }), ComposeError);
});

/* ------------------------------------------------------------------------------------------- state */

test("state: secrets generated once (600), state round trip, removal keeps secrets unless purged", () => {
  const first = state.ensureSecrets(office);
  assert.match(first.JWT_SECRET, /^[0-9a-f]{64}$/);
  assert.deepEqual(state.ensureSecrets(office), first, "a second install reuses the secret");
  const file = join(state.serviceDir("office"), "secrets.env");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(state.readSecret("office", "JWT_SECRET"), first.JWT_SECRET);
  const now = new Date().toISOString();
  state.writeState({ id: "office", image: office.image, bindHost: "100.64.0.7", hostPort: 3211, idleStopMinutes: 30, installedAt: now, updatedAt: now });
  assert.equal(state.readState("office").hostPort, 3211);
  assert.equal(state.patchState("office", { idleStopMinutes: 5 }).idleStopMinutes, 5);
  state.removeState("office", false);
  assert.equal(state.readState("office"), null);
  assert.equal(state.readSecret("office", "JWT_SECRET"), first.JWT_SECRET);
  state.removeState("office", true);
  assert.equal(state.readSecret("office", "JWT_SECRET"), null);
  assert.throws(() => state.serviceDir("../etc"), /invalid service id/);
});

test("autostart: starts an installed, not running, not held sidecar; waits RETRY_MS after a failure", () => {
  const now = Date.now();
  const on = { id: "learn-db", image: "x", bindHost: "127.0.0.1", hostPort: 3400, idleStopMinutes: 30, autostart: true, installedAt: "x", updatedAt: "x" };
  const free = { busy: false, now };
  for (const container of ["exited", "absent", "created", "dead", "paused"]) assert.equal(autostartDue(on, container, free), true, container);
  assert.equal(autostartDue(on, "running", free), false);
  assert.equal(autostartDue(on, "restarting", free), false);
  assert.equal(autostartDue(null, "exited", free), false, "not installed");
  assert.equal(autostartDue({ ...on, autostart: undefined }, "exited", free), false, "autostart off");
  assert.equal(autostartDue({ ...on, heldStopped: true }, "exited", free), false, "an administrator stopped it");
  assert.equal(autostartDue(on, "exited", { busy: true, now }), false, "an op holds the lock");
  assert.equal(autostartDue(on, "exited", { busy: false, now, lastFailureAt: now - RETRY_MS + 1000 }), false, "failed recently");
  assert.equal(autostartDue(on, "exited", { busy: false, now, lastFailureAt: now - RETRY_MS }), true, "retry after RETRY_MS");
});

test("autostart: configure turns it on and off; heldStopped round-trips and a start clears it", async () => {
  const now = new Date().toISOString();
  const def = findSidecar("learn-db");
  state.ensureSecrets(def);
  state.writeState({ id: "learn-db", image: def.image, bindHost: "127.0.0.1", hostPort: 3401, idleStopMinutes: 30, installedAt: now, updatedAt: now });
  assert.equal((await configure("learn-db", { autostart: true })).state.autostart, true);
  assert.equal(state.readState("learn-db").autostart, true);
  assert.equal(state.patchState("learn-db", { heldStopped: true }).heldStopped, true);
  assert.equal(state.patchState("learn-db", { heldStopped: undefined }).heldStopped, undefined, "upAndWait's patch clears it");
  assert.equal(state.readState("learn-db").heldStopped, undefined);
  assert.equal((await configure("learn-db", { autostart: false })).state.autostart, undefined, "off is stored as absent");
  assert.equal((await configure("learn-db", { idleStopMinutes: 5 })).state.idleStopMinutes, 5, "other settings leave autostart alone");
  state.removeState("learn-db", true);
});

test("op lock: exclusive, released, stale (dead pid) lock is cleared", () => {
  assert.ok(state.acquireLock("office", "install"));
  assert.equal(state.acquireLock("office", "start"), null, "second op refused while held");
  assert.equal(state.readLock("office").op, "install");
  state.releaseLock("office");
  writeFileSync(join(state.serviceDir("office"), "op.lock"), JSON.stringify({ pid: 2 ** 22 + 12345, op: "install", startedAt: "x" }));
  assert.equal(state.readLock("office"), null, "dead pid = stale");
  assert.ok(state.acquireLock("office", "start"));
  state.releaseLock("office");
});

/* ------------------------------------------------------------------------------------------- progress / ps */

test("pull progress folds compose JSON events into one percentage", () => {
  const t = new PullTracker();
  const ev = (o) => JSON.stringify(o);
  assert.equal(t.feed("not json"), false);
  t.feed(ev({ id: "documentserver", text: "Pulling" }));
  t.feed(ev({ id: "l1", parent_id: "documentserver", text: "Pulling fs layer" }));
  t.feed(ev({ id: "l2", parent_id: "documentserver", text: "Already exists" }));
  t.feed(ev({ id: "l1", parent_id: "documentserver", text: "Downloading", current: 500, total: 1000 }));
  let s = t.snapshot();
  assert.equal(s.phase, "downloading");
  assert.equal(s.totalBytes, 1000);
  assert.equal(s.percent, 40);
  t.feed(ev({ id: "l1", parent_id: "documentserver", text: "Extracting", current: 1000, total: 1000 }));
  s = t.snapshot();
  assert.equal(s.phase, "extracting");
  assert.equal(s.percent, 99, "capped below 100 until done");
  t.feed(ev({ id: "l1", parent_id: "documentserver", text: "Pull complete" }));
  t.feed(ev({ id: "documentserver", text: "Pulled" }));
  s = t.snapshot();
  assert.deepEqual([s.phase, s.percent, s.layers, s.layersDone], ["done", 100, 2, 2]);
});

test("compose ps output: JSON lines and the older array form", () => {
  const row = { Name: "samurai-knife-office-documentserver-1", Service: "documentserver", State: "running", Health: "" };
  assert.deepEqual(parsePs(`${JSON.stringify(row)}\n`), [row]);
  assert.deepEqual(parsePs(JSON.stringify([row])), [row]);
  assert.deepEqual(parsePs(""), []);
});

/* ------------------------------------------------------------------------------------------- urls */

test("app URL: derived from KNIFE_HOST, loopback gets a warning, env and state override", () => {
  assert.deepEqual(urls.appUrl(null), { url: "http://100.64.0.7:3210", source: "derived" });
  process.env.KNIFE_HOST = "127.0.0.1";
  const loop = urls.appUrl(null);
  assert.equal(loop.url, "http://host.docker.internal:3210");
  assert.match(loop.warning, /cannot reach/);
  process.env.KNIFE_SIDECAR_APP_URL = "http://10.0.0.5:3210/";
  assert.deepEqual(urls.appUrl(null), { url: "http://10.0.0.5:3210", source: "env" });
  assert.equal(urls.appUrl({ appUrl: "http://x:1" }).source, "state");
  delete process.env.KNIFE_SIDECAR_APP_URL;
  process.env.KNIFE_HOST = "100.64.0.7";
  assert.equal(urls.publicUrl({ bindHost: "100.64.0.7", hostPort: 3211 }), "http://100.64.0.7:3211");
  assert.equal(urls.publicUrl({ bindHost: "::1", hostPort: 3211 }), "http://[::1]:3211");
  assert.equal(urls.validateHttpUrl("ftp://x"), "must be http(s)");
  assert.equal(urls.validateHttpUrl("http://u:p@x"), "must not contain credentials");
  assert.equal(urls.validateHttpUrl("http://x:3210"), null);
});

test("pickPort skips claimed ports and returns a free one near the app port", async () => {
  const port = await urls.pickPort("127.0.0.1", 41000, new Set([41001]));
  assert.ok(port > 41001 && port <= 41200, String(port));
  assert.equal(await urls.portFree("127.0.0.1", port), true);
});

/* ------------------------------------------------------------------------------------------- jwt */

test("HS256 JWT: round trip, tamper, wrong secret, alg none, expiry", () => {
  const token = signJwt({ a: 1 }, "s".repeat(32));
  assert.equal(verifyJwt(token, "s".repeat(32)).a, 1);
  const [h, p, sig] = token.split(".");
  const forged = `${h}.${Buffer.from(JSON.stringify({ a: 2 })).toString("base64url")}.${sig}`;
  assert.throws(() => verifyJwt(forged, "s".repeat(32)), JwtError);
  assert.throws(() => verifyJwt(token, "t".repeat(32)), /bad signature/);
  const none = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${p}.`;
  assert.throws(() => verifyJwt(none, "s".repeat(32)), /algorithm/);
  const old = signJwt({ a: 1, iat: 1, exp: 100 }, "k");
  assert.throws(() => verifyJwt(old, "k"), /expired/);
  assert.equal(bearerToken("Bearer abc.def.ghi"), "abc.def.ghi");
  assert.equal(bearerToken("Basic x"), null);
});

/* ------------------------------------------------------------------------------------------- templates / text */

test("every blank format is a valid ZIP whose text extracts to empty-ish", () => {
  for (const format of OFFICE_FORMATS) {
    const bytes = buildDocument(format);
    assert.ok(store.isZipContainer(bytes), format);
    const zip = readZip(bytes);
    assert.ok(zip.names().length >= 3, format);
    assert.equal(typeof extractText(format, bytes), "string");
  }
  const odt = readZip(buildDocument("odt"));
  assert.equal(odt.names()[0], "mimetype", "ODF: mimetype first");
  assert.equal(odt.text("mimetype"), "application/vnd.oasis.opendocument.text");
});

test("content round trip: paragraphs, rows (numbers numeric), slides; XML is escaped", () => {
  const paragraphs = ["Hello <world> & \"friends\"", "", "Zażółć gęślą jaźń"];
  assert.equal(extractText("docx", buildDocument("docx", { paragraphs })), paragraphs.join("\n"));
  assert.equal(extractText("odt", buildDocument("odt", { paragraphs })), paragraphs.join("\n"));
  const rows = [["name", "qty"], ["apple", "3"], ["", "4.5"]];
  const xlsx = buildDocument("xlsx", { rows });
  assert.match(readZip(xlsx).text("xl/worksheets/sheet1.xml"), /<c r="B2"><v>3<\/v><\/c>/);
  assert.equal(extractText("xlsx", xlsx), "# Sheet: Sheet1\nname\tqty\napple\t3\n\t4.5");
  assert.equal(extractText("ods", buildDocument("ods", { rows })), "# Sheet: Sheet1\nname\tqty\napple\t3\n\t4.5");
  const slides = [{ title: "Plan", bullets: ["one", "two"] }, { title: "End" }];
  assert.equal(extractText("pptx", buildDocument("pptx", { slides })), "# Slide 1\nPlan\none\ntwo\n\n# Slide 2\nEnd");
  assert.equal(extractText("odp", buildDocument("odp", { slides })), "# Slide 1\nPlan\none\ntwo\n\n# Slide 2\nEnd");
});

test("zip reader: stored + deflated entries, bomb cap", () => {
  const zip = writeZip([{ name: "a.txt", data: "x".repeat(10000) }, { name: "b.txt", data: "stored", store: true }]);
  const r = readZip(zip);
  assert.equal(r.text("a.txt").length, 10000);
  assert.equal(r.text("b.txt"), "stored");
  assert.equal(r.read("missing"), null);
  assert.throws(() => readZip(zip, 100).read("a.txt"), /limit/);
  assert.throws(() => readZip(Buffer.from("not a zip at all, definitely not")), /not a ZIP/);
});

/* ------------------------------------------------------------------------------------------- store */

test("document store: create, list, save versions, key rotation, rename, delete; files private", () => {
  const doc = store.createDoc("genor", { name: "Report", format: "docx", bytes: buildDocument("docx"), source: "blank" });
  assert.equal(doc.name, "Report.docx");
  assert.equal(doc.version, 1);
  assert.equal(statSync(store.docFile("genor", doc)).mode & 0o777, 0o600);
  assert.deepEqual(store.listDocs("genor").map((d) => d.id), [doc.id]);
  const forced = store.saveVersion("genor", doc.id, buildDocument("docx", { paragraphs: ["v2"] }), { rotateKey: false });
  assert.equal(forced.version, 2);
  assert.equal(forced.key, doc.key, "force-save keeps the session key");
  const final = store.saveVersion("genor", doc.id, buildDocument("docx", { paragraphs: ["v3"] }), { rotateKey: true });
  assert.notEqual(final.key, doc.key);
  assert.equal(extractText("docx", store.readDocBytes("genor", final)), "v3");
  assert.equal(store.rotateKey("genor", doc.id, "stale-key").key, final.key, "rotate only from the expected key");
  const renamed = store.renameDoc("genor", doc.id, "../../etc/passwd");
  assert.ok(!renamed.name.includes("/") && renamed.name.endsWith(".docx") && !renamed.name.startsWith("."), renamed.name);
  assert.throws(() => store.createDoc("genor", { name: "x", format: "docx", bytes: Buffer.from("plain text"), source: "upload" }), /not an office file/);
  assert.throws(() => store.getDoc("genor", "../../x"), /unknown document/);
  assert.throws(() => store.getDoc("other", doc.id), /unknown document/, "other accounts do not see it");
  assert.equal(store.deleteDoc("genor", doc.id), true);
  assert.deepEqual(store.listDocs("genor"), []);
  assert.deepEqual(store.splitName("A.B.XLSX"), { base: "A.B", format: "xlsx" });
  assert.equal(store.splitName("a.doc"), null);
});

/* ------------------------------------------------------------------------------------------- editor + callback */

function installFakeOffice() {
  state.ensureSecrets(office);
  const now = new Date().toISOString();
  state.writeState({ id: "office", image: office.image, bindHost: "100.64.0.7", hostPort: 3211, idleStopMinutes: 30, installedAt: now, updatedAt: now });
  return state.readSecret("office", "JWT_SECRET");
}

test("editor config is signed server-side; capability tokens are purpose-bound", () => {
  const secret = installFakeOffice();
  const doc = store.createDoc("genor", { name: "Sheet", format: "xlsx", bytes: buildDocument("xlsx"), source: "blank" });
  const { apiUrl, config } = editor.editorConfig({ id: "genor", displayName: "Genor" }, doc, { mode: "edit" });
  assert.equal(apiUrl, "http://100.64.0.7:3211/web-apps/apps/api/documents/api.js");
  assert.equal(config.documentType, "cell");
  assert.equal(config.document.key, doc.key);
  const claims = verifyJwt(config.token, secret);
  assert.equal(claims.document.url, config.document.url);
  assert.equal(claims.editorConfig.callbackUrl, config.editorConfig.callbackUrl);
  assert.ok(config.document.url.startsWith("http://100.64.0.7:3210/api/office/ds/file?t="));
  const fileToken = decodeURIComponent(new URL(config.document.url).searchParams.get("t"));
  assert.deepEqual(editor.readCapability(fileToken, "file"), { acc: "genor", doc: doc.id, use: "file", ep: editor.readCapability(fileToken, "file").ep });
  assert.throws(() => editor.readCapability(fileToken, "callback"), /wrong capability/);
  assert.throws(() => editor.readCapability(signJwt({ acc: "genor", doc: doc.id, use: "file" }, "other-secret"), "file"), /bad signature/);
  const request = new Request("http://x/", { headers: { authorization: `Bearer ${signJwt({ payload: { status: 2, key: "k" } }, secret, { expiresInSec: 300 })}` } });
  assert.deepEqual(editor.readServerToken(request), { status: 2, key: "k" });
  assert.equal(editor.readServerToken(new Request("http://x/"), signJwt({ status: 6, key: "k" }, secret, { expiresInSec: 300 })).status, 6);
  assert.throws(() => editor.readServerToken(new Request("http://x/")), /missing Document Server token/);
  store.deleteDoc("genor", doc.id);
});

test("callback: 1 editing, 6 force-save keeps key, 2 saves + rotates, 4 rotates, foreign URL refused, stale key -> copy", async () => {
  installFakeOffice();
  const doc = store.createDoc("genor", { name: "Notes", format: "docx", bytes: buildDocument("docx"), source: "blank" });
  const served = new Map();
  const realFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    const body = served.get(new URL(url).pathname);
    return body ? new Response(body) : new Response("nope", { status: 404 });
  };
  try {
    assert.deepEqual(await handleCallback("genor", doc.id, { key: doc.key, status: 1, users: ["genor"] }), { error: 0, action: "editing" });
    served.set("/cache/files/v2/output.docx", buildDocument("docx", { paragraphs: ["forced"] }));
    let out = await handleCallback("genor", doc.id, { key: doc.key, status: 6, url: "http://100.64.0.7:3211/cache/files/v2/output.docx", users: ["genor"] });
    assert.equal(out.action, "force-saved");
    assert.equal(out.doc.key, doc.key);
    assert.equal(fetched.at(-1), "http://100.64.0.7:3211/cache/files/v2/output.docx");
    served.set("/cache/files/v3/output.docx", buildDocument("docx", { paragraphs: ["final"] }));
    out = await handleCallback("genor", doc.id, { key: doc.key, status: 2, url: "http://100.64.0.7:3211/cache/files/v3/output.docx" });
    assert.equal(out.action, "saved");
    assert.notEqual(out.doc.key, doc.key);
    assert.equal(out.doc.version, 3);
    assert.equal(extractText("docx", store.readDocBytes("genor", out.doc)), "final");
    const evil = await handleCallback("genor", doc.id, { key: out.doc.key, status: 2, url: "http://169.254.169.254/latest/meta-data" });
    assert.equal(evil.error, 1);
    assert.match(evil.message, /not the office sidecar/);
    const closed = await handleCallback("genor", doc.id, { key: out.doc.key, status: 4 });
    assert.equal(closed.action, "closed");
    assert.notEqual(closed.doc.key, out.doc.key);
    served.set("/cache/files/v4/output.docx", buildDocument("docx", { paragraphs: ["late"] }));
    const conflict = await handleCallback("genor", doc.id, { key: "old.key", status: 2, url: "http://100.64.0.7:3211/cache/files/v4/output.docx" });
    assert.equal(conflict.action, "conflict-copy");
    assert.equal(extractText("docx", store.readDocBytes("genor", store.getDoc("genor", doc.id))), "final", "original untouched");
    assert.match(conflict.doc.name, /\(edited copy\)\.docx$/);
    const noUrl = await handleCallback("genor", doc.id, { key: closed.doc.key, status: 2 });
    assert.equal(noUrl.error, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(readAccountText("genor", join(dataDir, "docs", "genor", doc.id, "meta.json")).includes('"version": 3'));
});
