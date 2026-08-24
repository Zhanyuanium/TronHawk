// TronHawk Runtime (main-process side) — executes the plugin execution plan.
// Provides gated APIs and bridges to Electron (docs/AGENTS.md: Runtime layer).
//
// Phase 1 MVP: CSS injection only, via `webContents.insertCSS` (data, never executed as JS).
// Renderer JS execution (`renderer.script` / `renderer.dom`) lands in Phase 2 with a
// restricted realm/sandbox.
const path = require("path");
const fs = require("fs");
const os = require("os");

const LOG = path.join(os.tmpdir(), "tronhawk-runtime.log");
function log(msg) {
  console.log("[tronhawk-runtime] " + msg);
  fs.appendFileSync(LOG, msg + "\n");
}

let currentPlugin = null;

function hasPermission(plugin, perm) {
  return Array.isArray(plugin.permissions) && plugin.permissions.includes(perm);
}

function setPlugin(plugin) {
  currentPlugin = plugin;
}

function start(app) {
  app.on("web-contents-created", (_e, contents) => {
    // Only target the app's main windows, not DevTools / webviews / background pages.
    if (contents.getType() !== "window") {
      return;
    }

    let attempts = 0;
    const inject = () => {
      const plugin = currentPlugin;
      if (!plugin || !plugin.css) {
        if (attempts < 20) {
          attempts += 1;
          setTimeout(inject, 500);
        }
        return;
      }
      if (!hasPermission(plugin, "renderer.css")) {
        log("refusing CSS injection: plugin lacks `renderer.css`");
        return;
      }
      contents
        .insertCSS(plugin.css)
        .then(() => log("css injected for " + plugin.id))
        .catch((e) => log("insertCSS failed: " + (e && e.message ? e.message : e)));
    };

    contents.on("did-finish-load", inject);
  });
}

module.exports = { start, setPlugin };
