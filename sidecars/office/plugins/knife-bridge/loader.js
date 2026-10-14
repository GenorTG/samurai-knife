/*
 * Minimal plugin loader for the Euro-Office / ONLYOFFICE plugin protocol (what the hosted `sdkjs-plugins/v1/plugins.js`
 * does, reduced to a background plugin): read our guid from config.json, tell the editor frame we are here
 * ("initialize"), then evaluate the plugin runtime the editor sends back ("plugin_init", the `Asc.plugin` API with
 * callCommand/executeMethod). The image ships no copy of plugins.js and a plugin must not load code from the internet,
 * so the loader lives here. Verified against sdkjs 9.3.5 (word/sdk-all.js: onMessage "initialize" -> "plugin_init").
 */
(function (window) {
  "use strict";
  var Asc = (window.Asc = window.Asc || {});
  Asc.plugin = Asc.plugin || {};
  Asc.scope = Asc.scope || {};
  Asc.supportOrigins = {};
  Asc.supportOrigins[window.origin] = true;

  function onMessage(event) {
    if (window.plugin_onMessage) {
      // Runtime installed: only the editor frame (same origin as this plugin) may drive it.
      if (Asc.supportOrigins[event.origin]) window.plugin_onMessage(event);
      return;
    }
    if (!Asc.plugin._initInternal || typeof event.data !== "string" || event.source !== window.parent) return;
    var data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!data || data.type !== "plugin_init" || event.origin !== window.origin) return;
    Asc.supportOrigins[event.origin] = true;
    // The editor's own plugin runtime (same origin, the frame that hosts us); this is how every plugin gets it.
    (0, eval)(data.data);
  }

  window.addEventListener("message", onMessage, false);

  window.addEventListener("load", function () {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", "./config.json", true);
    xhr.responseType = "json";
    xhr.onload = function () {
      if (xhr.status !== 200) return;
      var config = typeof xhr.response === "string" ? JSON.parse(xhr.response) : xhr.response;
      Asc.plugin.guid = config.guid;
      Asc.plugin.version = config.version;
      Asc.plugin._initInternal = true;
      window.parent.postMessage(JSON.stringify({ type: "initialize", guid: Asc.plugin.guid }), "*");
    };
    xhr.send();
  });
})(window);
