// Smart Knife Craft bridge (docs/SIDECARS.md "Craft files"). Runs on the craft origin, next to the app it serves, in a
// hidden iframe of the Smart Knife page. Plain browser JavaScript, no dependencies, served unmodified from the content dir.
//
// 1. Handshake: the Smart Knife page (our parent) sends {type:"knife-bridge:hello"} with a MessagePort; everything after
//    goes over that port. Only a message whose source is our parent is accepted (frame-ancestors limits who that can be).
// 2. Account separation: {type:"account", tag} -> if the craft origin's browser storage was last used by another
//    account, it is wiped (local/session storage, IndexedDB, OPFS, Cache Storage, service workers) BEFORE the page loads
//    the app; then {type:"account-ok", wiped}.
// 3. {type:"attach"} after each load of the app frame: the app's window (a sibling frame, same origin) gets hooks:
//    - Save: `a[download]` clicks with a blob:/data: URL are sent to the parent as {type:"save", name, mime, bytes}
//      instead of downloading (Save and Download are different things; the page offers Download separately). Over
//      MAX_SAVE bytes the browser downloads as before and the parent hears {type:"save-too-big"}.
//    - Open: `input[type=file]` clicks become {type:"open", id, accept, multiple}; the parent shows its own chooser (the
//      account's files, or this computer) and answers {type:"files", id, files:[{name, mime, bytes}]} or {type:"cancel", id},
//      which the bridge puts into the input and announces with input/change (or cancel) events, as the browser would.
// App code shares this origin and can reach this frame: the parent treats every message as untrusted and only ever
// reads files for the app after the person picked them in Smart Knife's own UI.
(() => {
  "use strict";
  const APP = new URLSearchParams(location.search).get("app") || "";
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(APP)) return;
  const MAX_SAVE = 50 * 1024 * 1024;
  const TAG_KEY = "knife:account";
  let port = null;
  let nextId = 1;
  const pending = new Map();

  window.addEventListener("message", (event) => {
    if (port || event.source !== window.parent || !event.data || event.data.type !== "knife-bridge:hello" || !event.ports[0]) return;
    port = event.ports[0];
    port.onmessage = (message) => void onParent(message.data);
    port.postMessage({ type: "hello", version: 1, app: APP });
  });

  async function onParent(message) {
    if (!message || typeof message !== "object") return;
    try {
      if (message.type === "account") port.postMessage({ type: "account-ok", wiped: await ensureAccount(String(message.tag || "")) });
      else if (message.type === "attach") port.postMessage({ type: "attached", ok: attach() });
      else if (message.type === "files") deliver(message.id, message.files);
      else if (message.type === "cancel") cancel(message.id);
    } catch (error) {
      port.postMessage({ type: "error", message: String((error && error.message) || error).slice(0, 300) });
    }
  }

  /* ------------------------------------------------------------------------------------- account separation */

  async function ensureAccount(tag) {
    if (!/^[0-9a-f]{16,64}$/.test(tag)) throw new Error("bad account tag");
    const last = localStorage.getItem(TAG_KEY);
    // First use on this browser (before account separation existed): adopt it, do not throw anybody's work away.
    if (last === tag || last === null) {
      localStorage.setItem(TAG_KEY, tag);
      return false;
    }
    await wipeOrigin();
    localStorage.setItem(TAG_KEY, tag);
    return true;
  }

  async function wipeOrigin() {
    try { localStorage.clear(); } catch { /* blocked */ }
    try { sessionStorage.clear(); } catch { /* blocked */ }
    if (indexedDB && typeof indexedDB.databases === "function") {
      for (const db of await indexedDB.databases()) {
        if (db.name) await new Promise((resolve) => { const r = indexedDB.deleteDatabase(db.name); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
      }
    }
    if (navigator.storage && typeof navigator.storage.getDirectory === "function") {
      try {
        const root = await navigator.storage.getDirectory();
        for await (const name of root.keys()) await root.removeEntry(name, { recursive: true });
      } catch { /* no OPFS (plain http) */ }
    }
    if (self.caches) for (const key of await caches.keys()) await caches.delete(key);
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
      for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
    }
  }

  /* ------------------------------------------------------------------------------------- the app's window */

  function appWindow() {
    const frames = window.parent.frames;
    for (let i = 0; i < frames.length; i += 1) {
      try {
        const candidate = frames[i];
        if (candidate !== window && candidate.location.pathname.startsWith(`/${APP}/`)) return candidate;
      } catch { /* another origin */ }
    }
    return null;
  }

  function attach() {
    const w = appWindow();
    if (!w) return false;
    if (w.__knifeBridge) return true;
    w.__knifeBridge = true;
    const blobs = new Map();
    const createObjectURL = w.URL.createObjectURL;
    const revokeObjectURL = w.URL.revokeObjectURL;
    // Apps revoke the URL right after clicking: keep the Blob itself, keyed by its URL, for a minute.
    w.URL.createObjectURL = function (object) {
      const url = createObjectURL.call(this, object);
      if (object instanceof w.Blob) {
        blobs.set(url, object);
        if (blobs.size > 64) blobs.delete(blobs.keys().next().value);
      }
      return url;
    };
    w.URL.revokeObjectURL = function (url) {
      setTimeout(() => blobs.delete(url), 60_000);
      return revokeObjectURL.call(this, url);
    };
    const click = w.HTMLElement.prototype.click;
    w.HTMLElement.prototype.click = function () {
      if (this instanceof w.HTMLInputElement && this.type === "file") return requestOpen(this);
      if (this instanceof w.HTMLAnchorElement && this.hasAttribute("download") && /^(blob:|data:)/.test(this.href)) {
        return void captureSave(w, this, blobs, () => click.call(this));
      }
      return click.call(this);
    };
    const showPicker = w.HTMLInputElement.prototype.showPicker;
    if (showPicker) {
      w.HTMLInputElement.prototype.showPicker = function () {
        return this.type === "file" ? requestOpen(this) : showPicker.call(this);
      };
    }
    // Anchors clicked by a dispatched event instead of .click(), while in the document.
    w.document.addEventListener("click", (event) => {
      const anchor = event.target && event.target.closest ? event.target.closest("a[download]") : null;
      if (anchor && /^(blob:|data:)/.test(anchor.href) && !event.defaultPrevented) {
        event.preventDefault();
        void captureSave(w, anchor, blobs, () => click.call(anchor));
      }
    }, true);
    return true;
  }

  async function captureSave(w, anchor, blobs, download) {
    let blob = blobs.get(anchor.href) || null;
    if (!blob) {
      try {
        blob = await (await w.fetch(anchor.href)).blob();
      } catch {
        return download();
      }
    }
    const name = anchor.getAttribute("download") || anchor.download || "untitled";
    if (blob.size > MAX_SAVE) {
      port.postMessage({ type: "save-too-big", name, size: blob.size });
      return download();
    }
    const bytes = await blob.arrayBuffer();
    port.postMessage({ type: "save", name, mime: blob.type || "", bytes }, [bytes]);
  }

  // The app's focused element when it asked for a file: focus goes back there afterwards (Smart Knife's chooser took
  // it), so the app's next shortcut (Ctrl+S) reaches it.
  function requestOpen(input) {
    const id = nextId++;
    const doc = input.ownerDocument;
    pending.set(id, { input, focused: doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : null });
    port.postMessage({ type: "open", id, accept: input.accept || "", multiple: Boolean(input.multiple) });
  }

  function refocus(entry) {
    const w = entry.input.ownerDocument.defaultView;
    setTimeout(() => {
      try {
        w.focus();
        if (entry.focused && typeof entry.focused.focus === "function") entry.focused.focus({ preventScroll: true });
      } catch { /* gone */ }
    }, 0);
  }

  function deliver(id, files) {
    const entry = pending.get(id);
    if (!entry || !Array.isArray(files)) return;
    pending.delete(id);
    const input = entry.input;
    const w = input.ownerDocument.defaultView;
    const transfer = new w.DataTransfer();
    for (const file of files.slice(0, input.multiple ? 50 : 1)) {
      if (!file || !(file.bytes instanceof ArrayBuffer)) continue;
      transfer.items.add(new w.File([file.bytes], String(file.name || "file").slice(0, 255), { type: String(file.mime || ""), lastModified: Number(file.lastModified) || Date.now() }));
    }
    input.files = transfer.files;
    input.dispatchEvent(new w.Event("input", { bubbles: true }));
    input.dispatchEvent(new w.Event("change", { bubbles: true }));
    refocus(entry);
  }

  function cancel(id) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    const w = entry.input.ownerDocument.defaultView;
    entry.input.dispatchEvent(new w.Event("cancel"));
    refocus(entry);
  }
})();
