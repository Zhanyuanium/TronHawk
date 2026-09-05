// electron-require-shim — trusted runtime substrate (ADR 0009).
//
// Why: `require("electron").BrowserWindow` is a configurable:false, getter-only accessor, so
// `require("electron").BrowserWindow = X` silently no-ops (ADR 0009 fact 3). To rewrite a target
// app's window-construction options BEFORE the real BrowserWindow constructor runs, we cannot
// replace the electron property; instead we intercept the module-resolution seam and hand out a
// Proxy facade whose `BrowserWindow` getter returns a wrapping constructor.
//
// Mechanism: wrap Node's `require("module")._load`. When the requested module id is exactly
// "electron", return the cached facade; otherwise delegate to the original _load unchanged. The
// facade forwards every property access except `BrowserWindow` to the real electron exports, so
// app/protocol/ipcMain/etc. keep identity, and `electron.BrowserWindow = x` behaves exactly as
// before (sloppy no-op / strict TypeError).
//
// Status: trusted core substrate bundled into runtime.js — never loaded from disk in the target,
// never .thx-installable, never a plugin. Fail-open: must never crash the target.
//
// Installed ONLY when a selected adapter declares onWindowOptions (see src/index.js). The `_load`
// hook is installed once per process (idempotent) and only intercepts the "electron" builtin.

// Build a Proxy facade over `realElectron`. The `BrowserWindow` getter resolves through
// `getFacadeBrowserWindow()` exactly once and caches the result; every other property is
// delegated to `realElectron` via Reflect (preserving getters, prototype chain, descriptors).
function createElectronFacade(realElectron, getFacadeBrowserWindow) {
  let cachedBrowserWindow;
  return new Proxy(realElectron, {
    get(target, prop, receiver) {
      if (prop === "BrowserWindow") {
        if (cachedBrowserWindow === undefined) {
          cachedBrowserWindow = getFacadeBrowserWindow();
        }
        return cachedBrowserWindow;
      }
      return Reflect.get(target, prop, receiver);
    },
    set(target, prop, value, receiver) {
      return Reflect.set(target, prop, value, receiver);
    },
    has(target, prop) {
      return Reflect.has(target, prop);
    },
    ownKeys(target) {
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, prop) {
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
    getPrototypeOf(target) {
      return Reflect.getPrototypeOf(target);
    },
    setPrototypeOf(target, proto) {
      return Reflect.setPrototypeOf(target, proto);
    },
    isExtensible(target) {
      return Reflect.isExtensible(target);
    },
    preventExtensions(target) {
      return Reflect.preventExtensions(target);
    },
    defineProperty(target, prop, descriptor) {
      return Reflect.defineProperty(target, prop, descriptor);
    },
    deleteProperty(target, prop) {
      return Reflect.deleteProperty(target, prop);
    },
  });
}

// Module-scoped install state: exactly one wrap per process.
const MARK = "__tronhawk_electron_facade__";
let installState = null; // { originalLoad }

// Install the _load hook and return the facade. `getFacadeBrowserWindow` is called once (on the
// first read of electron.BrowserWindow) and must return the wrapping constructor. Idempotent: a
// second call returns the existing facade without re-wrapping. Returns null on failure (caller
// fail-opens).
function installElectronFacade(getFacadeBrowserWindow) {
  if (typeof getFacadeBrowserWindow !== "function") return null;
  let mod;
  try {
    mod = require("module");
  } catch (_e) {
    return null;
  }
  if (!mod || typeof mod._load !== "function") return null;

  if (installState) {
    return installState.facade;
  }

  const originalLoad = mod._load;
  const realElectron = require("electron");
  // Build the facade eagerly so a caller can use it immediately; getFacadeBrowserWindow is only
  // invoked when electron.BrowserWindow is first read through the facade.
  const facade = createElectronFacade(realElectron, getFacadeBrowserWindow);

  const wrappedLoad = function (request, parent, isMain) {
    if (request === "electron") {
      return facade;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  // Preserve static/metadata shape the loader normally carries.
  for (const k of Object.getOwnPropertyNames(originalLoad)) {
    if (k === "length" || k === "name" || k === "prototype") continue;
    try {
      if (!(k in wrappedLoad)) wrappedLoad[k] = originalLoad[k];
    } catch (_e) {
      /* non-writable — skip */
    }
  }
  Object.defineProperty(wrappedLoad, MARK, { value: true, configurable: false, enumerable: false });

  mod._load = wrappedLoad;
  installState = { originalLoad, facade };
  return facade;
}

// Undo the wrap (test-only): restore the original _load and clear install state. Best-effort.
function uninstallElectronFacade() {
  if (!installState) return;
  const mod = require("module");
  if (typeof mod._load === "function" && mod._load[MARK]) {
    mod._load = installState.originalLoad;
  }
  installState = null;
}

module.exports = { installElectronFacade, uninstallElectronFacade, createElectronFacade };
