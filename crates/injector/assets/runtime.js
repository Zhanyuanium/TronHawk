// TronHawk Runtime (main-process side) — executes the plugin execution plan.
// Provides gated APIs and bridges to Electron (docs/AGENTS.md: Runtime layer).
//
// Phase 2: CSS injection via `webContents.insertCSS` (data, never executed as JS), with a
// multi-plugin, revision-based state machine supporting hot reload, plugin removal, and
// permission revocation. Renderer JS execution (`renderer.script`/`renderer.dom`) lands in a
// later phase with a QuickJS sandbox (docs/adr/0002-renderer-js-sandbox.md).
const path = require("path");
const fs = require("fs");
const os = require("os");

const LOG = path.join(os.tmpdir(), "tronhawk-runtime.log");
function log(msg) {
  console.log("[tronhawk-runtime] " + msg);
  fs.appendFileSync(LOG, msg + "\n");
}

let currentPlan = { revision: "", plugins: [] };
// webContents.id -> { contents, keys: Map(pluginId -> { css, key }) }
const windows = new Map();

function hasPermission(granted, perm) {
  return Array.isArray(granted) && granted.includes(perm);
}

// Reconcile one window against the current plan: inject wanted CSS, remove stale CSS.
function reconcile(w) {
  const wanted = new Map(); // pluginId -> { css }
  for (const p of currentPlan.plugins) {
    if (p.css && hasPermission(p.granted, "renderer.css")) {
      wanted.set(p.id, { css: p.css });
    }
  }

  // Inject or re-inject wanted plugins.
  for (const [pid, want] of wanted) {
    const entry = w.keys.get(pid);
    if (!entry) {
      inject(w, pid, want.css);
    } else if (entry.css !== want.css) {
      w.keys.delete(pid);
      w.contents
        .removeInsertedCSS(entry.key)
        .catch(() => {})
        .then(() => inject(w, pid, want.css));
    }
    // else: unchanged — leave it.
  }

  // Remove keys for plugins no longer wanted.
  for (const [pid, entry] of w.keys) {
    if (!wanted.has(pid)) {
      w.keys.delete(pid);
      w.contents.removeInsertedCSS(entry.key).catch(() => {});
      log("css removed for " + pid);
    }
  }
}

function inject(w, pid, css) {
  w.contents
    .insertCSS(css)
    .then((key) => {
      w.keys.set(pid, { css, key });
      log("css injected for " + pid);
    })
    .catch((e) => log("insertCSS failed for " + pid + ": " + (e && e.message ? e.message : e)));
}

function applyPlan(plan) {
  if (!plan || plan.revision === currentPlan.revision) {
    return;
  }
  currentPlan = plan;
  for (const w of windows.values()) {
    reconcile(w);
  }
}

function start(app) {
  app.on("web-contents-created", (_e, contents) => {
    if (contents.getType() !== "window") {
      return;
    }
    const w = { contents, keys: new Map() };
    windows.set(contents.id, w);
    contents.on("destroyed", () => {
      windows.delete(contents.id);
    });
    contents.on("did-finish-load", () => {
      reconcile(w);
    });
  });
}

module.exports = { start, applyPlan };
