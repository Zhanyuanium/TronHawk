// Denied network stubs (main/renderer/raw) + renderer ctx.css host functions.
//
// Covers the two bounded runtime changes in src/index.js:
// - ctx.network is always present (SDK PluginContext requires it); without network.access it is a
//   denied stub whose request() returns a rejected Promise ("network.access not granted"), never a
//   synchronous throw, and never touches the networkRequest transport.
// - ctx.css (renderer-only, gated by renderer.css) bridges contents.insertCSS / removeCssKey.
//
// Run with `bun test` from crates/runtime/js.
const { describe, test, expect, beforeEach, afterEach, mock } = require("bun:test");
const { EventEmitter } = require("events");

const electron = {
  BrowserWindow: { getAllWindows: () => [], fromId: () => null },
  app: new EventEmitter(),
  protocol: {},
};
mock.module("electron", () => electron);

const runtime = require("./index.js");
const testing = runtime.__testing;
const { applyPlan } = runtime;

let pluginLogs = [];
let requestCalls = [];
let respondQueue = [];
let requestFailQueue = [];
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, what, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error("timeout waiting for: " + what);
}

let nextContentsId = 100;
function makeContents(overrides = {}) {
  const contents = new EventEmitter();
  contents.id = nextContentsId++;
  contents.getType = () => "window";
  const inserted = [];
  const removed = [];
  contents.insertCSS =
    overrides.insertCSS ||
    (async (css) => {
      inserted.push(css);
      return "css-key-" + contents.id + "-" + inserted.length;
    });
  contents.removeInsertedCSS =
    overrides.removeInsertedCSS ||
    (async (key) => {
      removed.push(key);
    });
  contents.isDestroyed = overrides.isDestroyed || (() => false);
  contents.executeJavaScript = overrides.executeJavaScript || (async () => true);
  contents.__inserted = inserted;
  contents.__removed = removed;
  return contents;
}

function loadRendererPlugin({ pid, grants, rendererSource, contents, revision = "r1" }) {
  const c = contents || makeContents();
  electron.app.emit("web-contents-created", null, c);
  applyPlan({
    revision,
    plugins: [{ id: pid, version: "1", granted: grants, renderer: rendererSource, css: null, main: null }],
  });
  c.emit("did-finish-load");
  return c;
}

beforeEach(async () => {
  testing.reset();
  electron.app.removeAllListeners();
  pluginLogs = [];
  requestCalls = [];
  respondQueue = [];
  requestFailQueue = [];
  nextRequestId = 1;
  delete globalThis.__rawNetworkProbe;
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
  delete globalThis.__rawNetworkProbe;
});

describe("denied network stubs", () => {
  test("renderer without network.access gets a rejecting stub (no sync throw, no transport)", async () => {
    const pid = "stub-renderer";
    const src = `
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
          ctx.logger.info("NET-THENABLE:" + (!!p && typeof p.then === "function"));
          try {
            await p;
            ctx.logger.info("NET-UNEXPECTED-RESOLVE");
          } catch (e) {
            ctx.logger.info("NET-DENIED:" + (e && e.message ? e.message : e));
          }
        },
      };
    `;
    loadRendererPlugin({ pid, grants: ["renderer.script"], rendererSource: src });
    await waitFor(() => pluginMessages(pid, "info", "NET-DENIED").length > 0, "renderer denied rejection");
    expect(pluginMessages(pid, "info", "NET-TYPEOF")[0][2]).toBe("NET-TYPEOF:object");
    expect(pluginMessages(pid, "info", "NET-SYNC-THREW")[0][2]).toBe("NET-SYNC-THREW:false");
    expect(pluginMessages(pid, "info", "NET-THENABLE")[0][2]).toBe("NET-THENABLE:true");
    expect(pluginMessages(pid, "info", "NET-DENIED")[0][2]).toContain("network.access not granted");
    expect(pluginMessages(pid, "info", "NET-UNEXPECTED-RESOLVE").length).toBe(0);
    expect(requestCalls.some(([method]) => method === "networkRequest")).toBe(false);
    expect(testing.rendererPlugins().has(`${pid}@${nextContentsId - 1}`)).toBe(true);
  });

  test("raw main without network.access gets a rejecting stub (no sync throw)", async () => {
    const pid = "stub-raw-main";
    const src = `
      globalThis.__rawNetworkProbe = {
        hasNetwork: typeof ctx.network === "object",
        hasRequest: ctx.network && typeof ctx.network.request === "function",
      };
      module.exports = {
        activate(ctx) {
          let syncThrew = false;
          let p = null;
          try {
            p = ctx.network.request({ url: "https://api.example.com/" });
          } catch (e) {
            syncThrew = true;
          }
          globalThis.__rawNetworkProbe.syncThrew = syncThrew;
          globalThis.__rawNetworkProbe.isPromise = !!p && typeof p.then === "function";
          p.then(
            () => ctx.logger.info("RAW-NET-UNEXPECTED-RESOLVE"),
            (e) => ctx.logger.info("RAW-NET-DENIED:" + (e && e.message ? e.message : String(e))),
          );
        },
      };
    `;
    applyPlan({
      revision: "raw-stub-v1",
      plugins: [{ id: pid, version: "1", granted: ["runtime.unsafe"], main: src }],
    });
    await waitFor(() => pluginMessages(pid, "info", "RAW-NET-DENIED").length > 0, "raw denied rejection");
    expect(globalThis.__rawNetworkProbe.hasNetwork).toBe(true);
    expect(globalThis.__rawNetworkProbe.hasRequest).toBe(true);
    expect(globalThis.__rawNetworkProbe.syncThrew).toBe(false);
    expect(globalThis.__rawNetworkProbe.isPromise).toBe(true);
    expect(pluginMessages(pid, "info", "RAW-NET-DENIED")[0][2]).toContain("network.access not granted");
    expect(pluginMessages(pid, "info", "RAW-NET-UNEXPECTED-RESOLVE").length).toBe(0);
    expect(requestCalls.some(([method]) => method === "networkRequest")).toBe(false);
  });

  test("raw main with network.access bridges to the Core transport", async () => {
    const pid = "raw-granted-main";
    respondQueue.push((id) => ({
      id,
      envelope: {
        version: "0.1",
        id,
        result: { status: 200, headers: {}, body: "raw-ok" },
      },
    }));
    const src = `
      module.exports = {
        activate(ctx) {
          ctx.network.request({ url: "https://api.example.com/" }).then(
            (resp) => ctx.logger.info("RAW-NET-OK:" + resp.body),
            (e) => ctx.logger.info("RAW-NET-FAIL:" + (e && e.message ? e.message : String(e))),
          );
        },
      };
    `;
    applyPlan({
      revision: "raw-granted-v1",
      plugins: [{ id: pid, version: "1", granted: ["runtime.unsafe", "network.access"], main: src }],
    });
    await waitFor(() => pluginMessages(pid, "info", "RAW-NET-OK").length > 0, "raw granted resolve");
    expect(pluginMessages(pid, "info", "RAW-NET-OK")[0][2]).toContain("raw-ok");
    const call = requestCalls.find(([method]) => method === "networkRequest");
    expect(call).toBeDefined();
    expect(call[1].pluginId).toBe(pid);
  });
});

describe("renderer ctx.css host functions", () => {
  test("insert resolves to the host key and remove revokes it", async () => {
    const pid = "css-roundtrip";
    const src = `
      module.exports = {
        activate: async (ctx) => {
          ctx.logger.info("CSS-TYPEOF:" + (typeof ctx.css));
          const key = await ctx.css.insert("body { color: red; }");
          ctx.logger.info("CSS-KEY:" + key);
          await ctx.css.remove(key);
          ctx.logger.info("CSS-REMOVED");
        },
      };
    `;
    const contents = loadRendererPlugin({
      pid,
      grants: ["renderer.css", "renderer.script"],
      rendererSource: src,
    });
    await waitFor(() => pluginMessages(pid, "info", "CSS-REMOVED").length > 0, "css round-trip");
    expect(pluginMessages(pid, "info", "CSS-TYPEOF")[0][2]).toBe("CSS-TYPEOF:object");
    const keyLog = pluginMessages(pid, "info", "CSS-KEY")[0][2];
    expect(keyLog).toContain("css-key-");
    const key = keyLog.slice("CSS-KEY:".length);
    expect(contents.__inserted).toEqual(["body { color: red; }"]);
    expect(contents.__removed).toEqual([key]);
  });

  test("css is absent without the renderer.css grant", async () => {
    const pid = "css-absent";
    const src = `module.exports = { activate: (ctx) => { ctx.logger.info("CSS-TYPEOF:" + (typeof ctx.css)); } };`;
    loadRendererPlugin({ pid, grants: ["renderer.script"], rendererSource: src });
    await waitFor(() => pluginMessages(pid, "info", "CSS-TYPEOF").length > 0, "plugin loaded");
    expect(pluginMessages(pid, "info", "CSS-TYPEOF")[0][2]).toBe("CSS-TYPEOF:undefined");
  });

  test("insert/remove with invalid args return undefined without a host call", async () => {
    const pid = "css-invalid";
    const src = `
      module.exports = {
        activate: (ctx) => {
          ctx.logger.info("CSS-INSERT-INVALID:" + String(ctx.css.insert(123)));
          ctx.logger.info("CSS-REMOVE-INVALID:" + String(ctx.css.remove("")));
        },
      };
    `;
    const contents = loadRendererPlugin({
      pid,
      grants: ["renderer.css", "renderer.script"],
      rendererSource: src,
    });
    await waitFor(() => pluginMessages(pid, "info", "CSS-REMOVE-INVALID").length > 0, "invalid handling");
    expect(pluginMessages(pid, "info", "CSS-INSERT-INVALID")[0][2]).toBe("CSS-INSERT-INVALID:undefined");
    expect(pluginMessages(pid, "info", "CSS-REMOVE-INVALID")[0][2]).toBe("CSS-REMOVE-INVALID:undefined");
    expect(contents.__inserted).toEqual([]);
    expect(contents.__removed).toEqual([]);
  });
});
