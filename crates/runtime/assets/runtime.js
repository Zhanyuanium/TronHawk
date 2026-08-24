// TronHawk Runtime (main-process side) — executes the plugin execution plan.
// Provides gated APIs and bridges to Electron (docs/AGENTS.md: Runtime layer).
//
// Phase 2: CSS injection via `webContents.insertCSS` (data, never executed as JS), with a
// multi-plugin, revision-based state machine supporting hot reload, plugin removal, and
// permission revocation. A per-(window,plugin) generation token makes async CSS operations
// revoke-safe (a pending insert that resolves after a revoke is discarded).
// Renderer JS execution (`renderer.script`/`renderer.dom`) lands in a later phase with a
// QuickJS sandbox (docs/adr/0002-renderer-js-sandbox.md).
const path = require("path");
const fs = require("fs");
const os = require("os");

const LOG = path.join(os.tmpdir(), "tronhawk-runtime.log");
const MAX_LOG = 256 * 1024;
function log(msg) {
  console.log("[tronhawk-runtime] " + msg);
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > MAX_LOG) {
      fs.truncateSync(LOG, 0);
    }
    fs.appendFileSync(LOG, msg + "\n");
  } catch (e) {
    /* best-effort logging */
  }
}

let currentPlan = { revision: "", plugins: [] };
// webContents.id -> { contents, keys: Map(pluginId -> { css, key }), gens: Map(pluginId -> n) }
const windows = new Map();

function hasPermission(granted, perm) {
  return Array.isArray(granted) && granted.includes(perm);
}

// Inject (or re-inject) a plugin's CSS into a window. The generation token makes the
// result revoke-safe: if the plan changed while insertCSS was pending, the key is removed.
function inject(w, pid, css) {
  const gen = (w.gens.get(pid) || 0) + 1;
  w.gens.set(pid, gen);

  const old = w.keys.get(pid);
  w.keys.delete(pid);
  const removeOld = old
    ? w.contents.removeInsertedCSS(old.key).catch(() => {})
    : Promise.resolve();

  removeOld
    .then(() => w.contents.insertCSS(css))
    .then((key) => {
      if (w.gens.get(pid) !== gen) {
        // Stale: the plan changed while this insert was pending — discard it.
        w.contents.removeInsertedCSS(key).catch(() => {});
        return;
      }
      w.keys.set(pid, { css, key });
      log("css injected for " + pid);
    })
    .catch((e) => log("insertCSS failed for " + pid + ": " + (e && e.message ? e.message : e)));
}

// Reconcile one window against the current plan.
function reconcile(w) {
  const wanted = new Map(); // pluginId -> { css }
  for (const p of currentPlan.plugins) {
    if (p.css && hasPermission(p.granted, "renderer.css")) {
      wanted.set(p.id, { css: p.css });
    }
  }

  for (const [pid, want] of wanted) {
    const entry = w.keys.get(pid);
    if (!entry || entry.css !== want.css) {
      inject(w, pid, want.css);
    }
  }

  for (const [pid, entry] of w.keys) {
    if (!wanted.has(pid)) {
      // Invalidate any pending insert + remove the settled key.
      w.gens.set(pid, (w.gens.get(pid) || 0) + 1);
      w.keys.delete(pid);
      w.contents.removeInsertedCSS(entry.key).catch(() => {});
      log("css removed for " + pid);
    }
  }
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
    const w = { contents, keys: new Map(), gens: new Map() };
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
