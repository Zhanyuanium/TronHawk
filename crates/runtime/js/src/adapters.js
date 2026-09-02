// TronHawk Runtime — compat adapter generic interface (Phase A).
//
// Adapters are curated, trusted runtime substrate statically bundled into runtime.js. They are
// NOT sandboxed plugins: they can never be loaded from disk in the target nor installed via
// .thx. The generic interface is intentionally minimal for Phase A:
//     matches(appInfo)  -> truthy/falsy   (required; a throw is treated as no-match)
//     onBootstrap(ctx)  -> void           (optional)
//
// The loader is invoked synchronously inside start() (src/index.js), which happens BEFORE
// bootstrap.js requires the original target app — so adapter onBootstrap runs before the
// original app loads and can hook protocol.handle there in Phase B.
//
// Everything here is fail-open: an adapter error is logged and the target continues. This module
// must stay importable with no electron side effects (no `require("electron")`) so it is
// testable in isolation under bun test.
const path = require("path");

const exampleAdapter = require("./adapters/example");
const obsidianAdapter = require("./adapters/obsidian");

// Registry order matters: the first adapter whose matches() returns truthy wins. obsidian is
// registered AFTER example so the test-app's `example` still wins for the TronHawk test app.
const ADAPTERS = [exampleAdapter, obsidianAdapter];

// Host logger, shape log(level, message). Wired by the runtime via init(); defaults to console
// so any use before wiring (e.g. bun test) still surfaces warnings/errors.
let logger = (level, message) =>
  console.log("[tronhawk-adapter][" + level + "] " + message);

// Wire the host logger. `log` has the (level, message) shape — the same shape as the runtime's
// runtimeLog sink. Keep it simple and consistent with index.js's sink handling.
function init(sinks = {}) {
  if (typeof sinks.log === "function") logger = sinks.log;
}

function errorMessage(error) {
  return error && error.message ? error.message : String(error);
}

function adapterName(adapter) {
  if (adapter && typeof adapter.id === "string") return adapter.id;
  return "<anonymous adapter>";
}

// Build AppInfo from an Electron `app` object, tolerantly — never throws. Every field degrades
// to undefined rather than faulting the target.
function buildAppInfo(app) {
  const info = {
    name: undefined,
    appPath: undefined,
    packageJsonName: undefined,
    exeBasename: path.basename(process.execPath),
    electronVersion: process.versions.electron,
  };
  try {
    if (app && typeof app.getName === "function") info.name = app.getName();
    if (app && typeof app.getAppPath === "function") info.appPath = app.getAppPath();
    if (typeof info.appPath === "string" && info.appPath) {
      try {
        // Best-effort read of <appPath>/package.json .name. The file may be missing or
        // unreadable; that is not an error — packageJsonName just stays undefined.
        const pkg = require(path.join(info.appPath, "package.json"));
        if (pkg && typeof pkg.name === "string") info.packageJsonName = pkg.name;
      } catch (_e) {
        // No package.json (or unreadable): leave packageJsonName undefined.
      }
    }
  } catch (_e) {
    // app.getName()/getAppPath() threw (e.g. before the app is ready): keep undefined fields.
  }
  return info;
}

// Iterate the registry in order; return the first adapter whose matches(appInfo) is truthy.
// A throwing matches() is treated as a no-match (logged) so one bad adapter cannot fail the
// whole selection. Returns null when nothing matches. `adapters` defaults to the module
// registry; the parameter is a pure-function seam for ordering tests.
function select(appInfo, adapters = ADAPTERS) {
  for (const adapter of adapters) {
    let matched = false;
    try {
      matched = !!(adapter && typeof adapter.matches === "function" && adapter.matches(appInfo));
    } catch (e) {
      logger(
        "warn",
        adapterName(adapter) + " matches() threw; treating as no match: " + errorMessage(e),
      );
      matched = false;
    }
    if (matched) return adapter;
  }
  return null;
}

// Call adapter.onBootstrap(ctx) if present. If it throws, log the error and CONTINUE — fail-open:
// an adapter must never crash the target.
function runOnBootstrap(adapter, ctx) {
  if (!adapter || typeof adapter.onBootstrap !== "function") return;
  try {
    adapter.onBootstrap(ctx);
  } catch (e) {
    logger(
      "error",
      adapterName(adapter) + " onBootstrap threw; continuing: " + errorMessage(e),
    );
  }
}

module.exports = { init, buildAppInfo, select, runOnBootstrap };
