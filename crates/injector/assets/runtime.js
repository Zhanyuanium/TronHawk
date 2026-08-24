// TronHawk Runtime (main-process side) — executes the plugin execution plan.
// Provides gated APIs and bridges to Electron (docs/AGENTS.md: Runtime layer).
//
// Phase 2: CSS injection via `webContents.insertCSS` (data, never executed as JS), with
// hot reload (re-inject into already-loaded windows when the plugin's CSS changes).
// Renderer JS execution (`renderer.script` / `renderer.dom`) lands in a later phase with a
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
const windows = new Map(); // webContents.id -> { contents, cssKey }

function hasPermission(plugin, perm) {
  return Array.isArray(plugin.permissions) && plugin.permissions.includes(perm);
}

function inject(contents) {
  const plugin = currentPlugin;
  if (!plugin || !plugin.css) return;
  if (!hasPermission(plugin, "renderer.css")) {
    log("refusing CSS injection: plugin lacks `renderer.css`");
    return;
  }
  const prev = windows.get(contents.id);
  const doInsert = () =>
    contents
      .insertCSS(plugin.css)
      .then((key) => {
        windows.set(contents.id, { contents, cssKey: key });
        log("css injected for " + plugin.id);
      })
      .catch((e) => log("insertCSS failed: " + (e && e.message ? e.message : e)));

  if (prev && prev.cssKey) {
    contents
      .removeInsertedCSS(prev.cssKey)
      .catch(() => {})
      .then(doInsert);
  } else {
    doInsert();
  }
}

function start(app) {
  app.on("web-contents-created", (_e, contents) => {
    // Only target the app's main windows, not DevTools / webviews / background pages.
    if (contents.getType() !== "window") {
      return;
    }
    let attempts = 0;
    const tryInject = () => {
      if (!currentPlugin || !currentPlugin.css) {
        if (attempts < 20) {
          attempts += 1;
          setTimeout(tryInject, 500);
        }
        return;
      }
      inject(contents);
    };
    contents.on("did-finish-load", tryInject);
  });
}

function setPlugin(plugin) {
  const cssChanged = !currentPlugin || currentPlugin.css !== plugin.css;
  currentPlugin = plugin;
  if (cssChanged) {
    // Hot reload: re-inject into every already-loaded window.
    for (const w of windows.values()) {
      inject(w.contents);
    }
  }
}

module.exports = { start, setPlugin };
