// The assistant inside the Craft apps: the bridge's "agent" relay (sidecars/craft/knife-bridge/bridge.js) against a
// fake app window, and the craft_* tools (src/lib/agent-client/craft-live-tools.ts): availability, trust verdicts,
// command listing, screenshots and exports into the file chain, imports from it.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/craft_live.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  assert.equal(CRAFT_TOOL_DEFS.length, 8);
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
  assert.deepEqual(visible, ["craft_commands", "craft_inspect", "craft_request"]);
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
  assert.equal(all.body.shown, 40);
  assert.match(all.body.note, /More match/);
  assert.ok(all.body.commands[0].params.length <= 161);
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
