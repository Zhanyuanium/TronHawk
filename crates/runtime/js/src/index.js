// TronHawk Runtime (main-process side) — executes the plugin execution plan.
// Provides gated APIs and bridges to Electron (docs/AGENTS.md: Runtime layer).
//
// Phase 2: CSS injection via `webContents.insertCSS` (data, never executed as JS), with a
// multi-plugin, revision-based state machine supporting hot reload, removal, and revocation.
// Phase 3: main-process plugin JS runs in an embedded QuickJS sandbox (no DOM/network/Node),
// reaching Electron only through permission-gated host functions
// (docs/adr/0002-renderer-js-sandbox.md).
const path = require("path");
const fs = require("fs");
const os = require("os");
const { BrowserWindow } = require("electron");

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
let appRef = null;

function hasPermission(granted, perm) {
  return Array.isArray(granted) && granted.includes(perm);
}

// --- CSS injection ---

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
        w.contents.removeInsertedCSS(key).catch(() => {});
        return;
      }
      w.keys.set(pid, { css, key });
      log("css injected for " + pid);
    })
    .catch((e) => log("insertCSS failed for " + pid + ": " + (e && e.message ? e.message : e)));
}

function reconcile(w) {
  const wanted = new Map();
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

  const allIds = new Set([...w.keys.keys(), ...w.gens.keys()]);
  for (const pid of allIds) {
    if (!wanted.has(pid)) {
      w.gens.set(pid, (w.gens.get(pid) || 0) + 1);
      const entry = w.keys.get(pid);
      if (entry) {
        w.keys.delete(pid);
        w.contents.removeInsertedCSS(entry.key).catch(() => {});
        log("css removed for " + pid);
      }
    }
  }
}

// --- Main-plugin QuickJS sandbox ---

const { newQuickJSWASMModuleFromVariant } = require("quickjs-emscripten-core");
const variantModule = require("@jitl/quickjs-singlefile-cjs-release-sync");
const RELEASE_SYNC = variantModule.default || variantModule;

let QuickJSPromise = null;
function getQuickJS() {
  if (!QuickJSPromise) {
    QuickJSPromise = newQuickJSWASMModuleFromVariant(RELEASE_SYNC);
  }
  return QuickJSPromise;
}

// pluginId -> { vm, deactivate }
const mainPlugins = new Map();
// `${pluginId}@${webContentsId}` -> { vm, deactivate }
const rendererPlugins = new Map();

function buildWindowApi(vm, app) {
  const win = vm.newObject();

  const onCreated = vm.newFunction("onCreated", (cbHandle) => {
    // Fire for windows created after registration.
    app.on("browser-window-created", (_e, w) => {
      const id = vm.newNumber(w.id);
      const r = vm.callFunction(cbHandle, vm.undefined, id);
      r.dispose();
      id.dispose();
    });
    // Also fire for windows that already exist (the QuickJS sandbox loads async and can
    // miss the first window).
    for (const w of BrowserWindow.getAllWindows()) {
      const id = vm.newNumber(w.id);
      const r = vm.callFunction(cbHandle, vm.undefined, id);
      r.dispose();
      id.dispose();
    }
    return vm.undefined;
  });
  vm.setProp(win, "onCreated", onCreated);
  onCreated.dispose();

  const setOpacity = vm.newFunction("setOpacity", (winHandle, nHandle) => {
    const id = vm.getNumber(winHandle);
    const n = vm.getNumber(nHandle);
    const w = BrowserWindow.fromId(id);
    if (w) {
      w.setOpacity(n);
      log("window setOpacity: window=" + id + " opacity=" + n);
    }
    return vm.undefined;
  });
  vm.setProp(win, "setOpacity", setOpacity);
  setOpacity.dispose();

  const setSize = vm.newFunction("setSize", (winHandle, wHandle, hHandle) => {
    const id = vm.getNumber(winHandle);
    const w = BrowserWindow.fromId(id);
    if (w) w.setSize(vm.getNumber(wHandle), vm.getNumber(hHandle));
    return vm.undefined;
  });
  vm.setProp(win, "setSize", setSize);
  setSize.dispose();

  const setPosition = vm.newFunction("setPosition", (winHandle, xHandle, yHandle) => {
    const id = vm.getNumber(winHandle);
    const w = BrowserWindow.fromId(id);
    if (w) w.setPosition(vm.getNumber(xHandle), vm.getNumber(yHandle));
    return vm.undefined;
  });
  vm.setProp(win, "setPosition", setPosition);
  setPosition.dispose();

  return win;
}

function runMainPlugin(plugin, app) {
  getQuickJS().then((QuickJS) => {
    const vm = QuickJS.newContext();
    vm.runtime.setMemoryLimit(64 * 1024 * 1024);
    vm.runtime.setMaxStackSize(1024 * 512);

    const ctx = vm.newObject();
    if (hasPermission(plugin.granted, "electron.window")) {
      const win = buildWindowApi(vm, app);
      vm.setProp(ctx, "window", win);
      win.dispose();
    }
    vm.setProp(vm.global, "ctx", ctx);
    ctx.dispose();

    // CommonJS-style module scaffolding so the plugin can `module.exports = {...}`.
    const moduleObj = vm.newObject();
    const exportsObj = vm.newObject();
    vm.setProp(moduleObj, "exports", exportsObj);
    vm.setProp(vm.global, "module", moduleObj);
    vm.setProp(vm.global, "exports", exportsObj);
    moduleObj.dispose();

    const result = vm.evalCode(plugin.main || "");
    if (result.error) {
      const err = vm.dump(result.error);
      result.error.dispose();
      log("main plugin eval error (" + plugin.id + "): " + err);
      vm.dispose();
      return;
    }
    result.value.dispose();

    // Call module.exports.activate(ctx) if present. Read `module.exports` (not the stale
    // `global.exports`) because the plugin assigns `module.exports = {...}`.
    const moduleHandle = vm.getProp(vm.global, "module");
    const exportsHandle = vm.getProp(moduleHandle, "exports");
    const activate = vm.getProp(exportsHandle, "activate");
    const ctxHandle = vm.getProp(vm.global, "ctx");
    if (vm.typeof(activate) === "function") {
      const r = vm.callFunction(activate, exportsHandle, ctxHandle);
      r.dispose();
    }
    activate.dispose();
    ctxHandle.dispose();
    exportsHandle.dispose();
    moduleHandle.dispose();

    // Store the vm for later deactivate/disposal.
    const deactivate = () => {
      try {
        vm.dispose();
      } catch (e) {
        /* ignore */
      }
    };
    mainPlugins.set(plugin.id, { vm, deactivate });
    log("main plugin loaded: " + plugin.id);
  }).catch((e) => log("QuickJS init failed: " + (e && e.message ? e.message : e)));
}

// --- Renderer-plugin sandbox (runs per window on did-finish-load) ---

function runRendererPlugin(plugin, contents) {
  getQuickJS().then((QuickJS) => {
    const vm = QuickJS.newContext();
    vm.runtime.setMemoryLimit(64 * 1024 * 1024);
    vm.runtime.setMaxStackSize(1024 * 512);

    const ctx = vm.newObject();
    if (hasPermission(plugin.granted, "renderer.script")) {
      const script = vm.newObject();
      const execute = vm.newFunction("execute", (codeHandle) => {
        const code = vm.getString(codeHandle);
        // Fire-and-forget: run in the target window's renderer (main world), then read back
        // the title to confirm execution.
        contents
          .executeJavaScript(code)
          .then(() => contents.executeJavaScript("document.title"))
          .then((title) => log("script.execute ran; title=" + title))
          .catch((e) => log("script.execute failed: " + (e && e.message ? e.message : e)));
        return vm.undefined;
      });
      vm.setProp(script, "execute", execute);
      execute.dispose();
      vm.setProp(ctx, "script", script);
      script.dispose();
    }
    // (ctx.dom.query / ctx.dom.observe need async host functions — future.)
    vm.setProp(vm.global, "ctx", ctx);
    ctx.dispose();

    const moduleObj = vm.newObject();
    const exportsObj = vm.newObject();
    vm.setProp(moduleObj, "exports", exportsObj);
    vm.setProp(vm.global, "module", moduleObj);
    vm.setProp(vm.global, "exports", exportsObj);
    moduleObj.dispose();

    const result = vm.evalCode(plugin.renderer || "");
    if (result.error) {
      const err = vm.dump(result.error);
      result.error.dispose();
      log("renderer plugin eval error (" + plugin.id + "): " + err);
      vm.dispose();
      return;
    }
    result.value.dispose();

    const moduleHandle = vm.getProp(vm.global, "module");
    const exportsHandle = vm.getProp(moduleHandle, "exports");
    const activate = vm.getProp(exportsHandle, "activate");
    const ctxHandle = vm.getProp(vm.global, "ctx");
    if (vm.typeof(activate) === "function") {
      const r = vm.callFunction(activate, exportsHandle, ctxHandle);
      r.dispose();
    }
    activate.dispose();
    ctxHandle.dispose();
    exportsHandle.dispose();
    moduleHandle.dispose();

    const key = plugin.id + "@" + contents.id;
    rendererPlugins.set(key, {
      vm,
      deactivate: () => {
        try {
          vm.dispose();
        } catch (e) {
          /* ignore */
        }
      },
    });
    log("renderer plugin loaded: " + plugin.id);
  }).catch((e) => log("QuickJS init failed: " + (e && e.message ? e.message : e)));
}

function rendererPluginsForWindow(contents) {
  for (const p of currentPlan.plugins) {
    if (p.renderer && hasPermission(p.granted, "renderer.script")) {
      runRendererPlugin(p, contents);
    }
  }
}

function cleanupRendererPlugins(contentsId) {
  for (const [key, entry] of rendererPlugins) {
    if (key.endsWith("@" + contentsId)) {
      rendererPlugins.delete(key);
      entry.deactivate();
    }
  }
}

function reconcileMainPlugins(app) {
  const wanted = new Set();
  for (const p of currentPlan.plugins) {
    if (p.main && hasPermission(p.granted, "electron.window")) {
      wanted.add(p.id);
      if (!mainPlugins.has(p.id)) {
        runMainPlugin(p, app);
      }
    }
  }
  for (const [pid, entry] of mainPlugins) {
    if (!wanted.has(pid)) {
      mainPlugins.delete(pid);
      entry.deactivate();
      log("main plugin removed: " + pid);
    }
  }
}

// --- plan application ---

function applyPlan(plan) {
  if (!plan || plan.revision === currentPlan.revision) {
    return;
  }
  currentPlan = plan;
  for (const w of windows.values()) {
    reconcile(w);
  }
  reconcileMainPlugins(appRef);
}

function start(app) {
  appRef = app;
  app.on("web-contents-created", (_e, contents) => {
    if (contents.getType() !== "window") {
      return;
    }
    const w = { contents, keys: new Map(), gens: new Map() };
    windows.set(contents.id, w);
    contents.on("destroyed", () => {
      windows.delete(contents.id);
      cleanupRendererPlugins(contents.id);
    });
    contents.on("did-finish-load", () => {
      reconcile(w);
      rendererPluginsForWindow(contents);
    });
  });
}

module.exports = { start, applyPlan };
