// Tier-1 runtime feature tests: window glass host functions (ctx.window.setVibrancy/setMica) and
// the SPEC §9 MVP lifecycle events (ctx.onLoad/onRendererReady/onUnload).
//
// These exercise src/index.js directly against a stub Electron host — `mock.module("electron")`
// intercepts the CJS `require("electron")` — with real QuickJS sandboxes, the same harness pattern
// as index.test.js/raw.test.js. The __testing seam adds `setPlatform` so macOS/Windows-only host
// functions can be exercised on any host; `reset()` restores the real host platform.
//
// Run with `bun test` from crates/runtime/js (auto-discovers *.test.js).
const { describe, test, expect, beforeEach, afterEach, mock } = require("bun:test");
const { EventEmitter } = require("events");

// --- Stub Electron host ---
// BrowserWindow.fromId is bound to the live `fakeWindows` map so tests can register/unregister
// fake browser windows per scenario. Instance methods (setVibrancy/setBackgroundMaterial) record
// their calls for assertions; options let a test omit an API to exercise the "absent" branches.
let fakeWindows = new Map();
function createFakeWindow(id, options = {}) {
  const win = { id, calls: [] };
  win.setOpacity = (value) => win.calls.push(["setOpacity", value]);
  win.setVibrancy = (material) => win.calls.push(["setVibrancy", material]);
  win.setBackgroundMaterial = (material) => win.calls.push(["setBackgroundMaterial", material]);
  if (options.omitVibrancy) delete win.setVibrancy;
  if (options.omitBackgroundMaterial) delete win.setBackgroundMaterial;
  return win;
}

const electron = {
  BrowserWindow: {
    getAllWindows: () => [...fakeWindows.values()],
    fromId: (id) => fakeWindows.get(id) || null,
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
  fakeWindows = new Map();
  nextContentsId = 1;
  // `bun test` shares one module registry across files, so index.js captured whichever file's
  // "electron" stub loaded first. Route window-handle resolution through the __testing seam so
  // setVibrancy/setMica see this file's fake window map regardless of load order.
  testing.setWindowResolver((id) => fakeWindows.get(id) || null);
  runtimeLogs = [];
  pluginLogs = [];
  runtime.start(electron.app, {
    runtimeLog: (level, message) => runtimeLogs.push([level, String(message)]),
    pluginLog: (pid, level, message) => pluginLogs.push([pid, level, String(message)]),
  });
  await sleep(0);
});

afterEach(() => {
  // Dispose any plugin a test left loaded, then reset module state for the next test.
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

// --- Plugin fixtures (run inside the real QuickJS sandbox) ---

// setVibrancy on a fixed window handle inside activate.
const VIBRANCY_FIXTURE = `
module.exports = {
  activate(ctx) {
    ctx.window.setVibrancy(42, "sidebar");
  },
};
`;

// setMica with both true (mica) and false (none) on two window handles.
const MICA_FIXTURE = `
module.exports = {
  activate(ctx) {
    ctx.window.setMica(42, true);
    ctx.window.setMica(43, false);
  },
};
`;

const VIBRANCY_MICA_NOP_FIXTURE = `
module.exports = {
  activate(ctx) {
    ctx.window.setVibrancy(42, "sidebar");
    ctx.window.setMica(42, true);
  },
};
`;

const GLASS_API_PROBE_FIXTURE = `
module.exports = {
  activate(ctx) {
    const present =
      typeof ctx.window === "object" &&
      typeof ctx.window.setVibrancy === "function" &&
      typeof ctx.window.setMica === "function";
    ctx.logger.info(present ? "glass-apis-present" : "glass-apis-absent");
  },
};
`;

// ===========================================================================
// Feature 1 — ctx.window.setVibrancy / setMica
// ===========================================================================

describe("ctx.window.setVibrancy / setMica", () => {
  test(
    "setVibrancy on macOS calls BrowserWindow#setVibrancy with the material and logs success",
    async () => {
      const pid = "vib-mac";
      testing.setPlatform("darwin");
      const win = createFakeWindow(42);
      fakeWindows.set(42, win);

      applyPlan(planFor("vib-v1", [{ id: pid, main: VIBRANCY_FIXTURE, granted: ["electron.window"] }]));
      await waitFor(() => testing.mainPlugins().has(pid), "plugin loaded");

      // The activation ran the host function: the stub BrowserWindow recorded the call.
      expect(win.calls).toEqual([["setVibrancy", "sidebar"]]);
      // And the runtime logged the outcome at info level.
      expect(pluginMessages(pid, "info", "window.setVibrancy: window=42 material=sidebar")).toHaveLength(1);
    },
    15000,
  );

  test(
    "setMica on Windows maps enabled true/false to BrowserWindow#setBackgroundMaterial('mica'/'none')",
    async () => {
      const pid = "mica-win";
      testing.setPlatform("win32");
      const win42 = createFakeWindow(42);
      const win43 = createFakeWindow(43);
      fakeWindows.set(42, win42);
      fakeWindows.set(43, win43);

      applyPlan(planFor("mica-v1", [{ id: pid, main: MICA_FIXTURE, granted: ["electron.window"] }]));
      await waitFor(() => testing.mainPlugins().has(pid), "plugin loaded");

      expect(win42.calls).toEqual([["setBackgroundMaterial", "mica"]]);
      expect(win43.calls).toEqual([["setBackgroundMaterial", "none"]]);
      expect(pluginMessages(pid, "info", "window.setMica: window=42 material=mica")).toHaveLength(1);
      expect(pluginMessages(pid, "info", "window.setMica: window=43 material=none")).toHaveLength(1);
    },
    15000,
  );

  test(
    "on a non-matching platform each call is a logged no-op, not a throw",
    async () => {
      const pid = "glass-nop";
      // Linux matches neither macOS (vibrancy) nor Windows (mica).
      testing.setPlatform("linux");
      const win = createFakeWindow(42);
      fakeWindows.set(42, win);

      applyPlan(planFor("nop-v1", [{ id: pid, main: VIBRANCY_MICA_NOP_FIXTURE, granted: ["electron.window"] }]));
      await waitFor(() => testing.mainPlugins().has(pid), "plugin loaded");

      // The plugin activated successfully: nothing threw across the bridge.
      expect(testing.mainPlugins().has(pid)).toBe(true);
      // Neither host function touched the window…
      expect(win.calls).toEqual([]);
      // …and both reported a structured no-op instead of failing.
      const vibrancyWarns = pluginMessages(pid, "warn", "window.setVibrancy: requires macOS");
      expect(vibrancyWarns).toHaveLength(1);
      expect(vibrancyWarns[0][2]).toContain("host platform=linux");
      const micaWarns = pluginMessages(pid, "warn", "window.setMica: requires Windows");
      expect(micaWarns).toHaveLength(1);
      expect(micaWarns[0][2]).toContain("host platform=linux");
      // No error-level "failed" record: the calls were handled, not thrown.
      expect(pluginMessages(pid, "error", "setVibrancy failed")).toHaveLength(0);
      expect(pluginMessages(pid, "error", "setMica failed")).toHaveLength(0);
    },
    15000,
  );

  test(
    "an absent Electron API on the matching platform is a logged no-op, not a throw",
    async () => {
      const pid = "glass-absent";
      // macOS host, but this Electron build's BrowserWindow lacks setVibrancy.
      testing.setPlatform("darwin");
      const vibWin = createFakeWindow(42, { omitVibrancy: true });
      fakeWindows.set(42, vibWin);
      applyPlan(planFor("abs-v1", [{ id: pid, main: VIBRANCY_FIXTURE, granted: ["electron.window"] }]));
      await waitFor(() => testing.mainPlugins().has(pid), "vibrancy plugin loaded");
      expect(vibWin.calls).toEqual([]);
      expect(pluginMessages(pid, "error", "BrowserWindow#setVibrancy is unavailable")).toHaveLength(1);

      // Second phase: Windows host, but setBackgroundMaterial is missing from the instances.
      testing.setPlatform("win32");
      const micaWin42 = createFakeWindow(42, { omitBackgroundMaterial: true });
      const micaWin43 = createFakeWindow(43, { omitBackgroundMaterial: true });
      fakeWindows.set(42, micaWin42);
      fakeWindows.set(43, micaWin43);
      applyPlan(planFor("abs-v2", [
        { id: pid, main: MICA_FIXTURE, granted: ["electron.window"] },
      ]));
      // Wait for the second activation (same plugin id, new VM under the new plan revision).
      await waitFor(
        () => pluginMessages(pid, "error", "BrowserWindow#setBackgroundMaterial is unavailable").length >= 1,
        "mica absent-API error logged",
      );
      expect(micaWin42.calls).toEqual([]);
      expect(micaWin43.calls).toEqual([]);
      // The plugin stayed alive through both phases (host functions never threw).
      expect(testing.mainPlugins().has(pid)).toBe(true);
    },
    15000,
  );

  test(
    "an invalid window handle is logged as an error, not thrown, on both macOS and Windows",
    async () => {
      const pid = "glass-badwin";
      // macOS: setVibrancy on an id with no BrowserWindow behind it.
      testing.setPlatform("darwin");
      applyPlan(planFor("badwin-v1", [{ id: pid, main: VIBRANCY_FIXTURE, granted: ["electron.window"] }]));
      await waitFor(() => testing.mainPlugins().has(pid), "vibrancy plugin loaded");
      expect(pluginMessages(pid, "error", "window.setVibrancy: unknown window id 42")).toHaveLength(1);
      expect(testing.mainPlugins().has(pid)).toBe(true);

      // Windows: same for setMica with an id that does not resolve.
      testing.setPlatform("win32");
      applyPlan(planFor("badwin-v2", [
        { id: pid, main: MICA_FIXTURE, granted: ["electron.window"] },
      ]));
      await waitFor(
        () => pluginMessages(pid, "error", "window.setMica: unknown window id").length >= 2,
        "both setMica unknown-window errors logged",
      );
      expect(pluginMessages(pid, "error", "window.setMica: unknown window id 42")).toHaveLength(1);
      expect(pluginMessages(pid, "error", "window.setMica: unknown window id 43")).toHaveLength(1);
      expect(testing.mainPlugins().has(pid)).toBe(true);
    },
    15000,
  );

  test(
    "setVibrancy/setMica are gated by the electron.window permission",
    async () => {
      const pid = "glass-gated";
      // With electron.window granted, the sandboxed main context exposes both functions.
      applyPlan(planFor("gate-v1", [{ id: pid, main: GLASS_API_PROBE_FIXTURE, granted: ["electron.window"] }]));
      await waitFor(() => testing.mainPlugins().has(pid), "granted plugin loaded");
      expect(pluginMessages(pid, "info", "glass-apis-present")).toHaveLength(1);
      expect(pluginMessages(pid, "info", "glass-apis-absent")).toHaveLength(0);

      // Without the grant the main plugin is never loaded into the sandbox at all (reconcile only
      // wants main plugins holding electron.window or dev-mode runtime.unsafe), so its code can
      // never reach ctx.window.*.
      const ungranted = "glass-ungranted";
      applyPlan(planFor("gate-v2", [{ id: ungranted, main: GLASS_API_PROBE_FIXTURE, granted: [] }]));
      await sleep(100);
      expect(testing.mainPlugins().has(ungranted)).toBe(false);
      expect(pluginMessages(ungranted, "info", "Main plugin loaded")).toHaveLength(0);
      expect(pluginMessages(ungranted, "info", "glass-apis-present")).toHaveLength(0);
    },
    15000,
  );
});

// ===========================================================================
// Feature 2 — lifecycle events ctx.onLoad / ctx.onRendererReady / ctx.onUnload
// ===========================================================================

const RENDERER_READY_FIXTURE = `
module.exports = {
  activate(ctx) {
    ctx.onRendererReady((w) => {
      ctx.logger.info("rr:" + w);
    });
  },
};
`;

const UNLOAD_FIXTURE = `
module.exports = {
  activate(ctx) {
    ctx.onUnload((w) => {
      ctx.logger.info("ul:" + w);
    });
  },
};
`;

const ONLOAD_FIXTURE = `
module.exports = {
  activate(ctx) {
    ctx.onLoad(() => {
      ctx.logger.info("ol");
    });
  },
};
`;

const RENDERER_READY_BOOM_FIXTURE = `
module.exports = {
  activate(ctx) {
    ctx.onRendererReady((w) => {
      ctx.logger.info("rr-boom:" + w);
      throw new Error("boom-rr");
    });
  },
};
`;

const RENDERER_READY_SPIN_FIXTURE = `
module.exports = {
  activate(ctx) {
    ctx.onRendererReady(() => {
      for (;;) {}
    });
  },
};
`;

const RENDERER_READY_NONVOID_FIXTURE = `
module.exports = {
  activate(ctx) {
    ctx.onRendererReady((w) => {
      ctx.logger.info("rr-nv:" + w);
      return 5; // not undefined: same enforcement class as returning a Promise
    });
  },
};
`;

const ALL_LIFECYCLE_FIXTURE = `
module.exports = {
  activate(ctx) {
    ctx.onLoad(() => {
      ctx.logger.info("rc-onload");
    });
    ctx.onRendererReady((w) => {
      ctx.logger.info("rc-rr:" + w);
    });
    ctx.onUnload((w) => {
      ctx.logger.info("rc-ul:" + w);
    });
  },
};
`;

function mainPlugin(id, source) {
  return { id, main: source, granted: ["electron.window"] };
}

describe("ctx.onRendererReady", () => {
  test(
    "fires once per window did-finish-load with the window id, and per navigation",
    async () => {
      const pid = "rr-window";
      applyPlan(planFor("rr-v1", [mainPlugin(pid, RENDERER_READY_FIXTURE)]));
      await waitFor(() => testing.mainPlugins().has(pid), "plugin loaded");

      const c1 = makeContents();
      createWindow(c1);
      loadWindow(c1);
      // Fire happens synchronously inside the did-finish-load dispatch, exactly once per load.
      expect(pluginMessages(pid, "info", "rr:" + c1.id)).toHaveLength(1);

      // Second navigation on the same window fires again (per-navigation semantics).
      loadWindow(c1);
      expect(pluginMessages(pid, "info", "rr:" + c1.id)).toHaveLength(2);

      // Another window gets its own fire with its own id.
      const c2 = makeContents();
      createWindow(c2);
      loadWindow(c2);
      expect(pluginMessages(pid, "info", "rr:" + c2.id)).toHaveLength(1);
      expect(pluginMessages(pid, "info", "rr:" + c1.id)).toHaveLength(2);
    },
    15000,
  );

  test(
    "a late subscription replays windows that already finished loading, once each",
    async () => {
      const pid = "rr-replay";
      const c1 = makeContents();
      createWindow(c1);
      loadWindow(c1);

      applyPlan(planFor("rr-replay-v1", [mainPlugin(pid, RENDERER_READY_FIXTURE)]));
      await waitFor(() => testing.mainPlugins().has(pid), "plugin loaded");

      // The plugin registered after the load; the replay path delivered the missed event once.
      expect(pluginMessages(pid, "info", "rr:" + c1.id)).toHaveLength(1);
    },
    15000,
  );

  test(
    "a throwing callback fails closed: it unregisters its own listener and is never re-invoked",
    async () => {
      const pid = "rr-boom";
      applyPlan(planFor("rr-boom-v1", [mainPlugin(pid, RENDERER_READY_BOOM_FIXTURE)]));
      await waitFor(() => testing.mainPlugins().has(pid), "plugin loaded");

      const c1 = makeContents();
      createWindow(c1);
      loadWindow(c1);
      expect(pluginMessages(pid, "info", "rr-boom:" + c1.id)).toHaveLength(1);
      // The throw surfaced through the deadline-guarded operation as a failed callback.
      expect(pluginMessages(pid, "error", "ctx.onRendererReady callback failed")).toHaveLength(1);

      // A later load must not re-invoke the (now unregistered) callback.
      loadWindow(c1);
      expect(pluginMessages(pid, "info", "rr-boom:" + c1.id)).toHaveLength(1);
      expect(pluginMessages(pid, "error", "ctx.onRendererReady callback failed")).toHaveLength(1);
      // The plugin itself stays loaded; only the failed listener was dropped.
      expect(testing.mainPlugins().has(pid)).toBe(true);
    },
    15000,
  );

  test(
    "an over-deadline callback fails closed: it unregisters its own listener and is never re-invoked",
    async () => {
      const pid = "rr-spin";
      applyPlan(planFor("rr-spin-v1", [mainPlugin(pid, RENDERER_READY_SPIN_FIXTURE)]));
      await waitFor(() => testing.mainPlugins().has(pid), "plugin loaded");

      const c1 = makeContents();
      createWindow(c1);
      loadWindow(c1);
      // The busy loop burns past the per-operation CPU deadline (~1s) and the callback fails.
      await waitFor(
        () => pluginMessages(pid, "error", "ctx.onRendererReady callback").length >= 1,
        "over-deadline callback reported",
        5000,
      );

      // Give a (buggy) re-invocation enough time to overrun again before asserting absence.
      loadWindow(c1);
      await sleep(1500);
      expect(pluginMessages(pid, "error", "ctx.onRendererReady callback")).toHaveLength(1);
      expect(testing.mainPlugins().has(pid)).toBe(true);
    },
    20000,
  );

  test(
    "a non-void (undefined-void violation) callback fails closed and is not re-invoked",
    async () => {
      const pid = "rr-nonvoid";
      applyPlan(planFor("rr-nv-v1", [mainPlugin(pid, RENDERER_READY_NONVOID_FIXTURE)]));
      await waitFor(() => testing.mainPlugins().has(pid), "plugin loaded");

      const c1 = makeContents();
      createWindow(c1);
      loadWindow(c1);
      expect(pluginMessages(pid, "info", "rr-nv:" + c1.id)).toHaveLength(1);
      expect(pluginMessages(pid, "error", "rejected asynchronous/non-void lifecycle result")).toHaveLength(1);

      loadWindow(c1);
      expect(pluginMessages(pid, "info", "rr-nv:" + c1.id)).toHaveLength(1);
    },
    15000,
  );
});

describe("ctx.onUnload", () => {
  test(
    "fires when a window's webContents is destroyed, with the window id, once per destroy",
    async () => {
      const pid = "ul-window";
      applyPlan(planFor("ul-v1", [mainPlugin(pid, UNLOAD_FIXTURE)]));
      await waitFor(() => testing.mainPlugins().has(pid), "plugin loaded");

      const c1 = makeContents();
      createWindow(c1);
      loadWindow(c1);
      c1.emit("destroyed");
      // A3 background close: unload delivery leaves the destroyed handler via the close-queue
      // pump (order preserved, timing async). Await the background batch instead of asserting
      // synchronously.
      await waitFor(
        () => pluginMessages(pid, "info", "ul:" + c1.id).length === 1,
        "unload delivered for c1",
      );
      expect(pluginMessages(pid, "info", "ul:" + c1.id)).toHaveLength(1);
      // The runtime also dropped the window record as part of the same teardown path.
      expect(testing.windows().has(c1.id)).toBe(false);

      // A second window teardown fires again with its own id.
      const c2 = makeContents();
      createWindow(c2);
      loadWindow(c2);
      c2.emit("destroyed");
      await waitFor(
        () => pluginMessages(pid, "info", "ul:" + c2.id).length === 1,
        "unload delivered for c2",
      );
      expect(pluginMessages(pid, "info", "ul:" + c2.id)).toHaveLength(1);
      expect(pluginMessages(pid, "info", "ul:" + c1.id)).toHaveLength(1);
    },
    15000,
  );
});

describe("ctx.onLoad", () => {
  test(
    "fires exactly once when the original app finishes loading, and immediately for late subscribers",
    async () => {
      const pid = "ol-window";
      applyPlan(planFor("ol-v1", [mainPlugin(pid, ONLOAD_FIXTURE)]));
      await waitFor(() => testing.mainPlugins().has(pid), "plugin loaded");

      // Not yet fired: the app has not finished loading.
      expect(pluginMessages(pid, "info", "ol")).toHaveLength(0);

      // The host signals app load completion (the app 'ready' event on stub hosts).
      electron.app.emit("ready");
      expect(pluginMessages(pid, "info", "ol")).toHaveLength(1);

      // A second ready signal must not double-deliver.
      electron.app.emit("ready");
      expect(pluginMessages(pid, "info", "ol")).toHaveLength(1);

      // A plugin that subscribes after the app already loaded fires immediately, exactly once.
      const pid2 = "ol-late";
      applyPlan(planFor("ol-v2", [mainPlugin(pid, ONLOAD_FIXTURE), mainPlugin(pid2, ONLOAD_FIXTURE)]));
      await waitFor(() => testing.mainPlugins().has(pid2), "late plugin loaded");
      expect(pluginMessages(pid, "info", "ol")).toHaveLength(1);
      expect(pluginMessages(pid2, "info", "ol")).toHaveLength(1);
    },
    15000,
  );
});

describe("lifecycle subscription cleanup", () => {
  test(
    "all lifecycle callbacks are disposed on plugin revoke and never fire afterwards",
    async () => {
      const pid = "lc-revoke";
      applyPlan(planFor("lc-v1", [mainPlugin(pid, ALL_LIFECYCLE_FIXTURE)]));
      await waitFor(() => testing.mainPlugins().has(pid), "plugin loaded");

      // Prove each wiring path works while the plugin is active.
      electron.app.emit("ready");
      const c1 = makeContents();
      createWindow(c1);
      loadWindow(c1);
      c1.emit("destroyed");
      // A3 background close: unload is delivered by the close-queue pump; await it.
      await waitFor(
        () => pluginMessages(pid, "info", "rc-ul:" + c1.id).length === 1,
        "unload delivered for c1",
      );
      expect(pluginMessages(pid, "info", "rc-onload")).toHaveLength(1);
      expect(pluginMessages(pid, "info", "rc-rr:" + c1.id)).toHaveLength(1);
      expect(pluginMessages(pid, "info", "rc-ul:" + c1.id)).toHaveLength(1);

      // Revoke the plugin (plan revision without it).
      const disposeBefore = testing.vmDisposeCount();
      applyPlan(planFor("lc-v2", []));
      await waitFor(
        () => !testing.mainPlugins().has(pid) && testing.vmDisposeCount() === disposeBefore + 1,
        "plugin revoked and VM disposed",
      );

      // Fire every host event again: no subscription survives the revoke.
      electron.app.emit("ready");
      const c2 = makeContents();
      createWindow(c2);
      loadWindow(c2);
      c2.emit("destroyed");
      expect(pluginMessages(pid, "info", "rc-onload")).toHaveLength(1);
      expect(pluginMessages(pid, "info", "rc-rr:" + c1.id)).toHaveLength(1);
      expect(pluginMessages(pid, "info", "rc-rr:" + c2.id)).toHaveLength(0);
      expect(pluginMessages(pid, "info", "rc-ul:" + c1.id)).toHaveLength(1);
      expect(pluginMessages(pid, "info", "rc-ul:" + c2.id)).toHaveLength(0);
    },
    15000,
  );
});
