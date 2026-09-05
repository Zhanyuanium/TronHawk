// Tier-2 async-op job pump tests (ADR 0008 Option B): the host-driven pending-job pump primitives
// in src/index.js — pendingOps / settleOp / drainPendingJobs / newHostPromise, plus their teardown
// behavior in disposeVM.
//
// These exercise src/index.js directly against a stub Electron host (`mock.module("electron")`
// intercepts the CJS require) with real QuickJS sandboxes: each test spawns a real context via the
// __testing.getQuickJS seam, registers a `hostThing` host function backed by newHostPromise, and
// drives settlement through the __testing.settleOp seam. No real Electron, no DOM/network/storage
// behavior — only the pump primitives the rest of the async infra is built on.
//
// Run with `bun test` from crates/runtime/js (auto-discovers *.test.js).
const { describe, test, expect, beforeEach, afterEach, mock } = require("bun:test");
const { EventEmitter } = require("events");

// --- Stub Electron host (same harness shape as index.test.js) ---
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

// --- Shared test state / helpers ---

let pluginLogs = []; // [pluginId, level, message]

function pluginMessages(id, level, needle) {
  return pluginLogs.filter(
    ([pid, lvl, message]) =>
      pid === id && (level === undefined || lvl === level) && message.includes(needle),
  );
}

// The plugin id these tests report through (used for pump drain/settle error logs only).
const PID = "pump";

beforeEach(async () => {
  testing.reset();
  electron.app.removeAllListeners();
  pluginLogs = [];
  runtime.start(electron.app, {
    runtimeLog: () => {},
    pluginLog: (pid, level, message) => pluginLogs.push([pid, level, String(message)]),
  });
});

afterEach(() => {
  // No plugins were loaded (these tests drive raw VMs directly), so there is nothing to deactivate.
  testing.reset();
  electron.app.removeAllListeners();
});

// Spawn a real QuickJS context the same way the production loader does (memory/stack limits).
async function newVM() {
  const QuickJS = await testing.getQuickJS();
  const vm = QuickJS.newContext();
  vm.runtime.setMemoryLimit(64 * 1024 * 1024);
  vm.runtime.setMaxStackSize(1024 * 512);
  return vm;
}

// Evaluate a guest script (finished with `0` so the completion value is a disposable number, never
// a promise we would have to keep alive).
function evalGuest(vm, code) {
  const result = vm.evalCode(code);
  if (result.error) {
    let message = "guest eval failed";
    try {
      const dumped = vm.dump(result.error);
      message = dumped && dumped.message ? String(dumped.message) : JSON.stringify(dumped);
    } catch (_e) {
      /* best effort */
    }
    result.error.dispose();
    throw new Error(message);
  }
  result.value.dispose();
}

// Read a guest global (array/string/boolean — never a promise) into a host value.
function dumpGlobal(vm, name) {
  const handle = vm.getProp(vm.global, name);
  try {
    return vm.dump(handle);
  } finally {
    if (handle.alive) handle.dispose();
  }
}

// Register `hostThing(n)`: an async host API backed by the pump. It creates a host promise via
// newHostPromise, records the op for the test to settle, and returns the deferred's promise handle
// so the guest `await` suspends on it. ops receives { opId, arg } per call.
function registerHostThing(vm, ops) {
  const hostThing = vm.newFunction("hostThing", (argHandle) => {
    const arg = vm.getNumber(argHandle);
    const { opId, handle } = testing.newHostPromise(vm, PID, "hostThing");
    ops.push({ opId, arg });
    return handle;
  });
  vm.setProp(vm.global, "hostThing", hostThing);
  hostThing.dispose();
}

// Register `poke()`: a host function that re-enters drainPendingJobs while a drain is already
// running (used to prove the vmDrains re-entrancy guard).
function registerPoke(vm) {
  const poke = vm.newFunction("poke", () => {
    testing.drainPendingJobs(vm, PID, "poke-drain");
    return vm.undefined;
  });
  vm.setProp(vm.global, "poke", poke);
  poke.dispose();
}

function settleResolve(vm, opId, value) {
  testing.settleOp(opId, "resolve", () => vm.newNumber(value));
}

function settleReject(vm, opId, message) {
  testing.settleOp(opId, "reject", () => vm.newError(message));
}

// ===========================================================================
// Async-op job pump
// ===========================================================================

describe("async-op job pump (Tier-2 primitives)", () => {
  test(
    "a host deferred resolved via settleOp delivers its value to the guest await and runs the continuation",
    async () => {
      const vm = await newVM();
      const ops = [];
      registerHostThing(vm, ops);
      evalGuest(vm, `
        globalThis.__p = [];
        globalThis.__main = async () => {
          const v = await hostThing(41);
          __p.push(v);
        };
        globalThis.__pending = __main();
        0;
      `);

      // The guest suspended on a registered pending host op.
      expect(ops).toHaveLength(1);
      expect(ops[0].arg).toBe(41);
      expect(testing.pendingOpsSize()).toBe(1);
      expect(dumpGlobal(vm, "__p")).toEqual([]);

      // Resolving through the pump drains synchronously, so the continuation has already run when
      // settleOp returns.
      settleResolve(vm, ops[0].opId, 41);
      expect(dumpGlobal(vm, "__p")).toEqual([41]);
      expect(testing.pendingOpsSize()).toBe(0);
      expect(pluginMessages(PID, "error", "settle failed")).toHaveLength(0);

      vm.dispose(); // throws if any QuickJS handle leaked
    },
    20000,
  );

  test(
    "a host deferred rejected via settleOp is catchable inside the guest (try/catch sees the error)",
    async () => {
      const vm = await newVM();
      const ops = [];
      registerHostThing(vm, ops);
      evalGuest(vm, `
        globalThis.__caught = false;
        globalThis.__errMsg = "";
        globalThis.__main = async () => {
          try {
            await hostThing(1);
          } catch (e) {
            globalThis.__caught = true;
            globalThis.__errMsg = String(e && e.message);
          }
        };
        globalThis.__pending = __main();
        0;
      `);

      expect(ops).toHaveLength(1);
      settleReject(vm, ops[0].opId, "boom");

      // The rejection reached the guest and the catch branch ran with the host error message.
      expect(dumpGlobal(vm, "__caught")).toBe(true);
      expect(dumpGlobal(vm, "__errMsg")).toBe("boom");
      expect(testing.pendingOpsSize()).toBe(0);
      // The rejection was handled guest-side; the pump must not have reported a settle/drain error.
      expect(pluginMessages(PID, "error", "settle failed")).toHaveLength(0);

      vm.dispose();
    },
    20000,
  );

  test(
    "chained/nested awaits settle: the second host op is created after the first resolves and both values flow",
    async () => {
      const vm = await newVM();
      const ops = [];
      registerHostThing(vm, ops);
      evalGuest(vm, `
        globalThis.__p = [];
        globalThis.__main = async () => {
          const a = await hostThing(10);
          const b = await hostThing(a);
          __p.push(a * 100 + b);
        };
        globalThis.__pending = __main();
        0;
      `);

      // Only the first op exists until its resolve runs the continuation that awaits hostThing(a).
      expect(ops).toHaveLength(1);
      settleResolve(vm, ops[0].opId, 10);

      // The first drain resumed the guest, which created the second pending op with the awaited
      // value (10) as its argument.
      expect(ops).toHaveLength(2);
      expect(ops[1].arg).toBe(10);
      expect(dumpGlobal(vm, "__p")).toEqual([]);

      settleResolve(vm, ops[1].opId, 11);
      expect(dumpGlobal(vm, "__p")).toEqual([1011]); // a === 10, b === 11
      expect(testing.pendingOpsSize()).toBe(0);
      expect(pluginMessages(PID, "error", "settle failed")).toHaveLength(0);

      vm.dispose();
    },
    20000,
  );

  test(
    "Promise.all of two host deferreds settles with both delivered values",
    async () => {
      const vm = await newVM();
      const ops = [];
      registerHostThing(vm, ops);
      evalGuest(vm, `
        globalThis.__p = [];
        globalThis.__main = async () => {
          const [x, y] = await Promise.all([hostThing(1), hostThing(2)]);
          __p.push(x * 10 + y);
        };
        globalThis.__pending = __main();
        0;
      `);

      // Both ops were registered synchronously before __main suspended on the Promise.all.
      expect(ops).toHaveLength(2);

      // Settling in either order must resolve the outer promise with both values.
      settleResolve(vm, ops[0].opId, 1);
      settleResolve(vm, ops[1].opId, 2);

      expect(dumpGlobal(vm, "__p")).toEqual([12]); // x === 1 and y === 2 both arrived
      expect(testing.pendingOpsSize()).toBe(0);
      expect(pluginMessages(PID, "error", "settle failed")).toHaveLength(0);

      vm.dispose();
    },
    20000,
  );

  test(
    "drainPendingJobs is re-entrancy-guarded: a drain attempted while already draining is a no-op",
    async () => {
      const vm = await newVM();
      const ops = [];
      registerHostThing(vm, ops);
      registerPoke(vm); // poke() re-enters drainPendingJobs from inside the guest continuation
      evalGuest(vm, `
        globalThis.__p = [];
        globalThis.__main = async () => {
          const v = await hostThing(41);
          poke();
          __p.push(v);
        };
        globalThis.__pending = __main();
        0;
      `);

      expect(testing.drainCount()).toBe(0);

      settleResolve(vm, ops[0].opId, 41);

      // The settle ran exactly one drain; poke()'s nested drainPendingJobs hit the vmDrains guard
      // and returned without starting a second pump loop (drainCount stays 1)…
      expect(testing.drainCount()).toBe(1);
      // …and the value still reached the guest continuation that issued the nested call.
      expect(dumpGlobal(vm, "__p")).toEqual([41]);
      expect(testing.pendingOpsSize()).toBe(0);
      expect(pluginMessages(PID, "error", "settle failed")).toHaveLength(0);

      vm.dispose();
    },
    20000,
  );

  test(
    "after disposeVM a late settleOp on that VM's pending op is a no-op: no throw, no leak, no error log",
    async () => {
      const vm = await newVM();
      const ops = [];
      registerHostThing(vm, ops);
      evalGuest(vm, `
        globalThis.__p = [];
        globalThis.__main = async () => {
          const v = await hostThing(5);
          __p.push(v);
        };
        globalThis.__pending = __main();
        0;
      `);

      // The guest is parked on an unresolved host op.
      expect(ops).toHaveLength(1);
      expect(testing.pendingOpsSize()).toBe(1);

      // Teardown while the op is still pending: disposeVM must clean up the op's deferred (no
      // handle leak) and forget the VM.
      testing.disposeVM(vm);
      expect(testing.pendingOpsSize()).toBe(0);

      // A late settle for the torn-down op is a deliberate no-op: it must not throw, must not run
      // makeHandle (the VM is gone), and must not log a "settle failed" error.
      expect(() =>
        testing.settleOp(ops[0].opId, "resolve", () => {
          throw new Error("late settle reached makeHandle on a disposed VM");
        }),
      ).not.toThrow();
      expect(testing.pendingOpsSize()).toBe(0);
      expect(pluginMessages(PID, "error", "settle failed")).toHaveLength(0);
    },
    20000,
  );
});
