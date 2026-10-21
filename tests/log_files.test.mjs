// Log files (src/lib/logs/core.mjs + viewer.ts, deploy/bin/knife-update): daily files with a size cap, rotation parts,
// redaction, retention from legal.json, gzip of past days, and the viewer's strict path rules (unknown source, bad names,
// traversal, absolute and encoded paths, symlinks, FIFOs) plus bounded tails of plain and gzipped files.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/log_files.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";

const base = mkdtempSync(join(tmpdir(), "knife-logs-"));
const logDir = join(base, "logs");
const dataDir = join(base, "data");
mkdirSync(dataDir, { recursive: true });
process.env.KNIFE_LOG_DIR = logDir;
process.env.KNIFE_DATA_DIR = dataDir;
delete process.env.KNIFE_LEGAL_DIR;
test.after(() => rmSync(base, { recursive: true, force: true }));

const core = await import("../src/lib/logs/core.mjs");
const viewer = await import("../src/lib/logs/viewer.ts");

test("logRoot: KNIFE_LOG_DIR, the <cwd>/logs default and off", () => {
  assert.equal(core.logRoot({ KNIFE_LOG_DIR: "/srv/x/logs" }, "/repo"), "/srv/x/logs");
  assert.equal(core.logRoot({}, "/repo"), "/repo/logs");
  assert.equal(core.logRoot({ KNIFE_LOG_DIR: "off" }, "/repo"), null);
});

test("retentionDays reads legal.json logRetentionDays (string or number), else 30", () => {
  const legal = join(base, "legal");
  mkdirSync(legal, { recursive: true });
  const env = { KNIFE_LEGAL_DIR: legal };
  assert.equal(core.retentionDays(env), 30, "no legal.json");
  writeFileSync(join(legal, "legal.json"), JSON.stringify({ logRetentionDays: "70" }));
  assert.equal(core.retentionDays(env), 70);
  writeFileSync(join(legal, "legal.json"), JSON.stringify({ logRetentionDays: 14 }));
  assert.equal(core.retentionDays(env), 14);
  for (const bad of ["0", "-3", "abc", "99999", "{"]) {
    writeFileSync(join(legal, "legal.json"), bad === "{" ? "{" : JSON.stringify({ logRetentionDays: bad }));
    assert.equal(core.retentionDays(env), 30, bad);
  }
  assert.equal(core.retentionDays({ KNIFE_DATA_DIR: dataDir }), 30, "default legal dir under the data dir");
});

test("redactLine strips colours and control characters and hides credentials", () => {
  const cases = [
    ["\u001b[31mred\u001b[0m\u0007bell", "red bell"],
    ["Authorization: Bearer abcdefghijklmnop", "Authorization: [redacted]"],
    ["cookie: sk_session=abcdef123456", "cookie: [redacted]"],
    ['{"password":"hunter22","name":"x"}', '{"password":"[redacted]","name":"x"}'],
    ["KNIFE_SMTP_PASSWORD=s3cr3t-value other", "KNIFE_SMTP_PASSWORD=[redacted] other"],
    ["GET /api/office/ds/file?t=abc.def.ghi&x=1", "GET /api/office/ds/file?t=[redacted]&x=1"],
    ["key sk-ABCDEFGHIJKLMNOPQRSTUV used", "key [redacted-key] used"],
    ["token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ12", "token [redacted-key]"],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk", "jwt [redacted-jwt]"],
    ["smtp://user:pa55@mail.example.org:587", "smtp://[redacted]@mail.example.org:587"],
  ];
  for (const [input, expected] of cases) assert.equal(core.redactLine(input), expected, input);
  assert.equal(core.redactLine("prompt_tokens=120 max_tokens=4096"), "prompt_tokens=120 max_tokens=4096", "counters are not secrets");
  assert.ok(core.redactLine("x".repeat(10_000)).length < 8_100, "capped");
});

test("writer: one file per UTC day, `<time> <stream> <text>` lines, partial lines wait, 0640-or-stricter files", () => {
  let now = new Date("2026-10-21T23:59:58Z");
  const w = core.createLogWriter({ root: logDir, source: "app", prefix: "app", now: () => now });
  w.write("out", "first line\nsecond ");
  w.write("out", "half\n");
  w.write("err", "Authorization: Bearer abcdefghijklmnop\n");
  now = new Date("2026-10-22T00:00:01Z");
  w.line("out", "next day");
  w.write("err", "no newline yet");
  w.close();
  const day1 = readFileSync(join(logDir, "app", "app-2026-10-21.log"), "utf8").trim().split("\n");
  assert.deepEqual(day1, [
    "2026-10-21T23:59:58.000Z out first line",
    "2026-10-21T23:59:58.000Z out second half",
    "2026-10-21T23:59:58.000Z err Authorization: [redacted]",
  ]);
  const day2 = readFileSync(join(logDir, "app", "app-2026-10-22.log"), "utf8").trim().split("\n");
  assert.deepEqual(day2, ["2026-10-22T00:00:01.000Z out next day", "2026-10-22T00:00:01.000Z err no newline yet"], "close flushes the partial line");
  const fileMode = statSync(join(logDir, "app", "app-2026-10-22.log")).mode & 0o777;
  const dirMode = statSync(join(logDir, "app")).mode & 0o777;
  assert.equal(fileMode & 0o037, 0, `file mode ${fileMode.toString(8)}`);
  assert.equal(dirMode & 0o027, 0, `dir mode ${dirMode.toString(8)}`);
});

test("writer: size cap rotates to .1 .. .N (newest part first), the oldest part dropped", () => {
  const now = () => new Date("2026-10-20T12:00:00Z");
  const w = core.createLogWriter({ root: logDir, source: "sidecars/office", prefix: "ops", maxBytes: 200, maxParts: 3, now });
  for (let i = 0; i < 40; i++) w.line("out", `line ${String(i).padStart(2, "0")} ${"x".repeat(40)}`);
  w.close();
  const dir = join(logDir, "sidecars", "office");
  const names = readdirSync(dir).sort();
  assert.deepEqual(names, ["ops-2026-10-20.1.log", "ops-2026-10-20.2.log", "ops-2026-10-20.3.log", "ops-2026-10-20.log"]);
  for (const name of names) assert.ok(statSync(join(dir, name)).size <= 200, `${name} over the cap`);
  const current = readFileSync(join(dir, "ops-2026-10-20.log"), "utf8");
  const newestPart = readFileSync(join(dir, "ops-2026-10-20.1.log"), "utf8");
  assert.match(current, /line 39/);
  const last = (text) => Number(/line (\d+)/.exec(text.trim().split("\n").at(-1))[1]);
  assert.equal(last(newestPart) + 1, Number(/line (\d+)/.exec(current)[1]), ".1 ends right before the live file begins");
  assert.ok(!/line 00 /.test(readdirSync(dir).map((n) => readFileSync(join(dir, n), "utf8")).join("")), "the oldest lines left with the dropped part");
});

test("writer: an unwritable root never throws and reports once", () => {
  const blocker = join(base, "not-a-dir");
  writeFileSync(blocker, "x");
  const errors = [];
  const w = core.createLogWriter({ root: blocker, source: "app", prefix: "app", onError: (message) => errors.push(message) });
  w.line("out", "a");
  w.line("out", "b");
  assert.equal(errors.length, 1, errors.join("\n"));
});

test("maintainLogs: removes days past the retention, gzips past days, keeps today and foreign names, never follows symlinks", async () => {
  const root = join(base, "maint");
  const app = join(root, "app");
  const update = join(root, "update");
  const side = join(root, "sidecars", "learn-db");
  for (const dir of [app, update, side]) mkdirSync(dir, { recursive: true });
  const now = new Date("2026-10-21T08:00:00Z");
  // retention 30 days: 2026-09-22 is the first day kept (a file of 09-21 holds lines 30+ days old at most a day ago)
  const files = {
    [join(app, "app-2026-09-21.log")]: "gone",
    [join(app, "app-2026-09-21.1.log")]: "gone",
    [join(app, "app-2026-09-01.log.gz")]: "gone",
    [join(app, "app-2026-09-22.log")]: "kept and gzipped",
    [join(app, "app-2026-10-20.2.log")]: "kept and gzipped",
    [join(app, "app-2026-10-21.log")]: "today, plain",
    [join(app, "notes.txt")]: "not a log name",
    [join(update, "update-2026-01-01.log")]: "gone",
    [join(side, "ops-2026-09-10.log")]: "gone",
  };
  for (const [path, text] of Object.entries(files)) writeFileSync(path, text, { mode: 0o640 });
  const outside = join(base, "outside-2026-01-01.log");
  writeFileSync(outside, "victim");
  symlinkSync(outside, join(app, "app-2026-01-02.log"));
  const result = await core.maintainLogs({ root, days: 30, now });
  assert.deepEqual(readdirSync(app).sort(), ["app-2026-01-02.log", "app-2026-09-22.log.gz", "app-2026-10-20.2.log.gz", "app-2026-10-21.log", "notes.txt"]);
  assert.deepEqual(readdirSync(update), []);
  assert.deepEqual(readdirSync(side), []);
  assert.ok(existsSync(outside), "a symlink target is never touched");
  assert.equal(gunzipSync(readFileSync(join(app, "app-2026-09-22.log.gz"))).toString(), "kept and gzipped");
  assert.equal(statSync(join(app, "app-2026-09-22.log.gz")).mode & 0o777, 0o640, "gzip keeps the mode");
  assert.equal(result.removed.length, 5);
  assert.equal(result.compressed.length, 2);
  assert.equal(core.cutoffDay(now, 1), "2026-10-21", "1 day kept = today only");
});

// -- viewer -----------------------------------------------------------------------------------------------------------

function seedViewer() {
  const app = join(logDir, "app");
  mkdirSync(app, { recursive: true });
  const lines = Array.from({ length: 3000 }, (_, i) => `2026-10-19T10:00:00.000Z ${i % 10 === 0 ? "err" : "out"} line ${i}`).join("\n") + "\n";
  writeFileSync(join(app, "app-2026-10-19.log"), lines);
  writeFileSync(join(app, "app-2026-10-18.log.gz"), gzipSync(Buffer.from("old one\nold two\n")));
  writeFileSync(join(app, "app-2026-10-17.log.gz"), Buffer.from("not gzip at all"));
  const secret = join(base, "secret.txt");
  writeFileSync(secret, "storage key");
  symlinkSync(secret, join(app, "app-2026-10-16.log"));
  spawnSync("mkfifo", [join(app, "app-2026-10-15.log")]);
  const sec = join(dataDir, "security");
  mkdirSync(sec, { recursive: true });
  writeFileSync(join(sec, "events-2026-10-19.jsonl"), '{"ts":"2026-10-19T00:00:00.000Z","kind":"rate_block","count":1}\n');
  utimesSync(join(app, "app-2026-10-19.log"), new Date("2026-10-19T12:00:00Z"), new Date("2026-10-19T12:00:00Z"));
}

test("viewer lists sources and their real log files only, newest first", async () => {
  seedViewer();
  const listed = await viewer.listLogSources();
  assert.equal(listed.root, logDir);
  const ids = listed.sources.map((s) => s.id);
  assert.deepEqual(ids, ["app", "update", "sidecar:office", "security"]);
  const app = listed.sources.find((s) => s.id === "app").files.map((f) => f.name);
  assert.ok(!app.includes("app-2026-10-16.log"), "symlink not listed");
  assert.ok(!app.includes("app-2026-10-15.log"), "fifo not listed");
  assert.equal(app[0], "app-2026-10-22.log");
  assert.ok(app.indexOf("app-2026-10-19.log") < app.indexOf("app-2026-10-18.log.gz"));
  assert.deepEqual(listed.sources.find((s) => s.id === "security").files.map((f) => f.name), ["events-2026-10-19.jsonl"]);
  const office = listed.sources.find((s) => s.id === "sidecar:office").files.map((f) => f.name);
  assert.deepEqual(office.slice(0, 2), ["ops-2026-10-20.log", "ops-2026-10-20.1.log"]);
});

test("viewer tails plain and gzipped files within bounds", async () => {
  const tail = await viewer.readLogTail("app", "app-2026-10-19.log", 100);
  assert.equal(tail.lines.length, 100);
  assert.match(tail.lines.at(-1), /line 2999$/);
  assert.equal(tail.truncated, true);
  const capped = await viewer.readLogTail("app", "app-2026-10-19.log", 999_999);
  assert.equal(capped.lines.length, 3000, "the whole small file, never more than 5000 lines");
  const gz = await viewer.readLogTail("app", "app-2026-10-18.log.gz", 10);
  assert.deepEqual(gz.lines, ["old one", "old two"]);
  const broken = await viewer.readLogTail("app", "app-2026-10-17.log.gz", 10);
  assert.match(broken.lines[0], /damaged/);
  const sec = await viewer.readLogTail("security", "events-2026-10-19.jsonl", 10);
  assert.match(sec.lines[0], /rate_block/);
});

test("viewer refuses unknown sources, foreign names, traversal, absolute, encoded, symlinks and FIFOs", async () => {
  const refused = async (source, file, status) => {
    await assert.rejects(viewer.readLogTail(source, file, 10), (error) => error instanceof viewer.LogAccessError && error.status === status, `${source} ${file}`);
  };
  await refused("etc", "app-2026-10-19.log", 400);
  await refused("../app", "app-2026-10-19.log", 400);
  await refused("sidecar:../../etc", "ops-2026-10-19.log", 400);
  await refused("sidecar:Office", "ops-2026-10-19.log", 400);
  await refused("app", "../app/app-2026-10-19.log", 400);
  await refused("app", "/etc/passwd", 400);
  await refused("app", "..%2Fapp-2026-10-19.log", 400);
  await refused("app", "app-2026-10-19.log/../../x", 400);
  await refused("app", "ops-2026-10-19.log", 400);
  await refused("app", "events-2026-10-19.jsonl", 400);
  await refused("security", "app-2026-10-19.log", 400);
  await refused("app", "app-2026-10-19.log\u0000", 400);
  await refused("app", "app-2026-10-16.log", 404); // symlink
  await refused("app", "app-2026-10-15.log", 404); // fifo
  await refused("app", "app-2026-01-01.log", 404); // missing
  // a symlinked source folder is refused too
  rmSync(join(logDir, "update"), { recursive: true, force: true });
  symlinkSync(join(logDir, "app"), join(logDir, "update"));
  await refused("update", "update-2026-10-19.log", 404);
  const listed = await viewer.listLogSources();
  assert.deepEqual(listed.sources.find((s) => s.id === "update").files, []);
});

// -- knife-update's shell functions ------------------------------------------------------------------------------------

test("knife-update: daily 0640 log lines in update/, prune past the retention, gzip past days", () => {
  const script = readFileSync(new URL("../deploy/bin/knife-update", import.meta.url), "utf8");
  const pick = (name) => {
    const start = script.indexOf(`${name}() {`);
    assert.ok(start >= 0, `${name} not found`);
    const lineEnd = script.indexOf("\n", start);
    if (script.slice(start, lineEnd).trimEnd().endsWith("}")) return script.slice(start, lineEnd);
    return script.slice(start, script.indexOf("\n}\n", start) + 2);
  };
  const dir = join(base, "upd");
  mkdirSync(dir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  writeFileSync(join(dir, `update-${old}.log`), "old");
  writeFileSync(join(dir, `update-${yesterday}.log`), "yesterday");
  writeFileSync(join(dir, "keep.txt"), "x");
  const program = [
    `LOG_DIR=${JSON.stringify(dir)}; LOG_TO_DIR=1; LOG_DAYS=30; STATE=/nonexistent`,
    pick("log_file"), pick("logs"), pick("log"), pick("prune_logs"),
    "prune_logs", 'log "building v1"', 'logs err "FAILED: x"',
  ].join("\n");
  const out = spawnSync("bash", ["-euo", "pipefail", "-c", program], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(readdirSync(dir).sort(), [`update-${today}.log`, `update-${yesterday}.log.gz`, "keep.txt"].sort());
  const lines = readFileSync(join(dir, `update-${today}.log`), "utf8").trim().split("\n");
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z out building v1$/);
  assert.match(lines[1], / err FAILED: x$/);
  assert.equal(statSync(join(dir, `update-${today}.log`)).mode & 0o777, 0o640);
  assert.match(out.stderr, /building v1/, "still on stderr for the journal");
});
