// Runtime correctness tests (Tier-0): the plugin deactivate lifecycle and the CSS removal retry.
//
// These exercise src/index.js directly against a stub Electron host — `mock.module("electron")`
// intercepts the CJS `require("electron")` — with real QuickJS sandboxes and fake webContents that
// can be told to fail. No real Electron, no integration harness needed.
//
// Run with `bun test` from crates/runtime/js (auto-discovers *.test.js). The module under test
// keeps its public contract ({ start, applyPlan }) and exposes `__testing` seams (reset + live
// map/counter accessors) used only by this file.
const { describe, test, expect, beforeEach, afterEach, mock } = require("bun:test");
const { EventEmitter } = require("events");

// --- Stub Electron host ---
const electron = {
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
// Optional synchronous hook the pluginLog sink calls for every record. Lets a test snapshot
// runtime state exactly while a guest log call is being serviced (before any later disposal).
let pluginLogHook = null;

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
  pluginLogHook = null;
  runtime.start(electron.app, {
    runtimeLog: (level, message) => runtimeLogs.push([level, String(message)]),
    pluginLog: (pid, level, message) => {
      const record = [pid, level, String(message)];
      pluginLogs.push(record);
      if (pluginLogHook) pluginLogHook(pid, level, record[2]);
    },
  });
  await sleep(0);
});

afterEach(() => {
  // Dispose any VM a test left loaded so quickjs's disposal assertion (leaked handles) can catch
  // hygiene regressions, then reset module state for the next test.
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

// --- Plugin fixtures (run inside the real QuickJS sandbox) ---

const MAIN_FIXTURE = `
module.exports = {
  activate(ctx) {
    ctx.logger.info("main-activate-ran");
  },
  deactivate(ctx) {
    ctx.logger.info("main-deactivate-ran");
  }
};
`;

const MAIN_FIXTURE_NON_VOID_DEACTIVATE = `
module.exports = {
  activate(ctx) {
    ctx.logger.info("main-activate-ran");
  },
  deactivate(ctx) {
    ctx.logger.info("main-deactivate-bad-ran");
    return { not: undefined }; // non-undefined: same enforcement class as returning a Promise
  }
};
`;

const RENDERER_FIXTURE = `
module.exports = {
  activate(ctx) {
    ctx.logger.info("renderer-activate-ran");
  },
  deactivate(ctx) {
    ctx.logger.info("renderer-deactivate-ran");
  }
};
`;

function planFor(revision, plugins) {
  return { revision, plugins };
}

// ===========================================================================
// Plugin deactivate lifecycle
// ===========================================================================

describe("plugin deactivate lifecycle", () => {
  test(
    "main plugin: exported deactivate(ctx) runs exactly once, before VM disposal, on revoke",
    async () => {
      const id = "main-lc";
      applyPlan(planFor("lc-v1", [
        { id, main: MAIN_FIXTURE, granted: ["electron.window"] },
      ]));
      await waitFor(() => testing.mainPlugins().has(id), "main plugin loaded");
      expect(pluginMessages(id, "info", "main-activate-ran")).toHaveLength(1);

      const disposeBefore = testing.vmDisposeCount();
      let disposeAtDeactivate = -1;
      pluginLogHook = (pid, _level, message) => {
        if (pid === id && message === "main-deactivate-ran") {
          // Snapshot the disposal counter WHILE the guest deactivate is being serviced — i.e.
          // before the host's disposeVM step that immediately follows in the deactivate closure.
          disposeAtDeactivate = testing.vmDisposeCount();
        }
      };

      // Revoke: remove the plugin from the plan.
      applyPlan(planFor("lc-v2", []));
      await waitFor(
        () => !testing.mainPlugins().has(id) && disposeAtDeactivate !== -1,
        "main plugin deactivated and removed",
      );

      expect(pluginMessages(id, "info", "main-deactivate-ran")).toHaveLength(1);
      expect(disposeAtDeactivate).toBe(disposeBefore);
      expect(testing.vmDisposeCount()).toBe(disposeBefore + 1);
      expect(pluginMessages(id, "info", "Main plugin removed")).toHaveLength(1);
    },
    15000,
  );

  test(
    "main plugin: a stale double revoke never calls guest deactivate twice",
    async () => {
      const id = "main-guard";
      applyPlan(planFor("guard-v1", [
        { id, main: MAIN_FIXTURE, granted: ["electron.window"] },
      ]));
      await waitFor(() => testing.mainPlugins().has(id), "main plugin loaded");

      const entry = testing.mainPlugins().get(id);
      entry.deactivate();
      entry.deactivate(); // stale second invocation must be a no-op

      // A real revoke that removes the (already disposed) entry is also a no-op guest-wise.
      applyPlan(planFor("guard-v2", []));
      await waitFor(() => !testing.mainPlugins().has(id), "main plugin removed");

      expect(pluginMessages(id, "info", "main-deactivate-ran")).toHaveLength(1);
    },
    15000,
  );

  test(
    "main plugin: a non-undefined/Promise-returning deactivate is a failed cleanup but the VM is still disposed (no leak)",
    async () => {
      const id = "main-nonvoid";
      applyPlan(planFor("nonvoid-v1", [
        { id, main: MAIN_FIXTURE_NON_VOID_DEACTIVATE, granted: ["electron.window"] },
      ]));
      await waitFor(() => testing.mainPlugins().has(id), "main plugin loaded");

      const disposeBefore = testing.vmDisposeCount();
      applyPlan(planFor("nonvoid-v2", []));
      await waitFor(
        () => !testing.mainPlugins().has(id) && testing.vmDisposeCount() === disposeBefore + 1,
        "VM disposed despite non-void deactivate",
      );

      // Guest code ran, enforcement flagged the non-void result, and disposal still happened.
      expect(pluginMessages(id, "info", "main-deactivate-bad-ran")).toHaveLength(1);
      const enforcement = pluginMessages(id, "error", "non-void lifecycle result");
      expect(enforcement.length).toBeGreaterThanOrEqual(1);
      expect(testing.vmDisposeCount()).toBe(disposeBefore + 1);
    },
    15000,
  );

  test(
    "renderer plugin: exported deactivate(ctx) runs exactly once, before VM disposal, on revoke",
    async () => {
      const pid = "renderer-lc";
      const contents = makeContents();
      applyPlan(planFor("rlc-v1", [
        { id: pid, renderer: RENDERER_FIXTURE, granted: ["renderer.script"] },
      ]));
      createWindow(contents);
      loadWindow(contents);

      const key = pid + "@" + contents.id;
      await waitFor(() => testing.rendererPlugins().has(key), "renderer plugin loaded");
      expect(pluginMessages(pid, "info", "renderer-activate-ran")).toHaveLength(1);

      const disposeBefore = testing.vmDisposeCount();
      let disposeAtDeactivate = -1;
      pluginLogHook = (pluginId, _level, message) => {
        if (pluginId === pid && message === "renderer-deactivate-ran") {
          disposeAtDeactivate = testing.vmDisposeCount();
        }
      };

      applyPlan(planFor("rlc-v2", []));
      await waitFor(
        () => !testing.rendererPlugins().has(key) && disposeAtDeactivate !== -1,
        "renderer plugin deactivated and removed",
      );

      expect(pluginMessages(pid, "info", "renderer-deactivate-ran")).toHaveLength(1);
      expect(disposeAtDeactivate).toBe(disposeBefore);
      expect(testing.vmDisposeCount()).toBe(disposeBefore + 1);
    },
    15000,
  );
});

// ===========================================================================
// CSS removal retry
// ===========================================================================

describe("CSS removal retry", () => {
  const CSS_ID = "css-a";
  const CSS_A = "body { background: rgb(1, 2, 3); }";
  const CSS_B = "body { background: rgb(9, 8, 7); }";

  test(
    "removeInsertedCSS is retried after transient failures and the removal is reported",
    async () => {
      let removeAttempts = 0;
      const contents = makeContents({
        removeInsertedCSS: async () => {
          removeAttempts += 1;
          if (removeAttempts <= 2) throw new Error("transient failure " + removeAttempts);
        },
      });
      createWindow(contents);
      const w = testing.windows().get(contents.id);
      expect(w).toBeDefined();

      applyPlan(planFor("css-v1", [
        { id: CSS_ID, css: CSS_A, granted: ["renderer.css"] },
      ]));
      await waitFor(
        () => pluginMessages(CSS_ID, "info", "CSS injected").length === 1,
        "css injected",
      );
      expect(w.keys.get(CSS_ID).css).toBe(CSS_A);

      applyPlan(planFor("css-v2", []));
      await waitFor(
        () =>
          removeAttempts === 3 && pluginMessages(CSS_ID, "info", "CSS removed").length === 1,
        "css removal retried and reported",
      );

      expect(removeAttempts).toBe(3); // two failures then a success, not a single swallowed try
      expect(w.keys.has(CSS_ID)).toBe(false);
      expect(pluginMessages(CSS_ID, "error", "CSS removal failed")).toHaveLength(0);
    },
    10000,
  );

  test(
    "a persistently failing removal logs an error (not swallowed) and keeps the entry for a later retry",
    async () => {
      let removeAttempts = 0;
      const contents = makeContents({
        removeInsertedCSS: async () => {
          removeAttempts += 1;
          throw new Error("stubborn failure");
        },
      });
      createWindow(contents);
      const w = testing.windows().get(contents.id);

      applyPlan(planFor("css-p1", [
        { id: CSS_ID, css: CSS_A, granted: ["renderer.css"] },
      ]));
      await waitFor(
        () => pluginMessages(CSS_ID, "info", "CSS injected").length === 1,
        "css injected",
      );

      applyPlan(planFor("css-p2", []));
      await waitFor(
        () => removeAttempts === 3 && w.keys.has(CSS_ID),
        "css removal failure logged and entry retained",
      );

      const errors = pluginMessages(CSS_ID, "error", "CSS removal failed after 3 attempts");
      expect(errors).toHaveLength(1);
      expect(errors[0][1]).toBe("error");
      expect(pluginMessages(CSS_ID, "info", "CSS removed")).toHaveLength(0);
      // Re-registered so the reconcile loop retries instead of silently dropping the stale sheet.
      expect(w.keys.has(CSS_ID)).toBe(true);
      expect(w.keys.get(CSS_ID).css).toBe(CSS_A);
    },
    10000,
  );

  test(
    "a window destroyed mid-removal stops retrying without a spurious error",
    async () => {
      let removeAttempts = 0;
      let destroyed = false;
      const contents = makeContents({
        removeInsertedCSS: async () => {
          removeAttempts += 1;
          destroyed = true; // the window goes away while the first removal is in flight
          throw new Error("Object has been destroyed");
        },
        isDestroyed: () => destroyed,
      });
      createWindow(contents);
      const w = testing.windows().get(contents.id);

      applyPlan(planFor("css-d1", [
        { id: CSS_ID, css: CSS_A, granted: ["renderer.css"] },
      ]));
      await waitFor(
        () => pluginMessages(CSS_ID, "info", "CSS injected").length === 1,
        "css injected",
      );

      applyPlan(planFor("css-d2", []));
      // Give any (incorrect) retry backoff time to fire; only one attempt may happen.
      await waitFor(() => removeAttempts >= 1, "first removal attempt made");
      await sleep(300);

      expect(removeAttempts).toBe(1); // no blind retries against a destroyed window
      expect(pluginMessages(CSS_ID, "error", "CSS removal failed")).toHaveLength(0);
    },
    10000,
  );

  test(
    "re-injection revokes the superseded sheet with retry before injecting the new css",
    async () => {
      let removeAttempts = 0;
      const contents = makeContents({
        removeInsertedCSS: async () => {
          removeAttempts += 1;
          if (removeAttempts <= 2) throw new Error("transient failure " + removeAttempts);
        },
      });
      createWindow(contents);
      const w = testing.windows().get(contents.id);

      applyPlan(planFor("css-r1", [
        { id: CSS_ID, css: CSS_A, granted: ["renderer.css"] },
      ]));
      await waitFor(
        () => pluginMessages(CSS_ID, "info", "CSS injected").length === 1,
        "first css injected",
      );
      expect(w.keys.get(CSS_ID).css).toBe(CSS_A);
      expect(contents.__insertCount()).toBe(1);

      // Same plugin id, different css -> inject path must revoke the old key (with retry) first.
      applyPlan(planFor("css-r2", [
        { id: CSS_ID, css: CSS_B, granted: ["renderer.css"] },
      ]));
      await waitFor(
        () =>
          removeAttempts === 3 &&
          pluginMessages(CSS_ID, "info", "CSS injected").length === 2,
        "css re-injected after superseded-sheet removal",
      );

      expect(removeAttempts).toBe(3);
      expect(contents.__insertCount()).toBe(2);
      expect(w.keys.get(CSS_ID).css).toBe(CSS_B);
    },
    10000,
  );
});

// ===========================================================================
// Plugin ctx.config (per-plugin config snapshot from the execution plan)
// ===========================================================================

const CONFIG_MAIN_FIXTURE = `
module.exports = {
  activate(ctx) {
    ctx.logger.info("cfg-main-activate-opacity=" + ctx.config.get("opacity"));
    ctx.logger.info("cfg-main-mode=" + ctx.config.get("mode"));
    ctx.logger.info("cfg-main-debug=" + ctx.config.get("debug"));
    ctx.logger.info("cfg-main-missing=" + ctx.config.get("nope"));
    ctx.logger.info("cfg-main-nonstring-key=" + String(ctx.config.get(123)));
    ctx.logger.info("cfg-main-set-returns=" + String(ctx.config.set("opacity", 0.99)));
    ctx.logger.info("cfg-main-after-set=" + ctx.config.get("opacity"));
    ctx.logger.info("cfg-main-activate-ran");
  },
  deactivate(ctx) {
    ctx.logger.info("cfg-main-deactivate-opacity=" + ctx.config.get("opacity"));
  }
};
`;

const CONFIG_RENDERER_FIXTURE = `
module.exports = {
  activate(ctx) {
    ctx.logger.info("cfg-rr-activate-opacity=" + ctx.config.get("opacity"));
    ctx.logger.info("cfg-rr-mode=" + ctx.config.get("mode"));
    ctx.logger.info("cfg-rr-debug=" + ctx.config.get("debug"));
    ctx.logger.info("cfg-rr-missing=" + ctx.config.get("nope"));
    ctx.config.set("opacity", 0.01);
    ctx.logger.info("cfg-rr-after-set=" + ctx.config.get("opacity"));
    ctx.logger.info("cfg-rr-activate-ran");
  },
  deactivate(ctx) {
    ctx.logger.info("cfg-rr-deactivate-opacity=" + ctx.config.get("opacity"));
  }
};
`;

describe("plugin ctx.config", () => {
  test(
    "main plugin: ctx.config.get reads the merged snapshot; missing/non-string keys are undefined; set is a no-op",
    async () => {
      const id = "cfg-main";
      applyPlan(planFor("cfg-m1", [
        {
          id,
          main: CONFIG_MAIN_FIXTURE,
          granted: ["electron.window"],
          config: { opacity: 0.8, mode: "auto", debug: false },
        },
      ]));
      await waitFor(() => testing.mainPlugins().has(id), "main config plugin loaded");

      // Schema-default values are readable (0.8 / "auto" / false).
      expect(pluginMessages(id, "info", "cfg-main-activate-opacity=0.8")).toHaveLength(1);
      expect(pluginMessages(id, "info", "cfg-main-mode=auto")).toHaveLength(1);
      expect(pluginMessages(id, "info", "cfg-main-debug=false")).toHaveLength(1);
      // Missing and non-string keys return undefined.
      expect(pluginMessages(id, "info", "cfg-main-missing=undefined")).toHaveLength(1);
      expect(pluginMessages(id, "info", "cfg-main-nonstring-key=undefined")).toHaveLength(1);
      // set returns undefined and does NOT change what get returns (runtime never persists config).
      expect(pluginMessages(id, "info", "cfg-main-set-returns=undefined")).toHaveLength(1);
      expect(pluginMessages(id, "info", "cfg-main-after-set=0.8")).toHaveLength(1);
    },
    20000,
  );

  test(
    "renderer plugin: ctx.config.get reads overridden values; missing key is undefined; set is a no-op",
    async () => {
      const pid = "cfg-renderer";
      const contents = makeContents();
      applyPlan(planFor("cfg-r1", [
        {
          id: pid,
          renderer: CONFIG_RENDERER_FIXTURE,
          granted: ["renderer.script"],
          config: { opacity: 0.5, mode: "fast", debug: true },
        },
      ]));
      createWindow(contents);
      loadWindow(contents);

      const key = pid + "@" + contents.id;
      await waitFor(() => testing.rendererPlugins().has(key), "renderer config plugin loaded");

      // Stored overrides (not the schema defaults) are what the runtime sees.
      expect(pluginMessages(pid, "info", "cfg-rr-activate-opacity=0.5")).toHaveLength(1);
      expect(pluginMessages(pid, "info", "cfg-rr-mode=fast")).toHaveLength(1);
      expect(pluginMessages(pid, "info", "cfg-rr-debug=true")).toHaveLength(1);
      expect(pluginMessages(pid, "info", "cfg-rr-missing=undefined")).toHaveLength(1);
      // set is a no-op: get is unchanged.
      expect(pluginMessages(pid, "info", "cfg-rr-after-set=0.5")).toHaveLength(1);
    },
    20000,
  );

  test(
    "a config change across plan revisions deactivates the old VM and activates a new VM carrying the new config",
    async () => {
      const id = "cfg-reload";
      // v1: plugin loaded with config A.
      applyPlan(planFor("cfg-rv1", [
        {
          id,
          main: CONFIG_MAIN_FIXTURE,
          granted: ["electron.window"],
          config: { opacity: 0.25, mode: "old", debug: false },
        },
      ]));
      await waitFor(() => testing.mainPlugins().has(id), "config plugin v1 loaded");
      expect(pluginMessages(id, "info", "cfg-main-activate-opacity=0.25")).toHaveLength(1);

      // v2: same plugin, new config (Core bumps the plan revision + grant fingerprint). The old VM
      // must run its deactivate against its own (old) config, then a fresh VM activates with the
      // new config.
      applyPlan(planFor("cfg-rv2", [
        {
          id,
          main: CONFIG_MAIN_FIXTURE,
          granted: ["electron.window"],
          config: { opacity: 0.9, mode: "new", debug: true },
        },
      ]));
      await waitFor(
        () => pluginMessages(id, "info", "cfg-main-activate-opacity=0.9").length === 1,
        "config plugin v2 activated",
      );

      // The superseded VM deactivated with the OLD config snapshot…
      expect(pluginMessages(id, "info", "cfg-main-deactivate-opacity=0.25")).toHaveLength(1);
      // …and exactly two activates happened (old + new VM), the newest with the new config.
      expect(pluginMessages(id, "info", "cfg-main-activate-ran")).toHaveLength(2);
      expect(pluginMessages(id, "info", "cfg-main-activate-opacity=0.25")).toHaveLength(1);
      expect(pluginMessages(id, "info", "cfg-main-activate-opacity=0.9")).toHaveLength(1);
      // The running instance's deactivate (this test's teardown) sees the NEW config.
      const entry = testing.mainPlugins().get(id);
      entry.deactivate();
      await waitFor(
        () => pluginMessages(id, "info", "cfg-main-deactivate-opacity=0.9").length === 1,
        "v2 deactivate used the new config",
      );
      // set on the new VM is still a no-op (the new default 0.9 is not changed by the guest).
      expect(pluginMessages(id, "info", "cfg-main-after-set=0.9")).toHaveLength(1);
    },
    20000,
  );
});
