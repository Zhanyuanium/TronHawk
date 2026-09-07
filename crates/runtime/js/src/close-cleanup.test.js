// A3 background close-path tests: synchronous transfer, sealed-VM isolation, subscription
// snapshots, background pump ordering, quit semantics, and the P<=8 safety premise.
//
// These exercise src/index.js directly against a stub Electron host (same harness pattern as
// index.test.js / platform.test.js) with real QuickJS sandboxes. The destroyed handler must
// return with teardown only *queued* (closeQueueSize 1, zero disposals); the setImmediate pump
// then services deactivate-before-unload per window, round-robin.
//
// Run with `bun test` from crates/runtime/js (auto-discovers *.test.js).
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

let runtimeLogs = [];
let pluginLogs = [];

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

function logIndex(id, level, needle) {
  const i = pluginLogs.findIndex(
    ([pid, lvl, message]) =>
      pid === id && (level === undefined || lvl === level) && message.includes(needle),
  );
  return i;
}

beforeEach(async () => {
  testing.reset();
  electron.app.removeAllListeners();
  runtimeLogs = [];
  pluginLogs = [];
  delete globalThis.__rawRDeactivated;
  runtime.start(electron.app, {
    runtimeLog: (level, message) => runtimeLogs.push([level, String(message)]),
    pluginLog: (pid, level, message) => pluginLogs.push([pid, level, String(message)]),
  });
  await sleep(0);
});

afterEach(async () => {
  // Drain any background close batch the test left queued so no VM leaks across tests, then
  // dispose leftovers exactly like index.test.js.
  await waitFor(() => testing.closeQueueSize() === 0, "close queue drained", 10000).catch(() => {});
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
  delete globalThis.__rawRDeactivated;
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

function mainPlugin(id, source) {
  return { id, main: source, granted: ["electron.window"] };
}

function rendererPlugin(id, source) {
  return { id, renderer: source, granted: ["renderer.script"] };
}

// --- Plugin fixtures (run inside the real QuickJS sandbox) ---

const RENDERER_SYNC = `
module.exports = {
  activate(ctx) { ctx.logger.info("rsync-activate"); },
  deactivate(ctx) { ctx.logger.info("rsync-deactivate"); }
};
`;

const RENDERER_NEVER_DEACTIVATE = `
module.exports = {
  activate(ctx) { ctx.logger.info("rnever-activate"); },
  deactivate(ctx) { ctx.logger.info("rnever-deactivate-called"); return new Promise(() => {}); }
};
`;

const RENDERER_ASYNC_ACTIVATE_NEVER = `
module.exports = {
  activate(ctx) { ctx.logger.info("rasync-activate-called"); return new Promise(() => {}); },
  deactivate(ctx) { ctx.logger.info("rasync-deactivate"); }
};
`;

const MAIN_UNLOAD = `
module.exports = {
  activate(ctx) {
    ctx.onUnload((w) => { ctx.logger.info("mul:" + w); });
  },
};
`;

// Raw renderer plugin (runtime.unsafe): cleanup observed via a host-global probe counter.
const RAW_RENDERER_CLEANUP = `
module.exports = {
  activate(ctx) { ctx.logger.info("rawr-activate"); },
  deactivate(ctx) {
    ctx.logger.info("rawr-deactivate");
    globalThis.__rawRDeactivated = (globalThis.__rawRDeactivated || 0) + 1;
  },
};
`;

// CPU-bound guest deactivate (~200ms busy loop, inside the 1000ms CPU deadline so it
// succeeds): proves the destroyed path never blocks on guest work (finding 7 stall).
const CPU_SPIN_DEACTIVATE = `
module.exports = {
  activate(ctx) {},
  deactivate(ctx) {
    ctx.logger.info("spin-deactivate-start");
    const end = Date.now() + 200;
    while (Date.now() < end) {}
    ctx.logger.info("spin-deactivate-done");
  }
};
`;

// CPU-bound guest deactivate (~100ms): eight of these fill one window to the P<=8 cap and
// build the slow-dispose stall bound from real per-slice blocks (Gate 2R finding 7).
const CPU_SPIN_100_DEACTIVATE = `
module.exports = {
  activate(ctx) {},
  deactivate(ctx) {
    const end = Date.now() + 100;
    while (Date.now() < end) {}
  }
};
`;

// ===========================================================================
// A3-1: synchronous transfer defers teardown (the core latency claim)
// ===========================================================================

describe("A3 transfer defers teardown off the destroyed path", () => {
  test(
    "destroyed returns with work queued and zero disposals; pump disposes exactly once",
    async () => {
      const pid = "a3-defer";
      const contents = makeContents();
      applyPlan(planFor("a3d-v1", [rendererPlugin(pid, RENDERER_SYNC)]));
      createWindow(contents);
      loadWindow(contents);
      const key = pid + "@" + contents.id;
      await waitFor(() => testing.rendererPlugins().has(key), "renderer loaded");

      const disposeBefore = testing.vmDisposeCount();
      contents.emit("destroyed");
      // Synchronous postconditions: record dropped, batch queued, nothing disposed yet.
      expect(testing.windows().has(contents.id)).toBe(false);
      expect(testing.closeQueueSize()).toBe(1);
      expect(testing.vmDisposeCount()).toBe(disposeBefore);

      // Background pump: guest deactivate ran, VM disposed exactly once, queue drained.
      await waitFor(
        () =>
          testing.closeQueueSize() === 0 &&
          testing.vmDisposeCount() === disposeBefore + 1,
        "background batch completed",
      );
      expect(pluginMessages(pid, "info", "rsync-deactivate")).toHaveLength(1);
    },
    15000,
  );
});

// ===========================================================================
// A3-2/3: order preserved (deactivate before unload), duplicate destroy safe
// ===========================================================================

describe("A3 ordering and exactly-once unload", () => {
  test(
    "same window: renderer deactivate log precedes main onUnload log",
    async () => {
      const rid = "a3-ord-r";
      const mid = "a3-ord-m";
      const contents = makeContents();
      applyPlan(
        planFor("a3o-v1", [rendererPlugin(rid, RENDERER_SYNC), mainPlugin(mid, MAIN_UNLOAD)]),
      );
      createWindow(contents);
      loadWindow(contents);
      await waitFor(() => testing.rendererPlugins().has(rid + "@" + contents.id), "r loaded");
      await waitFor(() => testing.mainPlugins().has(mid), "m loaded");

      contents.emit("destroyed");
      await waitFor(
        () => pluginMessages(mid, "info", "mul:" + contents.id).length === 1,
        "unload delivered",
      );
      const d = logIndex(rid, "info", "rsync-deactivate");
      const u = logIndex(mid, "info", "mul:" + contents.id);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(u);
    },
    15000,
  );

  test(
    "duplicate destroyed emits unload once and disposes once",
    async () => {
      const rid = "a3-dup-r";
      const mid = "a3-dup-m";
      const contents = makeContents();
      applyPlan(
        planFor("a3u-v1", [rendererPlugin(rid, RENDERER_SYNC), mainPlugin(mid, MAIN_UNLOAD)]),
      );
      createWindow(contents);
      loadWindow(contents);
      await waitFor(() => testing.rendererPlugins().has(rid + "@" + contents.id), "r loaded");

      const disposeBefore = testing.vmDisposeCount();
      contents.emit("destroyed");
      contents.emit("destroyed"); // duplicate: must be discarded by the dead flag
      await waitFor(
        () => pluginMessages(mid, "info", "mul:" + contents.id).length === 1,
        "unload delivered once",
      );
      await waitFor(() => testing.closeQueueSize() === 0, "queue drained");
      expect(pluginMessages(mid, "info", "mul:" + contents.id)).toHaveLength(1);
      expect(pluginMessages(rid, "info", "rsync-deactivate")).toHaveLength(1);
      expect(testing.vmDisposeCount()).toBe(disposeBefore + 1);
      expect(testing.closeQueueSize()).toBe(0);
    },
    15000,
  );

  test(
    "second did-finish-load after destroy resurrects nothing",
    async () => {
      const pid = "a3-res";
      const contents = makeContents();
      applyPlan(planFor("a3r-v1", [rendererPlugin(pid, RENDERER_SYNC)]));
      createWindow(contents);
      loadWindow(contents);
      await waitFor(() => testing.rendererPlugins().has(pid + "@" + contents.id), "loaded");
      contents.emit("destroyed");
      contents.emit("did-finish-load"); // late load on a dead record: must no-op
      await waitFor(() => testing.closeQueueSize() === 0, "queue drained");
      await sleep(50);
      expect(testing.rendererPlugins().has(pid + "@" + contents.id)).toBe(false);
      expect(pluginMessages(pid, "info", "Renderer plugin loaded")).toHaveLength(1);
    },
    15000,
  );
});

// ===========================================================================
// A3-1: sealed-VM isolation (pendingOps settlement refused after transfer)
// ===========================================================================

describe("A3 sealed-VM isolation", () => {
  test(
    "late settleOp for a transferred VM never invokes its makeHandle",
    async () => {
      const pid = "a3-seal";
      const contents = makeContents();
      applyPlan(planFor("a3s-v1", [rendererPlugin(pid, RENDERER_SYNC)]));
      createWindow(contents);
      loadWindow(contents);
      const key = pid + "@" + contents.id;
      await waitFor(() => testing.rendererPlugins().has(key), "loaded");
      const vm = testing.rendererPlugins().get(key).vm;
      expect(testing.isVmSealed(vm)).toBe(false);

      const { opId } = testing.newHostPromise(vm, pid, "seal-probe");
      expect(testing.pendingOpsSize()).toBe(1);
      contents.emit("destroyed");
      expect(testing.isVmSealed(vm)).toBe(true);
      expect(testing.pendingOpsSize()).toBe(0); // abandoned synchronously at transfer

      let makeHandleCalled = false;
      testing.settleOp(opId, "resolve", () => {
        makeHandleCalled = true;
        return vm.undefined;
      });
      expect(makeHandleCalled).toBe(false);
      await waitFor(() => testing.closeQueueSize() === 0, "queue drained");
    },
    15000,
  );

  test(
    "newHostPromise on a sealed VM returns the undefined sentinel without registering",
    async () => {
      const pid = "a3-seal2";
      const contents = makeContents();
      applyPlan(planFor("a3s2-v1", [rendererPlugin(pid, RENDERER_SYNC)]));
      createWindow(contents);
      loadWindow(contents);
      const key = pid + "@" + contents.id;
      await waitFor(() => testing.rendererPlugins().has(key), "loaded");
      const vm = testing.rendererPlugins().get(key).vm;
      contents.emit("destroyed");
      const created = testing.newHostPromise(vm, pid, "post-seal");
      expect(created.opId).toBe(-1);
      expect(testing.pendingOpsSize()).toBe(0);
      await waitFor(() => testing.closeQueueSize() === 0, "queue drained");
    },
    15000,
  );

  test(
    "async activate settling after transfer neither registers nor disposes twice",
    async () => {
      const pid = "a3-aact";
      const contents = makeContents();
      applyPlan(planFor("a3a-v1", [rendererPlugin(pid, RENDERER_ASYNC_ACTIVATE_NEVER)]));
      createWindow(contents);
      loadWindow(contents);
      const key = pid + "@" + contents.id;
      // Registration happens immediately even while async activate is in flight.
      await waitFor(() => testing.rendererPlugins().has(key), "registered");
      const disposeBefore = testing.vmDisposeCount();
      contents.emit("destroyed");
      await waitFor(() => testing.closeQueueSize() === 0, "queue drained");
      await sleep(50);
      // Exactly one disposal: the batch owns it; the never-settling activate adds nothing.
      expect(testing.vmDisposeCount()).toBe(disposeBefore + 1);
      expect(testing.rendererPlugins().has(key)).toBe(false);
    },
    15000,
  );
});

// ===========================================================================
// A3-2: subscription snapshots (late subscribers excluded, revoke wins)
// ===========================================================================

describe("A3 unload subscription snapshots", () => {
  test(
    "a main plugin subscribing after destroy never receives the dead window's unload",
    async () => {
      const mid1 = "a3-snap-old";
      const mid2 = "a3-snap-new";
      const contents = makeContents();
      applyPlan(planFor("a3n-v1", [mainPlugin(mid1, MAIN_UNLOAD)]));
      await waitFor(() => testing.mainPlugins().has(mid1), "old loaded");
      createWindow(contents);
      loadWindow(contents);
      contents.emit("destroyed");
      // New subscriber arrives after the transfer (plan revision).
      applyPlan(
        planFor("a3n-v2", [mainPlugin(mid1, MAIN_UNLOAD), mainPlugin(mid2, MAIN_UNLOAD)]),
      );
      await waitFor(() => testing.mainPlugins().has(mid2), "new loaded");
      await waitFor(
        () => pluginMessages(mid1, "info", "mul:" + contents.id).length === 1,
        "old unload delivered",
      );
      await sleep(50);
      expect(pluginMessages(mid2, "info", "mul:" + contents.id)).toHaveLength(0);
    },
    15000,
  );

  test(
    "revoking the subscriber before the pump runs skips delivery without leaking",
    async () => {
      const mid = "a3-snap-rev";
      const contents = makeContents();
      applyPlan(planFor("a3rv-v1", [mainPlugin(mid, MAIN_UNLOAD)]));
      await waitFor(() => testing.mainPlugins().has(mid), "loaded");
      createWindow(contents);
      loadWindow(contents);
      contents.emit("destroyed");
      // Revoke synchronously, before the background pump turns.
      const disposeBefore = testing.vmDisposeCount();
      applyPlan(planFor("a3rv-v2", []));
      await waitFor(() => testing.mainPlugins().has(mid) === false, "revoked");
      await waitFor(() => testing.closeQueueSize() === 0, "queue drained");
      await sleep(50);
      expect(pluginMessages(mid, "info", "mul:" + contents.id)).toHaveLength(0);
      // Main VM disposed exactly once via the revoke path (the empty batch disposes nothing).
      expect(testing.vmDisposeCount()).toBe(disposeBefore + 1);
    },
    15000,
  );
});

// ===========================================================================
// A3 P<=8 safety premise (R2, permanent)
// ===========================================================================

describe("A3 renderer plugin cap", () => {
  test(
    "ninth renderer plugin on one window fails closed with an error log",
    async () => {
      const ids = Array.from({ length: 9 }, (_, i) => "a3-cap-" + i);
      const contents = makeContents();
      applyPlan(
        planFor(
          "a3c-v1",
          ids.map((id) => rendererPlugin(id, RENDERER_SYNC)),
        ),
      );
      createWindow(contents);
      loadWindow(contents);
      await waitFor(
        () => pluginMessages("a3-cap-7", "info", "Renderer plugin loaded").length === 1,
        "eighth loaded",
      );
      await sleep(100);
      // Deterministic first-eight-wins in stable plan order.
      expect(testing.rendererPlugins().size).toBe(8);
      expect(testing.rendererPlugins().has("a3-cap-8@" + contents.id)).toBe(false);
      expect(pluginMessages("a3-cap-8", "error", "limit exceeded")).toHaveLength(1);
      expect(testing.maxRendererPluginsPerWindow()).toBe(8);
    },
    20000,
  );
});

// ===========================================================================
// A3-4: quit semantics (mode switch, will-quit sweep, cancel recovery)
// ===========================================================================

describe("A3 quit semantics", () => {
  test(
    "before-quit gates new loads; new window content recovers the allocator",
    async () => {
      const pid = "a3-quit-blocked";
      // Window already alive before quit begins.
      const c0 = makeContents();
      applyPlan(planFor("a3q-v0", []));
      createWindow(c0);
      loadWindow(c0);
      electron.app.emit("before-quit");
      expect(testing.isQuitting()).toBe(true);
      // A plan revision arriving mid-quit must not start new loads on live windows.
      applyPlan(planFor("a3q-v1", [rendererPlugin(pid, RENDERER_SYNC)]));
      await sleep(150);
      expect(testing.rendererPlugins().has(pid + "@" + c0.id)).toBe(false);
      // Recovery: new window content proves continued life (cancelled quit).
      const c2 = makeContents();
      createWindow(c2);
      expect(testing.isQuitting()).toBe(false);
      loadWindow(c2);
      await waitFor(
        () => testing.rendererPlugins().has(pid + "@" + c2.id),
        "loads after recovery",
      );
    },
    15000,
  );

  test(
    "will-quit sweep disposes queued VMs synchronously while preserving unload for the pump",
    async () => {
      const rid = "a3-sweep-r";
      const mid = "a3-sweep-m";
      const contents = makeContents();
      applyPlan(
        planFor("a3sw-v1", [rendererPlugin(rid, RENDERER_SYNC), mainPlugin(mid, MAIN_UNLOAD)]),
      );
      createWindow(contents);
      loadWindow(contents);
      await waitFor(() => testing.rendererPlugins().has(rid + "@" + contents.id), "r loaded");
      const disposeBefore = testing.vmDisposeCount();
      contents.emit("destroyed");
      expect(testing.closeQueueSize()).toBe(1);
      // Sweep runs synchronously inside will-quit: dispose-only, no guest, no events. The batch
      // stays queued as unload-only so a cancelled quit still delivers it (finding 3).
      electron.app.emit("will-quit");
      expect(testing.vmDisposeCount()).toBe(disposeBefore + 1);
      expect(testing.closeQueueSize()).toBe(1);
      expect(pluginMessages(mid, "info", "mul:" + contents.id)).toHaveLength(0);
      expect(pluginMessages(rid, "info", "rsync-deactivate")).toHaveLength(0);
      // Repeat will-quit is idempotent: nothing left to dispose, no double delivery setup.
      electron.app.emit("will-quit");
      expect(testing.vmDisposeCount()).toBe(disposeBefore + 1);
      // Quit cancelled: the loop is alive, so the preserved unload is still delivered.
      await waitFor(
        () => pluginMessages(mid, "info", "mul:" + contents.id).length === 1,
        "unload delivered after cancelled quit",
      );
      await waitFor(() => testing.closeQueueSize() === 0, "queue drained");
      expect(pluginMessages(mid, "info", "mul:" + contents.id)).toHaveLength(1);
    },
    15000,
  );

  test(
    "reset deterministically retires queued batches without leaking VMs",
    async () => {
      const pid = "a3-reset";
      const contents = makeContents();
      applyPlan(planFor("a3rst-v1", [rendererPlugin(pid, RENDERER_SYNC)]));
      createWindow(contents);
      loadWindow(contents);
      await waitFor(() => testing.rendererPlugins().has(pid + "@" + contents.id), "loaded");
      contents.emit("destroyed");
      expect(testing.closeQueueSize()).toBe(1);
      testing.reset();
      expect(testing.closeQueueSize()).toBe(0);
      expect(testing.pendingOpsSize()).toBe(0);
    },
    15000,
  );
});

// ===========================================================================
// A3-5/6: fairness across windows and precise disposal accounting
// ===========================================================================

describe("A3 fairness and precise accounting", () => {
  test(
    "two windows destroyed back-to-back both complete: FIFO unload order, +2 disposals",
    async () => {
      const r1 = "a3-fair-r1";
      const r2 = "a3-fair-r2";
      const mid = "a3-fair-m";
      const c1 = makeContents();
      const c2 = makeContents();
      applyPlan(
        planFor("a3f-v1", [
          rendererPlugin(r1, RENDERER_SYNC),
          rendererPlugin(r2, RENDERER_SYNC),
          mainPlugin(mid, MAIN_UNLOAD),
        ]),
      );
      createWindow(c1);
      loadWindow(c1);
      createWindow(c2);
      loadWindow(c2);
      await waitFor(() => testing.rendererPlugins().has(r1 + "@" + c1.id), "r1c1");
      await waitFor(() => testing.rendererPlugins().has(r1 + "@" + c2.id), "r1c2");
      const disposeBefore = testing.vmDisposeCount();
      c1.emit("destroyed");
      c2.emit("destroyed");
      await waitFor(
        () =>
          pluginMessages(mid, "info", "mul:" + c1.id).length === 1 &&
          pluginMessages(mid, "info", "mul:" + c2.id).length === 1,
        "both unloads delivered",
      );
      await waitFor(() => testing.closeQueueSize() === 0, "queue drained");
      // Completion order across windows is intentionally unspecified (each unload carries its
      // own window handle, Gate 2 finding 6); both must arrive exactly once with precise
      // disposal accounting.
      expect(pluginMessages(mid, "info", "mul:" + c1.id)).toHaveLength(1);
      expect(pluginMessages(mid, "info", "mul:" + c2.id)).toHaveLength(1);
      // Precise accounting: 2 renderer VMs per window retired, zero pending ops left.
      expect(testing.vmDisposeCount()).toBe(disposeBefore + 4);
      expect(testing.pendingOpsSize()).toBe(0);
    },
    20000,
  );

  test(
    "never-settling async deactivate still resolves bounded with timeout log and disposal",
    async () => {
      const pid = "a3-never";
      const contents = makeContents();
      applyPlan(planFor("a3nv-v1", [rendererPlugin(pid, RENDERER_NEVER_DEACTIVATE)]));
      createWindow(contents);
      loadWindow(contents);
      await waitFor(() => testing.rendererPlugins().has(pid + "@" + contents.id), "loaded");
      const disposeBefore = testing.vmDisposeCount();
      contents.emit("destroyed");
      // destroyed returns immediately (no 2s block on the close path)...
      expect(testing.vmDisposeCount()).toBe(disposeBefore);
      // ...while the background drain honors the bounded timeout contract off-path.
      await waitFor(
        () => pluginMessages(pid, "error", "timed out").length === 1,
        "timeout logged",
        10000,
      );
      await waitFor(() => testing.closeQueueSize() === 0, "queue drained", 10000);
      expect(testing.vmDisposeCount()).toBe(disposeBefore + 1);
      expect(testing.pendingOpsSize()).toBe(0);
    },
    20000,
  );
});

// ===========================================================================
// Gate 2 finding 1: true round-robin — a never-settling head window must not
// starve a later window's unload.
// ===========================================================================

describe("Gate 2 true round-robin fairness", () => {
  test(
    "later window unloads promptly while an earlier window's 2s drain is still pending",
    async () => {
      const slow = "g2-slow";
      const fast = "g2-fast";
      const mid = "g2-fair-m";
      // Window A loads only the never-settling plugin; the plan is then revised so window B
      // loads only the fast plugin. (One plan applies to every window, so the phases must be
      // sequential: this also exercises plan-revision interplay with queued batches.)
      const cA = makeContents();
      applyPlan(
        planFor("g2f-v1", [rendererPlugin(slow, RENDERER_NEVER_DEACTIVATE), mainPlugin(mid, MAIN_UNLOAD)]),
      );
      createWindow(cA);
      loadWindow(cA);
      await waitFor(() => testing.rendererPlugins().has(slow + "@" + cA.id), "slow A");
      cA.emit("destroyed"); // 2s background drain starts

      applyPlan(
        planFor("g2f-v2", [rendererPlugin(fast, RENDERER_SYNC), mainPlugin(mid, MAIN_UNLOAD)]),
      );
      const cB = makeContents();
      createWindow(cB);
      loadWindow(cB);
      await waitFor(() => testing.rendererPlugins().has(fast + "@" + cB.id), "fast B");
      const disposeBefore = testing.vmDisposeCount();
      const tB0 = Date.now();
      cB.emit("destroyed");
      // B's unload must arrive while A's 2s drain is still in flight (no head-of-line block),
      // promptly (strictly below the 2s drain), and A's own unload must NOT have fired early
      // ahead of its running deactivate (finding 1 reentrancy regression).
      await waitFor(
        () => pluginMessages(mid, "info", "mul:" + cB.id).length === 1,
        "B unload delivered",
      );
      expect(Date.now() - tB0).toBeLessThan(1500);
      expect(pluginMessages(mid, "info", "mul:" + cA.id)).toHaveLength(0);
      expect(pluginMessages(slow, "error", "timed out")).toHaveLength(0);
      // Then the slow batch still completes exactly once.
      await waitFor(
        () => pluginMessages(slow, "error", "timed out").length === 1,
        "A timeout logged",
        10000,
      );
      await waitFor(() => testing.closeQueueSize() === 0, "queue drained", 10000);
      expect(pluginMessages(mid, "info", "mul:" + cA.id)).toHaveLength(1);
      expect(testing.vmDisposeCount()).toBe(disposeBefore + 2);
      expect(testing.pendingOpsSize()).toBe(0);
    },
    25000,
  );
});

// ===========================================================================
// Gate 2 finding 2: raw renderer cleanup executes in a surviving process.
// ===========================================================================

describe("Gate 2 raw renderer close cleanup", () => {
  test(
    "raw guest deactivate runs exactly once via the background pump",
    async () => {
      const pid = "g2-rawr";
      const contents = makeContents();
      applyPlan(
        planFor("g2r-v1", [{ id: pid, renderer: RAW_RENDERER_CLEANUP, granted: ["runtime.unsafe"] }]),
      );
      createWindow(contents);
      loadWindow(contents);
      const key = pid + "@" + contents.id;
      await waitFor(() => testing.rendererPlugins().has(key), "raw renderer loaded");
      expect(globalThis.__rawRDeactivated || 0).toBe(0);

      contents.emit("destroyed");
      // Transfer drops the map entry synchronously...
      expect(testing.rendererPlugins().has(key)).toBe(false);
      // ...while guest cleanup runs in the background (fail-closed, exactly once).
      await waitFor(() => (globalThis.__rawRDeactivated || 0) === 1, "raw cleanup ran");
      await waitFor(() => testing.closeQueueSize() === 0, "queue drained");
      await sleep(50);
      expect(globalThis.__rawRDeactivated).toBe(1);
      expect(pluginMessages(pid, "info", "rawr-deactivate")).toHaveLength(1);
    },
    15000,
  );
});

// ===========================================================================
// Gate 2 finding 3: recoverable quit semantics.
// ===========================================================================

describe("Gate 2 quit-cancel recovery", () => {
  test(
    "focus/activate recover the allocator without a new window; repeat quit re-latches",
    async () => {
      electron.app.emit("before-quit");
      expect(testing.isQuitting()).toBe(true);
      // Cancelled quit with no new window: focus proves continued life.
      electron.app.emit("browser-window-focus");
      expect(testing.isQuitting()).toBe(false);
      // Repeat quit re-latches (persistent hooks, finding 3a).
      electron.app.emit("before-quit");
      expect(testing.isQuitting()).toBe(true);
      electron.app.emit("activate");
      expect(testing.isQuitting()).toBe(false);
    },
    15000,
  );

  test(
    "will-quit-cancel still delivers preserved unload; repeat will-quit is a no-op",
    async () => {
      const rid = "g2-qc-r";
      const mid = "g2-qc-m";
      const contents = makeContents();
      applyPlan(
        planFor("g2qc-v1", [rendererPlugin(rid, RENDERER_SYNC), mainPlugin(mid, MAIN_UNLOAD)]),
      );
      createWindow(contents);
      loadWindow(contents);
      await waitFor(() => testing.rendererPlugins().has(rid + "@" + contents.id), "r loaded");
      const disposeBefore = testing.vmDisposeCount();
      contents.emit("destroyed");
      // First will-quit (cancelled by the app afterwards): sweep disposes, unload preserved.
      electron.app.emit("will-quit", { preventDefault() {} });
      expect(testing.vmDisposeCount()).toBe(disposeBefore + 1);
      // Repeat will-quit: idempotent, nothing left to dispose.
      electron.app.emit("will-quit", { preventDefault() {} });
      expect(testing.vmDisposeCount()).toBe(disposeBefore + 1);
      // Loop alive (quit cancelled): preserved unload is delivered exactly once.
      await waitFor(
        () => pluginMessages(mid, "info", "mul:" + contents.id).length === 1,
        "unload delivered",
      );
      await waitFor(() => testing.closeQueueSize() === 0, "queue drained");
      expect(pluginMessages(mid, "info", "mul:" + contents.id)).toHaveLength(1);
    },
    15000,
  );
});

// ===========================================================================
// Gate 2 finding 4: R2 stable refusal across re-reconciles.
// ===========================================================================

describe("Gate 2 R2 stable refusal", () => {
  test(
    "navigation re-reconcile neither retries nor re-logs the over-limit plugin",
    async () => {
      const ids = Array.from({ length: 9 }, (_, i) => "g2stab-" + i);
      const contents = makeContents();
      applyPlan(planFor("g2st-v1", ids.map((id) => rendererPlugin(id, RENDERER_SYNC))));
      createWindow(contents);
      loadWindow(contents);
      await waitFor(
        () => pluginMessages("g2stab-7", "info", "Renderer plugin loaded").length === 1,
        "eighth loaded",
      );
      await sleep(100);
      expect(testing.rendererPlugins().size).toBe(8);
      expect(pluginMessages("g2stab-8", "error", "limit exceeded")).toHaveLength(1);
      // Navigation re-runs reconcile on the same window/plan: the loser stays refused silently.
      loadWindow(contents);
      await sleep(300);
      expect(testing.rendererPlugins().size).toBe(8);
      expect(testing.rendererPlugins().has("g2stab-8@" + contents.id)).toBe(false);
      expect(pluginMessages("g2stab-8", "error", "limit exceeded")).toHaveLength(1);
    },
    20000,
  );
});

// ===========================================================================
// Gate 2 finding 7: slow-dispose stall bound and plan-path liveness during drain.
// ===========================================================================

describe("Gate 2 stall bounds and concurrent progress", () => {
  test(
    "CPU-bound guest deactivate never blocks the destroyed return",
    async () => {
      const pid = "g2-spin";
      const contents = makeContents();
      applyPlan(planFor("g2sp-v1", [rendererPlugin(pid, CPU_SPIN_DEACTIVATE)]));
      createWindow(contents);
      loadWindow(contents);
      await waitFor(() => testing.rendererPlugins().has(pid + "@" + contents.id), "loaded");
      const t0 = Date.now();
      contents.emit("destroyed");
      const syncMs = Date.now() - t0;
      // The 200ms guest burn happens off-path: destroyed returns in well under it.
      expect(syncMs).toBeLessThan(150);
      await waitFor(
        () => pluginMessages(pid, "info", "spin-deactivate-done").length === 1,
        "background cleanup completed",
        10000,
      );
      await waitFor(() => testing.closeQueueSize() === 0, "queue drained", 10000);
    },
    15000,
  );

  test(
    "plan-path revoke proceeds promptly while another window's 2s drain runs",
    async () => {
      const slow = "g2-conc-slow";
      const victim = "g2-conc-victim";
      const cA = makeContents();
      const cB = makeContents();
      applyPlan(
        planFor("g2cc-v1", [
          rendererPlugin(slow, RENDERER_NEVER_DEACTIVATE),
          rendererPlugin(victim, RENDERER_SYNC),
        ]),
      );
      createWindow(cA);
      loadWindow(cA);
      createWindow(cB);
      loadWindow(cB);
      await waitFor(() => testing.rendererPlugins().has(slow + "@" + cA.id), "slow loaded");
      await waitFor(() => testing.rendererPlugins().has(victim + "@" + cB.id), "victim loaded");
      cA.emit("destroyed"); // 2s background drain starts
      // Concurrent plan revision revoking the victim: served synchronously, not starved.
      const t0 = Date.now();
      applyPlan(planFor("g2cc-v2", [rendererPlugin(slow, RENDERER_NEVER_DEACTIVATE)]));
      await waitFor(
        () => testing.rendererPlugins().has(victim + "@" + cB.id) === false,
        "victim revoked",
      );
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(pluginMessages(slow, "error", "timed out")).toHaveLength(0);
      await waitFor(() => testing.closeQueueSize() === 0, "queue drained", 10000);
    },
    25000,
  );
});

// ===========================================================================
// Gate 2R: survivor P95 under adversarial drain (finding 2).
// ===========================================================================

describe("Gate 2R survivor responsiveness", () => {
  test(
    "event-loop ping P95 stays flat while a 2s never-settling drain runs",
    async () => {
      const slow = "g2r-surv-slow";
      const cA = makeContents();
      applyPlan(planFor("g2sv-v1", [rendererPlugin(slow, RENDERER_NEVER_DEACTIVATE)]));
      createWindow(cA);
      loadWindow(cA);
      await waitFor(() => testing.rendererPlugins().has(slow + "@" + cA.id), "slow loaded");
      cA.emit("destroyed"); // 2s background drain starts; destroyed itself returns in ms
      // Sample loop availability across the whole drain: 20 pings ~100ms apart (~2s span).
      const lags = [];
      for (let i = 0; i < 20; i += 1) {
        const s = Date.now();
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setImmediate(resolve));
        lags.push(Date.now() - s);
        await sleep(100);
      }
      await waitFor(() => testing.closeQueueSize() === 0, "queue drained", 10000);
      const sorted = [...lags].sort((a, b) => a - b);
      const p95 = sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))];
      const max = sorted[sorted.length - 1];
      console.log("[survivor-p95] p95=" + p95 + "ms max=" + max + "ms n=" + sorted.length);
      // Bound conclusion: with the old synchronous 2s drain every lag here would read ~2000ms;
      // the async pump keeps the loop turning at millisecond granularity.
      expect(p95).toBeLessThan(100);
      expect(max).toBeLessThan(500);
    },
    25000,
  );

  test(
    "slow-dispose bound: eight 100ms CPU-bound slices keep every turn under the cap",
    async () => {
      const ids = Array.from({ length: 8 }, (_, i) => "g2r-sd-" + i);
      const contents = makeContents();
      applyPlan(planFor("g2sd-v1", ids.map((id) => rendererPlugin(id, CPU_SPIN_100_DEACTIVATE))));
      createWindow(contents);
      loadWindow(contents);
      await waitFor(
        () => pluginMessages("g2r-sd-7", "info", "Renderer plugin loaded").length === 1,
        "eight loaded",
      );
      contents.emit("destroyed");
      // ~800ms of guest burn runs off-path in ~100ms slices; sample loop lag throughout.
      const lags = [];
      for (let i = 0; i < 16; i += 1) {
        const s = Date.now();
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setImmediate(resolve));
        lags.push(Date.now() - s);
        await sleep(50);
      }
      await waitFor(() => testing.closeQueueSize() === 0, "queue drained", 10000);
      const sorted = [...lags].sort((a, b) => a - b);
      const max = sorted[sorted.length - 1];
      console.log("[slow-dispose] max-turn-lag=" + max + "ms n=" + sorted.length);
      // No single turn may approach the old 2s synchronous block: worst observed slice sets
      // the documented per-turn bound component for CPU-bound guests (~100ms class here).
      expect(max).toBeLessThan(500);
    },
    25000,
  );
});

// ===========================================================================
// Gate 2R: plan polling continues during background cleanup (finding 4).
// ===========================================================================

describe("Gate 2R liveness during cleanup", () => {
  test(
    "three plan revisions each take effect promptly while a 2s drain runs",
    async () => {
      const slow = "g2r-dur-slow";
      const cA = makeContents();
      applyPlan(planFor("g2dur-v1", [rendererPlugin(slow, RENDERER_NEVER_DEACTIVATE)]));
      createWindow(cA);
      loadWindow(cA);
      await waitFor(() => testing.rendererPlugins().has(slow + "@" + cA.id), "slow loaded");
      cA.emit("destroyed"); // 2s background drain starts
      // Three successive plan polls (the DUR-1 poll analogue: deliver plan, expect effect).
      const latencies = [];
      for (let i = 0; i < 3; i += 1) {
        const mid = "g2r-dur-m" + i;
        const t0 = Date.now();
        applyPlan(
          planFor("g2dur-p" + i, [
            rendererPlugin(slow, RENDERER_NEVER_DEACTIVATE),
            { id: mid, main: "module.exports = { activate(ctx) { ctx.logger.info('dur-mark-" + i + "'); } };", granted: ["electron.window"] },
          ]),
        );
        // eslint-disable-next-line no-await-in-loop
        await waitFor(() => testing.mainPlugins().has(mid), "revision " + i + " applied");
        latencies.push(Date.now() - t0);
      }
      expect(latencies.length).toBe(3);
      console.log("[dur-during-cleanup] revision-ms=" + latencies.join(","));
      for (const ms of latencies) expect(ms).toBeLessThan(1500);
      expect(pluginMessages(slow, "error", "timed out")).toHaveLength(0);
      await waitFor(() => testing.closeQueueSize() === 0, "queue drained", 10000);
    },
    25000,
  );
});

// ===========================================================================
// Gate 2 round 2 finding 1: queue-empty implies no in-flight teardown.
// ===========================================================================

describe("Gate 2 queue-empty implies no in-flight work", () => {
  test(
    "in-flight batches stay queued until their slices complete",
    async () => {
      const slow = "g22-qe-slow";
      const fast = "g22-qe-fast";
      const cA = makeContents();
      const cB = makeContents();
      applyPlan(
        planFor("g22qe-v1", [
          rendererPlugin(slow, RENDERER_NEVER_DEACTIVATE),
          rendererPlugin(fast, RENDERER_SYNC),
        ]),
      );
      createWindow(cA);
      loadWindow(cA);
      createWindow(cB);
      loadWindow(cB);
      await waitFor(() => testing.rendererPlugins().has(slow + "@" + cA.id), "slow A");
      await waitFor(() => testing.rendererPlugins().has(fast + "@" + cB.id), "fast B");
      cA.emit("destroyed");
      cB.emit("destroyed");
      // Both batches must remain queued while slices are in flight (no early dequeue even
      // though B's slice finishes first); the queue drains only at the very end.
      await sleep(150);
      expect(testing.closeQueueSize()).toBe(2);
      await waitFor(() => testing.closeQueueSize() === 0, "queue drained", 10000);
    },
    25000,
  );
});

// ===========================================================================
// Gate 2 round 2 finding 3: drain-started then will-quit then cancel keeps order.
// ===========================================================================

describe("Gate 2 drain times will-quit race", () => {
  test(
    "will-quit during a running 2s drain still delivers deactivate before unload",
    async () => {
      const slow = "g22-dq-slow";
      const mid = "g22-dq-m";
      const contents = makeContents();
      applyPlan(
        planFor("g22dq-v1", [
          rendererPlugin(slow, RENDERER_NEVER_DEACTIVATE),
          mainPlugin(mid, MAIN_UNLOAD),
        ]),
      );
      createWindow(contents);
      loadWindow(contents);
      await waitFor(() => testing.rendererPlugins().has(slow + "@" + contents.id), "loaded");
      const disposeBefore = testing.vmDisposeCount();
      contents.emit("destroyed");
      await sleep(150); // drain started, still in flight
      // will-quit lands mid-drain and is then cancelled (loop stays alive).
      electron.app.emit("will-quit", { preventDefault() {} });
      // The sweep must not have disposed the in-flight VM nor fired the unload early.
      await waitFor(
        () => pluginMessages(mid, "info", "mul:" + contents.id).length === 1,
        "unload delivered",
        10000,
      );
      // Order kept: timeout (end of drain) precedes unload.
      const t = logIndex(slow, "error", "timed out");
      const u = logIndex(mid, "info", "mul:" + contents.id);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThan(u);
      await waitFor(() => testing.closeQueueSize() === 0, "queue drained", 10000);
      expect(pluginMessages(mid, "info", "mul:" + contents.id)).toHaveLength(1);
      expect(testing.vmDisposeCount()).toBe(disposeBefore + 1);
    },
    25000,
  );

  test(
    "will-quit never runs raw guest cleanup (dispose-only exit tier)",
    async () => {
      const pid = "g22-rawq";
      const contents = makeContents();
      applyPlan(
        planFor("g22rq-v1", [{ id: pid, renderer: RAW_RENDERER_CLEANUP, granted: ["runtime.unsafe"] }]),
      );
      createWindow(contents);
      loadWindow(contents);
      const key = pid + "@" + contents.id;
      await waitFor(() => testing.rendererPlugins().has(key), "raw loaded");
      contents.emit("destroyed");
      electron.app.emit("will-quit", { preventDefault() {} });
      // Synchronously: the sweep disposed nothing guest-touching (no VM here at all) and the
      // batch is still queued for the pump — checked before any pump turn can interleave.
      expect(globalThis.__rawRDeactivated || 0).toBe(0);
      expect(testing.closeQueueSize()).toBe(1);
      // ...but the surviving loop still runs it exactly once via the pump.
      await waitFor(() => (globalThis.__rawRDeactivated || 0) === 1, "raw cleanup ran", 10000);
      await waitFor(() => testing.closeQueueSize() === 0, "queue drained", 10000);
      expect(globalThis.__rawRDeactivated).toBe(1);
    },
    15000,
  );
});

// ===========================================================================
// Gate 2 round 2 finding 4: reorder squeeze and deterministic promotion.
// ===========================================================================

describe("Gate 2 R2 reorder and promotion", () => {
  test(
    "plan reorder squeezes the newly ninth active out even with matching fingerprints",
    async () => {
      const ids = Array.from({ length: 8 }, (_, i) => "g22ro-" + i);
      const contents = makeContents();
      applyPlan(planFor("g22ro-v1", ids.map((id) => rendererPlugin(id, RENDERER_SYNC))));
      createWindow(contents);
      loadWindow(contents);
      await waitFor(
        () => pluginMessages("g22ro-7", "info", "Renderer plugin loaded").length === 1,
        "eight loaded",
      );
      await sleep(100);
      expect(testing.rendererPlugins().size).toBe(8);
      // Reorder: g22ro-7 drops to ninth behind a newcomer while staying wanted; it must be
      // squeezed out although its fingerprint is unchanged, and the newcomer loads.
      applyPlan(
        planFor(
          "g22ro-v2",
          ["g22ro-new", ...ids].map((id) => rendererPlugin(id, RENDERER_SYNC)),
        ),
      );
      await waitFor(
        () => pluginMessages("g22ro-new", "info", "Renderer plugin loaded").length === 1,
        "newcomer promoted",
      );
      await sleep(100);
      expect(testing.rendererPlugins().has("g22ro-7@" + contents.id)).toBe(false);
      expect(testing.rendererPlugins().size).toBe(8);
      expect(pluginMessages("g22ro-7", "info", "squeezed out by plan reorder")).toHaveLength(1);
    },
    25000,
  );

  test(
    "removing a loaded winner deterministically promotes the previously refused candidate",
    async () => {
      const ids = Array.from({ length: 9 }, (_, i) => "g22pr-" + i);
      const contents = makeContents();
      applyPlan(planFor("g22pr-v1", ids.map((id) => rendererPlugin(id, RENDERER_SYNC))));
      createWindow(contents);
      loadWindow(contents);
      await waitFor(
        () => pluginMessages("g22pr-7", "info", "Renderer plugin loaded").length === 1,
        "eighth loaded",
      );
      await sleep(100);
      expect(pluginMessages("g22pr-8", "error", "limit exceeded")).toHaveLength(1);
      // Revision drops g22pr-0: g22pr-8 enters the first eight under the new plan and loads
      // exactly once, with no second diagnostic.
      applyPlan(planFor("g22pr-v2", ids.slice(1).map((id) => rendererPlugin(id, RENDERER_SYNC))));
      await waitFor(
        () => pluginMessages("g22pr-8", "info", "Renderer plugin loaded").length === 1,
        "refused candidate promoted",
      );
      await sleep(200);
      expect(testing.rendererPlugins().size).toBe(8);
      expect(pluginMessages("g22pr-8", "error", "limit exceeded")).toHaveLength(1);
    },
    25000,
  );
});
