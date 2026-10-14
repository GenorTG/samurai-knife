// Live editing of the open office document: protocol (src/lib/office/live-protocol.ts), the browser bridge
// (src/lib/office/live-bridge.ts) against a fake plugin frame, the plugin itself (sidecars/office/plugins/knife-bridge/
// bridge.js) in a sandbox with a fake editor Api, the assistant tools' trust verdicts, the plugin assets of the sidecar
// (src/lib/services/assets.ts + compose mount) and the editor config carrying the plugin options.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/office_live.test.mjs
import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { parse } from "yaml";

const dataDir = mkdtempSync(join(tmpdir(), "knife-office-live-"));
process.env.KNIFE_DATA_DIR = dataDir;
process.env.KNIFE_HOST = "100.64.0.7";
process.env.KNIFE_PORT = "3210";
delete process.env.KNIFE_SIDECAR_APP_URL;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const protocol = await import("../src/lib/office/live-protocol.ts");
const { OfficeLiveBridge, setActiveLiveBridge, connectedLiveEditor } = await import("../src/lib/office/live-bridge.ts");
const { assessLiveCall, liveToolAvailable, LIVE_TOOL_DEFS } = await import("../src/lib/agent-client/office-live-tools.ts");
const { visibleTools, TOOL_GROUPS, initialGroups } = await import("../src/lib/agent-client/tool-groups.ts");
const { findSidecar } = await import("../src/lib/services/definitions.ts");
const { renderCompose } = await import("../src/lib/services/compose.ts");
const { syncAssets, folderHash, expectedFolders } = await import("../src/lib/services/assets.ts");
const { composeHashOf } = await import("../src/lib/services/manager.ts");
const state = await import("../src/lib/services/state.ts");
const { verifyJwt } = await import("../src/lib/jwt-hs256.ts");

const TOKEN = "t".repeat(32);
const SIDECAR = "http://100.64.0.7:3211";
const APP = "http://100.64.0.7:3210";
const PLUGIN_DIR = new URL("../sidecars/office/plugins/knife-bridge/", import.meta.url);

/* ------------------------------------------------------------------------------------------------- protocol */

test("plugin config.json matches the protocol guid and is a hidden system plugin for word/cell/slide", () => {
  const config = JSON.parse(readFileSync(new URL("config.json", PLUGIN_DIR), "utf8"));
  assert.equal(config.guid, protocol.LIVE_PLUGIN_GUID);
  const v = config.variations[0];
  assert.equal(v.isSystem, true);
  assert.equal(v.isVisual, false);
  assert.deepEqual(v.EditorsSupport, ["word", "cell", "slide"]);
  assert.equal(v.url, "index.html");
  const html = readFileSync(new URL("index.html", PLUGIN_DIR), "utf8");
  assert.match(html, /src="loader\.js"[\s\S]*src="bridge\.js"/);
  assert.doesNotMatch(html, /https?:\/\//, "the plugin loads nothing from the internet");
});

test("parseHello: only this session's hello (protocol, version, token) passes", () => {
  const hello = { protocol: protocol.LIVE_PROTOCOL, v: 1, kind: "hello", token: TOKEN, editor: "word", viewMode: false, title: "A", plugin: "1.0.0", commands: ["get_text", 5] };
  assert.deepEqual(protocol.parseHello(hello, TOKEN)?.commands, ["get_text"]);
  assert.equal(protocol.parseHello({ ...hello, token: "x".repeat(32) }, TOKEN), null);
  assert.equal(protocol.parseHello({ ...hello, v: 2 }, TOKEN), null);
  assert.equal(protocol.parseHello({ ...hello, protocol: "other" }, TOKEN), null);
  assert.equal(protocol.parseHello(JSON.stringify(hello), TOKEN), null, "strings (the editor's own messages) are not ours");
  assert.equal(protocol.parseHello({ ...hello, editor: "pdf" }, TOKEN)?.editor, "unknown");
  assert.equal(protocol.parsePortMessage({ protocol: protocol.LIVE_PROTOCOL, kind: "response", id: "q1", ok: true, data: { a: 1 } })?.ok, true);
  assert.equal(protocol.parsePortMessage({ protocol: protocol.LIVE_PROTOCOL, kind: "response", id: "q1" }), null);
  assert.equal(protocol.parsePortMessage({ protocol: protocol.LIVE_PROTOCOL, kind: "pong", id: "p1" })?.kind, "pong");
});

test("appOriginFor: the claimed page origin must name the request's own host", () => {
  assert.equal(protocol.appOriginFor("http://100.64.0.7:3210", "100.64.0.7:3210"), APP);
  assert.equal(protocol.appOriginFor("http://100.64.0.7:3210/", "100.64.0.7:3210"), APP);
  assert.equal(protocol.appOriginFor("http://evil.example:3210", "100.64.0.7:3210"), null);
  assert.equal(protocol.appOriginFor("http://100.64.0.7:3211", "100.64.0.7:3210"), null, "another port is another origin");
  assert.equal(protocol.appOriginFor("http://100.64.0.7:3210/path", "100.64.0.7:3210"), null);
  assert.equal(protocol.appOriginFor("javascript:alert(1)", "100.64.0.7:3210"), null);
  assert.equal(protocol.appOriginFor("http://u:p@100.64.0.7:3210", "100.64.0.7:3210"), null);
  assert.equal(protocol.appOriginFor(null, "100.64.0.7:3210"), null);
});

test("toLiveCall: every assistant tool maps to a plugin command with checked arguments", () => {
  const ok = (tool, args, cmd) => {
    const r = protocol.toLiveCall(tool, args);
    assert.equal(r.ok, true, `${tool}: ${r.error}`);
    assert.equal(r.call.cmd, cmd);
    return r.call.args;
  };
  const bad = (tool, args, re) => {
    const r = protocol.toLiveCall(tool, args);
    assert.equal(r.ok, false, `${tool} should fail for ${JSON.stringify(args)}`);
    assert.match(r.error, re);
  };
  ok("doc_live_read", {}, "get_text");
  assert.deepEqual(ok("doc_live_read", { what: "structure", from: 3, limit: 10 }, "get_structure"), { from: 3, limit: 10 });
  ok("doc_live_read", { what: "selection" }, "get_selection");
  bad("doc_live_read", { what: "everything" }, /what must be/);
  bad("doc_live_read", { max_chars: 5 }, /max_chars/);
  assert.deepEqual(ok("doc_live_insert_text", { text: "hi" }, "insert_text"), { text: "hi", where: "end" });
  bad("doc_live_insert_text", { text: "hi", where: "top" }, /where/);
  bad("doc_live_insert_text", {}, /text is required/);
  assert.deepEqual(ok("doc_live_insert_paragraphs", { paragraphs: ["a", { text: "b", style: "Heading 1" }], index: 2 }, "insert_paragraphs"), {
    paragraphs: [{ text: "a" }, { text: "b", style: "Heading 1" }],
    index: 2,
  });
  bad("doc_live_insert_paragraphs", { paragraphs: [{ text: "a\nb" }] }, /without line breaks/);
  bad("doc_live_insert_paragraphs", { paragraphs: [] }, /1\.\.200/);
  bad("doc_live_insert_paragraphs", { paragraphs: [{ text: "a", style: "<script>" }] }, /bad style/);
  assert.deepEqual(ok("doc_live_replace", { search: "a", replace: "" }, "replace_text"), { search: "a", replace: "", match_case: false });
  bad("doc_live_replace", { search: "a" }, /replace is required/);
  ok("doc_live_set_style", { from: 0, to: 2, style: "Heading 2" }, "set_paragraph_style");
  bad("doc_live_set_style", { from: 2, to: 1, style: "Normal" }, /to must be >= from/);
  ok("doc_live_delete", { from: 1 }, "delete_range");
  bad("doc_live_delete", {}, /from/);
  ok("doc_live_comment", { text: "x", quote: "y" }, "add_comment");
  bad("doc_live_comment", { text: "" }, /text/);
  ok("doc_live_cells_read", { range: "A1:C3", sheet: "Sheet1" }, "cells_read");
  bad("doc_live_cells_read", { range: "A1:" }, /range/);
  assert.deepEqual(ok("doc_live_cells_write", { start: "B2", values: [[1, "=A1*2", null, true]] }, "cells_write"), {
    start: "B2",
    values: [[1, "=A1*2", null, true]],
    overwrite: false,
  });
  bad("doc_live_cells_write", { start: "B2:C3", values: [[1]] }, /top-left cell/);
  bad("doc_live_cells_write", { start: "A1", values: [[{}]] }, /cells are text/);
  bad("doc_live_cells_write", { start: "A1", values: Array.from({ length: 30 }, () => Array(100).fill(1)) }, /at most 2000/);
  ok("doc_live_add_sheet", { name: "Summary" }, "add_sheet");
  bad("doc_live_add_sheet", { name: "a/b" }, /name is required/);
  ok("doc_live_add_slide", { title: "T", body: "a\nb" }, "add_slide");
  bad("doc_live_add_slide", {}, /title/);
  bad("doc_live_unknown", {}, /unknown/);
});

test("every doc_live tool has an editor list, and risk classes follow the trust rules", () => {
  for (const d of LIVE_TOOL_DEFS) assert.ok(protocol.LIVE_TOOL_EDITORS[d.function.name], d.function.name);
  assert.equal(protocol.liveRisk("doc_live_read", {}), "read");
  assert.equal(protocol.liveRisk("doc_live_cells_read", {}), "read");
  assert.equal(protocol.liveRisk("doc_live_insert_text", {}), "edit");
  assert.equal(protocol.liveRisk("doc_live_delete", {}), "destructive");
  assert.equal(protocol.liveRisk("doc_live_replace", {}), "destructive");
  assert.equal(protocol.liveRisk("doc_live_cells_write", {}), "edit");
  assert.equal(protocol.liveRisk("doc_live_cells_write", { overwrite: true }), "destructive");

  const verdict = (name, args, mode) => assessLiveCall(name, args, mode, "detail", "Report.docx");
  for (const mode of ["strict", "standard", "destructive", "free"]) assert.equal(verdict("doc_live_read", {}, mode).ask, false, `read in ${mode}`);
  assert.equal(verdict("doc_live_insert_text", {}, "strict").ask, true);
  assert.equal(verdict("doc_live_insert_text", {}, "standard").ask, true);
  assert.equal(verdict("doc_live_insert_text", {}, "destructive").ask, false, "Risky: plain edits run");
  assert.equal(verdict("doc_live_insert_text", {}, "free").ask, false);
  for (const mode of ["strict", "standard", "destructive"]) {
    const v = verdict("doc_live_delete", { from: 1 }, mode);
    assert.equal(v.ask && v.destructive, true, `delete in ${mode}`);
    assert.equal(verdict("doc_live_replace", { search: "x", replace: "y" }, mode).destructive, true);
    assert.equal(verdict("doc_live_cells_write", { overwrite: true }, mode).destructive, true);
  }
  assert.equal(verdict("doc_live_delete", { from: 1 }, "free").ask, false, "None: never asks");
  assert.match(verdict("doc_live_replace", { search: "draft", replace: "final" }, "destructive").title, /Replace every “draft” in “Report\.docx”/);
});

/* ---------------------------------------------------------------------------------------------- browser bridge */

function fakeWindow() {
  const listeners = new Set();
  return {
    listeners,
    addEventListener: (type, fn) => listeners.add(fn),
    removeEventListener: (type, fn) => listeners.delete(fn),
    dispatch: (event) => listeners.forEach((fn) => fn(event)),
  };
}

/** A plugin frame: child of the editor frame window, answering requests over the port it is handed. */
function fakePlugin(editorWindow, answer) {
  const plugin = { parent: editorWindow, welcomes: [], port: null };
  plugin.postMessage = (message, targetOrigin, transfer) => {
    plugin.welcomes.push({ message, targetOrigin });
    plugin.port = transfer[0];
    plugin.port.onmessage = (event) => {
      const msg = event.data;
      if (msg.kind === "ping") return plugin.port.postMessage({ protocol: protocol.LIVE_PROTOCOL, kind: "pong", id: msg.id });
      const reply = answer(msg);
      if (reply) plugin.port.postMessage({ protocol: protocol.LIVE_PROTOCOL, kind: "response", id: msg.id, ...reply });
    };
  };
  return plugin;
}

function hello(extra = {}) {
  return { protocol: protocol.LIVE_PROTOCOL, v: 1, kind: "hello", token: TOKEN, editor: "word", viewMode: false, title: "Report", plugin: "1.0.0", commands: ["get_text"], ...extra };
}

function newBridge(win, editorWindow, extra = {}) {
  return new OfficeLiveBridge({ token: TOKEN, sidecarOrigin: SIDECAR, docId: "d1", docName: "Report.docx", editorFrame: () => ({ contentWindow: editorWindow }), win, ...extra });
}

test("bridge: hello accepted only from the sidecar origin, with the token, from inside our editor iframe", async () => {
  const win = fakeWindow();
  const editorWindow = { name: "editor" };
  const plugin = fakePlugin(editorWindow, (msg) => ({ ok: true, data: { echo: msg.cmd, args: msg.args } }));
  const bridge = newBridge(win, editorWindow);
  bridge.start();
  try {
    win.dispatch({ origin: "http://evil.example", data: hello(), source: plugin });
    win.dispatch({ origin: SIDECAR, data: hello({ token: "y".repeat(32) }), source: plugin });
    win.dispatch({ origin: SIDECAR, data: hello(), source: { parent: { name: "another frame" }, postMessage: plugin.postMessage } });
    win.dispatch({ origin: SIDECAR, data: JSON.stringify(hello()), source: plugin });
    assert.equal(bridge.state.state, "connecting");
    assert.equal(plugin.welcomes.length, 0);
    const refused = await bridge.call("get_text", {});
    assert.equal(refused.ok, false);

    win.dispatch({ origin: SIDECAR, data: hello(), source: plugin });
    assert.equal(bridge.state.state, "connected");
    assert.equal(bridge.state.editor, "word");
    assert.deepEqual(plugin.welcomes[0].message, { protocol: protocol.LIVE_PROTOCOL, kind: "welcome", token: TOKEN });
    assert.equal(plugin.welcomes[0].targetOrigin, SIDECAR);
    const result = await bridge.call("get_text", { max_chars: 500 });
    assert.deepEqual(result.data, { echo: "get_text", args: { max_chars: 500 } });

    setActiveLiveBridge(bridge);
    assert.equal(connectedLiveEditor(), "word");
    assert.equal(liveToolAvailable("doc_live_delete"), true);
    assert.equal(liveToolAvailable("doc_live_cells_write"), false, "spreadsheet tools hidden in the word editor");
    assert.equal(liveToolAvailable("knife_hash"), true);
  } finally {
    setActiveLiveBridge(null);
    bridge.stop();
    plugin.port?.close();
  }
  assert.equal(liveToolAvailable("doc_live_read"), false, "no editor -> no live tools");
  assert.equal(win.listeners.size, 0, "stop removes the window listener");
});

test("bridge: timeouts, abort, unavailable after the connect timeout, stop fails pending calls", async () => {
  const win = fakeWindow();
  const editorWindow = {};
  const plugin = fakePlugin(editorWindow, () => null); // never answers
  const lonely = newBridge(fakeWindow(), editorWindow, { connectTimeoutMs: 20 });
  lonely.start();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(lonely.state.state, "unavailable");
  assert.match((await lonely.call("get_text", {})).error, /did not connect/);
  lonely.stop();

  const bridge = newBridge(win, editorWindow);
  bridge.start();
  win.dispatch({ origin: SIDECAR, data: hello(), source: plugin });
  const slow = await bridge.call("get_text", {}, { timeoutMs: 30 });
  assert.match(slow.error, /did not answer within/);
  const controller = new AbortController();
  const pending = bridge.call("get_text", {}, { signal: controller.signal });
  controller.abort();
  assert.match((await pending).error, /Stopped by the user/);
  const left = bridge.call("get_text", {});
  bridge.stop();
  assert.match((await left).error, /closed/);
  plugin.port?.close();
});

test("tool groups: office_live preloads on /tools/office, and visibility follows the connected editor", () => {
  const group = TOOL_GROUPS.find((g) => g.id === "office_live");
  assert.ok(group);
  assert.ok(initialGroups("/tools/office", []).has("office_live"));
  assert.ok(!initialGroups("/tools/json", []).has("office_live"));
  const defs = [...LIVE_TOOL_DEFS, { type: "function", function: { name: "list_tools", description: "", parameters: {} } }];
  const names = (available) => visibleTools(defs, new Set(["office_live"]), available).map((d) => d.function.name);
  assert.deepEqual(names((n) => !n.startsWith("doc_live_")), ["list_tools"]);
  assert.ok(names(() => true).includes("doc_live_add_slide"));
  assert.deepEqual(visibleTools(defs, new Set()).map((d) => d.function.name), ["list_tools"], "not loaded -> hidden");
});

/* ----------------------------------------------------------------------------------- the plugin in a sandbox */

/** Loads bridge.js the way the editor would (after the runtime gave it Asc.plugin), with a fake Api behind callCommand. */
function loadPlugin({ options, editorType = "word", viewMode = false, api }) {
  const posted = [];
  const appWindow = { postMessage: (message, targetOrigin) => posted.push({ message, targetOrigin }) };
  const editorWindow = { parent: appWindow };
  const listeners = [];
  const calls = [];
  const sandbox = {
    window: null,
    Asc: {
      plugin: {
        info: { editorType, isViewMode: viewMode, documentTitle: "Report", options },
        callCommand(fn, isClose, isCalc, callback) {
          calls.push({ code: fn.toString(), isClose, isCalc });
          // What the runtime does: "var Asc = {}; Asc.scope = <json>; (fn)();" evaluated in the editor.
          const run = new Function("Api", "scopeJson", `var Asc = {}; Asc.scope = JSON.parse(scopeJson); return (${fn.toString()})();`);
          const result = run(api, JSON.stringify(sandbox.window.Asc.scope));
          setTimeout(() => callback(result), 0);
        },
      },
    },
    parent: editorWindow,
    addEventListener: (type, fn) => listeners.push(fn),
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    Promise,
    Date,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL("bridge.js", PLUGIN_DIR), "utf8"), sandbox);
  sandbox.Asc.plugin.init();
  return { sandbox, posted, appWindow, editorWindow, calls, dispatch: (event) => listeners.forEach((fn) => fn(event)), hooks: sandbox.__knifeBridgeTest };
}

function fakeWordApi(texts) {
  const paragraphs = texts.map((t) => ({ text: t, style: "Normal" }));
  const para = (p) => ({
    GetClassType: () => "paragraph",
    GetText: () => p.text,
    GetStyle: () => ({ GetName: () => p.style }),
  });
  return {
    paragraphs,
    GetDocument: () => ({
      GetElementsCount: () => paragraphs.length,
      GetElement: (i) => para(paragraphs[i]),
      RemoveElement: (i) => paragraphs.splice(i, 1),
      Push: () => paragraphs.push({ text: "", style: "Normal" }),
      Search: (s) => paragraphs.flatMap((p) => p.text.split(s).slice(1)),
      SearchAndReplace: ({ searchString, replaceString }) => paragraphs.forEach((p) => (p.text = p.text.split(searchString).join(replaceString))),
    }),
    CreateParagraph: () => ({}),
  };
}

test("plugin: idle without options; hello goes only to the app origin; welcome needs origin + source + token", async () => {
  const idle = loadPlugin({ options: undefined, api: fakeWordApi([]) });
  assert.equal(idle.posted.length, 0, "an editor not opened by Samurai Knife never says hello");
  assert.equal(idle.hooks.readOptions(), null);

  const p = loadPlugin({ options: { token: TOKEN, appOrigin: APP }, api: fakeWordApi(["Hello draft", "second draft"]) });
  try {
    assert.equal(p.posted.length, 1);
    assert.equal(p.posted[0].targetOrigin, APP);
    assert.equal(p.posted[0].message.token, TOKEN);
    assert.equal(p.posted[0].message.editor, "word");
    assert.ok(p.posted[0].message.commands.includes("delete_range"));

    const { port1, port2 } = new MessageChannel();
    const welcome = { protocol: protocol.LIVE_PROTOCOL, kind: "welcome", token: TOKEN };
    p.dispatch({ origin: "http://evil.example", source: p.appWindow, data: welcome, ports: [port2] });
    p.dispatch({ origin: APP, source: {}, data: welcome, ports: [port2] });
    p.dispatch({ origin: APP, source: p.appWindow, data: { ...welcome, token: "z".repeat(32) }, ports: [port2] });
    const replies = [];
    port1.onmessage = (event) => replies.push(event.data);
    port1.postMessage({ protocol: protocol.LIVE_PROTOCOL, kind: "ping", id: "p0" });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(replies.length, 0, "no channel before a valid welcome");

    p.dispatch({ origin: APP, source: p.appWindow, data: welcome, ports: [port2] });
    const ask = (id, cmd, args) => port1.postMessage({ protocol: protocol.LIVE_PROTOCOL, kind: "request", id, cmd, args });
    ask("q1", "get_text", {});
    ask("q2", "replace_text", { search: "draft", replace: "final" });
    ask("q3", "delete_range", { from: 0, to: 0 });
    ask("q4", "get_structure", {});
    ask("q5", "cells_read", {});
    ask("q6", "delete_range", { from: 5 });
    await new Promise((r) => setTimeout(r, 100));
    const byId = Object.fromEntries(replies.map((r) => [r.id, r]));
    assert.equal(byId.q1.data.text, "Hello draft\nsecond draft");
    assert.equal(byId.q2.data.count, 2);
    assert.equal(byId.q2.data.remaining, 0);
    assert.equal(byId.q3.data.removed_text, "Hello final");
    assert.deepEqual(byId.q4.data.items.map((i) => i.text), ["second final"]);
    assert.equal(byId.q5.ok, false);
    assert.match(byId.q5.error, /not available in the word editor/);
    assert.equal(byId.q6.ok, false, "an exception inside the editor comes back as an error");
    assert.match(byId.q6.error, /out of range/);
    assert.deepEqual(p.calls.map((c) => c.isCalc), [false, true, true, false, true], "reads do not recalculate, edits do");
    assert.ok(p.calls.every((c) => c.isClose === false), "the plugin never closes itself");
    assert.ok(p.calls.every((c) => /^function\(\)\{try\{return \{ok:true,data:\(/.test(c.code)));
    port1.close();
  } finally {
    p.sandbox.Asc.plugin.init = null;
  }
});

test("plugin: read-only editor refuses edits; cells_write block addressing", async () => {
  const p = loadPlugin({ options: { token: TOKEN, appOrigin: APP }, viewMode: true, api: fakeWordApi(["a"]) });
  const { port1, port2 } = new MessageChannel();
  p.dispatch({ origin: APP, source: p.appWindow, data: { protocol: protocol.LIVE_PROTOCOL, kind: "welcome", token: TOKEN }, ports: [port2] });
  const replies = [];
  port1.onmessage = (event) => replies.push(event.data);
  port1.postMessage({ protocol: protocol.LIVE_PROTOCOL, kind: "request", id: "e1", cmd: "insert_text", args: { text: "x", where: "end" } });
  port1.postMessage({ protocol: protocol.LIVE_PROTOCOL, kind: "request", id: "r1", cmd: "get_text", args: {} });
  await new Promise((r) => setTimeout(r, 50));
  assert.match(replies.find((r) => r.id === "e1").error, /read-only/);
  assert.equal(replies.find((r) => r.id === "r1").ok, true);
  port1.close();

  const cells = p.hooks.prepareCells({ start: "Y9", values: [[1, null, "=A1"], ["x"]], overwrite: true });
  assert.deepEqual(JSON.parse(JSON.stringify(cells.cells)), [["Y9", 1], ["AA9", "=A1"], ["Y10", "x"]]);
  assert.equal(cells.address, "Y9:AA10");
  assert.equal(cells.overwrite, true);
  assert.throws(() => p.hooks.prepareCells({ start: "nope", values: [[1]] }), /cell like/);
});

/* ------------------------------------------------------------------------------- sidecar assets + compose */

test("compose mounts the office plugin folder read-only into sdkjs-plugins", () => {
  const def = findSidecar("office");
  const doc = parse(renderCompose(def, { bindHost: "100.64.0.7", hostPort: 3211 }));
  const volumes = doc.services.documentserver.volumes;
  assert.ok(volumes.includes("./assets:/var/www/euro-office/documentserver/sdkjs-plugins:ro"), volumes.join(", "));
  const s = { id: "office", image: def.image, bindHost: "100.64.0.7", hostPort: 3211, idleStopMinutes: 30, installedAt: "x", updatedAt: "x" };
  assert.equal(composeHashOf(def, s), composeHashOf(def, s));
  assert.notEqual(composeHashOf(def, s), composeHashOf(def, { ...s, hostPort: 3212 }));
});

test("syncAssets: hashed folder names, world-readable copies, stale folders removed, unchanged = no-op", () => {
  const source = mkdtempSync(join(tmpdir(), "knife-assets-src-"));
  try {
    cpSync(new URL("../sidecars/office/plugins", import.meta.url), source, { recursive: true });
    const def = { ...findSidecar("office"), id: "office", assets: { source, target: "/x", label: "editor plugins" } };
    const first = syncAssets(def);
    const hash = folderHash(join(source, "knife-bridge"));
    assert.deepEqual(first.folders, [`knife-bridge-${hash}`]);
    assert.deepEqual(expectedFolders(def), first.folders);
    assert.equal(first.changed, true);
    const folder = join(first.dir, first.folders[0]);
    assert.equal(statSync(first.dir).mode & 0o777, 0o755);
    assert.equal(statSync(folder).mode & 0o777, 0o755);
    assert.equal(statSync(join(folder, "bridge.js")).mode & 0o777, 0o644);
    assert.equal(readFileSync(join(folder, "config.json"), "utf8"), readFileSync(new URL("config.json", PLUGIN_DIR), "utf8"));
    assert.equal(syncAssets(def).changed, false, "same content: nothing copied");

    writeFileSync(join(source, "knife-bridge", "bridge.js"), "// changed\n");
    chmodSync(join(source, "knife-bridge", "bridge.js"), 0o600);
    const second = syncAssets(def);
    assert.equal(second.changed, true);
    assert.notDeepEqual(second.folders, first.folders);
    assert.deepEqual(readdirSync(second.dir), second.folders, "the old folder is gone");
    assert.equal(statSync(join(second.dir, second.folders[0], "bridge.js")).mode & 0o777, 0o644, "copies are readable whatever the source mode");
    assert.ok(state.serviceDir("office").startsWith(dataDir));
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});

test("editor config carries the plugin options (token + app origin) inside the signed config, macros off", async () => {
  const { editorConfig, officeSecret } = await import("../src/lib/office/editor.ts");
  const { ensureSecrets, writeState } = state;
  const def = findSidecar("office");
  ensureSecrets(def);
  writeState({ id: "office", image: def.image, bindHost: "100.64.0.7", hostPort: 3211, idleStopMinutes: 30, installedAt: "x", updatedAt: "x" });
  const account = { id: "genor", displayName: "Genor" };
  const meta = { id: "abcdef0123456789", name: "R.docx", format: "docx", key: "k1", version: 1 };
  const withLive = editorConfig(account, meta, { mode: "edit", appOrigin: APP });
  assert.equal(withLive.live.sidecarOrigin, SIDECAR);
  assert.ok(withLive.live.token.length >= 30);
  const options = withLive.config.editorConfig.plugins.options[protocol.LIVE_PLUGIN_GUID];
  assert.deepEqual(options, { token: withLive.live.token, appOrigin: APP });
  assert.equal(withLive.config.editorConfig.customization.macros, false);
  assert.equal(withLive.config.editorConfig.customization.plugins, true);
  const signed = verifyJwt(withLive.config.token, officeSecret());
  assert.equal(signed.editorConfig.plugins.options[protocol.LIVE_PLUGIN_GUID].token, withLive.live.token, "the options are part of the signed config");
  const again = editorConfig(account, meta, { mode: "edit", appOrigin: APP });
  assert.notEqual(again.live.token, withLive.live.token, "a fresh token per editor session");
  const plain = editorConfig(account, meta, { mode: "edit" });
  assert.equal(plain.live, null);
  assert.deepEqual(plain.config.editorConfig.plugins.options, {});
});
