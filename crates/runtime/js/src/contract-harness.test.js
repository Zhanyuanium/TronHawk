// Contract-harness unit tests (Phase 2): the canonical QuickJS module/lifecycle
// convention in src/contract-harness.js — the same convention the host uses in
// src/index.js (runMainPlugin/runRendererPlugin) and the CLI reuses for
// `tronhawk test --sandbox`. No Electron needed: the harness mounts a
// permission-gated ctx directly.
//
// Run with `bun test` from crates/runtime/js.
const { describe, test, expect } = require("bun:test");

const {
  CONTRACT_VERSION,
  NETWORK_ACCESS_DENIED,
  checkStaticContract,
  runContractCheck,
} = require("./contract-harness.js");

const RENDERER_PERMS = ["renderer.css", "renderer.script"];

function logText(report) {
  return report.logs.map(([, message]) => message).join("\n");
}

describe("contract version + static checks", () => {
  test("contract version is 1", () => {
    expect(CONTRACT_VERSION).toBe(1);
  });

  test("denied-network string matches the host denied stub", () => {
    expect(NETWORK_ACCESS_DENIED).toBe("network.access not granted");
  });

  test("clean CJS passes static checks", () => {
    expect(
      checkStaticContract("module.exports = { activate(){}, deactivate(){} };"),
    ).toEqual([]);
  });

  test("ESM import/export residue fails static checks", () => {
    expect(checkStaticContract('import x from "y";\nmodule.exports = {};')).not.toEqual([]);
    expect(checkStaticContract("export default { activate(){}, deactivate(){} };")).not.toEqual(
      [],
    );
    expect(checkStaticContract("exports.default = {};")).not.toEqual([]);
  });

  test("residual require fails static checks", () => {
    expect(checkStaticContract('const fs = require("fs");\nmodule.exports = {};')).not.toEqual(
      [],
    );
  });
});

describe("lifecycle contract", () => {
  test("valid sync entry passes with logs captured", async () => {
    const report = await runContractCheck({
      source: `module.exports = {
        activate(ctx) { ctx.logger.info("hello"); ctx.script.setDocumentTitle("T"); },
        deactivate(ctx) { ctx.logger.info("bye"); },
      };`,
      permissions: RENDERER_PERMS,
      kind: "renderer",
    });
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
    expect(logText(report)).toContain("hello");
    expect(logText(report)).toContain("bye");
    expect(report.calls.setDocumentTitle).toEqual(["T"]);
    expect(report.async.activateWasAsync).toBe(false);
  });

  test("async activate/deactivate drain to fulfillment", async () => {
    const report = await runContractCheck({
      source: `module.exports = {
        activate(ctx) { return Promise.resolve().then(() => ctx.logger.info("async-on")); },
        deactivate(ctx) { return Promise.resolve().then(() => ctx.logger.info("async-off")); },
      };`,
      permissions: RENDERER_PERMS,
      kind: "renderer",
    });
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.async.activateWasAsync).toBe(true);
    expect(report.async.deactivateWasAsync).toBe(true);
    expect(logText(report)).toContain("async-on");
    expect(logText(report)).toContain("async-off");
  });

  test("missing deactivate fails the shape check", async () => {
    const report = await runContractCheck({
      source: `module.exports = { activate(ctx) {} };`,
      permissions: RENDERER_PERMS,
      kind: "renderer",
    });
    expect(report.ok).toBe(false);
    expect(report.issues.some((m) => m.includes("deactivate"))).toBe(true);
  });

  test("throwing activate fails closed", async () => {
    const report = await runContractCheck({
      source: `module.exports = {
        activate(ctx) { throw new Error("boom-sync"); },
        deactivate(ctx) {},
      };`,
      permissions: RENDERER_PERMS,
      kind: "renderer",
    });
    expect(report.ok).toBe(false);
    expect(report.issues.some((m) => m.includes("boom-sync"))).toBe(true);
  });

  test("rejected async activate fails closed", async () => {
    const report = await runContractCheck({
      source: `module.exports = {
        activate(ctx) { return Promise.reject(new Error("boom-async")); },
        deactivate(ctx) {},
      };`,
      permissions: RENDERER_PERMS,
      kind: "renderer",
    });
    expect(report.ok).toBe(false);
    expect(report.issues.some((m) => m.includes("boom-async"))).toBe(true);
  });

  test("non-void deactivate fails the sync-void contract", async () => {
    const report = await runContractCheck({
      source: `module.exports = {
        activate(ctx) {},
        deactivate(ctx) { return { not: "void" }; },
      };`,
      permissions: RENDERER_PERMS,
      kind: "renderer",
    });
    expect(report.ok).toBe(false);
    expect(report.issues.some((m) => m.includes("expected undefined"))).toBe(true);
  });

  test("Node globals are absent and touching them fails", async () => {
    const report = await runContractCheck({
      source: `module.exports = {
        activate(ctx) { ctx.logger.info("node:" + process.versions.node); },
        deactivate(ctx) {},
      };`,
      permissions: RENDERER_PERMS,
      kind: "renderer",
    });
    expect(report.ok).toBe(false);
    expect(report.issues.some((m) => m.includes("process"))).toBe(true);
  });
});

describe("permission-gated ctx", () => {
  test("denied network.request rejects with a catchable error", async () => {
    const report = await runContractCheck({
      source: `module.exports = {
        activate(ctx) {
          return ctx.network.request({ url: "https://example.com/" }).then(
            () => ctx.logger.info("UNEXPECTED-RESOLVE"),
            (e) => ctx.logger.info("DENIED:" + (e && e.message ? e.message : e)),
          );
        },
        deactivate(ctx) {},
      };`,
      // No network.access grant: the denied stub must be mounted.
      permissions: RENDERER_PERMS,
      kind: "renderer",
    });
    expect(report.ok).toBe(true);
    expect(logText(report)).toContain("DENIED:" + NETWORK_ACCESS_DENIED);
  });

  test("granted network.request resolves a canned response", async () => {
    const report = await runContractCheck({
      source: `module.exports = {
        activate(ctx) {
          return ctx.network.request({ url: "https://example.com/" }).then((res) => {
            ctx.logger.info("NET-STATUS:" + res.status);
          });
        },
        deactivate(ctx) {},
      };`,
      permissions: [...RENDERER_PERMS, "network.access"],
      kind: "renderer",
    });
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
    expect(logText(report)).toContain("NET-STATUS:200");
    expect(report.calls.networkRequest).toEqual([{ url: "https://example.com/" }]);
  });

  test("main entry runs with the electron.window surface", async () => {
    const report = await runContractCheck({
      source: `module.exports = {
        activate(ctx) {
          ctx.logger.info("main-on");
          ctx.window.onCreated((win) => ctx.logger.info("win:" + win));
        },
        deactivate(ctx) { ctx.logger.info("main-off"); },
      };`,
      permissions: ["electron.window"],
      kind: "main",
    });
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.calls.windowOnCreated).toEqual([true]);
  });

  test("renderer windowControls mount/unmount requires electron.windowControls", async () => {
    const denied = await runContractCheck({
      source: `module.exports = {
        activate(ctx) {
          return ctx.windowControls.mount().then(
            () => ctx.logger.info("UNEXPECTED-RESOLVE"),
            (e) => ctx.logger.info("DENIED:" + (e && e.message ? e.message : e)),
          );
        },
        deactivate(ctx) {},
      };`,
      permissions: RENDERER_PERMS,
      kind: "renderer",
    });
    // Without the grant ctx.windowControls is absent, so the entry throws a
    // TypeError (cannot read mount of undefined) — still a failing contract.
    expect(denied.ok).toBe(false);

    const granted = await runContractCheck({
      source: `module.exports = {
        activate(ctx) {
          return ctx.windowControls.mount().then(() => {
            ctx.logger.info("WC-MOUNTED");
            return ctx.windowControls.unmount().then(() => ctx.logger.info("WC-UNMOUNTED"));
          });
        },
        deactivate(ctx) {},
      };`,
      permissions: [...RENDERER_PERMS, "electron.windowControls"],
      kind: "renderer",
    });
    expect(granted.issues).toEqual([]);
    expect(granted.ok).toBe(true);
    expect(logText(granted)).toContain("WC-MOUNTED");
    expect(logText(granted)).toContain("WC-UNMOUNTED");
    expect(granted.calls.windowControlsMount).toEqual([true]);
    expect(granted.calls.windowControlsUnmount).toEqual([true]);
  });
});

describe("Gate 3: deadline-bounded promise drain", () => {
  test("Promise continuation infinite loop fails finite instead of hanging", async () => {
    // The reported shape: a single stuck job — a promise continuation that
    // never yields. Without a CPU deadline around executePendingJobs slices
    // (production parity: drainPendingJobs in src/index.js), `timeoutMs`
    // cannot interrupt it and the harness hangs. With the deadline the slice
    // is cut (~QUICKJS_CPU_DEADLINE_MS) and the hook fails closed.
    // Note: the loop must be a synchronous never-yielding continuation (not a
    // self-rescheduling microtask chain): the engine offers no cancel-pending-
    // jobs API, so a VM torn down with an ever-growing job queue cannot free
    // its runtime.
    const report = await runContractCheck({
      source: `module.exports = {
        activate(ctx) {
          return Promise.resolve().then(() => {
            let i = 0;
            while (true) { i++; }
          });
        },
        deactivate(ctx) {},
      };`,
      permissions: RENDERER_PERMS,
      kind: "renderer",
    });
    expect(report.ok).toBe(false);
    expect(
      report.issues.some((m) => /timed out|CPU deadline|pump failed|interrupt/i.test(m)),
    ).toBe(true);
  }, 15000);

  test("async hook resolving to a concrete value is accepted (host parity)", async () => {
    // Host parity: watchAsyncActivate/drainThenableResult in src/index.js never
    // inspect the fulfilled value — fulfillment of any value accepts. The SDK
    // drain helper (drainActivate/drainDeactivate) agrees since Gate 3.
    const report = await runContractCheck({
      source: `module.exports = {
        activate(ctx) { return Promise.resolve(42); },
        deactivate(ctx) { return Promise.resolve("oops"); },
      };`,
      permissions: RENDERER_PERMS,
      kind: "renderer",
    });
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.async.activateWasAsync).toBe(true);
    expect(report.async.deactivateWasAsync).toBe(true);
  });
});

describe("Gate 3: three-party surface parity (host is authoritative)", () => {
  test("dom.observe returns a callable disconnect (host parity)", async () => {
    const report = await runContractCheck({
      source: `module.exports = {
        activate(ctx) {
          const disc = ctx.dom.observe(".row", () => {});
          ctx.logger.info("OBSERVE-TYPE:" + typeof disc);
          disc();
          disc();
          ctx.logger.info("DISCONNECT-OK");
        },
        deactivate(ctx) {},
      };`,
      permissions: [...RENDERER_PERMS, "renderer.dom"],
      kind: "renderer",
    });
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(logText(report)).toContain("OBSERVE-TYPE:function");
    expect(logText(report)).toContain("DISCONNECT-OK");
    expect(report.calls.domObserve).toEqual([".row"]);
    // Second disconnect is an idempotent no-op: recorded exactly once.
    expect(report.calls.domDisconnect).toEqual([".row"]);
  });

  test("main harness exposes the implemented window + lifecycle-event surface", async () => {
    const report = await runContractCheck({
      source: `module.exports = {
        activate(ctx) {
          ctx.window.onCreated(() => {});
          ctx.window.setOpacity(1, 0.5);
          ctx.window.setSize(1, 800, 600);
          ctx.window.setPosition(1, 10, 20);
          ctx.window.setVibrancy(1, "sidebar");
          ctx.window.setMica(1, true);
          ctx.onLoad(() => {});
          ctx.onRendererReady(() => {});
          ctx.onUnload(() => {});
          ctx.logger.info("MAIN-SURFACE-OK");
        },
        deactivate(ctx) { ctx.logger.info("main-off"); },
      };`,
      permissions: ["electron.window"],
      kind: "main",
    });
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
    expect(logText(report)).toContain("MAIN-SURFACE-OK");
    expect(report.calls.windowSetOpacity).toHaveLength(1);
    expect(report.calls.windowSetSize).toHaveLength(1);
    expect(report.calls.windowSetPosition).toHaveLength(1);
    expect(report.calls.windowSetVibrancy).toHaveLength(1);
    expect(report.calls.windowSetMica).toHaveLength(1);
    expect(report.calls.lifecycleSubscribe.map((s) => s.event).sort()).toEqual([
      "onLoad",
      "onRendererReady",
      "onUnload",
    ]);
  });

  test("missing activate/deactivate still fails as an explicit authoring rule (stricter than host)", async () => {    const noDeact = await runContractCheck({
      source: `module.exports = { activate(ctx) {} };`,
      permissions: RENDERER_PERMS,
      kind: "renderer",
    });
    expect(noDeact.ok).toBe(false);
    expect(noDeact.issues.some((m) => m.includes("deactivate"))).toBe(true);
    expect(noDeact.issues.some((m) => m.includes("authoring rule"))).toBe(true);

    const noAct = await runContractCheck({
      source: `module.exports = { deactivate(ctx) {} };`,
      permissions: RENDERER_PERMS,
      kind: "renderer",
    });
    expect(noAct.ok).toBe(false);
    expect(noAct.issues.some((m) => m.includes("activate"))).toBe(true);
    expect(noAct.issues.some((m) => m.includes("authoring rule"))).toBe(true);
  });

  test("lifecycle-sourced numeric handles record verbatim in window ops (host parity)", async () => {
    // The harness never fires lifecycle callbacks (no live windows), so the
    // guest below stands in for one: a numeric id received from onCreated /
    // onRendererReady / onUnload flows unchanged into window ops. The host
    // issues BrowserWindow.id from all three events when a window is bound
    // (issuedWindowHandle) and resolves via fromId then a contents-id scan
    // on miss — proven end-to-end by the "unified WindowHandle" / collision
    // tests in platform.test.js.
    const report = await runContractCheck({
      source: `module.exports = {
        activate(ctx) {
          const fromLifecycle = 7;
          ctx.window.setOpacity(fromLifecycle, 0.5);
          ctx.window.setSize(fromLifecycle, 800, 600);
          ctx.window.setPosition(fromLifecycle, 10, 20);
          ctx.logger.info("handles-flowed");
        },
        deactivate(ctx) {},
      };`,
      permissions: ["electron.window"],
      kind: "main",
    });
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.calls.windowSetOpacity).toEqual([{ window: 7, opacity: 0.5 }]);
    expect(report.calls.windowSetSize).toEqual([{ window: 7, width: 800, height: 600 }]);
    expect(report.calls.windowSetPosition).toEqual([{ window: 7, x: 10, y: 20 }]);
    expect(logText(report)).toContain("handles-flowed");
  });
});
