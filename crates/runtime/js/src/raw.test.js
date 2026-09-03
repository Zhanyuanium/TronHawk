// Developer-mode raw plugin tests (runtime.unsafe): a raw plugin runs its `main`/`renderer` source
// in the host (main) process via `new Function` — full Node/Electron parity through ctx.raw — and
// bypasses the QuickJS sandbox entirely. These exercise src/index.js directly against a stub
// Electron host (same harness as index.test.js: `mock.module("electron")` intercepts the CJS
// require), so probes set by raw source land on the real host globalThis and are observable here.
//
// Run with `bun test` from crates/runtime/js (auto-discovers *.test.js).
const { describe, test, expect, beforeEach, afterEach, mock } = require("bun:test");
const { EventEmitter } = require("events");
const path = require("path");

// --- Stub Electron host ---
const electron = {
  __stubMarker: "electron-stub",
  BrowserWindow: {
    getAllWindows: () => [],
    fromId: () => null,
  },
  app: new EventEmitter(),
  protocol: {},
};
mock.module("electron", () => electron);

const runtime = require("./index.js");
const testing = runtime.__testing;
const { applyPlan } = runtime;

// --- Shared test state / helpers ---

let runtimeLogs = []; // [level, message]
let pluginLogs = []; // [pluginId, level, message]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, what, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error("timeout waiting for: " + what);
}

function pluginMessages(id, level, needle) {
  return pluginLogs.filter(
    ([pid, lvl, message]) =>
      pid === id && (level === undefined || lvl === level) && message.includes(needle),
  );
}

beforeEach(async () => {
  testing.reset();
  electron.app.removeAllListeners();
  runtimeLogs = [];
  pluginLogs = [];
  delete globalThis.__rawProbe;
  delete globalThis.__rawRendererProbe;
  delete globalThis.__rawDeactivated;
  runtime.start(electron.app, {
    runtimeLog: (level, message) => runtimeLogs.push([level, String(message)]),
    pluginLog: (pid, level, message) => pluginLogs.push([pid, level, String(message)]),
  });
  await sleep(0);
});

afterEach(() => {
  // Dispose any plugin a test left loaded (raw entries run their own deactivate closure), then
  // reset module state for the next test.
  for (const entry of [...testing.mainPlugins().values()]) {
    try {
      entry.deactivate();
    } catch (_e) {
      /* best effort */
    }
  }
  for (const entry of [...testing.rendererPlugins().values()]) {
    try {
      entry.deactivate();
    } catch (_e) {
      /* best effort */
    }
  }
  testing.reset();
  electron.app.removeAllListeners();
  delete globalThis.__rawProbe;
  delete globalThis.__rawRendererProbe;
  delete globalThis.__rawDeactivated;
});

// --- Fake webContents / window plumbing ---

let nextContentsId = 1;

function makeContents(overrides = {}) {
  const contents = new EventEmitter();
  contents.id = nextContentsId++;
  contents.getType = () => "window";
  let inserted = 0;
  contents.insertCSS =
    overrides.insertCSS || (async () => "css-key-" + contents.id + "-" + ++inserted);
  contents.removeInsertedCSS = overrides.removeInsertedCSS || (async () => {});
  contents.isDestroyed = overrides.isDestroyed || (() => false);
  contents.executeJavaScript = overrides.executeJavaScript || (async () => true);
  contents.__insertCount = () => inserted;
  return contents;
}

function createWindow(contents) {
  electron.app.emit("web-contents-created", null, contents);
}

function loadWindow(contents) {
  contents.emit("did-finish-load");
}

function planFor(revision, plugins) {
  return { revision, plugins };
}

// --- Raw plugin fixtures (executed in the HOST process via new Function) ---

// Probe runs at module load (before activate). It records the raw parity facts it can only observe
// from inside the host frame onto the real globalThis, where this test file can read them.
const RAW_MAIN_PROBE = `
globalThis.__rawProbe = {
  electronIdentity: ctx.raw.electron === require("electron"),
  nodeRequireIsFunction: typeof ctx.raw.node.require === "function",
  nodePathJoin: ctx.raw.node.require("path").join("a", "b"),
  nodeProcessIdentity: ctx.raw.node.process === process,
  directRequireIsFunction: typeof require === "function",
};
module.exports = {
  activate(ctx) {
    globalThis.__rawProbe.activateSawLogger =
      typeof ctx.logger.info === "function" &&
      typeof ctx.logger.warn === "function" &&
      typeof ctx.logger.error === "function";
    ctx.logger.info("raw-activate-ran");
  },
  deactivate(ctx) {
    ctx.logger.info("raw-deactivate-ran");
    globalThis.__rawDeactivated = (globalThis.__rawDeactivated || 0) + 1;
  },
};
`;

const RAW_THROWING_ACTIVATE = `
module.exports = {
  activate() {
    throw new Error("boom-raw-activate");
  },
};
`;

// A non-raw (sandboxed) main plugin used to prove the QuickJS frame exposes neither `ctx.raw` nor
// a `require` binding.
const SANDBOX_MAIN_PROBE = `
module.exports = {
  activate(ctx) {
    const absent =
      typeof ctx.raw === "undefined" && typeof require === "undefined";
    ctx.logger.info(absent ? "sandbox-has-no-raw-no-require" : "sandbox-unexpected-leak");
  },
};
`;

// ===========================================================================
// Raw parity: ctx.raw.electron / ctx.raw.node in the host frame
// ===========================================================================

describe("developer-mode raw plugins (runtime.unsafe)", () => {
  test(
    "raw main plugin runs in the host frame with real electron + node require/process parity",
    async () => {
      const id = "raw-main";
      applyPlan(planFor("raw-v1", [{ id, main: RAW_MAIN_PROBE, granted: ["runtime.unsafe"] }]));

      // Raw registration is synchronous: runRawPlugin executes the module and activates it before
      // applyPlan returns, so the entry is already live with no QuickJS round-trip.
      const entry = testing.mainPlugins().get(id);
      expect(entry).toBeDefined();
      expect(typeof entry.deactivate).toBe("function");

      const probe = globalThis.__rawProbe;
      expect(probe).toBeDefined();
      // ctx.raw.electron is the very module the host resolved for "electron".
      expect(probe.electronIdentity).toBe(true);
      // ctx.raw.node.require is a functioning host require (core modules resolve, per-platform sep).
      expect(probe.nodeRequireIsFunction).toBe(true);
      expect(probe.nodePathJoin).toBe(path.join("a", "b"));
      // ctx.raw.node.process is the host process.
      expect(probe.nodeProcessIdentity).toBe(true);
      // The source also got the direct require binding as a frame parameter (full parity).
      expect(probe.directRequireIsFunction).toBe(true);
      // activate(ctx) received a working logger.
      expect(probe.activateSawLogger).toBe(true);

      expect(pluginMessages(id, "info", "raw-activate-ran")).toHaveLength(1);
      expect(pluginMessages(id, "info", "Raw plugin loaded (developer mode)")).toHaveLength(1);
      // No VM was created, so nothing was ever disposed.
      expect(testing.vmDisposeCount()).toBe(0);
      // The raw path must never have asked QuickJS for a module.
      expect(testing.quickJSGetCount()).toBe(0);
    },
    15000,
  );

  test(
    "a raw plugin whose activate throws logs 'raw plugin activate failed' and is NOT registered",
    async () => {
      const id = "raw-throw";
      applyPlan(
        planFor("raw-throw-v1", [{ id, main: RAW_THROWING_ACTIVATE, granted: ["runtime.unsafe"] }]),
      );

      expect(testing.mainPlugins().has(id)).toBe(false);
      expect(globalThis.__rawProbe).toBeUndefined();
      const errors = pluginMessages(id, "error", "raw plugin activate failed");
      expect(errors).toHaveLength(1);
      expect(errors[0][2]).toContain("boom-raw-activate");
      // Success log must NOT have fired for a failed activate.
      expect(pluginMessages(id, "info", "Raw plugin loaded (developer mode)")).toHaveLength(0);
    },
    15000,
  );

  test(
    "removing the runtime.unsafe grant in a new plan deactivates the raw plugin and drops it from the map",
    async () => {
      const id = "raw-revoke";
      applyPlan(planFor("raw-revoke-v1", [{ id, main: RAW_MAIN_PROBE, granted: ["runtime.unsafe"] }]));
      expect(testing.mainPlugins().has(id)).toBe(true);
      expect(globalThis.__rawDeactivated).toBeUndefined();

      // Same plugin object but the grant is gone (and no electron.window): the widened wanted
      // condition no longer matches, so reconcile revokes it via the stored deactivate closure.
      applyPlan(planFor("raw-revoke-v2", [{ id, main: RAW_MAIN_PROBE, granted: [] }]));

      expect(testing.mainPlugins().has(id)).toBe(false);
      expect(globalThis.__rawDeactivated).toBe(1);
      expect(pluginMessages(id, "info", "raw-deactivate-ran")).toHaveLength(1);
      expect(pluginMessages(id, "info", "Main plugin removed")).toHaveLength(1);
      expect(testing.vmDisposeCount()).toBe(0);

      // A stale second revoke of the same closure must not call guest deactivate again.
      applyPlan(planFor("raw-revoke-v3", []));
      expect(testing.mainPlugins().has(id)).toBe(false);
      expect(globalThis.__rawDeactivated).toBe(1);
    },
    15000,
  );

  test(
    "a raw renderer plugin is loaded per-window under the plugin@contents key and revoked with the plan",
    async () => {
      const pid = "raw-renderer";
      const contents = makeContents();
      applyPlan(planFor("rawr-v1", [
        { id: pid, renderer: RAW_MAIN_PROBE, granted: ["runtime.unsafe"] },
      ]));
      createWindow(contents);
      loadWindow(contents);

      const key = pid + "@" + contents.id;
      // Renderer raw registration is synchronous with the did-finish-load reconcile.
      expect(testing.rendererPlugins().has(key)).toBe(true);
      const probe = globalThis.__rawProbe;
      expect(probe).toBeDefined();
      expect(probe.electronIdentity).toBe(true);
      expect(probe.nodePathJoin).toBe(path.join("a", "b"));
      expect(probe.nodeProcessIdentity).toBe(true);
      expect(pluginMessages(pid, "info", "raw-activate-ran")).toHaveLength(1);
      expect(pluginMessages(pid, "info", "Raw plugin loaded (developer mode)")).toHaveLength(1);
      expect(testing.vmDisposeCount()).toBe(0);
      expect(testing.quickJSGetCount()).toBe(0);

      applyPlan(planFor("rawr-v2", []));
      expect(testing.rendererPlugins().has(key)).toBe(false);
      expect(testing.vmDisposeCount()).toBe(0);
    },
    15000,
  );

  test(
    "a non-raw plugin still runs in QuickJS where ctx.raw and require are undefined (sandbox untouched)",
    async () => {
      const id = "sandboxed";
      applyPlan(planFor("sb-v1", [{ id, main: SANDBOX_MAIN_PROBE, granted: ["electron.window"] }]));
      await waitFor(() => testing.mainPlugins().has(id), "sandboxed main plugin loaded");

      // The QuickJS frame offers neither ctx.raw (dev-mode surface) nor a require binding.
      expect(pluginMessages(id, "info", "sandbox-has-no-raw-no-require")).toHaveLength(1);
      expect(pluginMessages(id, "info", "sandbox-unexpected-leak")).toHaveLength(0);
      // The sandboxed loader is the one that reports the regular loaded message and used QuickJS.
      expect(pluginMessages(id, "info", "Main plugin loaded")).toHaveLength(1);
      expect(pluginMessages(id, "info", "Raw plugin loaded (developer mode)")).toHaveLength(0);
      expect(testing.quickJSGetCount()).toBeGreaterThan(0);
    },
    20000,
  );
});
