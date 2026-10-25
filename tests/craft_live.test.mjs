// The assistant inside the Craft apps: the bridge's "agent" relay (sidecars/craft/knife-bridge/bridge.js) against a
// fake app window, and the craft_* tools (src/lib/agent-client/craft-live-tools.ts): availability, trust verdicts,
// command listing, screenshots and exports into the file chain, imports from it.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/craft_live.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const { assessCraftCall, craftRisk, craftStatusNote, craftToolAvailable, runCraftTool, CRAFT_TOOL_DEFS } = await import("../src/lib/agent-client/craft-live-tools.ts");
const { setCraftPresence, clearCraftPresence, activeCraft } = await import("../src/lib/craft/live.ts");
const { artifactFile, listArtifacts } = await import("../src/lib/agent-client/artifacts.ts");
const { groupOf, initialGroups, visibleTools } = await import("../src/lib/agent-client/tool-groups.ts");
const { PAGE_READS } = await import("../src/lib/agent-client/server-tool-policy.ts");

const BRIDGE = readFileSync(new URL("../sidecars/craft/knife-bridge/bridge.js", import.meta.url), "utf8");

/* ------------------------------------------------------------------------------------------- bridge */

/** Load bridge.js for app `democraft` next to `appWindow` (or none) and connect a port to it. */
function bridge(appWindow) {
  const listeners = [];
  const parent = { frames: [] };
  const self = { parent, addEventListener: (type, fn) => type === "message" && listeners.push(fn) };
  parent.frames.push(self);
  if (appWindow) parent.frames.push({ location: { pathname: "/democraft/index.html" }, ...appWindow });
  const location = { search: "?app=democraft" };
  new Function("window", "location", "localStorage", BRIDGE)(self, location, { getItem: () => null, setItem() {} });
  const sent = [];
  const port = { postMessage: (message, transfer) => sent.push({ message, transfer }), onmessage: null };
  for (const fn of listeners) fn({ source: parent, data: { type: "knife-bridge:hello" }, ports: [port] });
  let id = 0;
  return async (method, args = []) => {
    const mine = ++id;
    port.onmessage({ data: { type: "agent", id: mine, method, args } });
    for (let i = 0; i < 200; i += 1) {
      const hit = sent.find((s) => s.message.type === "agent-result" && s.message.id === mine);
      if (hit) return hit;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`no answer to ${method}`);
  };
}

function fakeApi(overrides = {}) {
  const calls = [];
  const api = {
    request: async (method, params) => (calls.push(["request", method, params]), { method }),
    execute: async (command, params) => (calls.push(["execute", command, params]), { done: command }),
    commands: async () => [{ id: "file.export", label: "Export…", menu: ["File"], params: "{format}", enabled: true }],
    inspect: async () => ({ tool: "selection" }),
    screenshot: async () => ({ pngBase64: Buffer.from("png").toString("base64"), width: 2, height: 1 }),
    files: () => [{ path: "/exports/out.svg", size: 3 }],
    readFile: async () => new Uint8Array([60, 115, 62]),
    importFiles: async (files) => (calls.push(["importFiles", files]), { items: files.length }),
    ...overrides,
  };
  return { api, calls };
}

test("probe: no API, an API that is still starting, a running one (with the methods it has)", async () => {
  assert.deepEqual((await bridge(null)("probe")).message.result, { api: false });
  const starting = bridge({ democraft: fakeApi({ inspect: async () => { throw new Error("DemoCraft is not running yet"); } }).api });
  assert.deepEqual((await starting("probe")).message.result, { api: false, waiting: "DemoCraft is not running yet" });
  const { api } = fakeApi();
  delete api.readFile;
  const result = (await bridge({ democraft: api })("probe")).message.result;
  assert.equal(result.api, true);
  assert.deepEqual(result.methods.sort(), ["commands", "execute", "files", "import", "inspect", "request", "screenshot"]);
});

test("calls are relayed as JSON; unknown methods and a missing API are refused", async () => {
  const { api, calls } = fakeApi({ execute: async (command, params) => (calls.push(["execute", command, params]), { when: new Date(0), fn: () => 1, n: 1 }) });
  const call = bridge({ democraft: api });
  const executed = (await call("execute", ["file.export", { format: "svg" }, "ignored third"])).message;
  assert.equal(executed.ok, true);
  assert.deepEqual(executed.result, { when: "1970-01-01T00:00:00.000Z", n: 1 }, "plain JSON, no live objects");
  assert.deepEqual(calls.at(-1), ["execute", "file.export", { format: "svg" }]);
  assert.deepEqual((await call("eval", ["1"])).message, { type: "agent-result", id: 2, ok: false, error: "unknown method" });
  assert.equal((await bridge(null)("execute", ["x"])).message.error, "no-api");
  const failing = bridge({ democraft: fakeApi({ request: async () => { throw new Error("unknown method `ui.elements`"); } }).api });
  assert.deepEqual((await failing("request", ["ui.elements", {}])).message, { type: "agent-result", id: 1, ok: false, error: "unknown method `ui.elements`" });
});

test("readFile comes back as a transferred ArrayBuffer; import hands the app File objects (or openFile bytes)", async () => {
  const { api, calls } = fakeApi();
  const call = bridge({ democraft: api });
  const read = await call("readFile", ["/exports/out.svg"]);
  assert.ok(read.message.result.bytes instanceof ArrayBuffer);
  assert.deepEqual(read.transfer, [read.message.result.bytes]);
  assert.equal(Buffer.from(read.message.result.bytes).toString(), "<s>");
  const bytes = new TextEncoder().encode("hello").buffer;
  const imported = await call("import", [[{ name: "a.txt", mime: "text/plain", bytes }, { name: "no bytes" }]]);
  assert.deepEqual(imported.message.result, { items: 1 });
  const [, files] = calls.at(-1);
  assert.ok(files[0] instanceof File);
  assert.equal(files[0].name, "a.txt");
  assert.equal(await files[0].text(), "hello");

  const opened = [];
  const vector = fakeApi({ openFile: async (name, data) => opened.push([name, Buffer.from(data).toString()]) }).api;
  delete vector.importFiles;
  const vcall = bridge({ democraft: vector });
  assert.ok((await vcall("probe")).message.result.methods.includes("import"));
  assert.deepEqual((await vcall("import", [[{ name: "b.svg", mime: "image/svg+xml", bytes: new TextEncoder().encode("<svg/>").buffer }]])).message.result, { opened: ["b.svg"] });
  assert.deepEqual(opened, [["b.svg", "<svg/>"]]);
});

/* ------------------------------------------------------------------------------------------- tools */

const BASE = { appId: "democraft", appName: "DemoCraft", version: "1.0.0" };

function connect(overrides = {}, methods = ["request", "execute", "commands", "inspect", "screenshot", "files", "readFile", "import"]) {
  const calls = [];
  const replies = {
    commands: { ok: true, result: Array.from({ length: 80 }, (_, i) => ({ id: `cmd.n${i}`, label: `Command ${i}`, menu: ["Edit"], params: "x".repeat(400), enabled: i % 2 === 0 })).concat([{ id: "file.export", label: "Export…", menu: ["File"], params: "{format}" }]) },
    inspect: { ok: true, result: { tool: "pen" } },
    ...overrides,
  };
  setCraftPresence({
    ...BASE,
    state: "connected",
    methods,
    call: async (method, args, _signal, transfer) => {
      calls.push({ method, args, transfer });
      const r = replies[method];
      return typeof r === "function" ? r(args) : r ?? { ok: true, result: { method, args } };
    },
  });
  return calls;
}

const run = async (name, args = {}) => {
  const r = await runCraftTool(name, args);
  return { ok: r.ok, body: JSON.parse(r.content) };
};

test("craft_* is a page-only group on /tools/artcraft, offered only while an app with the API is connected", () => {
  assert.equal(groupOf("craft_execute")?.id, "craft_live");
  assert.deepEqual([...initialGroups("/tools/artcraft", [])], ["craft_live"]);
  assert.equal(CRAFT_TOOL_DEFS.length, 10);
  clearCraftPresence("democraft");
  setCraftPresence(null);
  assert.equal(craftToolAvailable("craft_inspect"), false);
  assert.equal(craftToolAvailable("list_tools"), true);
  setCraftPresence({ ...BASE, state: "probing" });
  assert.equal(craftToolAvailable("craft_inspect"), false);
  assert.match(craftStatusNote(), /starting/);
  setCraftPresence({ ...BASE, state: "no-api" });
  assert.match(craftStatusNote(), /no agent API/);
  connect({}, ["request", "inspect", "commands"]);
  assert.equal(craftToolAvailable("craft_inspect"), true);
  assert.equal(craftToolAvailable("craft_export"), false, "the app has no readFile");
  const visible = visibleTools(CRAFT_TOOL_DEFS, new Set(["craft_live"]), craftToolAvailable).map((d) => d.function.name);
  assert.deepEqual(visible, ["craft_guide", "craft_commands", "craft_inspect", "craft_request", "craft_file_save"], "craft_file_save needs only a connected app");
  assert.match(craftStatusNote(), /CONNECTED/);
  // An unmount of another app's frame does not clear this one.
  clearCraftPresence("othercraft");
  assert.ok(activeCraft());
  clearCraftPresence("democraft");
  assert.equal(activeCraft(), null);
});

test("trust: reads never ask; commands and input act; ids that lose work are destructive in every mode but None", () => {
  connect();
  assert.equal(craftRisk("craft_inspect", {}), "read");
  assert.equal(craftRisk("craft_screenshot", {}), "read");
  assert.equal(craftRisk("craft_request", { method: "ui.elements" }), "read");
  assert.equal(craftRisk("craft_execute", { command: "object.move" }), "act");
  assert.equal(craftRisk("craft_request", { method: "ui.click", params: { id: "x" } }), "act");
  assert.equal(craftRisk("craft_execute", { command: "layer.delete" }), "destructive");
  assert.equal(craftRisk("craft_request", { method: "app.quit" }), "destructive");
  assert.equal(craftRisk("craft_request", { method: "ui.menu.invoke", params: { command: "file.revert" } }), "destructive");
  assert.equal(craftRisk("craft_import", { files: ["f1"] }), "act");
  const act = { command: "object.move" };
  assert.equal(assessCraftCall("craft_execute", act, "strict", "d").ask, true);
  assert.equal(assessCraftCall("craft_execute", act, "standard", "d").ask, true);
  assert.equal(assessCraftCall("craft_execute", act, "destructive", "d").ask, false);
  assert.equal(assessCraftCall("craft_execute", act, "free", "d").ask, false);
  const del = assessCraftCall("craft_execute", { command: "layer.delete" }, "destructive", "d");
  assert.equal(del.ask && del.destructive, true);
  assert.match(del.title, /layer\.delete in DemoCraft/);
  assert.equal(assessCraftCall("craft_execute", { command: "layer.delete" }, "free", "d").ask, false);
  assert.equal(assessCraftCall("craft_inspect", {}, "strict", "d").ask, false);
  // Craft state is third-party content for the conversation's taint.
  for (const name of ["craft_commands", "craft_inspect", "craft_execute", "craft_request", "craft_files"]) assert.ok(PAGE_READS.has(name), name);
  clearCraftPresence("democraft");
});

test("craft_commands lists compact entries, filters by id/label first, and says when more match", async () => {
  connect();
  const all = await run("craft_commands");
  assert.equal(all.body.total, 81);
  assert.ok(all.body.shown > 20 && all.body.shown <= 40, `whole entries that fit: ${all.body.shown}`);
  assert.match(all.body.note, /More match/);
  assert.match(all.body.commands[0].params, /^x{300}… \(craft_commands \{command:"cmd\.n0"\} for all of it\)$/);
  const many = await run("craft_commands", { limit: 200 });
  assert.ok(many.body.shown < 81 && many.body.shown > 20, `shrunk to fit, whole entries: ${many.body.shown}`);
  assert.equal(many.body._truncated, undefined);
  assert.equal(all.body.commands[1].enabled, false);
  assert.equal("enabled" in all.body.commands[0], false, "enabled:true is the default, not repeated");
  const exported = await run("craft_commands", { query: "export" });
  assert.deepEqual(exported.body.commands, [{ id: "file.export", label: "Export…", menu: "File", params: "{format}" }]);
  clearCraftPresence("democraft");
});

test("craft_execute / craft_request / craft_inspect pass through; errors name the app", async () => {
  const calls = connect({ execute: { ok: false, error: "unknown command `nope`" } });
  assert.deepEqual(await run("craft_execute", { command: "nope", params: { a: 1 } }), { ok: false, body: { ok: false, error: "DemoCraft: unknown command `nope`" } });
  assert.deepEqual(calls.at(-1).args, ["nope", { a: 1 }]);
  const clicked = await run("craft_request", { method: "ui.click", params: { id: "menu.File" } });
  assert.equal(clicked.ok, true);
  assert.deepEqual(calls.at(-1).args, ["ui.click", { id: "menu.File" }]);
  assert.deepEqual((await run("craft_inspect")).body.state, { tool: "pen" });
  await run("craft_inspect", { what: "elements", prefix: "menu." });
  assert.deepEqual(calls.at(-1), { method: "request", args: ["ui.elements", { prefix: "menu." }], transfer: undefined });
  assert.equal((await run("craft_execute", {})).ok, false);
  clearCraftPresence("democraft");
  assert.match((await run("craft_inspect")).body.error, /No Craft app is open/);
});

test("craft_screenshot asks again with data:true when the PNG is not inline, and files it in the chain", async () => {
  const png = Buffer.from([137, 80, 78, 71]).toString("base64");
  const calls = connect({ screenshot: (args) => ({ ok: true, result: args[0]?.data ? { pngBase64: png, width: 4, height: 3 } : { width: 4, height: 3 } }) });
  const shot = await run("craft_screenshot");
  assert.equal(shot.ok, true);
  assert.deepEqual(calls.filter((c) => c.method === "screenshot").map((c) => c.args[0]), [{}, { data: true }]);
  assert.equal(shot.body.file.name, "democraft-screenshot.png");
  assert.equal(shot.body.file.mime, "image/png");
  const file = artifactFile(shot.body.file.id);
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [137, 80, 78, 71]);
  // EffectCraft's field is `png`.
  connect({ screenshot: { ok: true, result: { png, width: 4, height: 3 } } });
  const effect = await run("craft_screenshot", { panel: "timeline" });
  assert.equal(effect.body.file.name, "democraft-timeline.png");
  clearCraftPresence("democraft");
});

test("craft_export copies an app file into the chain; craft_import sends chain files over (transferred)", async () => {
  const svg = new TextEncoder().encode("<svg/>");
  const calls = connect({ readFile: { ok: true, result: { bytes: svg.buffer.slice(0) } } });
  const exported = await run("craft_export", { path: "/exports/art.svg" });
  assert.equal(exported.ok, true);
  assert.equal(exported.body.file.name, "art.svg");
  assert.equal(exported.body.file.mime, "image/svg+xml");
  assert.ok(listArtifacts().some((a) => a.id === exported.body.file.id));
  const imported = await run("craft_import", { files: [exported.body.file.id] });
  assert.equal(imported.ok, true);
  const last = calls.at(-1);
  assert.equal(last.method, "import");
  assert.equal(last.args[0][0].name, "art.svg");
  assert.deepEqual(last.transfer, [last.args[0][0].bytes]);
  assert.equal((await run("craft_import", { files: ["../etc"] })).ok, false);
  assert.match((await run("craft_import", { files: ["f9999"] })).body.error, /no longer in your file chain/);
  clearCraftPresence("democraft");
});

test("craft_commands {command}: one command with its whole parameter doc and why it is disabled; a near miss lists similar ids", async () => {
  connect({ commands: { ok: true, result: [
    { id: "document.export", label: "Export Document", menu: ["File"], params: "p".repeat(3000), enabled: true },
    { id: "prop.set", label: "Set Property Value", params: "{layer?, path, value}", enabled: false, why: "select a layer first" },
  ] } });
  const one = await run("craft_commands", { command: "document.export" });
  assert.equal(one.ok, true);
  assert.equal(one.body.command.params.length, 3000, "not clipped");
  const disabled = await run("craft_commands", { command: "prop.set" });
  assert.deepEqual(disabled.body.command, { id: "prop.set", label: "Set Property Value", params: "{layer?, path, value}", enabled: false, why: "select a layer first" });
  const miss = await run("craft_commands", { command: "document.exportt" });
  assert.equal(miss.ok, false);
  assert.match(miss.body.error, /no command "document\.exportt"/);
  assert.equal(miss.body.similar[0].id, "document.export");
  clearCraftPresence("democraft");
});

test("file data an app returns inline (export without a path) goes to the file chain, never into the result", async () => {
  const png = Buffer.alloc(4000, 7).toString("base64");
  connect({ execute: { ok: true, result: { bytes: 4000, dataBase64: png, format: "png", warnings: [] } } });
  const r = await run("craft_execute", { command: "document.export", params: { format: "png" } });
  assert.equal(r.ok, true);
  assert.ok(!JSON.stringify(r.body).includes(png.slice(0, 200)), "no base64 in the result");
  assert.equal(r.body.result.file.name, "democraft-document-export.png");
  assert.equal(r.body.result.file.mime, "image/png");
  assert.equal(r.body.new_files[0].id, r.body.result.file.id);
  assert.equal((await artifactFile(r.body.result.file.id).arrayBuffer()).byteLength, 4000);
  // several files (one per artboard), named by the app; small strings and other keys stay as they are
  connect({ request: { ok: true, result: { files: [{ name: "art-1.svg", dataBase64: Buffer.alloc(900, 1).toString("base64") }, { name: "art-2.svg", dataBase64: Buffer.alloc(900, 2).toString("base64") }], note: "x".repeat(600) } } });
  const many = await run("craft_request", { method: "assets.export" });
  assert.deepEqual(many.body.new_files.map((f) => f.name), ["art-1.svg", "art-2.svg"]);
  assert.equal(many.body.result.note.length, 600);
  connect({ execute: { ok: true, result: { dataBase64: "short" } } });
  assert.deepEqual((await run("craft_execute", { command: "x.y" })).body.result, { dataBase64: "short" }, "too short to be a file");
  clearCraftPresence("democraft");
});

test("craft_guide: the guide of the open app, a version note when the app moved on, a fallback for apps without one", async () => {
  const { craftGuide } = await import("../src/lib/craft/guides.ts");
  const guide = craftGuide("vectorcraft");
  setCraftPresence({ appId: "vectorcraft", appName: "VectorCraft", version: guide.verified, state: "connected", methods: ["inspect"], call: async () => ({ ok: true, result: {} }) });
  assert.equal(craftToolAvailable("craft_guide"), true);
  const same = await run("craft_guide");
  assert.equal(same.body.guide, guide.text);
  assert.equal(same.body.note, undefined);
  assert.match(craftStatusNote(), /read craft_guide/);
  assert.ok(craftStatusNote().includes(guide.brief));
  setCraftPresence({ appId: "vectorcraft", appName: "VectorCraft", version: "9.9.9", state: "connected", methods: ["inspect"], call: async () => ({ ok: true, result: {} }) });
  assert.match((await run("craft_guide")).body.note, /checked against VectorCraft 0\.17\.0; the open app is 9\.9\.9/);
  clearCraftPresence("vectorcraft");
  connect({}, ["inspect"]);
  assert.match((await run("craft_guide")).body.guide, /No guide for this app yet/);
  clearCraftPresence("democraft");
});

test("readFile: bytes from the app's own frame (another realm, where instanceof Uint8Array is false) still come back", async () => {
  const foreign = vm.runInNewContext("new Uint8Array([1, 2, 3, 4]).subarray(1)");
  assert.equal(foreign instanceof Uint8Array, false, "the test really crosses realms");
  const call = bridge({ democraft: fakeApi({ readFile: async () => foreign }).api });
  const hit = await call("readFile", ["/exports/a.png"]);
  assert.equal(hit.message.ok, true, JSON.stringify(hit.message));
  assert.deepEqual([...new Uint8Array(hit.message.result.bytes)], [2, 3, 4], "the view's own bytes, not its whole buffer");
  const plain = bridge({ democraft: fakeApi({ readFile: async () => "nope" }).api });
  assert.equal((await plain("readFile", ["/x"])).message.error, "the app returned no bytes");
});

test("craft_file_save: a chain file into the account's Craft files (POST /api/craft/files), never replacing unless asked", async () => {
  connect({ screenshot: { ok: true, result: { pngBase64: Buffer.from("png").toString("base64"), width: 2, height: 1 } } });
  const real = globalThis.fetch;
  const sent = [];
  let reply = () => new Response(JSON.stringify({ file: { id: "a".repeat(20), name: "Poster.png", app: "democraft", mime: "image/png", size: 4, updatedAt: "2026-10-26T10:00:00.000Z" } }), { status: 201 });
  globalThis.fetch = async (url, init) => (sent.push({ url, init, body: JSON.parse(init.body) }), reply());
  try {
    const shot = await run("craft_screenshot");
    const id = shot.body.file.id;
    const saved = await run("craft_file_save", { file: id, name: "Poster.png" });
    assert.equal(saved.ok, true, JSON.stringify(saved.body));
    assert.equal(saved.body.saved.id, "a".repeat(20));
    assert.match(saved.body.note, /knife_craft_file_read/);
    const req = sent.at(-1);
    assert.equal(req.url, "/api/craft/files");
    assert.equal(req.init.method, "POST");
    assert.equal(req.init.credentials, "same-origin", "the tab's own session: its account, quota and rate");
    assert.deepEqual({ ...req.body, data: undefined }, { action: "save", app: "democraft", name: "Poster.png", mime: "image/png", data: undefined, replace: false });
    assert.equal(Buffer.from(req.body.data, "base64").toString(), "png", "the chain file's bytes");
    // replace:true sends no `replace` (the route's default: same app + name replaces)
    await run("craft_file_save", { file: id, replace: true });
    assert.equal(sent.at(-1).body.replace, undefined);
    assert.equal(sent.at(-1).body.name, "democraft-screenshot.png", "the chain file's own name by default");
    // An existing name: refused with the hint, the server's message names the existing id.
    reply = () => new Response(JSON.stringify({ error: 'A file named "Poster.png" from this app is already in your files (id bbb).', code: "file_exists" }), { status: 409 });
    const taken = await run("craft_file_save", { file: id, name: "Poster.png" });
    assert.equal(taken.ok, false);
    assert.match(taken.body.error, /already in your files/);
    assert.match(taken.body.hint, /replace:true/);
    reply = () => new Response(JSON.stringify({ error: "Your storage is full.", code: "storage_quota_exceeded" }), { status: 507 });
    assert.match((await run("craft_file_save", { file: id })).body.error, /Could not save .*storage is full/);
    const calls = sent.length;
    assert.match((await run("craft_file_save", { file: "../etc" })).body.error, /needs \{"file": "f3"\}/);
    assert.match((await run("craft_file_save", { file: "f9999" })).body.error, /no longer in the file chain/);
    assert.equal(sent.length, calls, "nothing is sent for a bad or missing id");
  } finally {
    globalThis.fetch = real;
    clearCraftPresence("democraft");
  }
});

test("craft_file_save trust: a save acts (asked in Standard/Strict), replace:true is destructive in every mode but None", async () => {
  connect({ screenshot: { ok: true, result: { pngBase64: Buffer.from("png").toString("base64"), width: 2, height: 1 } } });
  const id = (await run("craft_screenshot")).body.file.id;
  assert.equal(craftRisk("craft_file_save", { file: id }), "act");
  assert.equal(craftRisk("craft_file_save", { file: id, replace: true }), "destructive");
  const save = assessCraftCall("craft_file_save", { file: id, name: "Poster.png" }, "standard", "d");
  assert.equal(save.ask, true);
  assert.equal(save.destructive, false);
  assert.match(save.title, /Save Poster\.png to your files\?/);
  assert.equal(assessCraftCall("craft_file_save", { file: id }, "destructive", "d").ask, false);
  const replace = assessCraftCall("craft_file_save", { file: id, name: "Poster.png", replace: true }, "destructive", "d");
  assert.equal(replace.ask, true);
  assert.equal(replace.destructive, true);
  assert.match(replace.title, /Replace Poster\.png/);
  assert.equal(assessCraftCall("craft_file_save", { file: id, replace: true }, "free", "d").ask, false);
  assert.equal(assessCraftCall("craft_file_save", { file: "f99999" }, "strict", "d").ask, false, "no such chain file: nothing to ask, the tool reports it");
  assert.equal(assessCraftCall("craft_file_save", { file: "../x", replace: true }, "standard", "d").ask, false);
  assert.match(assessCraftCall("craft_file_save", { file: id }, "strict", "d").title, /democraft-screenshot\.png/, "the card names the chain file");
  assert.ok(!PAGE_READS.has("craft_file_save"), "its result is our own metadata, like craft_screenshot");
  clearCraftPresence("democraft");
});

test("an outside agent's call is refused in a tab loaded by another account (a sign-in elsewhere switched the cookie)", async () => {
  const { runExternalCall } = await import("../src/lib/agent-client/external-call.ts");
  const { runtime } = await import("../src/lib/agent-client/runtime-store.ts");
  connect();
  runtime.setAccount("alice");
  const approve = async () => true;
  const other = await runExternalCall({ tool: "craft_file_save", args: { file: "f1" }, from: "MCP agent", account: "bob" }, approve);
  assert.equal(other.status, "unavailable");
  assert.match(other.content, /another account/);
  assert.equal((await runExternalCall({ tool: "list_tools", args: {}, from: "MCP agent", account: "bob" }, approve)).status, "unavailable", "not even the definitions");
  const own = await runExternalCall({ tool: "list_tools", args: {}, from: "MCP agent", account: "alice" }, approve);
  assert.equal(own.status, "done");
  assert.ok(JSON.parse(own.content).tools.some((t) => t.name === "craft_file_save"));
  runtime.setAccount(null);
  clearCraftPresence("democraft");
});
