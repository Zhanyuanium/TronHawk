// Tier-2 async host-API tests for `ctx.network` (ADR 0008 Option B).
//
// These exercise src/index.js directly against a stub Electron host (`mock.module("electron")`)
// with real QuickJS sandboxes. A fake `request` transport is injected through `runtime.start(...)`
// so a main plugin granted `network.access` can `await ctx.network.request(...)` and receive the
// Core-side fetch result delivered by the in-process pending-job pump.
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
const { applyPlan } = runtime;

// --- Shared test state / helpers ---

let pluginLogs = []; // [pluginId, level, message]
// The fake transport: `request(method, params, opts)` resolves to `{ id, envelope }`. Tests drive
// the respond queue to simulate a successful networkRequest or a transport error.
let requestCalls = []; // [method, params, opts]
let respondQueue = []; // functions that return { id, envelope } to resolve in order
let requestFailQueue = []; // errors to reject in order
let nextRequestId = 1;

function pluginMessages(id, level, needle) {
  return pluginLogs.filter(
    ([pid, lvl, message]) =>
      pid === id && (level === undefined || lvl === level) && message.includes(needle),
  );
}

function makeTransport() {
  return (method, params, opts) => {
    const id = nextRequestId++;
    requestCalls.push([method, params, opts]);
    if (requestFailQueue.length > 0) {
      return Promise.reject(requestFailQueue.shift());
    }
    const respond = respondQueue.shift();
    if (!respond) {
      return new Promise(() => {}); // hang if the test did not queue a response
    }
    return Promise.resolve(respond(id));
  };
}

const PID = "com.example.network";

function plan(revision, mainSource, grants) {
  return {
    revision,
    plugins: [{ id: PID, version: "1", granted: grants, main: mainSource, renderer: null, css: null }],
  };
}

// A main plugin that, on activate, calls ctx.network.request and records the outcome in a guest
// global. `requestArgs` matches {url, method}. The outcome string is captured so the test can read
// it back from `ctx.__result`.
function networkActivator(requestArgs) {
  const args = JSON.stringify(requestArgs);
  return `
    module.exports = {
      activate: async (ctx) => {
        const resp = await ctx.network.request(${args});
        ctx.logger.info("NET-OK:" + JSON.stringify(resp));
        globalThis.__result = "resolved";
      },
    };
  `;
}

async function loadNetworkPlugin({ grants = ["network.access"], requestArgs = { url: "https://api.example.com/", method: "GET" } } = {}) {
  applyPlan(plan("r1", networkActivator(requestArgs), grants));
  // The runtime plan-polls getExecutionPlan over the same transport, so a networkRequest may not be
  // the first call. Wait until the networkRequest call appears (the plugin's activate ran).
  await waitFor(() => requestCalls.some(([method]) => method === "networkRequest"), "networkRequest sent", 8000);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, what, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error("timeout waiting for: " + what);
}

beforeEach(async () => {
  testing.reset();
  electron.app.removeAllListeners();
  pluginLogs = [];
  requestCalls = [];
  respondQueue = [];
  requestFailQueue = [];
  nextRequestId = 1;
  runtime.start(electron.app, {
    runtimeLog: () => {},
    pluginLog: (pid, level, message) => pluginLogs.push([pid, level, String(message)]),
    request: makeTransport(),
  });
  await sleep(0);
});

afterEach(() => {
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

describe("ctx.network (ADR 0008)", () => {
  test("a network.access plugin loads and sends networkRequest with the request shape", async () => {
    await loadNetworkPlugin();
    const call = requestCalls.find(([method]) => method === "networkRequest");
    expect(call).toBeDefined();
    const method = call[0];
    const params = call[1];
    expect(method).toBe("networkRequest");
    expect(params.pluginId).toBe(PID);
    expect(params.url).toBe("https://api.example.com/");
    expect(params.method).toBe("GET");
    expect(params.headers).toEqual({});
    expect(params.body).toBe("");
  });

  test("ctx.network.request resolves a NetworkResponse to the awaiting guest", async () => {
    respondQueue.push((id) => ({
      id,
      envelope: { version: "0.1", id, result: { status: 200, headers: { "content-type": "application/json" }, body: "{\"ok\":true}" } },
    }));
    await loadNetworkPlugin();
    await waitFor(() => pluginMessages(PID, "info", "NET-OK").length > 0, "resolved plugin log");
    const ok = pluginMessages(PID, "info", "NET-OK")[0][2];
    expect(ok).toContain('"status":200');
    expect(ok).toContain('"body":"{\\"ok\\":true}"');
    // The plugin is still registered (activation settled via the pump).
    expect(testing.mainPlugins().has(PID)).toBe(true);
  });

  test("ctx.network.request rejects the guest promise on a transport error", async () => {
    requestFailQueue.push(new Error("Core unreachable"));
    const src = `
      module.exports = {
        activate: async (ctx) => {
          try {
            await ctx.network.request({ url: "https://api.example.com/", method: "GET" });
            ctx.logger.info("NET-UNEXPECTED-RESOLVE");
          } catch (e) {
            ctx.logger.info("NET-REJECT:" + (e && e.message ? e.message : e));
          }
        },
      };
    `;
    applyPlan(plan("r1", src, ["network.access"]));
    await waitFor(() => pluginMessages(PID, "info", "NET-REJECT").length > 0, "rejected plugin log");
    expect(pluginMessages(PID, "info", "NET-REJECT").length).toBe(1);
    expect(pluginMessages(PID, "info", "NET-UNEXPECTED-RESOLVE").length).toBe(0);
  });

  test("ctx.network denied stub rejects with a catchable error when network.access is missing", async () => {
    // Without network.access the runtime mounts a denied stub (SDK PluginContext requires
    // ctx.network): request() must return a rejected Promise — never throw synchronously — with
    // "network.access not granted", and must never touch the networkRequest transport.
    const withoutAccess = `
      module.exports = {
        activate: async (ctx) => {
          ctx.logger.info("NET-TYPEOF:" + (typeof ctx.network));
          let syncThrew = false;
          let p = null;
          try {
            p = ctx.network.request({ url: "https://api.example.com/", method: "GET" });
          } catch (e) {
            syncThrew = true;
          }
          ctx.logger.info("NET-SYNC-THREW:" + syncThrew);
          try {
            await p;
            ctx.logger.info("NET-UNEXPECTED-RESOLVE");
          } catch (e) {
            ctx.logger.info("NET-DENIED:" + (e && e.message ? e.message : e));
          }
        },
      };
    `;
    applyPlan(plan("r1", withoutAccess, ["electron.window"]));
    await waitFor(() => pluginMessages(PID, "info", "NET-TYPEOF").length > 0, "plugin loaded");
    await waitFor(() => pluginMessages(PID, "info", "NET-DENIED").length > 0, "denied rejection");
    expect(pluginMessages(PID, "info", "NET-TYPEOF")[0][2]).toBe("NET-TYPEOF:object");
    expect(pluginMessages(PID, "info", "NET-SYNC-THREW")[0][2]).toBe("NET-SYNC-THREW:false");
    expect(pluginMessages(PID, "info", "NET-DENIED")[0][2]).toContain("network.access not granted");
    expect(pluginMessages(PID, "info", "NET-UNEXPECTED-RESOLVE").length).toBe(0);
    expect(requestCalls.some(([method]) => method === "networkRequest")).toBe(false);
    // A network-only grant still loads (wanted-predicate widened) — verified by a separate test above.
    expect(testing.mainPlugins().has(PID)).toBe(true);
  });
});
